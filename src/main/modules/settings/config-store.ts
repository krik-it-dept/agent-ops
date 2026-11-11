// SettingsStore owns <dataDir>\config.json: load or migrate at start, then one
// read-modify-write at a time, each validated and saved atomically before it
// becomes current. A corrupt file is moved aside (never silently replaced); a
// file that cannot be read, or one from a newer release, is kept and settings
// become read-only until the next start.

import path from 'node:path';
import { isDirectory } from '../../lib/safe-io/paths';
import {
  Mutex,
  errnoCode,
  isMissing,
  moveAside,
  readFileRetry,
  writeFileAtomic,
  type SafeIoOptions,
} from '../../lib/safe-io/safe-io';
import {
  ConfigContentError,
  NewerConfigError,
  cloneConfig,
  defaultConfig,
  parseConfig,
  serializeConfig,
  validTextSize,
  validTheme,
  validateConfig,
  type AppConfig,
  type TextSize,
  type Theme,
} from './config';
import { projectDisplayName, projectIdFor } from './identity';
import { OwnerError, settle, type Result } from './result';

export const CONFIG_FILE_NAME = 'config.json';

export function configFilePath(dataDir: string): string {
  return path.join(dataDir, CONFIG_FILE_NAME);
}

/** readConfig reads and validates config.json; a missing file throws ENOENT. */
export async function readConfig(
  file: string,
  io?: SafeIoOptions,
): Promise<AppConfig> {
  const bytes = await readFileRetry(file, io);
  const config = parseConfig(bytes.toString('utf8'));
  const problem = validateConfig(config);
  if (problem !== '') throw new ConfigContentError(problem);
  return config;
}

