// The <dataDir>\config.json schema, compatible with the Go baseline (version 1).
// Unknown keys are kept as they are; the legacy keys stateFile and slotsFile
// are dropped on the next save. integrations and integrationsSeeded belong to
// the Skills module and are kept verbatim here.

import {
  cleanPath,
  isAbsolutePath,
  isNetworkOrDevicePath,
  overlaps,
  pathKey,
} from '../../lib/safe-io/paths';
import { stripBom } from '../../lib/safe-io/safe-io';
import { PROJECT_ID_PATTERN, TASKS_PROJECT_ID } from './identity';

export const CONFIG_VERSION = 1;
export const MAX_PROJECT_NAME_BYTES = 120;
/** The time Go writes for a zero time.Time, used when a project has no addedAt. */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

/** Keys of earlier releases that are ignored on load and dropped on save. */
export const LEGACY_KEYS = ['stateFile', 'slotsFile'] as const;

export type ProjectKind = 'repo' | 'folder';
export type Theme = '' | 'system' | 'light' | 'dark';

/** Project is one workspace: a repository, or a folder whose direct children are repositories. */
export interface Project {
  id: string;
  path: string;
  name: string;
  kind: ProjectKind;
  enabled: boolean;
  /** RFC 3339 time the workspace was added. */
  addedAt: string;
}

export interface AppConfig {
  version: number;
  setupComplete: boolean;
  projects: Project[];
  /** The shared Tasks folder, <tasksDir>\<workspace>\<plan>.md; '' until chosen. */
  tasksDir: string;
  /** The Tasks folder before the last change, while it may still hold plans. */
  previousTasksDir: string;
  notifications: boolean;
  /** '' means system. */
  theme: Theme;
  /** Interface scale; '' means default. */
  textSize: TextSize;
  shortcuts: boolean;
  autoArchiveDone: boolean;
  /** Agent Ops keeps its hooks in Claude Code settings (installed app only). */
  claudeHooks: boolean;
  /** Explicit owner choices by plan key; false overrides automatic archiving. */
  planArchive: Record<string, boolean>;
  pickerDirectory: string;
  /** Owned by the Skills module; kept verbatim (undefined when absent). */
  integrations?: unknown;
  integrationsSeeded?: unknown;
  /** Top-level keys this release does not know, kept for a newer release or another module. */
  extra: Record<string, unknown>;
}

export function defaultConfig(): AppConfig {
  return {
    version: CONFIG_VERSION,
    setupComplete: false,
    projects: [],
    tasksDir: '',
    previousTasksDir: '',
    notifications: true,
    theme: '',
    textSize: '',
    shortcuts: true,
    autoArchiveDone: false,
    claudeHooks: true,
    planArchive: {},
    pickerDirectory: '',
    extra: {},
  };
}

export function cloneConfig(c: AppConfig): AppConfig {
  return structuredClone(c);
}

export const TEXT_SIZES = ['small', 'default', 'large', 'larger'] as const;
export type TextSize = (typeof TEXT_SIZES)[number] | '';
export function validTextSize(size: unknown): size is TextSize {
  return size === '' || (TEXT_SIZES as readonly unknown[]).includes(size);
}

export function validTheme(theme: unknown): theme is Theme {
  return (
    theme === '' || theme === 'system' || theme === 'light' || theme === 'dark'
  );
}

/** ConfigContentError is a config.json that was read but is not valid settings; only this kind is moved aside. */
export class ConfigContentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigContentError';
  }
}

/** NewerConfigError marks a file written by a newer release; it is kept as it is, never moved aside or migrated. */
export class NewerConfigError extends Error {
  constructor(readonly fileVersion: number) {
    super(
      `settings were saved by a newer Agent Ops (settings version ${fileVersion})`,
    );
    this.name = 'NewerConfigError';
  }
}

