// The one-time move from the Go version, on the first start of the installed
// Electron app. The installer (build/installer.nsh) already moved a Go install
// out of %LOCALAPPDATA%\Programs\AgentOps before writing the new files; this
// finishes the rest:
//   - the old runtime folder (%USERPROFILE%\.claude\tools\<old>) is stopped and
//     renamed to <folder>.backup-<time> when it holds more than the no-op
//     task-sync/task-report stubs, and the stubs are put back at the old path;
//   - the old startup entries are retired; when either was present (the owner
//     had Start with Windows on) the "Agent Ops" entry is pointed at this app;
//   - the old protocol class and the Go Apps & features entry are removed;
//   - config.json of the oldest data folder is copied once when the current
//     data folder has none.
// The data folder %LOCALAPPDATA%\AgentOps is never changed apart from its
// legacy-move folder (result and log). Nothing is deleted: folders are renamed
// next to themselves, and only the known registry entries are removed. Every
// step is logged; a failed step is retried on the next start.

import { constants, promises as fs } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';

import { LEGACY } from './legacy-names';
import { writeJsonAtomic } from './store';

/** HKEY_CURRENT_USER, with paths relative to it; name '' is the default value. */
export interface RegistryLayer {
  getString(key: string, name: string): Promise<string | null>;
  setString(key: string, name: string, value: string): Promise<void>;
  /** A missing value is not an error. */
  deleteValue(key: string, name: string): Promise<void>;
  /** Removes the key with its subkeys; a missing key is not an error. */
  deleteKey(key: string): Promise<void>;
}

export interface ProcessLayer {
  /**
   * Stops processes whose executable is exactly one of executables (file
   * identity, not a folder prefix); returns how many. Throws when one could not
   * be inspected or stopped.
   */
  stopExact(executables: string[]): Promise<number>;
}

export interface LegacyMoveOptions {
  /** %LOCALAPPDATA%. */
  localAppData: string;
  /** %USERPROFILE%. */
  userProfile: string;
  /** The app data folder; the move runs only for the default %LOCALAPPDATA%\AgentOps. */
  dataDir: string;
  /** process.execPath of the installed app. */
  executablePath: string;
  /** The packaged no-op stubs (resources\legacy-stubs); null when not packaged. */
  stubsDir: string | null;
  registry: RegistryLayer;
  processes: ProcessLayer;
  now?: () => Date;
  log?: (line: string) => void;
}

export type StepOutcome = 'done' | 'nothing' | 'skipped' | 'failed';

export interface LegacyStep {
  step: string;
  outcome: StepOutcome;
  detail: string;
}

export interface LegacyMoveResult {
  version: 1;
  at: string;
  /** All steps finished; the move does not run again. */
  completed: boolean;
  steps: LegacyStep[];
}

export interface LegacyDetection {
  /** The old runtime folder when it holds more than the stubs. */
  runtimeFolder: string | null;
  /** The old runtime folder holds only the stubs (an earlier move). */
  runtimeStubsOnly: boolean;
  /** Where the installer moved a Go install, from its receipt. */
  goInstallBackup: string | null;
  goUninstallEntry: boolean;
  runValueOld: string | null;
  runValue: string | null;
  oldProtocol: boolean;
  /** config.json of the oldest data folder, when the data folder has none. */
  oldConfig: string | null;
}

export function legacyMoveFolder(dataDir: string): string {
  return join(dataDir, 'legacy-move');
}

function same(a: string, b: string): boolean {
  return (
    a.replace(/[\\/]+$/, '').toLowerCase() ===
    b.replace(/[\\/]+$/, '').toLowerCase()
  );
}

/** Refuse existing links, including junctions in an ancestor, before migration. */
async function requirePlainPath(path: string): Promise<void> {
  if (!isAbsolute(path)) throw new Error('Migration paths must be absolute.');
  for (let current = path; ; current = dirname(current)) {
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) {
        throw new Error('Migration refuses a redirected path.');
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }
    if (dirname(current) === current) return;
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}

