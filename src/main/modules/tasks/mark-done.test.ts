import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  symlinkSync,
  writeFileSync,
  promises as fs,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { put, tempDir } from '../../lib/safe-io/test-helpers';
import { SettingsStore } from '../settings/config-store';
import type { Result } from '../settings/result';
import { parseMarkdown } from '../plans/parse';
import {
  MarkDone,
  PLAN_EDITS_DIR,
  pruneBackups,
  type MarkedDone,
} from './mark-done';
import { planKey, type PlanRef } from './plan-actions';
import { findStatus, isDone, replaceStatus } from './plan-edit';
import { MAX_PLAN_BYTES } from './move';

const sha = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
const code = <T>(r: Result<T>) => (r.ok ? 'ok' : r.error.code);
const message = <T>(r: Result<T>) => (r.ok ? '' : r.error.message);

/** markText marks the bytes Done with the pure functions, or returns null. */
function markText(text: string | Buffer): Buffer | null {
  const bytes = typeof text === 'string' ? Buffer.from(text) : text;
  const span = findStatus(bytes);
  return span ? replaceStatus(bytes, span, 'Done') : null;
}

describe('Status line replacement', () => {
  it('changes only the value on LF, CRLF and BOM files', () => {
    expect(
      markText(
        '# Plan\nOwner: Lan\nStatus: Implementing\nGoal: x\n',
      )!.toString(),
    ).toBe('# Plan\nOwner: Lan\nStatus: Done\nGoal: x\n');
    expect(
      markText('Next: a  \r\nStatus: Testing\r\nGoal: b\t\r\n')!.toString(),
    ).toBe('Next: a  \r\nStatus: Done\r\nGoal: b\t\r\n');
    const bom = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('Status: Planning\r\n## M1: A\r\n- [todo] x\r\n'),
    ]);
    const out = markText(bom)!;
    expect(out.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(out.subarray(3).toString()).toBe(
      'Status: Done\r\n## M1: A\r\n- [todo] x\r\n',
    );
  });

  it('keeps Vietnamese text, detail spacing and the line around the value', () => {
    const text =
      'Mục tiêu: Tìm đúng việc\nStatus:   Waiting for owner - Chờ duyệt nội dung   \nTiếp theo: kiểm tra\n';
    expect(markText(text)!.toString()).toBe(
      'Mục tiêu: Tìm đúng việc\nStatus:   Done   \nTiếp theo: kiểm tra\n',
    );
    expect(markText('  status:Implementing\n')!.toString()).toBe(
      '  status:Done\n',
    );
    expect(markText('Status:\nGoal: x\n')!.toString()).toBe(
      'Status: Done\nGoal: x\n',
    );
    expect(markText('Trạng thái: Đang làm\nGoal: x\n')).toBeNull();
    // Only the English header is writable.
    expect(
      markText('Trạng thái: Đang làm\nStatus: Testing\n')!.toString(),
    ).toBe('Trạng thái: Đang làm\nStatus: Done\n');
  });

  it('uses the first header Status line only, as the reader does', () => {
    const text =
      '# Title\nStatus: Reviewing\nStatus: Testing\n## M1: A\nStatus: Blocked\n';
    expect(markText(text)!.toString()).toBe(
      '# Title\nStatus: Done\nStatus: Testing\n## M1: A\nStatus: Blocked\n',
    );
    expect(parseMarkdown(markText(text)!).label).toBe('Done');
  });

  it('finds no Status line inside a milestone, after a heading or in fenced code', () => {
    expect(markText('Goal: x\n## M1: A\nStatus: Implementing\n')).toBeNull();
    expect(markText('Goal: x\n## Notes\nStatus: Implementing\n')).toBeNull();
    expect(markText('```\nStatus: Implementing\n```\nGoal: x\n')).toBeNull();
    expect(markText('Goal: only\n')).toBeNull();
    expect(markText('')).toBeNull();
  });

  it('keeps invalid UTF-8 bytes elsewhere in the file', () => {
    const bytes = Buffer.concat([
      Buffer.from('Status: Testing\nNote: '),
      Buffer.from([0xff, 0xfe, 0xc3]),
      Buffer.from('\n'),
    ]);
    const out = markText(bytes)!;
    expect(out).toEqual(
      Buffer.concat([
        Buffer.from('Status: Done\nNote: '),
        Buffer.from([0xff, 0xfe, 0xc3]),
        Buffer.from('\n'),
      ]),
    );
  });

  it('reads Done with or without detail as already Done', () => {
    expect(isDone('Done')).toBe(true);
    expect(isDone('done')).toBe(true);
    expect(isDone('Done - shipped v1')).toBe(true);
    expect(isDone('Doneish')).toBe(false);
    expect(isDone('Implementing - almost done')).toBe(false);
  });

  it('requires an English Status header and preserves Unicode whitespace', () => {
    expect(markText('Trạng thái: Testing\n')).toBeNull();
    expect(markText('Status:\u00a0Testing\u2003\n')!.toString()).toBe(
      'Status:\u00a0Done\u2003\n',
    );
  });

  it('preserves mixed endings and a missing final newline', () => {
    expect(
      markText(
        '\ufeffGoal: Việt Nam  \r\nStatus:\tTesting \nNext: x\r\nTail',
      )!.toString(),
    ).toBe('\ufeffGoal: Việt Nam  \r\nStatus:\tDone \nNext: x\r\nTail');
    expect(markText('Status: Testing')!.toString()).toBe('Status: Done');
  });
});

