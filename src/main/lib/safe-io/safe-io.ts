// safe-io writes the app's settings and stores so that a reader always sees
// either the old or the new file, never a partial one, and survives the short
// sharing violations Windows reports while an editor, backup tool or antivirus
// scanner holds a file. A file that was read but cannot be parsed is renamed
// aside with a warning, never silently replaced.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import path from 'node:path';

const isWindows = process.platform === 'win32';

/** FsOps are the file operations safe-io performs; tests replace them to inject faults. */
export interface FsOps {
  rename(source: string, target: string): Promise<void>;
  readFile(file: string): Promise<Buffer>;
  /** writeAll writes data to an open temporary file. */
  writeAll(handle: FileHandle, data: Uint8Array): Promise<void>;
}

export const nodeFsOps: FsOps = {
  rename: (source, target) => fs.rename(source, target),
  readFile: (file) => fs.readFile(file),
  writeAll: async (handle, data) => {
    await handle.writeFile(data);
  },
};

export interface SafeIoOptions {
  /** How long a read or write waits for a file another program holds. Default 5 s. */
  retryForMs?: number;
  ops?: Partial<FsOps>;
}

export const DEFAULT_RETRY_MS = 5000;

function opsOf(opts?: SafeIoOptions): FsOps {
  return { ...nodeFsOps, ...opts?.ops };
}

/** errnoCode returns the Node error code of err, or ''. */
export function errnoCode(err: unknown): string {
  return err &&
    typeof err === 'object' &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string'
    ? (err as { code: string }).code
    : '';
}

export function isMissing(err: unknown): boolean {
  return errnoCode(err) === 'ENOENT';
}

/**
 * isBusy reports an error caused by another program holding the file. On
 * Windows a sharing or lock violation is EBUSY, and access denied while a
 * delete or replace is pending is EPERM or EACCES.
 */
export function isBusy(err: unknown): boolean {
  const code = errnoCode(err);
  if (code === 'EBUSY') return true;
  return isWindows && (code === 'EPERM' || code === 'EACCES');
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** retry runs op until it succeeds, fails for a reason other than a held file, or retryForMs passes. */
export async function retry<T>(
  op: () => Promise<T>,
  retryForMs = DEFAULT_RETRY_MS,
): Promise<T> {
  const deadline = Date.now() + retryForMs;
  let wait = 10;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      if (!isBusy(err) || Date.now() > deadline) throw err;
      await sleep(wait);
      if (wait < 250) wait *= 2;
    }
  }
}

/**
 * writeFileAtomic replaces file with data: it writes a temporary file in the
 * same folder, flushes it to disk, then renames it over file, retrying while
 * the target is held. The folder is created when missing. On any failure the
 * old file stays intact and no temporary file is left.
 */
