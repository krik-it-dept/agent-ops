// Mark as Done is the one plan edit Agent Ops makes, on the owner's action on
// the Board, a card menu or a plan page. It changes only the value of the
// plan's top Status line to Done (see plan-edit.ts). The file is resolved from
// the plan key like Archive and Delete, never from a path the window sends;
// its bytes must still be the revision the owner saw; the original is copied
// to <dataDir>\backups\plan-edits first; and the file is replaced atomically
// after a last check that it did not change. For two minutes the owner can
// undo it, which puts the original bytes back only while the file still holds
// exactly what Mark as Done wrote.

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { errorText, pathKey } from '../../lib/safe-io/paths';
import {
  isMissing,
  timestamp,
  writeFileAtomic,
  type SafeIoOptions,
} from '../../lib/safe-io/safe-io';
import type { SettingsStore } from '../settings/config-store';
import { OwnerError, fail, settle, type Result } from '../settings/result';
import { MAX_PLAN_BYTES } from './move';
import { planActionPath, type PlanRef } from './plan-actions';
import { findStatus, isDone, replaceStatus } from './plan-edit';

export const UNDO_FOR_MS = 2 * 60 * 1000;
export const KEEP_BACKUPS = 50;
export const PLAN_EDITS_DIR = path.join('backups', 'plan-edits');

const CHANGED = 'This plan changed. Look again before marking it Done.';
const UNDO_CHANGED =
  'This plan changed after it was marked Done, so Undo did not change it.';
const UNDO_GONE =
  'Undo is no longer available. It works for 2 minutes after marking a plan Done.';
const NO_STATUS =
  'This plan has no Status line at the top, so it was not changed. Add a Status line to the plan first.';
const VERB = 'marked Done';

export interface MarkDoneRequest {
  key: string;
  revision: string;
}
export interface UndoMarkDoneRequest {
  key: string;
  token: string;
}

export interface MarkDoneResult {
  key: string;
  /** False when the plan was already Done and nothing was written. */
  changed: boolean;
  status: string;
  /** The Status value before the change. */
  previous: string;
  /** SHA-256 hex of the file after the action. */
  revision: string;
  undo: { token: string; expiresAt: string } | null;
  /** The backup copy of the original file. */
  backup?: string;
}
export interface UndoMarkDoneResult {
  key: string;
  status: string;
  revision: string;
}

/** MarkedDone is what the caller records in the activity feed. */
export interface MarkedDone {
  key: string;
  plan: PlanRef;
  previous: string;
  at: Date;
}

export interface MarkDoneOptions {
  store: SettingsStore;
  /** lookup returns the plan on the board under key, or undefined. */
  lookup: (key: string) => PlanRef | undefined;
  now?: () => Date;
  /** record adds the activity entry; a failure does not undo the edit. */
  record?: (event: MarkedDone) => Promise<void> | void;
  /** changed runs after the plan file was written, so the caller can refresh the board. */
  changed?: () => void;
  io?: SafeIoOptions;
  undoForMs?: number;
  keepBackups?: number;
}

interface UndoEntry {
  key: string;
  file: string;
  written: string;
  original: Buffer;
  previous: string;
  expires: number;
}

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');

function unavailable(err: unknown): OwnerError {
  if (err instanceof OwnerError) return err;
  if (isMissing(err))
    return new OwnerError(
      'NOT_FOUND',
      'The plan file no longer exists. Refresh the list.',
    );
  return new OwnerError(
    'CONFLICT',
    `This plan could not be changed. The file may be locked or unavailable. ${errorText(err)}`,
  );
}

interface Read {
  bytes: Buffer;
  dev: bigint;
  ino: bigint;
  mtimeNs: bigint;
  size: bigint;
}

