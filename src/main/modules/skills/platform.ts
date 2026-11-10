// The operating-system services the Skills module needs, behind one interface so
// the module stays a plain Node library and tests can replace them. The default
// uses Node built-ins only: on Windows, fs.realpath.native resolves symbolic
// links and junctions (GetFinalPathNameByHandle), and a rename over a file
// another program holds fails with EBUSY or EPERM for a moment, so it retries.

import { promises as fs, realpath } from 'node:fs';
import { promisify } from 'node:util';

const realpathNative = promisify(realpath.native);

export interface SkillsPlatform {
  /** Every link and junction in an existing path resolved. Rejects when it does not exist. */
  finalPath(path: string): Promise<string>;
  /** Renames source over target, retrying while another program holds target. */
  replaceFile(source: string, target: string): Promise<void>;
  /** Reads a file, retrying while another program holds it. */
  readFile(path: string): Promise<Buffer>;
  /** Whether two existing paths name the same file or folder (by file identity). */
  sameFile(a: string, b: string): Promise<boolean>;
  /** Whether paths compare without case (true on Windows). */
  readonly caseInsensitive: boolean;
}

/** Error codes Windows reports while an editor, scanner or backup tool holds a file. */
const BUSY_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

export function isBusy(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    BUSY_CODES.has(String((err as { code?: unknown }).code))
  );
}

export async function retryBusy<T>(
  op: () => Promise<T>,
  retryForMs: number,
): Promise<T> {
  const deadline = Date.now() + retryForMs;
  let wait = 10;
  for (;;) {
    try {
      return await op();
    } catch (err) {
      if (!isBusy(err) || Date.now() >= deadline) {
        throw err;
      }
      await new Promise((resolve) => setTimeout(resolve, wait));
      wait = Math.min(wait * 2, 250);
    }
  }
}

export function nodePlatform(
  options: { retryForMs?: number } = {},
): SkillsPlatform {
  const retryForMs = options.retryForMs ?? 5000;
  return {
    caseInsensitive:
      process.platform === 'win32' || process.platform === 'darwin',
    async finalPath(path) {
      const resolved = await realpathNative(path);
      if (resolved.startsWith('\\\\?\\UNC\\')) {
        return `\\\\${resolved.slice(8)}`;
      }
      return resolved.startsWith('\\\\?\\') ? resolved.slice(4) : resolved;
    },
    async replaceFile(source, target) {
      await retryBusy(() => fs.rename(source, target), retryForMs);
    },
    async readFile(path) {
      return retryBusy(() => fs.readFile(path), retryForMs);
    },
    async sameFile(a, b) {
      try {
        const [sa, sb] = await Promise.all([
          fs.stat(a, { bigint: true }),
          fs.stat(b, { bigint: true }),
        ]);
        return sa.dev === sb.dev && sa.ino === sb.ino && sa.ino !== 0n;
      } catch {
        return false;
      }
    },
  };
}
