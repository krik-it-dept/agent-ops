// Run records: what agents reported about their own work, one append-only
// JSON Lines file per run under <dataDir>\runs\<runId>.jsonl. The report
// command is the only writer; the app reads the files and prunes old ones.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunEvent } from '../../../shared/contracts';
import { canonicalAgent } from '../plans/agents';

export const RUNS_DIR_NAME = 'runs';
export const RUN_EVENTS: readonly RunEvent[] = [
  'start',
  'progress',
  'done',
  'blocked',
  'stopped',
];
export const TERMINAL_EVENTS: readonly RunEvent[] = [
  'done',
  'blocked',
  'stopped',
];
export const MAX_RESULT_CHARS = 4000;
/** A run file stops taking reports at this size; the agent starts a new run. */
export const MAX_RUN_FILE_BYTES = 256 * 1024;
export const MAX_RUN_EVENTS = 500;
/** The reader skips longer lines. */
export const MAX_LINE_BYTES = 32 * 1024;
/** The reader reads at most this many run files, newest first. */
export const MAX_RUN_FILES = 2000;
export const RECORD_VERSION = 1;

export interface RunStep {
  line: number;
  text: string;
  milestone: string;
  index: number;
}
/** RunRecord is one line of a run file. */
export interface RunRecord {
  v: 1;
  runId: string;
  at: string;
  event: RunEvent;
  agent: string;
  coordinator: string;
  role: 'coordinator' | 'executor';
  /** The plan file as the collector names it (forward slashes). */
  file: string;
  /** The plan's revision when the event was reported. */
  revision: string;
  step: RunStep | null;
  result: string;
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function validRunId(id: string): boolean {
  return RUN_ID.test(id);
}
export const isTerminal = (event: RunEvent): boolean =>
  TERMINAL_EVENTS.includes(event);
export function runFile(runsDir: string, runId: string): string {
  if (!validRunId(runId)) throw new Error('Invalid run ID.');
  return path.join(runsDir, `${runId}.jsonl`);
}

/** Never follow a redirected runs folder when reading, writing or pruning. */
async function requireRunsDirectory(runsDir: string): Promise<void> {
  const info = await fs.lstat(runsDir);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error(
      'The agent reports folder must be a regular folder, not a link.',
    );
}

const isString = (v: unknown): v is string => typeof v === 'string';
const positive = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
function isStep(v: unknown): v is RunStep {
  if (!v || typeof v !== 'object') return false;
  const s = v as Record<string, unknown>;
  return (
    positive(s.line) &&
    s.line > 0 &&
    isString(s.text) &&
    isString(s.milestone) &&
    positive(s.index)
  );
}
export function isRunRecord(v: unknown): v is RunRecord {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    r.v === RECORD_VERSION &&
    isString(r.runId) &&
    validRunId(r.runId) &&
    isString(r.at) &&
    Number.isFinite(Date.parse(r.at)) &&
    RUN_EVENTS.includes(r.event as RunEvent) &&
    isString(r.agent) &&
    r.agent !== '' &&
    canonicalAgent(r.agent) === r.agent &&
    isString(r.coordinator) &&
    canonicalAgent(r.coordinator) === r.coordinator &&
    (r.role === 'coordinator' || r.role === 'executor') &&
    isString(r.file) &&
    r.file !== '' &&
    isString(r.revision) &&
    /^[a-f0-9]{64}$/.test(r.revision) &&
    (r.step === null || isStep(r.step)) &&
    isString(r.result) &&
    Array.from(r.result).length <= MAX_RESULT_CHARS &&
    !/\p{Cc}/u.test(r.result.replace(/[\t\r\n]/g, '')) &&
    (!isTerminal(r.event as RunEvent) || r.result.trim() !== '')
  );
}

export interface ReadRun {
  /** Valid records in file order, all of this run and consistent with its first record. */
  records: RunRecord[];
  /** Lines that could not be read or do not belong to the run. */
  skipped: number;
}

