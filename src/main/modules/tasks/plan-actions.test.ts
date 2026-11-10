import { createHash } from 'node:crypto';
import {
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  has,
  holdExclusively,
  junction,
  onWindows,
  put,
  read,
  tempDir,
} from '../../lib/safe-io/test-helpers';
import { SettingsStore, readConfig } from '../settings/config-store';
import { defaultConfig } from '../settings/config';
import type { Result } from '../settings/result';
import {
  PlanActions,
  archivedKeys,
  isArchived,
  planKey,
  type PlanRef,
} from './plan-actions';

const sha = (file: string) =>
  createHash('sha256').update(readFileSync(file)).digest('hex');
const code = <T>(r: Result<T>) => (r.ok ? 'ok' : r.error.code);

interface Fixture {
  dir: string;
  store: SettingsStore;
  plan: PlanRef;
  file: string;
  trashed: string[];
  board: Map<string, PlanRef>;
  actions: PlanActions;
  setTrash: (fn: (file: string) => Promise<void>) => void;
}

/** A legacy plan in an enabled repo workspace, with a fake Recycle Bin. */
async function legacyFixture(): Promise<Fixture> {
  const dir = tempDir();
  const root = path.join(dir, 'workspace');
  mkdirSync(path.join(root, '.git'), { recursive: true });
  const file = put(
    path.join(root, '.tasks', 'delivery.md'),
    'Owner: Lan\nStatus: Implementing\n',
  );
  const store = new SettingsStore({ dataDir: path.join(dir, 'data') });
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
    revision: sha(file),
    root,
    file: file.replace(/\\/g, '/'),
    source: 'legacy',
  };
  return withActions(dir, store, plan, file);
}

/** A plan in the Tasks folder. */
async function tasksFixture(): Promise<Fixture> {
  const dir = tempDir();
  const tasks = path.join(dir, 'Công việc');
  const file = put(
    path.join(tasks, 'web', 'release-go-live.md'),
    'Owner: Lan\nStatus: Testing\n',
  );
  const store = new SettingsStore({ dataDir: path.join(dir, 'data') });
  await store.load();
  await store.mutate((c) => {
    c.tasksDir = tasks;
  });
  const plan: PlanRef = {
    project: 'tasks',
    repo: 'web',
    name: 'release-go-live',
    status: 'Testing',
    revision: sha(file),
    file: file.replace(/\\/g, '/'),
    source: 'tasks',
  };
  return withActions(dir, store, plan, file);
}

function withActions(
  dir: string,
  store: SettingsStore,
  plan: PlanRef,
  file: string,
): Fixture {
  const board = new Map([[planKey(plan), plan]]);
  const trashed: string[] = [];
  const bin = path.join(dir, 'fake-bin');
  mkdirSync(bin, { recursive: true });
  let trash = async (f: string) => {
    trashed.push(f);
    renameSync(f, path.join(bin, path.basename(f)));
  };
  const actions = new PlanActions({
    store,
    lookup: (k) => board.get(k),
    trash: (f) => trash(f),
  });
  return {
    dir,
    store,
    plan,
    file,
    trashed,
    board,
    actions,
    setTrash: (fn) => {
      trash = fn;
    },
  };
}

function recycleBody(f: Fixture) {
  return { key: planKey(f.plan), revision: f.plan.revision, confirm: true };
}

describe('archive', () => {
  it('records the owner choice in settings only', async () => {
    const f = await legacyFixture();
    const before = read(f.file);
    for (const choice of [true, false]) {
      const r = await f.actions.archive(planKey(f.plan), choice);
      expect(r.ok).toBe(true);
      expect(
        (await readConfig(f.store.file)).planArchive[planKey(f.plan)],
      ).toBe(choice);
      expect(read(f.file)).toBe(before);
    }
    expect(code(await f.actions.archive('nope/x/y', true))).toBe('NOT_FOUND');
    expect(code(await f.actions.archive(planKey(f.plan), 'yes'))).toBe(
      'INVALID_REQUEST',
    );
  });

  it('auto-archives Done plans unless the owner chose otherwise', () => {
    const c = defaultConfig();
    const done: PlanRef = {
      project: 'p',
      repo: 'r',
      name: 'a',
      status: 'Done',
      revision: '',
    };
    const detail: PlanRef = { ...done, name: 'b', status: 'Done - shipped' };
    const lower: PlanRef = { ...done, name: 'c', status: 'done' };
    const busy: PlanRef = { ...done, name: 'd', status: 'Implementing' };
    expect(isArchived(done, c)).toBe(false);
    c.autoArchiveDone = true;
    expect(archivedKeys([done, detail, lower, busy], c)).toEqual([
      'p/r/a',
      'p/r/b',
    ]);
    c.planArchive = { 'p/r/a': false, 'p/r/d': true };
    expect(archivedKeys([done, detail, lower, busy], c)).toEqual([
      'p/r/b',
      'p/r/d',
    ]);
    expect(planKey({ repo: 'r', name: 'old' })).toBe('r/old');
  });
});

