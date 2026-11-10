// Safe edits of AI tool files (the skill, instruction files). The owner and the
// AI tools edit these files too, so every change:
//   - starts from bytes read just before, and re-reads the file right before the
//     final rename or delete; if anything changed meanwhile, nothing is written;
//   - backs the previous file up first;
//   - replaces the file atomically (temp file in the same folder, then rename,
//     retried while another program holds the file);
//   - never edits a file that is itself a symbolic link or junction. Folders
//     above it may be links; the edit then goes through the same path.

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import { FileChangedError, FileLinkedError } from './errors.js';
import type { SkillsPlatform } from './platform.js';
import { bytesEqual } from './text.js';

export interface ClientFileHooks {
  /** Runs just before the final re-read of a write or delete; tests change the file here. */
  beforeReplace?: (file: string) => void | Promise<void>;
}

function codeOf(err: unknown): string {
  return typeof err === 'object' && err !== null
    ? String((err as { code?: unknown }).code)
    : '';
}

/** A symbolic link or junction at the file itself (not at a parent folder). */
export async function isLinkedFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isSymbolicLink();
  } catch {
    return false;
  }
}

export class ClientFiles {
  constructor(
    private readonly platform: SkillsPlatform,
    private readonly hooks: ClientFileHooks = {},
  ) {}

  /** The content, or null when the file does not exist. */
  async read(file: string): Promise<Buffer | null> {
    let info;
    try {
      info = await fs.lstat(file);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }
    if (info.isSymbolicLink()) {
      throw new FileLinkedError();
    }
    if (!info.isFile()) {
      throw new Error('this path is not a plain file');
    }
    try {
      return await this.platform.readFile(file);
    } catch (err) {
      if (codeOf(err) === 'ENOENT') {
        return null;
      }
      throw err;
    }
  }

  /**
   * Copies content into backupDir, keeping the file's path below base (or its
   * full path without the drive colon when it is not below base).
   */
  static async backup(
    file: string,
    base: string,
    backupDir: string,
    content: Uint8Array,
  ): Promise<string> {
    let rel = path.relative(base, file);
    if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
      rel = path.normalize(file).replace(/^\\\\/, '').replaceAll(':', '');
    }
    const target = path.join(backupDir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await fs.writeFile(target, content, { mode: 0o600, flag: 'wx' });
    return target;
  }

  private async unchanged(
    file: string,
    expected: Uint8Array | null,
  ): Promise<void> {
    const again = await this.read(file);
    if (!bytesEqual(again, expected === null ? null : Buffer.from(expected))) {
      throw new FileChangedError();
    }
  }

  /**
   * Replaces file with content (null deletes it) when the file still holds
   * expected (null: did not exist). The previous file is backed up first into
   * backupDir. Returns where it was backed up ('' when there was no file).
   */
  async write(
    file: string,
    expected: Uint8Array | null,
    content: Uint8Array | null,
    base: string,
    backupDir: string,
  ): Promise<string> {
    const current = await this.read(file);
    if (
      !bytesEqual(current, expected === null ? null : Buffer.from(expected))
    ) {
      throw new FileChangedError();
    }
    let saved = '';
    if (current !== null) {
      try {
        saved = await ClientFiles.backup(file, base, backupDir, current);
      } catch (err) {
        throw new Error(
          `the backup failed, nothing was written: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }
    }
    if (content === null) {
      if (current === null) {
        return '';
      }
      await this.hooks.beforeReplace?.(file);
      await this.unchanged(file, expected);
      await fs.unlink(file);
      return saved;
    }
    const dir = path.dirname(file);
    await fs.mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.agent-ops-${randomBytes(6).toString('hex')}.tmp`,
    );
    try {
      const handle = await fs.open(tmp, 'wx', 0o644);
      try {
        await handle.writeFile(content);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await this.hooks.beforeReplace?.(file);
      await this.unchanged(file, expected);
      await this.platform.replaceFile(tmp, file);
    } finally {
      await fs.rm(tmp, { force: true });
    }
    return saved;
  }
}
