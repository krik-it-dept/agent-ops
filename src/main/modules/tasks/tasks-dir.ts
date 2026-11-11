// The shared Tasks folder: every agent writes its plans to
// <tasksDir>\<workspace-name>\<plan>.md. Agents find it through two pointers
// the app keeps current: the user environment variable AGENT_OPS_TASKS
// (installed instance only, through an injected writer) and
// <dataDir>\tasks-dir.txt. The installed skill never contains the path.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  cleanInputPath,
  errorText,
  isDriveRoot,
  overlaps,
  pathKey,
  pathWithin,
  realKey,
  realPath,
} from '../../lib/safe-io/paths';
import {
  isMissing,
  readFileRetry,
  writeFileAtomic,
  type SafeIoOptions,
} from '../../lib/safe-io/safe-io';
import type { Project } from '../settings/config';
import { OwnerError } from '../settings/result';

export const TASKS_ENV_NAME = 'AGENT_OPS_TASKS';
export const TASKS_POINTER_NAME = 'tasks-dir.txt';

/** suggestedTasksDir follows Orca, which keeps its workspaces under the user folder. */
export function suggestedTasksDir(homeDir: string): string {
  return path.join(homeDir, 'agent-ops', 'tasks');
}

/** insideWorkspace returns the workspace that contains dir (or is dir), also through links and junctions. */
export async function insideWorkspace(
  dir: string,
  projects: Project[],
): Promise<Project | undefined> {
  const keys = [pathKey(dir), await realKey(dir)];
  for (const p of projects) {
    const projectKeys = [pathKey(p.path), await realKey(p.path)];
    for (const k of keys)
      for (const pk of projectKeys) if (k === pk || pathWithin(k, pk)) return p;
  }
  return undefined;
}

export interface CheckTasksDirOptions {
  projects: Project[];
  dataDir: string;
  homeDir: string;
  /** allowInside confirms a folder inside a workspace (plans there can end up in commits). */
  allowInside: boolean;
}

/**
 * checkTasksDir validates and creates a Tasks folder: an absolute local path,
 * not a drive root, not in or around the data folder, never containing a
 * workspace, inside one only when the owner confirms, and writable. It returns
 * the cleaned path or throws OwnerError ('INSIDE_WORKSPACE' may be confirmed).
 */
export async function checkTasksDir(
  raw: string,
  opts: CheckTasksDirOptions,
): Promise<string> {
  const dir = cleanInputPath(raw);
  if (!dir)
    throw new OwnerError(
      'INVALID_REQUEST',
      `Enter a full folder path on this computer, for example ${suggestedTasksDir(opts.homeDir)}.`,
    );
  if (isDriveRoot(dir))
    throw new OwnerError(
      'INVALID_REQUEST',
      'Choose a folder, not a whole drive.',
    );
  const real = await realPath(dir);
  const realK = pathKey(real);
  const dirK = pathKey(dir);
  for (const data of [pathKey(opts.dataDir), await realKey(opts.dataDir)]) {
    if (overlaps(realK, data) || overlaps(dirK, data))
      throw new OwnerError(
        'INVALID_REQUEST',
        'Choose a folder outside the Agent Ops data folder.',
      );
  }
  for (const p of opts.projects) {
    for (const c of [pathKey(p.path), await realKey(p.path)]) {
      if (c === realK || c === dirK)
        throw new OwnerError(
          'INVALID_REQUEST',
          `This folder is the workspace “${p.name}”. Choose a folder outside your workspaces.`,
        );
      if (pathWithin(c, realK) || pathWithin(c, dirK))
        throw new OwnerError(
          'CONTAINS_WORKSPACE',
          `This folder contains the workspace “${p.name}”, so its files would be read as plans. Use a new folder inside it instead.`,
        );
    }
  }
  if (!opts.allowInside) {
    const p = await insideWorkspace(dir, opts.projects);
    if (p) {
      throw new OwnerError(
        'INSIDE_WORKSPACE',
        `This folder is inside the workspace “${p.name}”, so plans could end up in its commits. Choose a folder outside your workspaces, or confirm to use it anyway.`,
      );
    }
  }
  let info;
  try {
    info = await fs.stat(dir);
  } catch (err) {
    if (!isMissing(err))
      throw new OwnerError(
        'INVALID_REQUEST',
        `Agent Ops cannot open this folder: ${errorText(err)}`,
      );
    try {
      await fs.mkdir(dir, { recursive: true });
    } catch (mkErr) {
      throw new OwnerError(
        'INVALID_REQUEST',
        `Agent Ops cannot create this folder: ${errorText(mkErr)}`,
      );
    }
  }
  if (info && !info.isDirectory())
    throw new OwnerError(
      'INVALID_REQUEST',
      'This path is a file. Choose a folder.',
    );
  try {
    await writableDir(dir);
  } catch (err) {
    throw new OwnerError(
      'INVALID_REQUEST',
      `Agent Ops cannot write to this folder: ${errorText(err)}`,
    );
  }
  return dir;
}

export async function writableDir(dir: string): Promise<void> {
  const probe = path.join(
    dir,
    `.agent-ops-check-${randomBytes(6).toString('hex')}.tmp`,
  );
  const handle = await fs.open(probe, 'wx');
  await handle.close();
  await fs.rm(probe, { force: true });
}

// ---------- pointers ----------

/**
 * UserEnvironment is the per-user environment (HKCU\Environment on Windows).
 * The Electron main process provides it; tests use a fake and never touch the
 * real environment.
 */
export interface UserEnvironment {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** broadcast tells running programs the environment changed (WM_SETTINGCHANGE). */
  broadcast(): void;
}

/** writeTasksEnv sets (or with '' removes) AGENT_OPS_TASKS; an unchanged value is not written or broadcast. */
export async function writeTasksEnv(
  env: UserEnvironment,
  value: string,
): Promise<void> {
  const current = await env.get(TASKS_ENV_NAME);
  if (
    (value === '' && current === undefined) ||
    (value !== '' && current === value)
  )
    return;
  if (value === '') await env.delete(TASKS_ENV_NAME);
  else await env.set(TASKS_ENV_NAME, value);
  env.broadcast();
}

export interface PointerOptions {
  dataDir: string;
  /** env is set only for the installed instance; dev, test and smoke instances never write it. */
  env?: UserEnvironment | undefined;
  io?: SafeIoOptions | undefined;
}

/**
 * syncTasksPointers makes tasks-dir.txt (one line, UTF-8, LF) and, when env is
 * given, AGENT_OPS_TASKS name dir; '' removes both. Unchanged pointers are not
 * rewritten. Every failure is collected; the rest still runs.
 */
export async function syncTasksPointers(
  dir: string,
  opts: PointerOptions,
): Promise<string[]> {
  const file = path.join(opts.dataDir, TASKS_POINTER_NAME);
  const problems: string[] = [];
  try {
    if (dir === '') {
      await fs.rm(file, { force: true });
    } else {
      let current = '';
      try {
        current = (await readFileRetry(file, opts.io)).toString('utf8');
      } catch {
        current = '';
      }
      if (current !== dir + '\n')
        await writeFileAtomic(file, dir + '\n', opts.io);
    }
  } catch (err) {
    problems.push(`${TASKS_POINTER_NAME}: ${errorText(err)}`);
  }
  if (opts.env) {
    try {
      await writeTasksEnv(opts.env, dir);
    } catch (err) {
      problems.push(`${TASKS_ENV_NAME}: ${errorText(err)}`);
    }
  }
  return problems;
}