/** parseRun reads a run file's text; lines that are cut, invalid or inconsistent are skipped and counted. */
export function parseRun(runId: string, text: string): ReadRun {
  const records: RunRecord[] = [];
  let skipped = 0;
  for (const line of text.replace(/^\uFEFF/, '').split('\n')) {
    if (line.trim() === '') continue;
    let value: unknown;
    try {
      value =
        Buffer.byteLength(line) > MAX_LINE_BYTES ? undefined : JSON.parse(line);
    } catch {
      value = undefined;
    }
    const first = records[0];
    if (
      !isRunRecord(value) ||
      value.runId !== runId ||
      (first &&
        (value.agent !== first.agent ||
          value.coordinator !== first.coordinator ||
          value.role !== first.role ||
          (value.step &&
            (!first.step ||
              value.step.text !== first.step.text ||
              value.step.milestone !== first.step.milestone)) ||
          value.file.toLowerCase() !== first.file.toLowerCase() ||
          isTerminal(records[records.length - 1]!.event) ||
          value.event === 'start'))
    ) {
      skipped++;
      continue;
    }
    if (!first && value.event !== 'start') {
      skipped++;
      continue;
    }
    records.push(value);
  }
  return { records, skipped };
}

/** readRun reads one run file; a missing file is an empty run. */
export async function readRun(
  runsDir: string,
  runId: string,
): Promise<ReadRun & { bytes: number }> {
  let text: string;
  try {
    await requireRunsDirectory(runsDir);
    const info = await fs.lstat(runFile(runsDir, runId));
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('The agent report must be a regular file, not a link.');
    const handle = await fs.open(runFile(runsDir, runId), 'r');
    let bytes: Buffer;
    try {
      const limit = MAX_RUN_FILE_BYTES * 2;
      const info = await handle.stat();
      if (info.size > limit)
        return { records: [], skipped: 1, bytes: info.size };
      bytes = Buffer.alloc(limit + 1);
      let offset = 0;
      while (offset < bytes.length) {
        const { bytesRead } = await handle.read(
          bytes,
          offset,
          bytes.length - offset,
          null,
        );
        if (!bytesRead) break;
        offset += bytesRead;
      }
      bytes = bytes.subarray(0, offset);
    } finally {
      await handle.close();
    }
    if (bytes.length > MAX_RUN_FILE_BYTES * 2)
      return { records: [], skipped: 1, bytes: bytes.length };
    text = bytes.toString('utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT')
      return { records: [], skipped: 0, bytes: 0 };
    throw err;
  }
  return { ...parseRun(runId, text), bytes: Buffer.byteLength(text) };
}

/**
 * appendRecord writes one complete line under the caller's lock and flushes it. A file whose
 * last line was cut by a crash gets a newline first, so the cut line stays
 * one skipped line. The caller holds the run lock.
 */