describe('recycle a legacy plan', () => {
  it('moves only the confirmed, unchanged, configured file to the Recycle Bin', async () => {
    const f = await legacyFixture();
    let changed = 0;
    const actions = new PlanActions({
      store: f.store,
      lookup: (k) => f.board.get(k),
      trash: async (file) => {
        f.trashed.push(file);
        rmSync(file);
      },
      changed: () => changed++,
    });
    // The canonical long path, also when the temp folder is an 8.3 short name.
    const file = realpathSync.native(f.file);
    const r = await actions.recycle(recycleBody(f));
    expect(r).toEqual({ ok: true, value: { recycled: true, file } });
    expect(f.trashed).toEqual([file]);
    expect(changed).toBe(1);
  });

  const refusals: [string, (f: Fixture) => void | Promise<void>, string][] = [
    ['unconfirmed', () => undefined, 'INVALID_REQUEST'],
    [
      'traversal',
      (f) => {
        f.plan.name = '../escape';
        f.board.set(planKey(f.plan), f.plan);
      },
      'INVALID_REQUEST',
    ],
    [
      'trailing dot',
      (f) => {
        f.plan.name = 'delivery.';
        f.board.set(planKey(f.plan), f.plan);
      },
      'INVALID_REQUEST',
    ],
    [
      'outside',
      (f) => {
        f.plan.root = path.join(f.dir, 'outside');
      },
      'CONFLICT',
    ],
    ['missing', (f) => rmSync(f.file), 'NOT_FOUND'],
    [
      'changed',
      (f) => writeFileSync(f.file, 'Changed by the owner'),
      'REVISION_CHANGED',
    ],
    [
      'stale board revision',
      (f) => {
        f.plan.revision = 'f'.repeat(64);
      },
      'REVISION_CHANGED',
    ],
    [
      'disabled workspace',
      async (f) => {
        await f.store.mutate((c) => {
          c.projects[0]!.enabled = false;
        });
      },
      'CONFLICT',
    ],
    [
      'worktree (.git is a file)',
      (f) => {
        rmSync(path.join(f.plan.root!, '.git'), { recursive: true });
        writeFileSync(path.join(f.plan.root!, '.git'), 'gitdir: elsewhere');
      },
      'CONFLICT',
    ],
    ['unknown key', (f) => void f.board.clear(), 'NOT_FOUND'],
  ];
  for (const [kind, prepare, want] of refusals) {
    it(`refuses: ${kind}`, async () => {
      const f = await legacyFixture();
      const body = recycleBody(f);
      if (kind === 'unconfirmed') body.confirm = false as unknown as true;
      await prepare(f);
      const r = await f.actions.recycle({
        ...body,
        key: planKey(f.plan),
        revision: kind === 'stale board revision' ? sha(f.file) : body.revision,
      });
      expect(code(r)).toBe(want);
      expect(f.trashed).toEqual([]);
    });
  }

  it.skipIf(!onWindows)(
    'refuses a .tasks folder redirected outside by a junction',
    async () => {
      const f = await legacyFixture();
      const outside = path.join(f.dir, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'delivery.md'), read(f.file));
      rmSync(path.join(f.plan.root!, '.tasks'), { recursive: true });
      if (!junction(path.join(f.plan.root!, '.tasks'), outside)) return;
      expect(code(await f.actions.recycle(recycleBody(f)))).toBe('CONFLICT');
      expect(f.trashed).toEqual([]);
    },
  );

  it.skipIf(!onWindows)(
    'refuses a file held by another program',
    async () => {
      const f = await legacyFixture();
      const { released } = await holdExclusively(f.file, 1500);
      const r = await f.actions.recycle(recycleBody(f));
      await released;
      expect(code(r)).toBe('CONFLICT');
      expect(f.trashed).toEqual([]);
      expect(has(f.file)).toBe(true);
    },
    20000,
  );

  it('reports a Recycle Bin failure and keeps the file', async () => {
    const f = await legacyFixture();
    f.setTrash(async () => {
      throw new Error('Recycle Bin unavailable');
    });
    const r = await f.actions.recycle(recycleBody(f));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('CONFLICT');
      expect(r.error.message).toContain('Recycle Bin unavailable');
    }
    expect(has(f.file)).toBe(true);
  });
});

describe('recycle a Tasks-folder plan', () => {
  it('resolves <TasksDir>\\<workspace>\\<plan>.md from the key', async () => {
    const f = await tasksFixture();
    const file = realpathSync.native(f.file);
    expect(code(await f.actions.recycle(recycleBody(f)))).toBe('ok');
    expect(f.trashed).toEqual([file]);
  });

  it('refuses a file field naming another file', async () => {
    const f = await tasksFixture();
    const other = put(path.join(f.dir, 'other.md'), read(f.file));
    f.plan.file = other.replace(/\\/g, '/');
    expect(code(await f.actions.recycle(recycleBody(f)))).toBe('CONFLICT');
    expect(f.trashed).toEqual([]);
  });

  it('refuses a dot workspace', async () => {
    const f = await tasksFixture();
    for (const ws of ['..', '.hidden', 'a/b', 'a\\b', 'C:']) {
      const p = { ...f.plan, repo: ws };
      f.board.set(planKey(p), p);
      expect(
        code(await f.actions.recycle({ ...recycleBody(f), key: planKey(p) })),
        ws,
      ).toBe('INVALID_REQUEST');
    }
    expect(f.trashed).toEqual([]);
  });

  it('refuses without a Tasks folder', async () => {
    const f = await tasksFixture();
    await f.store.mutate((c) => {
      c.tasksDir = '';
    });
    expect(code(await f.actions.recycle(recycleBody(f)))).toBe('CONFLICT');
  });

  it.skipIf(!onWindows)(
    'refuses a workspace folder that is a junction outside the Tasks folder',
    async () => {
      const f = await tasksFixture();
      const outside = path.join(f.dir, 'outside');
      mkdirSync(outside);
      writeFileSync(path.join(outside, 'release-go-live.md'), read(f.file));
      const wsDir = path.dirname(f.file);
      rmSync(wsDir, { recursive: true });
      if (!junction(wsDir, outside)) return;
      expect(code(await f.actions.recycle(recycleBody(f)))).toBe('CONFLICT');
      expect(f.trashed).toEqual([]);
    },
  );
});
