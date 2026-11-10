import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname } from 'node:path';

export interface LogStorage {
  mkdir(path: string): void;
  size(path: string): number;
  append(path: string, data: string): void;
  move(from: string, to: string): void;
  remove(path: string): void;
  read(path: string, maxBytes: number): string | null;
  writeAtomic(path: string, data: string): void;
}
export const nodeLogStorage: LogStorage = {
  mkdir(path) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  },
  size(path) {
    try {
      return statSync(path).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  },
  append(path, data) {
    appendFileSync(path, data, { encoding: 'utf8', mode: 0o600 });
  },
  move(from, to) {
    if (existsSync(from)) renameSync(from, to);
  },
  remove(path) {
    try {
      unlinkSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  },
  read(path, maxBytes) {
    try {
      if (statSync(path).size > maxBytes) return null;
      const handle = openSync(path, 'r');
      try {
        const bytes = Buffer.alloc(maxBytes + 1);
        let offset = 0;
        while (offset < bytes.length) {
          const read = readSync(
            handle,
            bytes,
            offset,
            bytes.length - offset,
            null,
          );
          if (!read) break;
          offset += read;
        }
        return offset > maxBytes
          ? null
          : bytes.subarray(0, offset).toString('utf8');
      } finally {
        closeSync(handle);
      }
    } catch {
      return null;
    }
  },
  writeAtomic(path, data) {
    const temp = `${path}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const handle = openSync(temp, 'wx', 0o600);
    let closed = false;
    try {
      writeFileSync(handle, data, 'utf8');
      fsyncSync(handle);
      closeSync(handle);
      closed = true;
      renameSync(temp, path);
    } finally {
      if (!closed) {
        try {
          closeSync(handle);
        } catch {
          /* Preserve the original storage error. */
        }
      }
      try {
        unlinkSync(temp);
      } catch {
        /* Best-effort cleanup must not hide an atomic replacement failure. */
      }
    }
  },
};
