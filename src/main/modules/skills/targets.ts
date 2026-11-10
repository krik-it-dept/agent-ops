// Reading and writing the stored list (config.json "integrations"), with the
// baseline's shape and validation. Unknown keys of an entry are preserved.

import path from 'node:path';

import { isLocalAbsolute, PathTools } from './paths.js';
import type { SkillTarget } from './types.js';

export const TARGET_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;
export const MAX_LABEL = 80;

const KNOWN_KEYS = [
  'id',
  'label',
  'skillDir',
  'instructionFile',
  'instructionBlock',
  'enabled',
  'source',
  'addedAt',
  'version',
  'sha256',
  'installedAt',
  'kept',
  'instructionSha256',
  'legacySha256',
] as const;

const OPTIONAL_STRINGS = [
  'instructionFile',
  'addedAt',
  'sha256',
  'installedAt',
  'kept',
  'instructionSha256',
  'legacySha256',
] as const;

export class TargetListError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The stored list. A missing value is an empty list. Anything that does not
 * validate throws TargetListError: the caller then refuses every change so the
 * stored value is never overwritten.
 */
export function parseTargets(raw: unknown, paths: PathTools): SkillTarget[] {
  if (raw === undefined || raw === null) {
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new TargetListError('it is in an older format');
  }
  const out: SkillTarget[] = [];
  const ids = new Set<string>();
  const dirs = new Set<string>();
  raw.forEach((entry: unknown, i) => {
    if (!isObject(entry)) {
      throw new TargetListError(`entry ${i + 1} is not an object`);
    }
    const { id, label, skillDir, instructionBlock, enabled, source, version } =
      entry;
    if (typeof id !== 'string' || !TARGET_ID_PATTERN.test(id)) {
      throw new TargetListError(`entry ${i + 1} has an invalid id`);
    }
    if (ids.has(id)) {
      throw new TargetListError(`the id ${id} is listed twice`);
    }
    ids.add(id);
    if (typeof skillDir !== 'string' || !isLocalAbsolute(skillDir)) {
      throw new TargetListError(`entry ${id} needs a full folder path`);
    }
    const key = paths.key(skillDir);
    if (dirs.has(key)) {
      throw new TargetListError(`the folder ${skillDir} is listed twice`);
    }
    dirs.add(key);
    if (
      typeof label !== 'string' ||
      label.trim() === '' ||
      [...label].length > MAX_LABEL
    ) {
      throw new TargetListError(
        `entry ${id} needs a name of at most ${MAX_LABEL} characters`,
      );
    }
    if (source !== 'detected' && source !== 'custom') {
      throw new TargetListError(`entry ${id} has an unknown source`);
    }
    if (
      (instructionBlock !== undefined &&
        typeof instructionBlock !== 'boolean') ||
      (enabled !== undefined && typeof enabled !== 'boolean')
    ) {
      throw new TargetListError(`entry ${id} has an invalid switch`);
    }
    if (
      version !== undefined &&
      (typeof version !== 'number' || !Number.isInteger(version) || version < 0)
    ) {
      throw new TargetListError(`entry ${id} has an invalid version`);
    }
    const t: SkillTarget = {
      id,
      label,
      skillDir,
      instructionBlock: instructionBlock === true,
      enabled: enabled === true,
      source,
      extra: {},
    };
    if (typeof version === 'number' && version > 0) {
      t.version = version;
    }
    for (const name of OPTIONAL_STRINGS) {
      const v = entry[name];
      if (v === undefined || v === null || v === '') {
        continue;
      }
      if (typeof v !== 'string') {
        throw new TargetListError(`entry ${id} has an invalid ${name}`);
      }
      t[name] = v;
    }
    if (
      t.instructionFile !== undefined &&
      !isLocalAbsolute(t.instructionFile)
    ) {
      throw new TargetListError(
        `entry ${id} needs a full instruction file path`,
      );
    }
    for (const [k, v] of Object.entries(entry)) {
      if (!(KNOWN_KEYS as readonly string[]).includes(k)) {
        t.extra[k] = v;
      }
    }
    out.push(t);
  });
  return out;
}

/** The stored form: known keys in the baseline order (empty optional ones left out), then unknown keys. */
export function serializeTarget(t: SkillTarget): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: t.id,
    label: t.label,
    skillDir: t.skillDir,
  };
  if (t.instructionFile) {
    out['instructionFile'] = t.instructionFile;
  }
  out['instructionBlock'] = t.instructionBlock;
  out['enabled'] = t.enabled;
  out['source'] = t.source;
  if (t.addedAt) {
    out['addedAt'] = t.addedAt;
  }
  if (t.version) {
    out['version'] = t.version;
  }
  for (const name of [
    'sha256',
    'installedAt',
    'kept',
    'instructionSha256',
    'legacySha256',
  ] as const) {
    const v = t[name];
    if (v) {
      out[name] = v;
    }
  }
  for (const [k, v] of Object.entries(t.extra)) {
    if (!(k in out)) {
      out[k] = v;
    }
  }
  return out;
}

export function cloneTarget(t: SkillTarget): SkillTarget {
  return { ...t, extra: { ...t.extra } };
}

/** The skill file Agent Ops manages inside a target folder. */
export function skillFileOf(dir: string): string {
  return path.join(dir, 'task-plan', 'SKILL.md');
}