/** writeConfig validates c before it reaches the disk and replaces the file atomically. */
export async function writeConfig(
  file: string,
  c: AppConfig,
  io?: SafeIoOptions,
): Promise<void> {
  const problem = validateConfig(c);
  if (problem !== '')
    throw new OwnerError('INVALID_REQUEST', capitalize(problem) + '.');
  await writeFileAtomic(file, serializeConfig(c), io);
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export interface LoadResult {
  config: AppConfig;
  /** A sentence for the owner, or ''. */
  warning: string;
  /** Set when settings cannot be saved until the file is fixed or removed. */
  readOnly: string;
}

export interface LegacyPaths {
  /** The first release's fixed repositories folder; only the installed app's own data folder migrates it. */
  reposDir?: string;
}

/**
 * loadOrMigrateConfig reads the config. Without one, an existing legacy repos
 * folder becomes a single folder workspace so an upgraded install looks the
 * same. A corrupt file is moved aside and reported.
 */
export async function loadOrMigrateConfig(
  file: string,
  legacy: LegacyPaths,
  now: Date,
  io?: SafeIoOptions,
): Promise<LoadResult> {
  let corrupt: ConfigContentError | undefined;
  try {
    return { config: await readConfig(file, io), warning: '', readOnly: '' };
  } catch (err) {
    if (err instanceof ConfigContentError) {
      corrupt = err;
    } else if (!isMissing(err)) {
      // A read failure (locked by an editor or antivirus, access denied, a
      // folder) or a newer release's file is kept untouched: no move aside, no
      // migration, and settings stay read-only until the next start.
      const reason =
        err instanceof NewerConfigError
          ? err.message
          : errnoCode(err) || String(err);
      return {
        config: defaultConfig(),
        warning: `The settings file ${file} could not be used (${reason}); it was left unchanged.`,
        readOnly: `Settings cannot be saved until ${file} is fixed or removed.`,
      };
    }
  }
  let warning = '';
  if (corrupt) {
    let aside: string;
    try {
      aside = await moveAside(file, now, io);
    } catch (moveErr) {
      return {
        config: defaultConfig(),
        warning: `The settings file ${file} is unreadable (${corrupt.message}) and could not be moved aside: ${errnoCode(moveErr) || String(moveErr)}.`,
        readOnly: `Settings cannot be saved until ${file} is fixed or removed.`,
      };
    }
    warning = `The settings file was unreadable (${corrupt.message}). It was kept as ${aside}. Add your workspaces again.`;
  }
  const config = defaultConfig();
  if (!legacy.reposDir || !(await isDirectory(legacy.reposDir)))
    return { config, warning, readOnly: '' };
  const repos = path.resolve(legacy.reposDir);
  config.projects = [
    {
      id: projectIdFor(repos),
      path: repos,
      name: projectDisplayName(repos),
      kind: 'folder',
      enabled: true,
      addedAt: now.toISOString(),
    },
  ];
  config.setupComplete = true;
  try {
    await writeConfig(file, config, io);
  } catch (err) {
    return {
      config,
      warning:
        `${warning} Could not save migrated settings: ${(err as Error).message}`.trim(),
      readOnly: '',
    };
  }
  return { config, warning, readOnly: '' };
}

/** SettingsPatch is the general settings an owner may change in one request. */
export interface SettingsPatch {
  notifications?: boolean;
  setupComplete?: boolean;
  theme?: Theme;
  textSize?: TextSize;
  shortcuts?: boolean;
  autoArchiveDone?: boolean;
}

const BOOLEAN_FIELDS = [
  'notifications',
  'setupComplete',
  'shortcuts',
  'autoArchiveDone',
] as const;

export interface SettingsStoreOptions {
  dataDir: string;
  now?: () => Date;
  legacy?: LegacyPaths;
  io?: SafeIoOptions;
}

export class SettingsStore {
  readonly dataDir: string;
  readonly file: string;
  private current: AppConfig = defaultConfig();
  private warningText = '';
  private readOnlyText = '';
  private readonly lock = new Mutex();
  private readonly now: () => Date;

  constructor(private readonly opts: SettingsStoreOptions) {
    this.dataDir = opts.dataDir;
    this.file = configFilePath(opts.dataDir);
    this.now = opts.now ?? (() => new Date());
  }

  get io(): SafeIoOptions | undefined {
    return this.opts.io;
  }

  /** load reads (or migrates) config.json. Call once at start. */
  async load(): Promise<LoadResult> {
    return this.lock.run(async () => {
      const result = await loadOrMigrateConfig(
        this.file,
        this.opts.legacy ?? {},
        this.now(),
        this.opts.io,
      );
      this.current = result.config;
      this.warningText = result.warning;
      this.readOnlyText = result.readOnly;
      return { ...result, config: cloneConfig(result.config) };
    });
  }

  /** get returns a copy of the current settings. */
  get(): AppConfig {
    return cloneConfig(this.current);
  }

  get warning(): string {
    return this.warningText;
  }

  get readOnly(): string {
    return this.readOnlyText;
  }

  /** setupRequired is true until setup is done, except while the file is unusable (the warning shows instead). */
  get setupRequired(): boolean {
    return !this.current.setupComplete && this.readOnlyText === '';
  }

  /**
   * mutate applies change to a copy, validates and saves it, then makes it
   * current. change may throw OwnerError to refuse; nothing is saved then.
   */
  mutate(
    change: (draft: AppConfig) => void | Promise<void>,
  ): Promise<Result<AppConfig>> {
    return settle(() => this.lock.run(() => this.mutateLocked(change)));
  }

  private async mutateLocked(
    change: (draft: AppConfig) => void | Promise<void>,
  ): Promise<AppConfig> {
    if (this.readOnlyText !== '')
      throw new OwnerError('READ_ONLY', this.readOnlyText);
    const next = cloneConfig(this.current);
    await change(next);
    try {
      await writeConfig(this.file, next, this.opts.io);
    } catch (err) {
      if (err instanceof OwnerError) throw err;
      throw new OwnerError(
        'IO_ERROR',
        `Could not save settings: ${errnoCode(err) || (err as Error).message}`,
      );
    }
    this.current = next;
    return cloneConfig(next);
  }

  /** update changes general settings; any other key, or a value of the wrong type, is refused. */
  update(patch: unknown): Promise<Result<AppConfig>> {
    return this.mutate((draft) => {
      if (typeof patch !== 'object' || patch === null || Array.isArray(patch))
        throw new OwnerError('INVALID_REQUEST', 'Invalid settings request.');
      const body = patch as Record<string, unknown>;
      for (const key of Object.keys(body)) {
        if (
          key !== 'theme' &&
          key !== 'textSize' &&
          !(BOOLEAN_FIELDS as readonly string[]).includes(key)
        )
          throw new OwnerError('INVALID_REQUEST', 'Invalid settings request.');
      }
      for (const key of BOOLEAN_FIELDS) {
        if (body[key] !== undefined && typeof body[key] !== 'boolean')
          throw new OwnerError('INVALID_REQUEST', 'Invalid settings request.');
      }
      if (
        body.theme !== undefined &&
        (body.theme === '' || !validTheme(body.theme))
      ) {
        throw new OwnerError(
          'INVALID_REQUEST',
          'Theme must be system, light or dark.',
        );
      }
      if (
        body.textSize !== undefined &&
        (body.textSize === '' || !validTextSize(body.textSize))
      ) {
        throw new OwnerError(
          'INVALID_REQUEST',
          'Text size must be small, default, large or larger.',
        );
      }
      for (const key of BOOLEAN_FIELDS)
        if (typeof body[key] === 'boolean') draft[key] = body[key];
      if (body.textSize !== undefined)
        draft.textSize = body.textSize as TextSize;
      if (body.theme !== undefined) draft.theme = body.theme as Theme;
    });
  }
}

/** themeOrSystem is the theme as the UI shows it. */
export function themeOrSystem(theme: Theme): Exclude<Theme, ''> {
  return theme === '' ? 'system' : theme;
}
