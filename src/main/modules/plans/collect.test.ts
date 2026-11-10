import * as fs from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import {
  collectOverview,
  repoNameOf,
  listPlans,
  type Project,
} from './collect';
import { slash } from './io';
import {
  fixtureRoot,
  fixtures,
  fixtureSupported,
  withTemp,
  write,
  collectFixture,
  normalized,
} from './fixtures.test-support';

const project = (path: string): Project => ({
  id: 'p',
  name: 'P',
  path,
  kind: 'folder',
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});
describe('Go collector differential corpus', () => {
  it.each(fixtures)('deeply equals saved Go overview: $name', async (fixture) =>
    withTemp(async (root) => {
      // Junctions and 8.3 names need Windows and a volume with short names.
      if (!fixtureSupported(fixture)) return;
      const result = await collectFixture(root, fixture);
      const expected: unknown = JSON.parse(
        await fs.readFile(
          join(fixtureRoot, 'expected', `${fixture.name}.json`),
          'utf8',
        ),
      );
      expect(normalized(result, root)).toEqual(expected);
    }),
  );
  it('covers every corpus and expected overview', async () => {
    const names = fixtures.map((f) => f.name).sort();
    expect((await fs.readdir(join(fixtureRoot, 'corpus'))).sort()).toEqual(
      names,
    );
    expect((await fs.readdir(join(fixtureRoot, 'expected'))).sort()).toEqual(
      names.map((n) => `${n}.json`),
    );
  });
});
describe('Go collector baseline and resilience', () => {
  it('reads Tasks and legacy, keeps Vietnamese paths and excludes duplicates', async () =>
    withTemp(async (root) => {
      const f = fixtures.find((f) => f.name === 'tasks')!;
      const out = await collectFixture(root, f);
      expect(out.projects.map((p) => [p.id, p.repos, p.plans])).toEqual([
        ['tasks', 5, 5],
        ['work', 2, 2],
      ]);
      expect(
        out.plans.map((p) => `${p.project}/${p.repo}/${p.name}`).sort(),
      ).toEqual([
        'tasks/ALPHA-case/plan with space',
        'tasks/Dự án mới/kế hoạch v1.2',
        'tasks/alpha/release',
        'tasks/alpha/shared',
        'tasks/orphan/only-in-tasks',
        'work/alpha/legacy',
        'work/beta/beta',
      ]);
      expect(out.plans.find((p) => p.name === 'kế hoạch v1.2')).toMatchObject({
        source: 'tasks',
        workspace: 'Dự án mới',
        projectName: 'Tasks',
        goal: 'Tên tiếng Việt có dấu',
        root: '',
        file: slash(join(root, 'Công việc/Dự án mới/kế hoạch v1.2.md')),
      });
      expect(out.plans.find((p) => p.name === 'release')?.root).toBe(
        slash(join(root, 'repos/alpha')),
      );
      expect(out.plans.find((p) => p.name === 'legacy')).toMatchObject({
        source: 'legacy',
        workspace: 'alpha',
        projectName: 'Work',
      });
      expect(out.plans.find((p) => p.name === 'shared')?.status).toBe(
        'Testing',
      );
      expect(out.diagnostics).toHaveLength(1);
      expect(out.diagnostics[0]).toMatchObject({
        kind: 'duplicate',
        project: 'work',
        repo: 'alpha',
        plan: 'Shared',
      });
      expect(out.repos.every((r) => r.project !== 'tasks')).toBe(true);
    }));
  it('reports bad plans while preserving good, partial-write and fenced plans', async () =>
    withTemp(async (root) => {
      const out = await collectFixture(
        root,
        fixtures.find((f) => f.name === 'faults')!,
      );
      expect(out.plans.map((p) => p.name).sort()).toEqual([
        'bad-utf8',
        'fence',
        'good',
        'half',
      ]);
      expect(out.diagnostics.map((d) => [d.plan, d.kind])).toEqual([
        ['bad-utf8', 'invalid-utf8'],
        ['fence', 'unclosed-fence'],
        ['grown', 'too-large'],
        ['large', 'too-large'],
        ['locked', 'unreadable'],
      ]);
      expect(out.projects[0]).toMatchObject({ status: 'ok', plans: 4 });
    }));
  it('reports missing projects with fallback names and an injected clock', async () =>
    withTemp(async (root) => {
      await write(root, 'file.txt', 'x');
      const out = await collectOverview(
        {
          projects: [
            { id: 'gone', path: join(root, 'none'), kind: 'folder' },
            {
              id: 'file',
              name: 'F',
              path: join(root, 'file.txt'),
              kind: 'repo',
            },
          ],
        },
        { now: () => new Date(0) },
      );
      expect(out.projects[0]).toMatchObject({
        status: 'missing',
        message: 'Folder not found.',
        name: join(root, 'none'),
      });
      expect(out.projects[1]?.message).toBe(
        'Folder cannot be opened (ENOTDIR).',
      );
      expect(out).toMatchObject({
        generatedAt: '1970-01-01T00:00:00.000Z',
        plans: [],
        repos: [],
        diagnostics: [],
      });
    }));
  it.each(['', 'missing', 'file'])(
    'handles missing or unchosen Tasks folder: %s',
    async (dir) =>
      withTemp(async (root) => {
        await write(root, 'file', 'x');
        const out = await collectOverview({
          tasksDir: dir ? join(root, dir) : '',
        });
        if (!dir) expect(out.projects).toEqual([]);
        else
          expect(out.projects[0]).toMatchObject({
            status: 'missing',
            message:
              dir === 'file'
                ? 'Folder cannot be opened (ENOTDIR).'
                : 'Folder not found.',
          });
      }),
  );
  it('stops before reading when already cancelled', async () => {
    const c = new AbortController();
    c.abort();
    await expect(
      collectOverview({}, { signal: c.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('cancels an in-flight file read promptly even if the reader ignores the signal', async () =>
    withTemp(async (root) => {
      await write(root, 'web/.tasks/a.md', 'a');
      const c = new AbortController();
      const run = collectOverview(
        { projects: [project(root)] },
        {
          signal: c.signal,
          readFile: async () => {
            c.abort();
            return new Promise<Uint8Array>(() => {});
          },
        },
      );
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    }));
  it('bounds injected Git and emits no worktree data or worktree calls', async () =>
    withTemp(async (root) => {
      await write(root, 'web/.git', 'fixture');
      await write(root, 'web/.tasks/a.md', '- [done] a');
      const git = vi.fn(async () => new Promise<string>(() => {}));
      const out = await collectOverview(
        { projects: [project(root)] },
        { git, gitTimeoutMs: 20 },
      );
      expect(out.plans).toHaveLength(1);
      expect(out.repos[0]).toMatchObject({ gh: '', worktrees: [] });
      expect(git).toHaveBeenCalledTimes(1);
      expect(git.mock.calls[0]?.length).toBe(3);
    }));
  it('cancels an in-flight Git call and does not swallow cancellation', async () =>
    withTemp(async (root) => {
      await write(root, 'web/.git', 'fixture');
      const c = new AbortController();
      await expect(
        collectOverview(
          { projects: [project(root)] },
          {
            signal: c.signal,
            git: async () => {
              c.abort();
              return new Promise<string>(() => {});
            },
          },
        ),
      ).rejects.toMatchObject({ name: 'AbortError' });
    }));
  it('links only unique repository names and runs no more than eight Git calls at once', async () =>
    withTemp(async (root) => {
      for (let i = 0; i < 17; i++)
        await write(root, `repos/r${i}/.git`, 'fixture');
      await write(root, 'tasks/R0/a.md', 'a');
      let active = 0,
        max = 0;
      const out = await collectOverview(
        {
          tasksDir: join(root, 'tasks'),
          projects: [project(join(root, 'repos'))],
        },
        {
          git: async (_path, args) => {
            expect(args).toEqual(['remote', 'get-url', 'origin']);
            active++;
            max = Math.max(max, active);
            await new Promise((resolve) => setTimeout(resolve, 5));
            active--;
            return 'git@github.com:owner/sample.git\n';
          },
        },
      );
      expect(max).toBe(8);
      expect(out.plans[0]).toMatchObject({
        root: slash(join(root, 'repos/r0')),
        gh: 'https://github.com/owner/sample',
      });
    }));
  it('keeps legacy when the duplicate Tasks file could not be read', async () =>
    withTemp(async (root) => {
      await write(root, 'tasks/web/a.md', 'unreadable');
      await write(root, 'repos/web/.tasks/a.md', '- [done] legacy');
      const out = await collectOverview(
        {
          tasksDir: join(root, 'tasks'),
          projects: [project(join(root, 'repos'))],
        },
        {
          readFile: async (file) => {
            if (!file.includes('.tasks')) throw new Error('locked');
            return fs.readFile(file);
          },
        },
      );
      expect(out.plans).toHaveLength(1);
      expect(out.plans[0]?.source).toBe('legacy');
      expect(out.diagnostics.map((d) => d.kind)).toEqual(['unreadable']);
    }));
  it('turns unreadable plan folders into warnings and keeps other roots', async () =>
    withTemp(async (root) => {
      await write(root, 'repos/web/.tasks/a.md', 'a');
      await write(root, 'tasks/web/a.md', 'a');
      const original = vi.mocked(fs.readdir).getMockImplementation()!;
      const mock = vi.mocked(fs.readdir).mockImplementation((async (
        path: Parameters<typeof fs.readdir>[0],
        ...args: unknown[]
      ) => {
        if (
          String(path) === join(root, 'tasks/web') ||
          String(path).endsWith(join('web', '.tasks'))
        )
          throw Object.assign(new Error('denied'), { code: 'EACCES' });
        return Reflect.apply(original, fs, [path, ...args]) as Promise<unknown>;
      }) as typeof fs.readdir);
      try {
        const out = await collectOverview({
          tasksDir: join(root, 'tasks'),
          projects: [project(join(root, 'repos'))],
        });
        expect(out.diagnostics.map((d) => [d.kind, d.plan, d.message])).toEqual(
          [
            [
              'folder-unreadable',
              '',
              'The workspace folder cannot be listed (EACCES).',
            ],
            [
              'folder-unreadable',
              '',
              'The older plan folder of this workspace cannot be listed (EACCES).',
            ],
          ],
        );
        expect(out.projects.every((p) => p.status === 'ok')).toBe(true);
      } finally {
        mock.mockImplementation(original);
      }
    }));
  it('sorts newest first with millisecond stable ties', async () =>
    withTemp(async (root) => {
      for (const name of ['a', 'b', 'c'])
        await write(root, `web/.tasks/${name}.md`, name);
      await fs.utimes(join(root, 'web/.tasks/a.md'), 1, 1);
      await fs.utimes(join(root, 'web/.tasks/b.md'), 3, 3);
      await fs.utimes(join(root, 'web/.tasks/c.md'), 3, 3);
      const out = await collectOverview({ projects: [project(root)] });
      expect(out.plans.map((p) => p.name)).toEqual(['b', 'c', 'a']);
    }));
  it('skips disabled projects and treats a file named .tasks as empty', async () =>
    withTemp(async (root) => {
      await write(root, 'web/.tasks', 'file');
      const out = await collectOverview({
        projects: [
          { ...project(root), enabled: false },
          project(join(root, 'web')),
        ],
      });
      expect(out.projects).toHaveLength(1);
      expect(out.plans).toEqual([]);
      expect(await listPlans(join(root, 'web/.tasks'))).toEqual([]);
    }));
  it('supports Windows long paths and case-insensitive access', async () =>
    withTemp(async (root) => {
      const dir = join(
        root,
        'long repository '.repeat(8),
        'nested '.repeat(12),
      );
      await write(dir, '.tasks/plan.md', '- [doing] step');
      const path = process.platform === 'win32' ? dir.toUpperCase() : dir;
      const out = await collectOverview({
        projects: [{ id: 'p', path, kind: 'repo' }],
      });
      expect(out.plans).toHaveLength(1);
      expect(out.plans[0]?.file.toLowerCase()).toBe(
        slash(join(dir, '.tasks/plan.md')).toLowerCase(),
      );
    }));
  it('reads actual Git origin without writes and caches default runner details', async () =>
    withTemp(async (root) => {
      await write(root, '.tasks/a.md', '- [done] a');
      const git = promisify(execFile);
      await git('git', ['-C', root, 'init', '-q'], { windowsHide: true });
      await git(
        'git',
        [
          '-C',
          root,
          'remote',
          'add',
          'origin',
          'https://github.com/owner/sample.git',
        ],
        { windowsHide: true },
      );
      const config = {
        projects: [{ id: 'p', path: root, kind: 'repo' as const }],
      };
      const before = await fs.readFile(join(root, '.git/config'));
      expect((await collectOverview(config)).repos[0]).toMatchObject({
        gh: 'https://github.com/owner/sample',
        worktrees: [],
      });
      expect((await collectOverview(config)).plans[0]?.gh).toBe(
        'https://github.com/owner/sample',
      );
      expect(await fs.readFile(join(root, '.git/config'))).toEqual(before);
    }));
  it.each(
    process.platform === 'win32'
      ? [
          ['C:\\', 'C'],
          ['\\\\server\\share\\', 'share'],
          ['D:\\repo\\', 'repo'],
        ]
      : [
          ['/', 'root'],
          ['/tmp/repo/', 'repo'],
        ],
  )('names repository root %s', (path, name) =>
    expect(repoNameOf(path)).toBe(name),
  );
});
