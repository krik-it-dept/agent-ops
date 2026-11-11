// Run records: what agents reported about their own work, one append-only
// JSON Lines file per run under <dataDir>\runs\<runId>.jsonl. The report
// command is the only writer; the app reads the files and prunes old ones.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { RunEvent } from '../../../shared/contracts';

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
  return path.join(runsDir, `${runId}.jsonl`);
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
    r.agent.length <= 40 &&
    isString(r.coordinator) &&
    r.coordinator.length <= 40 &&
    (r.role === 'coordinator' || r.role === 'executor') &&
    isString(r.file) &&
    r.file !== '' &&
    isString(r.revision) &&
    (r.step === null || isStep(r.step)) &&
    isString(r.result) &&
    r.result.length <= MAX_RESULT_CHARS * 2
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
    const bytes = await fs.readFile(runFile(runsDir, runId));
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
 * appendRecord adds one line in a single write and flushes it. A file whose
 * last line was cut by a crash gets a newline first, so the cut line stays
 * one skipped line. The caller holds the run lock.
 */
export async function appendRecord(
  runsDir: string,
  record: RunRecord,
): Promise<void> {
  await fs.mkdir(runsDir, { recursive: true });
  const file = runFile(runsDir, record.runId);
  const handle = await fs.open(file, 'a+');
  try {
    const { size } = await handle.stat();
    let prefix = '';
    if (size > 0) {
      const last = Buffer.alloc(1);
      await handle.read(last, 0, 1, size - 1);
      if (last[0] !== 0x0a) prefix = '\n';
    }
    await handle.write(prefix + JSON.stringify(record) + '\n');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export const LOCK_STALE_MS = 30_000;
/**
 * withRunLock runs work while holding <runId>.lock, created exclusively. A
 * lock left by a crashed reporter is taken over once it is older than 30
 * seconds; otherwise the wait ends after waitMs with an error.
 */
export async function withRunLock<T>(
  runsDir: string,
  runId: string,
  work: () => Promise<T>,
  waitMs = 3000,
): Promise<T> {
  await fs.mkdir(runsDir, { recursive: true });
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
        const info = await fs.stat(lock);
        if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
          await fs.rm(lock, { force: true });
          continue;
        }
      } catch {
        continue;
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
      const info = await fs.stat(file);
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
 * pruneRuns removes runs that ended over 90 days ago, unreadable run files
 * untouched for as long, and locks left behind by crashed reporters. It
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
      remove = last
        ? isTerminal(last.event) && Date.parse(last.at) < cutoff
        : run.mtimeMs < cutoff;
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
      if (!name.endsWith('.lock')) continue;
      const lock = path.join(runsDir, name);
      try {
        if (now.getTime() - (await fs.stat(lock)).mtimeMs > 60 * 60 * 1000) {
          await fs.rm(lock, { force: true });
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