/** readPlan reads a plan file and its identity, refusing an oversized file as changed. */
async function readPlan(file: string, changed: string): Promise<Read> {
  let opened;
  try {
    opened = await fs.open(file, 'r');
  } catch (err) {
    throw unavailable(err);
  }
  try {
    const info = await opened.stat({ bigint: true });
    if (!info.isFile())
      throw new OwnerError(
        'CONFLICT',
        `Only a regular plan file can be ${VERB}.`,
      );
    if (info.size > BigInt(MAX_PLAN_BYTES))
      throw new OwnerError('REVISION_CHANGED', changed);
    const bytes = await opened.readFile();
    return {
      bytes,
      dev: info.dev,
      ino: info.ino,
      mtimeNs: info.mtimeNs,
      size: info.size,
    };
  } catch (err) {
    throw unavailable(err);
  } finally {
    await opened.close();
  }
}

/**
 * replaceChecked writes bytes over file atomically. Just before the rename it
 * checks the file is still the one read with the expected revision; like
 * Delete, a change in the moment between that check and the rename is accepted.
 */
async function replaceChecked(
  file: string,
  before: Read,
  expected: string,
  bytes: Uint8Array,
  changed: string,
  validate: () => Promise<void>,
  io?: SafeIoOptions,
): Promise<void> {
  const rename = io?.ops?.rename ?? ((a: string, b: string) => fs.rename(a, b));
  await validate();
  await writeFileAtomic(file, bytes, {
    ...io,
    ops: {
      ...io?.ops,
      rename: async (tmp, target) => {
        const now = await readPlan(target, changed);
        if (
          now.dev !== before.dev ||
          now.ino !== before.ino ||
          now.mtimeNs !== before.mtimeNs ||
          now.size !== before.size ||
          sha(now.bytes) !== expected
        )
          throw new OwnerError('REVISION_CHANGED', changed);
        await validate();
        await rename(tmp, target);
      },
    },
  });
}

export class MarkDone {
  private readonly undos = new Map<string, UndoEntry>();

  constructor(private readonly opts: MarkDoneOptions) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private prune(): void {
    const now = this.now().getTime();
    for (const [token, entry] of this.undos)
      if (entry.expires <= now) this.undos.delete(token);
  }

  /** Re-resolve authority at commit time, including removed plans and redirected folders. */
  private async validatePath(key: string, expected: string): Promise<void> {
    if (this.opts.store.readOnly)
      throw new OwnerError('READ_ONLY', this.opts.store.readOnly);
    const plan = this.opts.lookup(key);
    if (!plan)
      throw new OwnerError(
        'NOT_FOUND',
        'This plan is no longer available. Refresh the list.',
      );
    const current = await planActionPath(plan, this.opts.store.get(), VERB);
    if (pathKey(current) !== pathKey(expected))
      throw new OwnerError(
        'CONFLICT',
        'The plan location changed. Refresh the list.',
      );
  }

  /** markDone writes `Done` as the plan's Status value. */
  async markDone(req: MarkDoneRequest): Promise<Result<MarkDoneResult>> {
    if (this.opts.store.readOnly)
      return fail('READ_ONLY', this.opts.store.readOnly);
    const p = this.opts.lookup(req.key);
    if (!p)
      return fail(
        'NOT_FOUND',
        'This plan is no longer available. Refresh the list.',
      );
    if (typeof req.revision !== 'string' || req.revision === '')
      return fail('INVALID_REQUEST', 'This request is not valid.');
    const result = await settle(async () => {
      if (req.revision !== p.revision)
        throw new OwnerError('REVISION_CHANGED', CHANGED);
      let file: string;
      try {
        file = await planActionPath(p, this.opts.store.get(), VERB);
      } catch (err) {
        throw unavailable(err);
      }
      const read = await readPlan(file, CHANGED);
      if (sha(read.bytes) !== req.revision)
        throw new OwnerError('REVISION_CHANGED', CHANGED);
      const span = findStatus(read.bytes);
      if (!span) throw new OwnerError('CONFLICT', NO_STATUS);
      if (isDone(span.value))
        return {
          key: req.key,
          changed: false,
          status: span.value,
          previous: span.value,
          revision: req.revision,
          undo: null,
        };
      const next = replaceStatus(read.bytes, span, 'Done');
      const backup = await this.backup(p, read.bytes);
      try {
        await replaceChecked(
          file,
          read,
          req.revision,
          next,
          CHANGED,
          () => this.validatePath(req.key, file),
          this.opts.io,
        );
      } catch (err) {
        throw unavailable(err);
      }
      const revision = sha(next);
      for (const [token, entry] of this.undos)
        if (entry.key === req.key) this.undos.delete(token);
      this.prune();
      const token = randomBytes(16).toString('hex');
      const expires =
        this.now().getTime() + (this.opts.undoForMs ?? UNDO_FOR_MS);
      this.undos.set(token, {
        key: req.key,
        file,
        written: revision,
        original: read.bytes,
        previous: span.value,
        expires,
      });
      return {
        key: req.key,
        changed: true,
        status: 'Done',
        previous: span.value,
        revision,
        undo: { token, expiresAt: new Date(expires).toISOString() },
        backup,
      };
    });
    if (result.ok && result.value.changed) {
      try {
        await this.opts.record?.({
          key: req.key,
          plan: p,
          previous: result.value.previous,
          at: this.now(),
        });
      } catch {
        // The edit stands; the activity entry is best effort.
      }
      this.opts.changed?.();
    }
    return result;
  }