interface Fixture {
  dir: string;
  data: string;
  store: SettingsStore;
  plan: PlanRef;
  file: string;
  board: Map<string, PlanRef>;
  marker: MarkDone;
  recorded: MarkedDone[];
  changed: () => number;
  clock: { now: number };
}

async function tasksFixture(
  text:
    | string
    | Buffer = 'Owner: Lan\r\nStatus: Testing - Kiểm tra lần cuối\r\nGoal: Phát hành\r\n',
): Promise<Fixture> {
  const dir = tempDir();
  const tasks = path.join(dir, 'Công việc');
  const file = put(path.join(tasks, 'web', 'release-go-live.md'), text);
  const data = path.join(dir, 'data');
  const store = new SettingsStore({ dataDir: data });
  await store.load();
  await store.mutate((c) => {
    c.tasksDir = tasks;
  });
  const plan: PlanRef = {
    project: 'tasks',
    repo: 'web',
    name: 'release-go-live',
    status: 'Testing',
    revision: sha(readFileSync(file)),
    file: file.replace(/\\/g, '/'),
    source: 'tasks',
  };
  return withMarker(dir, data, store, plan, file);
}

async function legacyFixture(): Promise<Fixture> {
  const dir = tempDir();
  const root = path.join(dir, 'workspace');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  const file = put(
    path.join(root, '.tasks', 'delivery.md'),
    'Owner: Lan\nStatus: Implementing\n- [doing] Build\n',
  );
  const data = path.join(dir, 'data');
  const store = new SettingsStore({ dataDir: data });
  await store.load();
  await store.mutate((c) => {
    c.projects.push({
      id: 'aa11aa11',
      name: 'Workspace',
      path: root,
      kind: 'repo',
      enabled: true,
      addedAt: '2026-11-10T00:00:00Z',
    });
  });
  const plan: PlanRef = {
    project: 'aa11aa11',
    repo: 'workspace',
    name: 'delivery',
    status: 'Implementing',
    revision: sha(readFileSync(file)),
    root,
    file: file.replace(/\\/g, '/'),
    source: 'legacy',
  };
  return withMarker(dir, data, store, plan, file);
}

