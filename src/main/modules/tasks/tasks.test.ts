import {
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  has,
  junction,
  mkRepo,
  onWindows,
  put,
  read,
  tempDir,
} from '../../lib/safe-io/test-helpers';
import { SettingsStore, readConfig } from '../settings/config-store';
import { projectIdFor } from '../settings/identity';
import type { Result } from '../settings/result';
import { WorkspaceService } from '../workspaces/workspaces';
import { movePlanFile } from './move';
import {
  TASKS_POINTER_NAME,
  writeTasksEnv,
  type UserEnvironment,
} from './tasks-dir';
import { TasksService, type TasksServiceOptions } from './tasks';

/** FakeEnvironment records AGENT_OPS_TASKS writes; the real user environment is never touched. */
class FakeEnvironment implements UserEnvironment {
  values = new Map<string, string>();
  writes: string[] = [];
  broadcasts = 0;
  async get(name: string) {
    return this.values.get(name);
  }
  async set(name: string, value: string) {
    this.values.set(name, value);
    this.writes.push(value);
  }
  async delete(name: string) {
    this.values.delete(name);
    this.writes.push('');
  }
  broadcast() {
    this.broadcasts++;
  }
}

async function fixture(extra: Partial<TasksServiceOptions> = {}) {
  const dir = tempDir();
  const dataDir = path.join(dir, 'data');
  const store = new SettingsStore({ dataDir });
  await store.load();
  const env = new FakeEnvironment();
  let changes = 0;
  const tasks = new TasksService({
    store,
    homeDir: path.join(dir, 'home'),
    env,
    changed: () => changes++,
    ...extra,
  });
  const workspaces = new WorkspaceService(store);
  return {
    dir,
    dataDir,
    store,
    env,
    tasks,
    workspaces,
    changes: () => changes,
  };
}

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
}

function code<T>(r: Result<T>): string {
  return r.ok ? 'ok' : r.error.code;
}

describe('Tasks folder rules', () => {
  it('refuses bad folders with plain sentences', async () => {
    const { dir, dataDir, tasks, workspaces } = await fixture();
    const project = mkRepo(path.join(dir, 'work', 'repo'), 'plan');
    value(await workspaces.add(project));
    put(path.join(dir, 'a-file'), 'x');
    const cases: [string, string, string][] = [
      ['relative', 'tasks', 'full folder path'],
      ['empty', '', 'full folder path'],
      ['network share', '\\\\server\\share\\tasks', 'full folder path'],
      ['device path', '\\\\?\\C:\\tasks', 'full folder path'],
      ['drive root', 'C:\\', 'whole drive'],
      ['data folder', path.join(dataDir, 'tasks'), 'data folder'],
      ['contains the data folder', path.dirname(dataDir), 'data folder'],
      ['a file', path.join(dir, 'a-file'), 'is a file'],
      [
        'contains a project',
        path.dirname(project) + '\\.',
        'contains the workspace',
      ],
      ['is a project', project, 'contains the workspace'],
    ];
    for (const [name, p, want] of cases) {
      const r = await tasks.setTasksDir({ tasksDir: p });
      expect(r.ok, name).toBe(false);
      if (!r.ok) {
        expect(r.error.code, name).toBe('INVALID_REQUEST');
        expect(r.error.message, name).toContain(want);
      }
    }
    expect(
      code(await tasks.setTasksDir({ tasksDir: 42 as unknown as string })),
    ).toBe('INVALID_REQUEST');
    const inside = path.join(project, 'notes', 'tasks');
    const r = await tasks.setTasksDir({ tasksDir: inside });
    expect(code(r)).toBe('INSIDE_WORKSPACE');
    expect(has(inside)).toBe(false);
    const confirmed = value(
      await tasks.setTasksDir({
        tasksDir: `"${inside}"`,
        allowInsideWorkspace: true,
      }),
    );
    expect(confirmed.config.tasksDir).toBe(inside);
    expect(statSync(inside).isDirectory()).toBe(true);
  });

  it.skipIf(!onWindows)(
    'sees a workspace through a junction and ignores case and a trailing slash',
    async () => {
      const { dir, tasks, workspaces } = await fixture();
      const project = mkRepo(path.join(dir, 'Work', 'Repo'), 'plan');
      value(await workspaces.add(project));
      const link = path.join(dir, 'link');
      if (junction(link, project)) {
        expect(
          code(await tasks.setTasksDir({ tasksDir: path.join(link, 'tasks') })),
        ).toBe('INSIDE_WORKSPACE');
      }
      expect(
        code(
          await tasks.setTasksDir({
            tasksDir: path.join(dir, 'WORK', 'REPO', 'tasks\\'),
          }),
        ),
      ).toBe('INSIDE_WORKSPACE');
      expect(
        code(
          await tasks.setTasksDir({ tasksDir: path.join(dir, 'work') + '\\' }),
        ),
      ).toBe('INVALID_REQUEST');
    },
  );

  it('suggests %USERPROFILE%\\agent-ops\\tasks', async () => {
    const { dir, tasks } = await fixture();
    expect(tasks.suggestedTasksDir()).toBe(
      path.join(dir, 'home', 'agent-ops', 'tasks'),
    );
    expect(await tasks.status()).toMatchObject({
      tasksDir: '',
      previousTasksDir: '',
      previousPlanCount: 0,
    });
  });
});