const KNOWN_KEYS = new Set([
  'version',
  'setupComplete',
  'projects',
  'tasksDir',
  'previousTasksDir',
  'notifications',
  'theme',
  'textSize',
  'shortcuts',
  'autoArchiveDone',
  'claudeHooks',
  'planArchive',
  'pickerDirectory',
  'integrations',
  'integrationsSeeded',
  ...LEGACY_KEYS,
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function field<T>(
  obj: Record<string, unknown>,
  key: string,
  kind: 'string' | 'boolean' | 'number',
  fallback: T,
  where = '',
): T {
  const v = obj[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== kind)
    throw new ConfigContentError(
      `invalid JSON: ${where}${key} must be a ${kind}`,
    );
  return v as T;
}

function parseProject(raw: unknown, index: number): Project {
  if (!isRecord(raw))
    throw new ConfigContentError(
      `invalid JSON: project ${index + 1} must be an object`,
    );
  const where = `project ${index + 1} `;
  return {
    id: field(raw, 'id', 'string', '', where),
    path: field(raw, 'path', 'string', '', where),
    name: field(raw, 'name', 'string', '', where),
    kind: field(raw, 'kind', 'string', '' as ProjectKind, where),
    enabled: field(raw, 'enabled', 'boolean', false, where),
    addedAt: field(raw, 'addedAt', 'string', ZERO_TIME, where),
  };
}

/**
 * parseConfig turns config.json text into settings without validating them.
 * notifications and shortcuts default to on when absent, as in the baseline.
 */
export function parseConfig(text: string): AppConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(stripBom(text));
  } catch (err) {
    throw new ConfigContentError(`invalid JSON: ${(err as Error).message}`);
  }
  if (!isRecord(raw))
    throw new ConfigContentError(
      'invalid JSON: the settings must be an object',
    );
  const projectsRaw = raw.projects;
  if (
    projectsRaw !== undefined &&
    projectsRaw !== null &&
    !Array.isArray(projectsRaw)
  ) {
    throw new ConfigContentError('invalid JSON: projects must be a list');
  }
  const archiveRaw = raw.planArchive;
  const planArchive: Record<string, boolean> = {};
  if (archiveRaw !== undefined && archiveRaw !== null) {
    if (!isRecord(archiveRaw))
      throw new ConfigContentError(
        'invalid JSON: planArchive must be an object',
      );
    for (const [k, v] of Object.entries(archiveRaw)) {
      if (typeof v !== 'boolean')
        throw new ConfigContentError(
          'invalid JSON: planArchive values must be true or false',
        );
      planArchive[k] = v;
    }
  }
  const version = field(raw, 'version', 'number', 0);
  if (!Number.isInteger(version))
    throw new ConfigContentError(
      'invalid JSON: version must be a whole number',
    );
  const extra: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw))
    if (!KNOWN_KEYS.has(k)) extra[k] = v;
  const config: AppConfig = {
    version,
    setupComplete: field(raw, 'setupComplete', 'boolean', false),
    projects: (projectsRaw ?? []).map(parseProject),
    tasksDir: field(raw, 'tasksDir', 'string', ''),
    previousTasksDir: field(raw, 'previousTasksDir', 'string', ''),
    notifications: field(raw, 'notifications', 'boolean', true),
    theme: field(raw, 'theme', 'string', '' as Theme),
    textSize: field(raw, 'textSize', 'string', '' as TextSize),
    shortcuts: field(raw, 'shortcuts', 'boolean', true),
    autoArchiveDone: field(raw, 'autoArchiveDone', 'boolean', false),
    claudeHooks: field(raw, 'claudeHooks', 'boolean', true),
    planArchive,
    pickerDirectory: field(raw, 'pickerDirectory', 'string', ''),
    extra,
  };
  if (raw.integrations !== undefined && raw.integrations !== null)
    config.integrations = raw.integrations;
  if (raw.integrationsSeeded !== undefined && raw.integrationsSeeded !== null)
    config.integrationsSeeded = raw.integrationsSeeded;
  return config;
}

