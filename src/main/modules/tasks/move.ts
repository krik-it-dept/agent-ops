// Moving plan files on the owner's action: legacy .tasks plans into the Tasks
// folder, or every plan of the previous Tasks folder into the new one. Each
// file is backed up first, the target is created exclusively, the source is
// re-checked before removal, and the result is reported per file.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errorText } from '../../lib/safe-io/paths';
import { isBusy, retry, timestamp } from '../../lib/safe-io/safe-io';

/** MAX_PLAN_BYTES matches the plan reader: a larger file is not a plan. */
export const MAX_PLAN_BYTES = 8 << 20;

/** PlanMove is one file of a move. key is the legacy key for a legacy move, tasks/<workspace>/<plan> otherwise. */
export interface PlanMove {
  key: string;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}

export interface MoveReport {
  results: PlanMove[];
  moved: number;
  failed: number;
  backup: string;
}

export function emptyReport(backup = ''): MoveReport {
  return { results: [], moved: 0, failed: 0, backup };
}

export function addResult(
  report: MoveReport,
  m: Omit<PlanMove, 'ok' | 'error'>,
  error?: string,
): void {
  if (error !== undefined) {
    report.results.push({ ...m, ok: false, error });
    report.failed++;
  } else {
    report.results.push({ ...m, ok: true });
    report.moved++;
  }
}

/** newMoveBackup creates a fresh backup folder for one move: <dataDir>\backups\<kind>-<time>-<random>. */
export async function newMoveBackup(
  dataDir: string,
  kind: string,
  now: Date,
): Promise<string> {
  const root = path.join(dataDir, 'backups');
  await fs.mkdir(root, { recursive: true });
  return fs.mkdtemp(path.join(root, `${kind}-${timestamp(now)}-`));
}

/** listPlans returns the plan file names of a plan folder (*.md except tong-hop.md); a missing folder has none. */
export async function listPlans(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  return names.filter((n) => n.endsWith('.md') && n !== 'tong-hop.md').sort();
}

/** tasksWorkspaces lists the workspace folders of a Tasks folder, skipping dot folders. */
export async function tasksWorkspaces(dir: string): Promise<string[]> {
  const info = await fs.stat(dir);
  if (!info.isDirectory())
    throw Object.assign(new Error('not a folder'), { code: 'ENOTDIR' });
  const out: string[] = [];
  for (const name of (await fs.readdir(dir)).sort()) {
    if (name.startsWith('.')) continue;
    try {
      if ((await fs.stat(path.join(dir, name))).isDirectory()) out.push(name);
    } catch {
      // A folder that vanished or cannot be opened holds no plan we can move.
    }
  }
  return out;
}

/** tasksPlanFiles lists <dir>\<workspace>\<plan>.md. */
export async function tasksPlanFiles(dir: string): Promise<string[]> {
  const files: string[] = [];
  for (const ws of await tasksWorkspaces(dir)) {
    let names: string[];
    try {
      names = await listPlans(path.join(dir, ws));
    } catch {
      names = [];
    }
    for (const name of names) files.push(path.join(dir, ws, name));
  }
  return files;
}

export async function countTasksPlans(dir: string): Promise<number> {
  if (dir === '') return 0;
  try {
    return (await tasksPlanFiles(dir)).length;
  } catch {
    return 0;
  }
}

/** MoveHooks let tests change a source between the copy and the check. */
export interface MoveHooks {
  afterPlanCopy?: (src: string) => void | Promise<void>;
  retryForMs?: number;
}

/**
 * movePlanFile moves one plan: src is read once, a copy is kept at backup,
 * the target is created exclusively (an existing file is never replaced), and
 * src is removed only while it still holds the bytes that were copied. Any
 * failure leaves src in place and no target behind. It returns an error
 * sentence, or undefined on success.
 */
export async function movePlanFile(
  src: string,
  dst: string,
  backup: string,
  hooks: MoveHooks = {},
): Promise<string | undefined> {
  let info;
  try {
    info = await fs.lstat(src);
  } catch (err) {
    return `The plan cannot be read (${errorText(err)}).`;
  }
  if (!info.isFile())
    return 'This is not a plain file (a link?); move it by hand.';
  if (info.size > MAX_PLAN_BYTES) return 'The plan is too large to move.';
  let data: Buffer;
  try {
    data = await retry(() => fs.readFile(src), hooks.retryForMs);
  } catch (err) {
    return `The plan cannot be read (${errorText(err)}).`;
  }
  try {
    await fs.mkdir(path.dirname(backup), { recursive: true });
    await fs.writeFile(backup, data, { flag: 'wx' });
  } catch (err) {
    return `The backup could not be written (${errorText(err)}).`;
  }
  try {
    await fs.mkdir(path.dirname(dst), { recursive: true });
  } catch (err) {
    return `The folder ${path.dirname(dst)} could not be created (${errorText(err)}).`;
  }
  let handle;
  try {
    handle = await fs.open(dst, 'wx', 0o644);
  } catch (err) {
    if ((err as { code?: string }).code === 'EEXIST') {
      return `A plan named ${path.basename(dst)} is already in ${path.dirname(dst)}. Rename or remove one of them first.`;
    }
    return `The plan could not be written to ${path.dirname(dst)} (${errorText(err)}).`;
  }
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (err) {
    await handle.close().catch(() => undefined);
    await fs.rm(dst, { force: true });
    return `The plan could not be written to ${path.dirname(dst)} (${errorText(err)}).`;
  }
  await handle.close();
  await fs.utimes(dst, info.atime, info.mtime).catch(() => undefined);
  await hooks.afterPlanCopy?.(src);
  let now: Buffer | undefined;
  try {
    now = await retry(() => fs.readFile(src), hooks.retryForMs);
  } catch {
    now = undefined;
  }
  if (!now || !now.equals(data)) {
    await fs.rm(dst, { force: true });
    return 'The plan changed while it was moved. Try again.';
  }
  try {
    await retry(() => fs.unlink(src), hooks.retryForMs);
  } catch (err) {
    await fs.rm(dst, { force: true });
    return `The original could not be removed (${isBusy(err) ? 'it is open in another program' : errorText(err)}), so it was not moved.`;
  }
  return undefined;
}