export async function writeFileAtomic(
  file: string,
  data: string | Uint8Array,
  opts?: SafeIoOptions,
): Promise<void> {
  const ops = opsOf(opts);
  const dir = path.dirname(file);
  await fs.mkdir(dir, { recursive: true });
  const tmp = path.join(
    dir,
    `.${path.basename(file)}.${randomBytes(6).toString('hex')}.tmp`,
  );
  const bytes = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  try {
    const handle = await fs.open(tmp, 'wx', 0o644);
    try {
      await ops.writeAll(handle, bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await retry(() => ops.rename(tmp, file), opts?.retryForMs);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** replaceFile renames source over target, retrying while target is held. */
export async function replaceFile(
  source: string,
  target: string,
  opts?: SafeIoOptions,
): Promise<void> {
  const ops = opsOf(opts);
  await retry(() => ops.rename(source, target), opts?.retryForMs);
}

/** readFileRetry reads file, retrying while another program holds it. A missing file fails at once (ENOENT). */
export async function readFileRetry(
  file: string,
  opts?: SafeIoOptions,
): Promise<Buffer> {
  const ops = opsOf(opts);
  return retry(() => ops.readFile(file), opts?.retryForMs);
}

/**
 * readTail reads at most limit bytes from the end of file, dropping the first
 * line when it was cut. A missing file returns null.
 */
export async function readTail(
  file: string,
  limit: number,
  opts?: SafeIoOptions,
): Promise<Buffer | null> {
  try {
    return await retry(async () => {
      const handle = await fs.open(file, 'r');
      try {
        const { size } = await handle.stat();
        const offset = size > limit ? size - limit : 0;
        const length = size - offset;
        const buf = Buffer.alloc(length);
        let read = 0;
        while (read < length) {
          const { bytesRead } = await handle.read(
            buf,
            read,
            length - read,
            offset + read,
          );
          if (bytesRead === 0) break;
          read += bytesRead;
        }
        let out = buf.subarray(0, read);
        if (offset > 0) {
          const nl = out.indexOf(0x0a);
          out = nl >= 0 ? out.subarray(nl + 1) : Buffer.alloc(0);
        }
        return out;
      } finally {
        await handle.close();
      }
    }, opts?.retryForMs);
  } catch (err) {
    if (isMissing(err)) return null;
    throw err;
  }
}

/** timestamp formats a time as YYYYMMDD-HHMMSS in UTC, the suffix of a file kept aside. */
export function timestamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}-${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}`;
}

/**
 * moveAside renames file to <file>.corrupt-<time> (or with a counter when that
 * name is taken) and returns the new name. It never overwrites.
 */
export async function moveAside(
  file: string,
  now: Date,
  opts?: SafeIoOptions,
): Promise<string> {
  const base = `${file}.corrupt-${timestamp(now)}`;
  for (let i = 0; i < 100; i++) {
    const aside = i === 0 ? base : `${base}-${i}`;
    try {
      await fs.lstat(aside);
      continue;
    } catch (err) {
      if (!isMissing(err)) throw err;
    }
    await replaceFile(file, aside, opts);
    return aside;
  }
  throw new Error(`no free name to keep ${file} aside`);
}

/** JsonRead is the outcome of a tolerant JSON read. */
export type JsonRead<T> =
  | { status: 'ok'; value: T }
  | { status: 'missing' }
  /** The file was read but is not valid; it was moved to aside (or could not be moved, then aside is ''). */
  | { status: 'corrupt'; aside: string; reason: string; warning: string }
  /** The file could not be read (locked, access denied, a folder); it is left untouched. */
  | { status: 'unreadable'; reason: string };

export interface JsonReadOptions<T> extends SafeIoOptions {
  now?: Date;
  /** validate turns parsed JSON into a value, or throws an Error whose message says why it is invalid. */
  validate?: (value: unknown) => T;
  /** label names the file in warnings, for example "The activity snapshot". */
  label?: string;
}

/**
 * readJsonTolerant reads a JSON file. A partial or corrupt file is renamed
 * aside and reported with a warning; a read failure leaves the file alone.
 */
export async function readJsonTolerant<T = unknown>(
  file: string,
  opts: JsonReadOptions<T> = {},
): Promise<JsonRead<T>> {
  let bytes: Buffer;
  try {
    bytes = await readFileRetry(file, opts);
  } catch (err) {
    if (isMissing(err)) return { status: 'missing' };
    return { status: 'unreadable', reason: errnoCode(err) || String(err) };
  }
  let value: T;
  try {
    const parsed: unknown = JSON.parse(stripBom(bytes.toString('utf8')));
    value = opts.validate ? opts.validate(parsed) : (parsed as T);
  } catch (err) {
    const reason =
      err instanceof SyntaxError
        ? `invalid JSON: ${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    const label = opts.label ?? `The file ${path.basename(file)}`;
    try {
      const aside = await moveAside(file, opts.now ?? new Date(), opts);
      return {
        status: 'corrupt',
        aside,
        reason,
        warning: `${label} was unreadable (${reason}). It was kept as ${aside}.`,
      };
    } catch (moveErr) {
      return {
        status: 'corrupt',
        aside: '',
        reason,
        warning: `${label} is unreadable (${reason}) and could not be moved aside: ${errnoCode(moveErr) || String(moveErr)}`,
      };
    }
  }
  return { status: 'ok', value };
}

export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

export interface AppendOptions extends SafeIoOptions {
  /** maxBytes bounds the file: once it grows past this, it is rewritten with compact(). */
  maxBytes: number;
  /** compact returns the lines to keep when the file is too large. */
  compact: () => string[];
}

/**
 * appendLines appends lines in one write, so a crash cuts at most the last
 * line, and compacts the file atomically once it grows past maxBytes. It
 * returns whether the file was compacted.
 */
export async function appendLines(
  file: string,
  lines: string[],
  opts: AppendOptions,
): Promise<boolean> {
  if (lines.length === 0) return false;
  await fs.mkdir(path.dirname(file), { recursive: true });
  const text = lines.map((l) => l + '\n').join('');
  const size = await retry(async () => {
    const handle = await fs.open(file, 'a', 0o644);
    try {
      await handle.write(text);
      return (await handle.stat()).size;
    } finally {
      await handle.close();
    }
  }, opts.retryForMs);
  if (size <= opts.maxBytes) return false;
  await writeFileAtomic(
    file,
    opts
      .compact()
      .map((l) => l + '\n')
      .join(''),
    opts,
  );
  return true;
}

/**
 * readJsonLines reads the last maxBytes of a JSON-lines file. A line cut by a
 * crash mid-append, or one accept rejects, is skipped.
 */
export async function readJsonLines<T>(
  file: string,
  maxBytes: number,
  accept: (value: unknown) => value is T,
  opts?: SafeIoOptions,
): Promise<T[]> {
  const bytes = await readTail(file, maxBytes, opts);
  if (!bytes) return [];
  const out: T[] = [];
  for (const line of stripBom(bytes.toString('utf8')).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const value: unknown = JSON.parse(line);
      if (accept(value)) out.push(value);
    } catch {
      // A partial line is skipped.
    }
  }
  return out;
}

/** Mutex runs async sections one at a time, in call order. */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;

  /** locked reports a section running or waiting. */
  get locked(): boolean {
    return this.pending > 0;
  }

  run<T>(section: () => Promise<T>): Promise<T> {
    this.pending++;
    const result = this.tail.then(section).finally(() => {
      this.pending--;
    });
    this.tail = result.catch(() => undefined);
    return result;
  }
}