describe('Tasks folder setting and pointers', () => {
  it('saves the folder, keeps both pointers current and remembers the previous folder', async () => {
    const { dir, dataDir, store, env, tasks } = await fixture();
    const first = path.join(dir, 'Công việc', 'tasks');
    const r = value(await tasks.setTasksDir({ tasksDir: first }));
    expect(r.config.tasksDir).toBe(first);
    expect(r.pointerProblems).toEqual([]);
    expect(r.move).toBeUndefined();
    const saved = await readConfig(store.file);
    expect(saved.tasksDir).toBe(first);
    expect(saved.previousTasksDir).toBe('');
    const pointer = path.join(dataDir, TASKS_POINTER_NAME);
    expect(read(pointer)).toBe(first + '\n');
    expect(env.writes).toEqual([first]);

    put(
      path.join(first, 'web', 'release-go-live.md'),
      'Status: Implementing\n',
    );
    const second = path.join(dir, 'second');
    value(await tasks.setTasksDir({ tasksDir: second }));
    expect(await tasks.status()).toMatchObject({
      tasksDir: second,
      previousTasksDir: first,
      previousPlanCount: 1,
    });
    expect(read(pointer)).toBe(second + '\n');
    expect(env.writes).toEqual([first, second]);

    // Choosing the previous folder again forgets it as previous; the old current one becomes previous.
    value(await tasks.setTasksDir({ tasksDir: first }));
    expect(store.get().previousTasksDir).toBe(second);
    // Saving the same folder keeps the previous one and does not rewrite unchanged pointers.
    const writesBefore = env.writes.length;
    const mtime = statSync(pointer).mtimeMs;
    value(await tasks.setTasksDir({ tasksDir: first + '\\' }));
    expect(store.get().previousTasksDir).toBe(second);
    expect(env.writes.length).toBe(writesBefore);
    expect(statSync(pointer).mtimeMs).toBe(mtime);
  });

  it('syncPointers at start rewrites a stale pointer and leaves no pointer without a folder', async () => {
    const { dataDir, env, tasks, store } = await fixture();
    const pointer = path.join(dataDir, TASKS_POINTER_NAME);
    put(pointer, 'C:\\old\n');
    env.values.set('AGENT_OPS_TASKS', 'C:\\old');
    expect(await tasks.syncPointers()).toEqual([]);
    expect(has(pointer)).toBe(false);
    expect(env.values.has('AGENT_OPS_TASKS')).toBe(false);
    await store.mutate((c) => {
      c.tasksDir = 'C:\\new tasks';
    });
    await tasks.syncPointers();
    expect(read(pointer)).toBe('C:\\new tasks\n');
    expect(env.values.get('AGENT_OPS_TASKS')).toBe('C:\\new tasks');
  });

  it('a non-installed instance never writes the environment', async () => {
    const dir = tempDir();
    const store = new SettingsStore({ dataDir: path.join(dir, 'data') });
    await store.load();
    const tasks = new TasksService({ store, homeDir: dir });
    const r = value(
      await tasks.setTasksDir({ tasksDir: path.join(dir, 'tasks') }),
    );
    expect(r.pointerProblems).toEqual([]);
    expect(read(path.join(dir, 'data', TASKS_POINTER_NAME))).toBe(
      path.join(dir, 'tasks') + '\n',
    );
  });

  it('a failing environment writer is reported, and the folder is still saved', async () => {
    const env = new FakeEnvironment();
    env.set = async () => {
      throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    };
    const { dir, store, tasks } = await fixture({ env });
    const r = value(
      await tasks.setTasksDir({ tasksDir: path.join(dir, 'tasks') }),
    );
    expect(r.pointerProblems).toEqual(['AGENT_OPS_TASKS: EACCES']);
    expect(store.get().tasksDir).toBe(path.join(dir, 'tasks'));
  });

  it('writeTasksEnv writes and broadcasts only a change', async () => {
    const env = new FakeEnvironment();
    await writeTasksEnv(env, 'D:\\Tasks');
    expect(env.values.get('AGENT_OPS_TASKS')).toBe('D:\\Tasks');
    expect(env.broadcasts).toBe(1);
    await writeTasksEnv(env, 'D:\\Tasks');
    expect(env.broadcasts).toBe(1);
    await writeTasksEnv(env, '');
    expect(env.values.has('AGENT_OPS_TASKS')).toBe(false);
    expect(env.broadcasts).toBe(2);
    await writeTasksEnv(env, '');
    expect(env.broadcasts).toBe(2);
  });

  it('is read-only while the settings file is unusable', async () => {
    const dir = tempDir();
    put(
      path.join(dir, 'data', 'config.json'),
      '{"version":1,"projects":"broken"',
    );
    const store = new SettingsStore({ dataDir: path.join(dir, 'data') });
    await store.load();
    // The corrupt file was moved aside; settings work again.
    expect(store.readOnly).toBe('');
    put(path.join(dir, 'data', 'config.json'), '{"version":3}');
    const locked = new SettingsStore({ dataDir: path.join(dir, 'data') });
    await locked.load();
    const tasks = new TasksService({ store: locked, homeDir: dir });
    expect(
      code(await tasks.setTasksDir({ tasksDir: path.join(dir, 'tasks') })),
    ).toBe('READ_ONLY');
    expect(code(await tasks.moveLegacy())).toBe('READ_ONLY');
  });
});