function stamp(d: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reads what is left of the Go version, without changing anything. */
export async function detectLegacy(
  options: LegacyMoveOptions,
): Promise<LegacyDetection> {
  const runtime = join(options.userProfile, ...LEGACY.runtimeFolder);
  let runtimeFolder: string | null = null;
  let runtimeStubsOnly = false;
  try {
    const entries = await fs.readdir(runtime, { withFileTypes: true });
    const stubsOnly = entries.every(
      (e) =>
        e.isFile() &&
        LEGACY.stubs.some((s) => s.toLowerCase() === e.name.toLowerCase()),
    );
    if (stubsOnly) {
      runtimeStubsOnly = entries.length > 0;
    } else {
      runtimeFolder = runtime;
    }
  } catch {
    // no old runtime folder
  }
  let goInstallBackup: string | null = null;
  try {
    const receipt = await fs.readFile(
      join(legacyMoveFolder(options.dataDir), 'installer-receipt.txt'),
      'utf8',
    );
    const m = /^goInstallBackup=(.+)$/m.exec(receipt);
    goInstallBackup = m?.[1]?.trim() || null;
  } catch {
    // no receipt: the installer found no Go install
  }
  const uninstall = await options.registry.getString(
    LEGACY.goUninstallKey,
    'UninstallString',
  );
  const oldData = join(options.localAppData, LEGACY.dataFolder, 'config.json');
  const oldConfig =
    (await exists(oldData)) &&
    !(await exists(join(options.dataDir, 'config.json')))
      ? oldData
      : null;
  return {
    runtimeFolder,
    runtimeStubsOnly,
    goInstallBackup,
    goUninstallEntry: uninstall !== null && uninstall.includes('--uninstall'),
    runValueOld: await options.registry.getString(
      LEGACY.runKey,
      LEGACY.runValueOld,
    ),
    runValue: await options.registry.getString(LEGACY.runKey, LEGACY.runValue),
    oldProtocol:
      (await options.registry.getString(LEGACY.protocolKey, '')) !== null,
    oldConfig,
  };
}

/** Runs the move once; later calls return the stored result. */
export async function runLegacyMove(
  options: LegacyMoveOptions,
): Promise<LegacyMoveResult> {
  const now = options.now ?? (() => new Date());
  const folder = legacyMoveFolder(options.dataDir);
  const resultFile = join(folder, 'result.json');
  const steps: LegacyStep[] = [];
  const lines: string[] = [];
  const record = (step: string, outcome: StepOutcome, detail: string): void => {
    steps.push({ step, outcome, detail });
    const line = `${now().toISOString()} ${step}: ${outcome}${detail ? ` - ${detail}` : ''}`;
    lines.push(line);
    options.log?.(line);
  };

  if (
    !same(options.dataDir, join(options.localAppData, 'AgentOps')) ||
    !same(
      options.executablePath,
      join(options.localAppData, 'Programs', 'AgentOps', 'agent-ops.exe'),
    )
  ) {
    // An isolated or development run never touches the real install.
    record(
      'scope',
      'skipped',
      'the app is not running from the installed defaults',
    );
    return { version: 1, at: now().toISOString(), completed: false, steps };
  }

  try {
    for (const path of [
      resultFile,
      options.executablePath,
      join(options.userProfile, ...LEGACY.runtimeFolder),
      join(options.localAppData, LEGACY.dataFolder, 'config.json'),
      join(options.dataDir, 'config.json'),
      join(folder, 'legacy-move.log'),
      join(folder, 'installer-receipt.txt'),
      join(folder, 'runtime-move.json'),
    ]) {
      await requirePlainPath(path);
    }
  } catch (err) {
    record('scope', 'failed', message(err));
    return { version: 1, at: now().toISOString(), completed: false, steps };
  }
  try {
    const previous = JSON.parse(
      await fs.readFile(resultFile, 'utf8'),
    ) as LegacyMoveResult;
    if (previous.completed === true) return previous;
  } catch {
    // first run, or an earlier run did not finish
  }

  const found = await detectLegacy(options);

  record(
    'go-install',
    found.goInstallBackup ? 'done' : 'nothing',
    found.goInstallBackup
      ? `moved by the installer to ${found.goInstallBackup}`
      : '',
  );

  // The old runtime folder: moved aside when it holds more than the stubs.
  const runtimeDir = join(options.userProfile, ...LEGACY.runtimeFolder);
  // Journal of a runtime move: written before anything is stopped or renamed,
  // removed once the stubs are back, so an interruption anywhere in between is
  // repaired on the next start even when the old folder no longer exists.
  const pendingFile = join(folder, 'runtime-move.json');
  let pending: { backup: string } | null;
  try {
    const raw = JSON.parse(await fs.readFile(pendingFile, 'utf8')) as {
      backup?: unknown;
    };
    pending = typeof raw.backup === 'string' ? { backup: raw.backup } : null;
  } catch {
    pending = null;
  }
  let runtimePresent = found.runtimeStubsOnly || pending !== null;
  if (found.runtimeFolder) {
    try {
      const backup = `${runtimeDir}.backup-${stamp(now())}`;
      await fs.mkdir(folder, { recursive: true });
      await writeJsonAtomic(pendingFile, { backup, stubsPending: true });
      pending = { backup };
      const stopped = await options.processes.stopExact([
        join(runtimeDir, 'agent-ops.exe'),
        join(runtimeDir, LEGACY.aliasExe),
      ]);
      await fs.rename(runtimeDir, backup);
      await fs.mkdir(runtimeDir, { recursive: true });
      runtimePresent = true;
      record(
        'runtime-folder',
        'done',
        `stopped ${stopped} process(es), moved ${runtimeDir} to ${backup}`,
      );
    } catch (err) {
      record('runtime-folder', 'failed', message(err));
    }
  } else {
    runtimePresent = runtimePresent || (await exists(runtimeDir));
    record(
      'runtime-folder',
      'nothing',
      found.runtimeStubsOnly ? 'only the stubs are left' : '',
    );
  }
  // The no-op stubs stay callable at the old path (also repaired on a retry).
  if (runtimePresent && options.stubsDir) {
    try {
      await fs.mkdir(runtimeDir, { recursive: true });
      const added: string[] = [];
      for (const stub of LEGACY.stubs) {
        if (!(await exists(join(runtimeDir, stub)))) {
          await fs.copyFile(
            join(options.stubsDir, stub),
            join(runtimeDir, stub),
            constants.COPYFILE_EXCL,
          );
          added.push(stub);
        }
      }
      if (pending) await fs.rm(pendingFile, { force: true });
      record(
        'runtime-stubs',
        added.length ? 'done' : 'nothing',
        added.length ? `kept ${added.join(' and ')} at ${runtimeDir}` : '',
      );
    } catch (err) {
      record('runtime-stubs', 'failed', message(err));
    }
  } else if (runtimePresent) {
    record('runtime-stubs', 'skipped', 'no packaged stubs');
  }

  // Startup: retire the old entries, keep the owner's choice for this app.
  try {
    const wanted = found.runValueOld !== null || found.runValue !== null;
    const command = `"${options.executablePath}" --background`;
    if (wanted && found.runValue !== command) {
      await options.registry.setString(LEGACY.runKey, LEGACY.runValue, command);
    }
    if (found.runValueOld !== null) {
      await options.registry.deleteValue(LEGACY.runKey, LEGACY.runValueOld);
    }
    record(
      'startup',
      wanted ? 'done' : 'nothing',
      wanted
        ? 'Start with Windows stays on for this app; the old startup entries were removed'
        : '',
    );
  } catch (err) {
    record('startup', 'failed', message(err));
  }

  try {
    if (found.oldProtocol) {
      await options.registry.deleteKey(LEGACY.protocolKey);
    }
    record('old-protocol', found.oldProtocol ? 'done' : 'nothing', '');
  } catch (err) {
    record('old-protocol', 'failed', message(err));
  }

  try {
    if (found.goUninstallEntry) {
      await options.registry.deleteKey(LEGACY.goUninstallKey);
    }
    record(
      'go-uninstall-entry',
      found.goUninstallEntry ? 'done' : 'nothing',
      '',
    );
  } catch (err) {
    record('go-uninstall-entry', 'failed', message(err));
  }

  if (found.oldConfig) {
    try {
      await fs.mkdir(options.dataDir, { recursive: true });
      await fs.copyFile(
        found.oldConfig,
        join(options.dataDir, 'config.json'),
        constants.COPYFILE_EXCL,
      );
      record('old-config', 'done', `copied ${found.oldConfig}`);
    } catch (err) {
      record('old-config', 'failed', message(err));
    }
  } else {
    record('old-config', 'nothing', '');
  }

  const result: LegacyMoveResult = {
    version: 1,
    at: now().toISOString(),
    completed: steps.every((s) => s.outcome !== 'failed'),
    steps,
  };
  try {
    await fs.mkdir(folder, { recursive: true });
    await fs.appendFile(
      join(folder, 'legacy-move.log'),
      `${lines.join('\r\n')}\r\n`,
    );
    await writeJsonAtomic(resultFile, result);
  } catch (err) {
    options.log?.(`legacy move result could not be saved: ${message(err)}`);
    result.completed = false;
  }
  return result;
}