  /** undo puts the previous Status value back while the file still holds what markDone wrote. */
  async undo(req: UndoMarkDoneRequest): Promise<Result<UndoMarkDoneResult>> {
    if (this.opts.store.readOnly)
      return fail('READ_ONLY', this.opts.store.readOnly);
    this.prune();
    const entry = this.undos.get(req.token);
    if (!entry || entry.key !== req.key) return fail('CONFLICT', UNDO_GONE);
    const result = await settle(async () => {
      await this.validatePath(req.key, entry.file);
      const read = await readPlan(entry.file, UNDO_CHANGED);
      if (sha(read.bytes) !== entry.written)
        throw new OwnerError('REVISION_CHANGED', UNDO_CHANGED);
      try {
        await replaceChecked(
          entry.file,
          read,
          entry.written,
          entry.original,
          UNDO_CHANGED,
          async () => {
            await this.validatePath(req.key, entry.file);
            if (
              entry.expires <= this.now().getTime() ||
              this.undos.get(req.token) !== entry
            )
              throw new OwnerError('CONFLICT', UNDO_GONE);
          },
          this.opts.io,
        );
      } catch (err) {
        throw unavailable(err);
      }
      this.undos.delete(req.token);
      return {
        key: req.key,
        status: entry.previous,
        revision: sha(entry.original),
      };
    });
    if (result.ok) this.opts.changed?.();
    return result;
  }

  /** backup copies the original file and keeps the newest backups only. */
  private async backup(p: PlanRef, bytes: Uint8Array): Promise<string> {
    const root = path.join(this.opts.store.dataDir, PLAN_EDITS_DIR);
    const now = this.now();
    // The milliseconds keep backups made within one second in order.
    const folder = `${timestamp(now)}-${String(now.getUTCMilliseconds()).padStart(3, '0')}${randomBytes(4).toString('hex')}`;
    const workspace =
      [...p.repo]
        .map((c) => (c < ' ' || '\\/:*?"<>|'.includes(c) ? '_' : c))
        .join('')
        .replace(/^\.+/, '_') || '_';
    const file = path.join(root, folder, workspace, p.name + '.md');
    try {
      await writeFileAtomic(file, bytes, this.opts.io);
    } catch (err) {
      throw new OwnerError(
        'IO_ERROR',
        `The plan was not changed because its backup could not be saved. ${errorText(err)}`,
      );
    }
    await pruneBackups(root, this.opts.keepBackups ?? KEEP_BACKUPS);
    return file;
  }
}

/** pruneBackups removes the oldest backup folders beyond keep; other entries are left alone. */
export async function pruneBackups(root: string, keep: number): Promise<void> {
  let names: string[];
  try {
    names = (await fs.readdir(root, { withFileTypes: true }))
      .filter(
        (d) => d.isDirectory() && /^\d{8}-\d{6}-\d{3}[a-f0-9]{8}$/.test(d.name),
      )
      .map((d) => d.name)
      .sort();
  } catch {
    return;
  }
  for (const name of names.slice(0, Math.max(0, names.length - keep)))
    await fs
      .rm(path.join(root, name), { recursive: true, force: true })
      .catch(() => undefined);
}