describe('moving plans from the previous Tasks folder', () => {
  it('moves plans with backups, refuses clashes and forgets an emptied folder', async () => {
    const { dir, dataDir, store, tasks, changes } = await fixture();
    const old = path.join(dir, 'old');
    const next = path.join(dir, 'new');
    value(await tasks.setTasksDir({ tasksDir: old }));
    put(path.join(old, 'web', 'release-go-live.md'), 'Status: Testing\n');
    put(
      path.join(old, 'Dự án', 'ke-hoach.md'),
      'Status: Planning\nGoal: Tiếng Việt\n',
    );
    put(path.join(old, 'web', 'clash.md'), 'old copy');
    put(path.join(old, 'web', 'notes.txt'), 'not a plan');
    put(path.join(old, '.hidden', 'skip.md'), 'dot folders are not workspaces');
    const stamp = new Date('2026-01-02T03:04:05Z');
    utimesSync(path.join(old, 'web', 'release-go-live.md'), stamp, stamp);
    value(await tasks.setTasksDir({ tasksDir: next }));
    expect((await tasks.status()).previousPlanCount).toBe(3);
    put(path.join(next, 'web', 'clash.md'), 'new copy');
    for (const from of [dir, next, '', 42]) {
      expect(code(await tasks.moveAll(from as string)), String(from)).toBe(
        'INVALID_REQUEST',
      );
    }
    const before = changes();
    const report = value(
      await tasks.moveAll(onWindows ? old.toUpperCase() : old),
    );
    expect(report).toMatchObject({ moved: 2, failed: 1 });
    expect(changes()).toBe(before + 1);
    expect(
      report.backup.startsWith(
        path.join(dataDir, 'backups', 'tasks-move-all-'),
      ),
    ).toBe(true);
    expect(read(path.join(report.backup, 'Dự án', 'ke-hoach.md'))).toBe(
      'Status: Planning\nGoal: Tiếng Việt\n',
    );
    expect(read(path.join(next, 'Dự án', 'ke-hoach.md'))).toBe(
      'Status: Planning\nGoal: Tiếng Việt\n',
    );
    expect(has(path.join(old, 'Dự án', 'ke-hoach.md'))).toBe(false);
    expect(
      statSync(
        path.join(next, 'web', 'release-go-live.md'),
      ).mtime.toISOString(),
    ).toBe(stamp.toISOString());
    expect(read(path.join(next, 'web', 'clash.md'))).toBe('new copy');
    expect(read(path.join(old, 'web', 'clash.md'))).toBe('old copy');
    for (const m of report.results) {
      expect(m.key.startsWith('tasks/')).toBe(true);
      expect(m.ok).toBe(!m.from.endsWith('clash.md'));
    }
    const clash = report.results.find((m) => m.key === 'tasks/web/clash');
    expect(clash?.error).toContain('already in');
    expect(clash?.to).toBe(path.join(next, 'web', 'clash.md'));
    expect(has(path.join(old, 'web', 'notes.txt'))).toBe(true);
    expect(has(path.join(old, '.hidden', 'skip.md'))).toBe(true);
    expect(store.get().previousTasksDir).toBe(old);
    expect((await tasks.status()).previousPlanCount).toBe(1);

    rmSync(path.join(old, 'web', 'clash.md'));
    put(path.join(old, 'web', 'last.md'), 'Status: Done\n');
    const last = value(await tasks.moveAll(old));
    expect(last.moved).toBe(1);
    expect(store.get().previousTasksDir).toBe('');
    expect((await readConfig(store.file)).previousTasksDir).toBe('');
  });

  it('moves with the folder change (moveExisting), reporting per file', async () => {
    const { dir, tasks } = await fixture();
    const old = path.join(dir, 'old');
    const next = path.join(dir, 'new');
    const first = value(
      await tasks.setTasksDir({ tasksDir: old, moveExisting: true }),
    );
    expect(first.move).toMatchObject({ moved: 0, failed: 0, results: [] });
    put(path.join(old, 'web', 'release-go-live.md'), 'Status: Testing\n');
    put(path.join(old, 'web', 'clash.md'), 'old');
    put(path.join(next, 'web', 'clash.md'), 'new');
    const r = value(
      await tasks.setTasksDir({ tasksDir: next, moveExisting: true }),
    );
    expect(r.config).toMatchObject({ tasksDir: next, previousTasksDir: old });
    expect(r.move).toMatchObject({ moved: 1, failed: 1 });
    const byKey = new Map(r.move!.results.map((m) => [m.key, m]));
    expect(byKey.get('tasks/web/release-go-live')).toMatchObject({
      ok: true,
      to: path.join(next, 'web', 'release-go-live.md'),
    });
    expect(byKey.get('tasks/web/clash')?.error).toContain('already in');
  });

  it('refuses overlapping folders before touching a file, but keeps the new folder', async () => {
    const { dir, store, tasks } = await fixture();
    const old = path.join(dir, 'old');
    value(await tasks.setTasksDir({ tasksDir: old }));
    put(path.join(old, 'web', 'p.md'), 'x');
    const inner = path.join(old, 'web', 'deeper');
    const r = value(
      await tasks.setTasksDir({ tasksDir: inner, moveExisting: true }),
    );
    expect(r.moveError).toContain('overlap');
    expect(r.move).toMatchObject({ moved: 0, failed: 0 });
    expect(store.get().tasksDir).toBe(inner);
    expect(has(path.join(old, 'web', 'p.md'))).toBe(true);
    expect(code(await tasks.moveAll(old))).toBe('CONFLICT');
  });

  it.skipIf(!onWindows)(
    'refuses a workspace folder that is a junction leading outside',
    async () => {
      const { dir, tasks } = await fixture();
      const old = path.join(dir, 'old');
      value(await tasks.setTasksDir({ tasksDir: old }));
      const outside = path.join(dir, 'outside');
      put(path.join(outside, 'evil.md'), 'Status: Planning\n');
      if (!junction(path.join(old, 'linked'), outside)) return;
      value(await tasks.setTasksDir({ tasksDir: path.join(dir, 'new') }));
      const r = value(await tasks.moveAll(old));
      expect(r.results[0]?.error).toContain('leads outside');
      expect(has(path.join(outside, 'evil.md'))).toBe(true);
    },
  );

  it('runs one move at a time', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const { dir, tasks } = await fixture({
      hooks: { afterPlanCopy: () => gate },
    });
    value(await tasks.setTasksDir({ tasksDir: path.join(dir, 'old') }));
    put(path.join(dir, 'old', 'web', 'p.md'), 'x');
    value(await tasks.setTasksDir({ tasksDir: path.join(dir, 'new') }));
    const first = tasks.moveAll(path.join(dir, 'old'));
    await new Promise((r) => setTimeout(r, 50));
    expect(code(await tasks.moveLegacy())).toBe('BUSY');
    expect(
      code(
        await tasks.setTasksDir({
          tasksDir: path.join(dir, 'third'),
          moveExisting: true,
        }),
      ),
    ).toBe('BUSY');
    release();
    expect(value(await first).moved).toBe(1);
  });
});