export async function appendRecord(
  runsDir: string,
  record: RunRecord,
): Promise<void> {
  await fs.mkdir(runsDir, { recursive: true });
  await requireRunsDirectory(runsDir);
  const file = runFile(runsDir, record.runId);
  const line = JSON.stringify(record) + '\n';
  if (Buffer.byteLength(line) - 1 > MAX_LINE_BYTES)
    throw new Error(
      'The report is too large. Shorten the step text or report the whole plan.',
    );
  try {
    const info = await fs.lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
      throw new Error('The agent report must be a regular file without links.');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const handle = await fs.open(file, 'a+');
  try {
    const { size } = await handle.stat();
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    if (size + Buffer.byteLength(prefix + line) > MAX_RUN_FILE_BYTES)
      throw new Error('This run has too many reports. Start a new run.');
    await handle.writeFile(prefix + line);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const LOCK_STALE_MS = 30_000;
async function abandonedLock(
  lock: string,
  age: number,
  now: number,
): Promise<boolean> {
  const handle = await fs.open(lock, 'r');
  try {
    const info = await handle.stat();
    if (now - info.mtimeMs <= age) return false;
    const bytes = Buffer.alloc(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const pid = Number(bytes.subarray(0, bytesRead).toString('utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return true;
    try {
      process.kill(pid, 0);
      return false;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === 'ESRCH';
    }
  } finally {
    await handle.close();
  }
}

/** Serialize stale-lock removal so two reclaimers cannot unlink a new owner's lock. */
async function removeAbandonedLock(
  lock: string,
  age: number,
  now: number,
): Promise<boolean> {
  if (!(await abandonedLock(lock, age, now))) return false;
  const recovery = lock + '.recovery';
  let guard;
  try {
    guard = await fs.open(recovery, 'wx');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
  try {
    if (!(await abandonedLock(lock, age, now))) return false;
    await fs.rm(lock, { force: true });
    return true;
  } finally {
    await guard.close();
    await fs.rm(recovery, { force: true });
  }
  // A crash during recovery leaves this run unavailable until the marker is removed.
  // Keep it rather than risk unlinking a living reporter's lock; new runs still work.
}
/**
 * withRunLock runs work while holding <runId>.lock, created exclusively. A
 * lock left by a crashed reporter is taken over once it is older than 30
 * seconds and its process is gone; otherwise the wait ends after waitMs with an error.
 */
export async function withRunLock<T>(
  runsDir: string,
  runId: string,
  work: () => Promise<T>,
  waitMs = 3000,
): Promise<T> {
  await fs.mkdir(runsDir, { recursive: true });
  await requireRunsDirectory(runsDir);
  if (!validRunId(runId)) throw new Error('Invalid run ID.');
  const lock = path.join(runsDir, `${runId}.lock`);
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const handle = await fs.open(lock, 'wx');
      await handle.write(String(process.pid));
      await handle.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (await removeAbandonedLock(lock, LOCK_STALE_MS, Date.now())) {
          continue;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw error;
      }
      if (Date.now() >= deadline) throw new RunBusyError();
      await delay(40);
    }
  }
  try {
    return await work();
  } finally {
    await fs.rm(lock, { force: true });
  }
}
export class RunBusyError extends Error {
  constructor() {
    super('Another report for this run is being written. Try again.');
  }
}

export interface RunFile {
  runId: string;
  file: string;
  mtimeMs: number;
  size: number;
}
/** listRuns returns run files, newest first. A missing folder has none. */
export async function listRuns(runsDir: string): Promise<RunFile[]> {
  let names: string[];
  try {
    await requireRunsDirectory(runsDir);
    names = await fs.readdir(runsDir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return [];
    throw err;
  }
  const out: RunFile[] = [];
  for (const name of names) {
    const m = /^(.+)\.jsonl$/.exec(name);
    if (!m || !validRunId(m[1]!)) continue;
    const file = path.join(runsDir, name);
    try {
      const info = await fs.lstat(file);
      if (info.isFile())
        out.push({
          runId: m[1]!,
          file,
          mtimeMs: info.mtimeMs,
          size: info.size,
        });
    } catch {
      /* Removed while listing. */
    }
  }
  return out.sort(
    (a, b) => b.mtimeMs - a.mtimeMs || (a.runId < b.runId ? -1 : 1),
  );
}

export const PRUNE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
/**
 * pruneRuns removes runs that ended over 90 days ago and locks left behind by crashed reporters. It
 * returns the number of files removed. Runs still in progress are kept.
 */
export async function pruneRuns(runsDir: string, now: Date): Promise<number> {
  let removed = 0;
  const cutoff = now.getTime() - PRUNE_AFTER_MS;
  for (const run of await listRuns(runsDir)) {
    let remove: boolean;
    try {
      const { records } = await readRun(runsDir, run.runId);
      const last = records[records.length - 1];
      remove = !!last && isTerminal(last.event) && Date.parse(last.at) < cutoff;
    } catch {
      remove = false;
    }
    if (remove) {
      await fs.rm(run.file, { force: true });
      removed++;
    }
  }
  try {
    for (const name of await fs.readdir(runsDir)) {
      if (!name.endsWith('.lock') || !validRunId(name.slice(0, -5))) continue;
      const lock = path.join(runsDir, name);
      try {
        if (await removeAbandonedLock(lock, 60 * 60 * 1000, now.getTime())) {
          removed++;
        }
      } catch {
        /* Released meanwhile. */
      }
    }
  } catch {
    /* No runs folder. */
  }
  return removed;
}
