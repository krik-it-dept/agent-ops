import { lstat, open, readdir, stat } from 'node:fs/promises';
import { join, parse } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const MAX_PLAN_BYTES = 8 << 20;
export function slash(path: string): string {
  return path.replace(/\\/g, '/');
}
export function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EPERM') return 'EACCES';
  if (code === 'EBUSY' || code === 'ETXTBSY') return 'EBUSY';
  return code ?? 'EIO';
}
export function checkAbort(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

/** Stop waiting promptly even when a filesystem or injected runner cannot be cancelled. */
export async function abortable<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  if (signal.aborted) {
    // The caller may already have started an I/O promise before cancellation.
    void operation.catch(() => {});
    signal.throwIfAborted();
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    operation
      .then(resolve, reject)
      .finally(() => signal.removeEventListener('abort', onAbort));
  });
}
export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * longPath expands Windows 8.3 short names (C:\Users\RUNNER~1) to long names,
 * like the baseline's GetLongPathName: only a component that looks short is
 * replaced, by the entry of its folder with the same file identity, so links
 * and junctions keep the configured location (realpath would resolve them).
 * A path that cannot be resolved is returned as it is.
 */
export async function longPath(path: string): Promise<string> {
  if (process.platform !== 'win32' || !/~\d/.test(path)) return path;
  try {
    const { root } = parse(path);
    let current = root;
    for (const part of path.slice(root.length).split(/[\\/]+/)) {
      if (part === '') continue;
      current = join(
        current,
        /~\d/.test(part) ? await longName(current, part) : part,
      );
    }
    return current;
  } catch {
    return path;
  }
}

/** longName finds the entry of dir that is the same file as dir\name. */
async function longName(dir: string, name: string): Promise<string> {
  const target = await lstat(join(dir, name), { bigint: true });
  for (const entry of await readdir(dir)) {
    if (entry === name) return name;
    try {
      const info = await lstat(join(dir, entry), { bigint: true });
      if (info.ino === target.ino && info.dev === target.dev) return entry;
    } catch {
      // An entry that vanished cannot be the one we look for.
    }
  }
  return name;
}

/** Bounded reads and short retries for Windows sharing/lock violations. */
export async function readPlanFile(
  file: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal);
    try {
      const handle = await open(file, 'r');
      try {
        const bytes = Buffer.alloc(MAX_PLAN_BYTES + 1);
        let offset = 0;
        while (offset < bytes.length) {
          checkAbort(signal);
          const { bytesRead } = await handle.read(
            bytes,
            offset,
            bytes.length - offset,
            null,
          );
          if (!bytesRead) break;
          offset += bytesRead;
        }
        return bytes.subarray(0, offset);
      } finally {
        await handle.close();
      }
    } catch (error) {
      checkAbort(signal);
      if (attempt >= 7 || errorCode(error) !== 'EBUSY') throw error;
      await delay(
        25 << Math.min(attempt, 3),
        undefined,
        signal ? { signal } : {},
      );
    }
  }
}