describe('moving legacy .tasks plans', () => {
  it('moves selected or all legacy plans; a key never names a path; a junction outside is refused', async () => {
    const { dir, dataDir, tasks, workspaces, store } = await fixture();
    const folder = path.join(dir, 'repos');
    mkRepo(path.join(folder, 'web'), 'release', 'clash', 'Kế hoạch');
    mkRepo(path.join(folder, 'api'), 'api-plan');
    put(path.join(folder, 'api', '.tasks', 'tong-hop.md'), 'generated');
    const outside = path.join(dir, 'outside');
    put(path.join(outside, 'evil.md'), 'Status: Planning\n');
    mkdirSync(path.join(folder, 'linked', '.git'), { recursive: true });
    const hasJunction =
      onWindows && junction(path.join(folder, 'linked', '.tasks'), outside);
    value(await workspaces.add(folder));
    expect(code(await tasks.moveLegacy())).toBe('CONFLICT');
    const tasksDir = path.join(dir, 'tasks');
    value(await tasks.setTasksDir({ tasksDir }));
    put(path.join(tasksDir, 'web', 'clash.md'), 'Status: Testing\n');
    const id = projectIdFor(folder);
    expect((await tasks.legacyPlanFiles()).map((f) => f.key).sort()).toEqual(
      [
        `${id}/api/api-plan`,
        `${id}/web/Kế hoạch`,
        `${id}/web/clash`,
        `${id}/web/release`,
        ...(hasJunction ? [`${id}/linked/evil`] : []),
      ].sort(),
    );
    const keys = [
      `${id}/web/release`,
      `${id}/web/Kế hoạch`,
      `${id}/web/../../../outside/evil`,
      `other/web/release`,
      `${id}/web/clash`,
      `${id}/web/release`,
    ];
    const r = value(await tasks.moveLegacy(keys));
    expect(r).toMatchObject({ moved: 2, failed: 3 });
    expect(has(path.join(tasksDir, 'web', 'release.md'))).toBe(true);
    expect(has(path.join(folder, 'web', '.tasks', 'release.md'))).toBe(false);
    expect(has(path.join(tasksDir, 'web', 'Kế hoạch.md'))).toBe(true);
    expect(has(path.join(r.backup, id, 'web', 'release.md'))).toBe(true);
    expect(
      r.backup.startsWith(path.join(dataDir, 'backups', 'tasks-move-legacy-')),
    ).toBe(true);
    expect(read(path.join(tasksDir, 'web', 'clash.md'))).toBe(
      'Status: Testing\n',
    );
    expect(has(path.join(folder, 'web', '.tasks', 'clash.md'))).toBe(true);
    expect(has(path.join(outside, 'evil.md'))).toBe(true);
    expect(
      r.results.find((m) => m.key === 'other/web/release')?.error,
    ).toContain('not among the older plans');

    // [] selects none.
    expect(value(await tasks.moveLegacy([]))).toMatchObject({
      moved: 0,
      failed: 0,
    });
    expect(code(await tasks.moveLegacy(['ok', 3 as unknown as string]))).toBe(
      'INVALID_REQUEST',
    );

    // No keys: every legacy plan of the enabled workspaces.
    const all = value(await tasks.moveLegacy());
    expect(all.moved).toBe(1);
    expect(has(path.join(tasksDir, 'api', 'api-plan.md'))).toBe(true);
    expect(has(path.join(folder, 'api', '.tasks', 'tong-hop.md'))).toBe(true);
    if (hasJunction) {
      expect(
        all.results.find((m) => m.key === `${id}/linked/evil`)?.error,
      ).toContain('leads outside the workspace');
      expect(has(path.join(outside, 'evil.md'))).toBe(true);
    }

    // A disabled workspace's plans are not moved.
    mkRepo(path.join(folder, 'later'), 'p');
    await workspaces.setEnabled(id, false);
    expect(value(await tasks.moveLegacy())).toMatchObject({ moved: 0 });
    expect(store.get().projects[0]?.enabled).toBe(false);
  });
});