function withMarker(
  dir: string,
  data: string,
  store: SettingsStore,
  plan: PlanRef,
  file: string,
): Fixture {
  const board = new Map([[planKey(plan), plan]]);
  const recorded: MarkedDone[] = [];
  let changes = 0;
  const clock = { now: Date.parse('2026-11-11T08:00:00Z') };
  const marker = new MarkDone({
    store,
    lookup: (k) => board.get(k),
    now: () => new Date(clock.now),
    record: (e) => {
      recorded.push(e);
    },
    changed: () => changes++,
  });
  return {
    dir,
    data,
    store,
    plan,
    file,
    board,
    marker,
    recorded,
    changed: () => changes,
    clock,
  };
}

const body = (f: Fixture) => ({
  key: planKey(f.plan),
  revision: f.plan.revision,
});

function backups(f: Fixture): string[] {
  try {
    return readdirSync(path.join(f.data, PLAN_EDITS_DIR));
  } catch {
    return [];
  }
}

describe('mark a plan Done', () => {
  it('revalidates containment after the workspace is redirected during backup', async () => {
    const f = await tasksFixture();
    const original = readFileSync(f.file);
    const outside = path.join(f.dir, 'outside');
    const workspace = path.dirname(f.file);
    let redirected = false;
    const marker = new MarkDone({
      store: f.store,
      lookup: (key) => f.board.get(key),
      io: {
        ops: {
          rename: async (source, target) => {
            await fs.rename(source, target);
            if (!redirected) {
              redirected = true;
              renameSync(workspace, outside);
              symlinkSync(outside, workspace, 'junction');
            }
          },
        },
      },
    });
    const result = await marker.markDone(body(f));
    expect(code(result)).toBe('CONFLICT');
    expect(readFileSync(path.join(outside, path.basename(f.file)))).toEqual(
      original,
    );
  });

  it('does not change a plan when its backup fails', async () => {
    const f = await tasksFixture();
    const before = readFileSync(f.file);
    const marker = new MarkDone({
      store: f.store,
      lookup: (key) => f.board.get(key),
      io: {
        ops: {
          rename: async () => {
            throw new Error('Disk full');
          },
        },
      },
    });
    expect(code(await marker.markDone(body(f)))).toBe('IO_ERROR');
    expect(readFileSync(f.file)).toEqual(before);
  });

  it('rechecks the agent revision on every sharing-violation retry', async () => {
    const f = await tasksFixture();
    let attempts = 0;
    const marker = new MarkDone({
      store: f.store,
      lookup: (key) => f.board.get(key),
      io: {
        ops: {
          rename: async (source, target) => {
            if (target === f.file && ++attempts === 1) {
              writeFileSync(
                f.file,
                'Status: Blocked\nGoal: Agent saved this\n',
              );
              throw Object.assign(new Error('File held'), { code: 'EBUSY' });
            }
            await fs.rename(source, target);
          },
        },
      },
    });
    expect(code(await marker.markDone(body(f)))).toBe('REVISION_CHANGED');
    expect(readFileSync(f.file, 'utf8')).toBe(
      'Status: Blocked\nGoal: Agent saved this\n',
    );
    expect(attempts).toBe(1);
  });

  it('keeps an 8 MiB plan exact and refuses an oversized plan', async () => {
    const prefix = Buffer.from('Status: Testing\r\n');
    const bytes = Buffer.concat([
      prefix,
      Buffer.alloc(MAX_PLAN_BYTES - prefix.length, 0x61),
    ]);
    const f = await tasksFixture(bytes);
    expect(code(await f.marker.markDone(body(f)))).toBe('ok');
    expect(readFileSync(f.file)).toEqual(
      Buffer.concat([
        Buffer.from('Status: Done\r\n'),
        bytes.subarray(prefix.length),
      ]),
    );
    const large = await tasksFixture(Buffer.concat([bytes, Buffer.from('x')]));
    expect(code(await large.marker.markDone(body(large)))).toBe(
      'REVISION_CHANGED',
    );
    expect(backups(large)).toEqual([]);
  });
  it('writes only the Status value of a Tasks plan, keeps a backup and records it', async () => {
    const f = await tasksFixture();
    const before = readFileSync(f.file);
    const r = await f.marker.markDone(body(f));
    expect(code(r)).toBe('ok');
    if (!r.ok) return;
    const after = readFileSync(f.file);
    expect(after.toString()).toBe(
      'Owner: Lan\r\nStatus: Done\r\nGoal: Phát hành\r\n',
    );
    expect(r.value).toMatchObject({
      changed: true,
      status: 'Done',
      previous: 'Testing - Kiểm tra lần cuối',
      revision: sha(after),
    });
    expect(r.value.undo?.token).toMatch(/^[a-f0-9]{32}$/);
    expect(r.value.backup).toBe(
      path.join(
        f.data,
        PLAN_EDITS_DIR,
        backups(f)[0]!,
        'web',
        'release-go-live.md',
      ),
    );
    expect(readFileSync(r.value.backup!)).toEqual(before);
    expect(backups(f)[0]).toMatch(/^20261111-080000-000[a-f0-9]{8}$/);
    expect(f.recorded).toHaveLength(1);
    expect(f.recorded[0]).toMatchObject({
      key: 'tasks/web/release-go-live',
      previous: 'Testing - Kiểm tra lần cuối',
    });
    expect(f.changed()).toBe(1);
    // No temporary file is left beside the plan.
    expect(readdirSync(path.dirname(f.file))).toEqual(['release-go-live.md']);
  });

  it('works for a legacy workspace plan', async () => {
    const f = await legacyFixture();
    const r = await f.marker.markDone(body(f));
    expect(code(r)).toBe('ok');
    expect(readFileSync(f.file, 'utf8')).toBe(
      'Owner: Lan\nStatus: Done\n- [doing] Build\n',
    );
    expect(backups(f)).toHaveLength(1);
  });

  it('refuses a plan whose bytes changed since the owner saw it', async () => {
    const f = await tasksFixture();
    writeFileSync(f.file, 'Status: Reviewing\n');
    const r = await f.marker.markDone(body(f));
    expect(code(r)).toBe('REVISION_CHANGED');
    expect(message(r)).toBe(
      'This plan changed. Look again before marking it Done.',
    );
    expect(readFileSync(f.file, 'utf8')).toBe('Status: Reviewing\n');
    // A revision other than the board's is refused too.
    const g = await tasksFixture();
    expect(
      code(await g.marker.markDone({ ...body(g), revision: 'b'.repeat(64) })),
    ).toBe('REVISION_CHANGED');
    expect(backups(f)).toEqual([]);
    expect(f.recorded).toEqual([]);
  });

  it('refuses when the file changes between the check and the rename', async () => {
    const f = await tasksFixture();
    const marker = new MarkDone({
      store: f.store,
      lookup: (k) => f.board.get(k),
      io: {
        ops: {
          writeAll: async (handle, data) => {
            await handle.writeFile(data);
            // Another program saves the plan while the new copy is written.
            writeFileSync(f.file, 'Status: Blocked\n');
          },
        },
      },
    });
    const r = await marker.markDone(body(f));
    expect(code(r)).toBe('REVISION_CHANGED');
    expect(readFileSync(f.file, 'utf8')).toBe('Status: Blocked\n');
    expect(readdirSync(path.dirname(f.file))).toEqual(['release-go-live.md']);
  });

  it('refuses a plan with no top Status line and writes nothing', async () => {
    for (const text of [
      'Owner: Lan\nGoal: x\n',
      'Goal: x\n## M1: First [doing]\nStatus: Implementing\n- [doing] a\n',
    ]) {
      const f = await tasksFixture(text);
      const r = await f.marker.markDone(body(f));
      expect(code(r)).toBe('CONFLICT');
      expect(message(r)).toMatch(/no Status line/);
      expect(readFileSync(f.file, 'utf8')).toBe(text);
      expect(backups(f)).toEqual([]);
    }
  });

  it('does not write a plan that is already Done', async () => {
    const f = await tasksFixture('Status: Done - shipped\n');
    const r = await f.marker.markDone(body(f));
    expect(r.ok && r.value).toMatchObject({ changed: false, undo: null });
    expect(readFileSync(f.file, 'utf8')).toBe('Status: Done - shipped\n');
    expect(backups(f)).toEqual([]);
    expect(f.recorded).toEqual([]);
    expect(f.changed()).toBe(0);
  });

  it('respects read-only settings', async () => {
    const f = await tasksFixture();
    put(path.join(f.data, 'config.json'), '{"version":3}');
    const locked = new SettingsStore({ dataDir: f.data });
    await locked.load();
    const marker = new MarkDone({
      store: locked,
      lookup: (k) => f.board.get(k),
    });
    expect(code(await marker.markDone(body(f)))).toBe('READ_ONLY');
    expect(
      code(await marker.undo({ key: planKey(f.plan), token: 'a'.repeat(32) })),
    ).toBe('READ_ONLY');
    expect(readFileSync(f.file, 'utf8')).toContain('Status: Testing');
  });

  it('resolves the file from the key only, never from a path', async () => {
    const f = await tasksFixture();
    const outside = put(path.join(f.dir, 'outside.md'), 'Status: Planning\n');
    const revision = sha(readFileSync(outside));
    // A key that is a path is not a plan on the board.
    for (const key of [outside, outside.replace(/\\/g, '/'), '../outside'])
      expect(code(await f.marker.markDone({ key, revision }))).toBe(
        'NOT_FOUND',
      );
    // A board entry whose recorded file points elsewhere is refused.
    f.board.set(planKey(f.plan), {
      ...f.plan,
      revision,
      file: outside.replace(/\\/g, '/'),
    });
    expect(code(await f.marker.markDone({ ...body(f), revision }))).toBe(
      'CONFLICT',
    );
    // A plan name that escapes its folder is refused.
    f.board.set(planKey(f.plan), { ...f.plan, name: '../outside' });
    expect(code(await f.marker.markDone(body(f)))).toBe('INVALID_REQUEST');
    expect(readFileSync(outside, 'utf8')).toBe('Status: Planning\n');
  });

  it('keeps the newest 50 backups', async () => {
    const root = path.join(tempDir(), PLAN_EDITS_DIR);
    for (let i = 0; i < 55; i++)
      mkdirSync(
        path.join(root, `20261111-0800${String(i).padStart(2, '0')}-000aa`),
        { recursive: true },
      );
    mkdirSync(path.join(root, 'keep-me'));
    await pruneBackups(root, 50);
    const left = readdirSync(root).sort();
    expect(left).toHaveLength(51);
    expect(left).toContain('keep-me');
    expect(left[0]).toBe('20261111-080005-000aa');

    const f = await tasksFixture();
    const own = path.join(f.data, PLAN_EDITS_DIR);
    for (let i = 0; i < 50; i++)
      mkdirSync(
        path.join(own, `20261110-0000${String(i).padStart(2, '0')}-000bb`),
        {
          recursive: true,
        },
      );
    expect(code(await f.marker.markDone(body(f)))).toBe('ok');
    const kept = backups(f).sort();
    expect(kept).toHaveLength(50);
    expect(kept[0]).toBe('20261110-000001-000bb');
    expect(kept[49]).toMatch(/^20261111-080000-/);
  });
});