/**
 * validateConfig returns why the settings are invalid, in a sentence for the
 * owner, or '' when they are valid. A newer version throws NewerConfigError.
 */
export function validateConfig(c: AppConfig): string {
  if (c.version > CONFIG_VERSION) throw new NewerConfigError(c.version);
  if (c.version !== CONFIG_VERSION)
    return `unsupported settings version ${c.version}`;
  const ids = new Set<string>();
  const paths = new Set<string>();
  for (const [i, p] of c.projects.entries()) {
    if (!PROJECT_ID_PATTERN.test(p.id) || p.id === TASKS_PROJECT_ID)
      return `project ${i + 1} has an invalid id`;
    if (ids.has(p.id)) return `duplicate project id "${p.id}"`;
    ids.add(p.id);
    if (!isAbsolutePath(p.path))
      return `project "${p.id}" path must be absolute`;
    const key = pathKey(p.path);
    if (paths.has(key)) return `project path "${p.path}" is listed twice`;
    paths.add(key);
    if (p.kind !== 'repo' && p.kind !== 'folder')
      return `project "${p.id}" kind must be repo or folder`;
    if (
      p.name.trim() === '' ||
      Buffer.byteLength(p.name, 'utf8') > MAX_PROJECT_NAME_BYTES
    ) {
      return `project "${p.id}" needs a name of at most ${MAX_PROJECT_NAME_BYTES} characters`;
    }
  }
  // A folder inside another project would be collected twice under two keys.
  for (let i = 0; i < c.projects.length; i++) {
    for (let j = i + 1; j < c.projects.length; j++) {
      const a = c.projects[i]!;
      const b = c.projects[j]!;
      if (overlaps(pathKey(a.path), pathKey(b.path))) {
        return `projects "${a.path}" and "${b.path}" overlap: one folder contains the other`;
      }
    }
  }
  if (!validTheme(c.theme)) return 'theme must be system, light or dark';
  if (!validTextSize(c.textSize))
    return 'text size must be small, default, large or larger';
  for (const dir of [c.tasksDir, c.previousTasksDir]) {
    if (dir !== '' && (!isAbsolutePath(dir) || isNetworkOrDevicePath(dir))) {
      return 'the Tasks folder must be an absolute path on this computer';
    }
  }
  return '';
}

/** serializeConfig writes the baseline's key order and omissions, then unknown keys, with a final newline. */
export function serializeConfig(c: AppConfig): string {
  const out: Record<string, unknown> = {
    version: c.version,
    setupComplete: c.setupComplete,
    projects: c.projects.map((p) => ({
      id: p.id,
      path: p.path,
      name: p.name,
      kind: p.kind,
      enabled: p.enabled,
      addedAt: p.addedAt,
    })),
  };
  if (c.tasksDir !== '') out.tasksDir = c.tasksDir;
  if (c.previousTasksDir !== '') out.previousTasksDir = c.previousTasksDir;
  out.notifications = c.notifications;
  if (c.theme !== '') out.theme = c.theme;
  if (c.textSize !== '') out.textSize = c.textSize;
  out.shortcuts = c.shortcuts;
  out.autoArchiveDone = c.autoArchiveDone;
  if (!c.claudeHooks) out.claudeHooks = false;
  if (Object.keys(c.planArchive).length > 0) out.planArchive = c.planArchive;
  if (c.pickerDirectory !== '') out.pickerDirectory = c.pickerDirectory;
  if (c.integrations !== undefined) out.integrations = c.integrations;
  if (c.integrationsSeeded !== undefined)
    out.integrationsSeeded = c.integrationsSeeded;
  for (const [k, v] of Object.entries(c.extra)) {
    if (!KNOWN_KEYS.has(k)) out[k] = v;
  }
  return JSON.stringify(out, null, 2) + '\n';
}

/** cleanProjectPath is the stored form of a workspace folder. */
export function cleanProjectPath(p: string): string {
  return cleanPath(p);
}