describe('movePlanFile', () => {
  it('keeps a plan that changes during the move', async () => {
    const dir = tempDir();
    const src = put(path.join(dir, 'a', 'plan.md'), 'one');
    const dst = path.join(dir, 'b', 'plan.md');
    const backup = path.join(dir, 'backup', 'plan.md');
    const err = await movePlanFile(src, dst, backup, {
      afterPlanCopy: (f) => writeFileSync(f, 'two'),
    });
    expect(err).toContain('changed');
    expect(read(src)).toBe('two');
    expect(has(dst)).toBe(false);
    expect(read(backup)).toBe('one');
    expect(await movePlanFile(src, dst, backup + '2')).toBeUndefined();
    expect(read(dst)).toBe('two');
    expect(has(src)).toBe(false);
  });

  it('refuses a missing file, a too large file and a folder', async () => {
    const dir = tempDir();
    expect(
      await movePlanFile(
        path.join(dir, 'none.md'),
        path.join(dir, 'x.md'),
        path.join(dir, 'b1'),
      ),
    ).toContain('cannot be read');
    const big = put(path.join(dir, 'big.md'), Buffer.alloc((8 << 20) + 1, 120));
    expect(
      await movePlanFile(big, path.join(dir, 'x.md'), path.join(dir, 'b2')),
    ).toContain('too large');
    mkdirSync(path.join(dir, 'folder.md'));
    expect(
      await movePlanFile(
        path.join(dir, 'folder.md'),
        path.join(dir, 'x.md'),
        path.join(dir, 'b3'),
      ),
    ).toContain('not a plain file');
    expect(readdirSync(dir).sort()).toEqual(['big.md', 'folder.md']);
  });

  it.skipIf(!onWindows)(
    'leaves a plan held by another program where it was',
    async () => {
      const { holdExclusively } =
        await import('../../lib/safe-io/test-helpers');
      const dir = tempDir();
      const src = put(path.join(dir, 'a', 'plan.md'), 'held');
      const dst = path.join(dir, 'b', 'plan.md');
      const { released } = await holdExclusively(src, 1500);
      const err = await movePlanFile(
        src,
        dst,
        path.join(dir, 'backup', 'plan.md'),
        { retryForMs: 200 },
      );
      await released;
      expect(err).toContain('cannot be read');
      expect(read(src)).toBe('held');
      expect(has(dst)).toBe(false);
    },
    20000,
  );
});