describe('undo Mark as Done', () => {
  it('refuses when the plan is no longer in the ledger', async () => {
    const f = await tasksFixture();
    const r = await f.marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    const after = readFileSync(f.file);
    f.board.clear();
    const u = await f.marker.undo({
      key: planKey(f.plan),
      token: r.value.undo!.token,
    });
    expect(code(u)).toBe('NOT_FOUND');
    expect(readFileSync(f.file)).toEqual(after);
  });

  it('refuses an in-memory token after restart', async () => {
    const f = await tasksFixture();
    const r = await f.marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    const marker = new MarkDone({
      store: f.store,
      lookup: (key) => f.board.get(key),
    });
    expect(
      code(
        await marker.undo({ key: planKey(f.plan), token: r.value.undo!.token }),
      ),
    ).toBe('CONFLICT');
    expect(readFileSync(f.file, 'utf8')).toContain('Status: Done');
  });

  it('checks token expiry again immediately before replacing the file', async () => {
    const f = await tasksFixture();
    let expireDuringWrite = false;
    const marker = new MarkDone({
      store: f.store,
      lookup: (key) => f.board.get(key),
      now: () => new Date(f.clock.now),
      io: {
        ops: {
          writeAll: async (handle, data) => {
            await handle.writeFile(data);
            if (expireDuringWrite) f.clock.now += 120_001;
          },
        },
      },
    });
    const r = await marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    expireDuringWrite = true;
    expect(
      code(
        await marker.undo({ key: planKey(f.plan), token: r.value.undo!.token }),
      ),
    ).toBe('CONFLICT');
    expect(readFileSync(f.file, 'utf8')).toContain('Status: Done');
  });
  it('puts the original bytes back within 2 minutes', async () => {
    const f = await tasksFixture();
    const before = readFileSync(f.file);
    const r = await f.marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    f.clock.now += 119_000;
    const u = await f.marker.undo({
      key: planKey(f.plan),
      token: r.value.undo!.token,
    });
    expect(code(u)).toBe('ok');
    expect(u.ok && u.value).toEqual({
      key: 'tasks/web/release-go-live',
      status: 'Testing - Kiểm tra lần cuối',
      revision: sha(before),
    });
    expect(readFileSync(f.file)).toEqual(before);
    // The token is used up.
    expect(
      code(
        await f.marker.undo({
          key: planKey(f.plan),
          token: r.value.undo!.token,
        }),
      ),
    ).toBe('CONFLICT');
  });

  it('refuses after 2 minutes', async () => {
    const f = await tasksFixture();
    const r = await f.marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    const after = readFileSync(f.file);
    f.clock.now += 120_001;
    const u = await f.marker.undo({
      key: planKey(f.plan),
      token: r.value.undo!.token,
    });
    expect(code(u)).toBe('CONFLICT');
    expect(message(u)).toMatch(/2 minutes/);
    expect(readFileSync(f.file)).toEqual(after);
  });

  it('refuses when the file changed after Mark as Done', async () => {
    const f = await tasksFixture();
    const r = await f.marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    const edited =
      'Owner: Lan\r\nStatus: Done\r\nGoal: Phát hành\r\n- [done] x\r\n';
    writeFileSync(f.file, edited);
    const u = await f.marker.undo({
      key: planKey(f.plan),
      token: r.value.undo!.token,
    });
    expect(code(u)).toBe('REVISION_CHANGED');
    expect(readFileSync(f.file, 'utf8')).toBe(edited);
  });

  it('refuses a token for another plan or an unknown token', async () => {
    const f = await tasksFixture();
    const r = await f.marker.markDone(body(f));
    if (!r.ok) throw new Error(r.error.message);
    const after = readFileSync(f.file);
    expect(
      code(
        await f.marker.undo({
          key: 'tasks/web/other',
          token: r.value.undo!.token,
        }),
      ),
    ).toBe('CONFLICT');
    expect(
      code(
        await f.marker.undo({ key: planKey(f.plan), token: 'c'.repeat(32) }),
      ),
    ).toBe('CONFLICT');
    expect(readFileSync(f.file)).toEqual(after);
  });
});
