import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectOverview } from '../plans';
import { createRuntime } from './services';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-composition-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const changed = vi.fn();
  const runtime = createRuntime({
    dataDir: join(root, 'data'),
    profileDir: join(root, 'profile'),
    version: 'v1.0.0',
    worker: () => {
      throw new Error('Injected collector should be used.');
    },
    collector: (c, signal) => collectOverview(c, { signal }),
    changed,
    settingsChanged: changed,
  });
  cleanup.push(() => runtime.stop());
  await runtime.start();
  return { root, runtime, changed };
}
describe('composition adapters with real libraries and isolated files', () => {
  it('passes the scoped first-release folder migration to the shared settings owner', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-scoped-migration-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const reposDir = join(root, 'former-workspaces');
    await mkdir(reposDir);
    const runtime = createRuntime({
      dataDir: join(root, 'data'),
      profileDir: join(root, 'profile'),
      version: 'v1.0.0',
      legacy: { reposDir },
      worker: () => {
        throw new Error('No collector in initialization');
      },
      changed: () => {},
    });
    cleanup.push(() => runtime.stop());
    await runtime.initialize();
    expect(runtime.core.store.get().projects).toMatchObject([
      { path: reposDir, kind: 'folder' },
    ]);
  });
  it('uses the real version1 store and full Settings DTO, preserving Skills across concurrent preferences', async () => {
    const { root, runtime } = await fixture();
    const input = join(root, 'tools', 'skills');
    await mkdir(join(root, 'tools'), { recursive: true });
    const [added] = await Promise.all([
      runtime.handlers['skills:add']!({ skillDir: input }),
      runtime.handlers['settings:set']!({ theme: 'dark', shortcuts: false }),
    ]);
    const target = (added as { added: string }).added;
    const settings = await runtime.handlers['settings:get']!({});
    expect(settings).toMatchObject({
      theme: 'dark',
      shortcuts: false,
      setupRequired: true,
      startupManaged: false,
      tasksDir: '',
      previousPlanCount: 0,
      legacyPlanCount: 0,
      projects: [],
      version: 'v1.0.0',
    });
    const config = JSON.parse(
      await readFile(join(root, 'data', 'config.json'), 'utf8'),
    ) as { version: number; integrations: { id: string }[]; theme: string };
    expect(config.version).toBe(1);
    expect(config.theme).toBe('dark');
    expect(config.integrations[0]?.id).toBe(target);
    await runtime.handlers['skills:install']!({ id: target });
    expect(
      await readFile(join(input, 'task-plan', 'SKILL.md'), 'utf8'),
    ).toContain('agent-ops-skill: 4');
    // Regression: a preferences save after Skills installed must keep its recorded hashes.
    await runtime.handlers['settings:set']!({ theme: 'light' });
    const saved = JSON.parse(
      await readFile(join(root, 'data', 'config.json'), 'utf8'),
    );
    expect(saved.theme).toBe('light');
    expect(saved.integrations[0]).toMatchObject({
      id: target,
      version: 4,
      sha256: expect.any(String),
    });
  });
  it('collects workspace plans, moves into Tasks with reports, preserves source bytes and records one move', async () => {
    const { root, runtime } = await fixture();
    const workspace = join(root, 'workspace');
    await mkdir(join(workspace, '.tasks'), { recursive: true });
    const source = 'Status: Implementing\nGoal: Deliver\n- [doing] Real work\n';
    await writeFile(join(workspace, '.tasks', 'move.md'), source);
    await runtime.handlers['workspaces:add']!({ path: workspace });
    expect(runtime.ledger.getState().state.plans).toHaveLength(1);
    expect(await runtime.handlers['settings:get']!({})).toMatchObject({
      legacyPlanCount: 1,
    });
    const tasks = join(root, 'Tasks');
    await runtime.handlers['settings:set']!({ tasksDir: tasks });
    const moved = await runtime.handlers['tasks:move-legacy']!({});
    expect(moved).toMatchObject({
      moved: 1,
      failed: 0,
      settings: { legacyPlanCount: 0, tasksDir: tasks },
    });
    expect(await readFile(join(tasks, 'workspace', 'move.md'), 'utf8')).toBe(
      source,
    );
    expect(await readFile(join(root, 'data', 'tasks-dir.txt'), 'utf8')).toBe(
      tasks + '\n',
    );
    const state = runtime.ledger.getState();
    expect(state.state.plans[0]?.source).toBe('tasks');
    expect(
      state.activity.filter((e) => (e as { kind: string }).kind === 'moved'),
    ).toHaveLength(1);
    await runtime.handlers['plans:archive']!({
      key: 'tasks/workspace/move',
      archived: true,
    });
    expect(runtime.ledger.getState().planArchive).toMatchObject({
      'tasks/workspace/move': true,
    });
    expect(await readFile(join(tasks, 'workspace', 'move.md'), 'utf8')).toBe(
      source,
    );
  });
  it('keeps platform mutations unavailable until injected and respects newer config', async () => {
    const { root, runtime } = await fixture();
    await expect(
      runtime.handlers['settings:set']!({
        startWithWindows: true,
        tasksDir: join(root, 'unaccepted-tasks'),
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(runtime.core.store.get().tasksDir).toBe('');
    await runtime.stop();
    await writeFile(
      join(root, 'data', 'config.json'),
      '{"version":999,"private":"keep"}',
    );
    await writeFile(
      join(root, 'data', 'tasks-dir.txt'),
      'D:\\existing-pointer\n',
    );
    const next = createRuntime({
      dataDir: join(root, 'data'),
      profileDir: join(root, 'profile'),
      version: 'v1.0.0',
      worker: () => {
        throw new Error('no collector');
      },
      changed: () => {},
    });
    cleanup.push(() => next.stop());
    await next.start();
    expect(await next.handlers['settings:get']!({})).toMatchObject({
      readOnly: expect.any(String),
      setupRequired: false,
    });
    await expect(
      next.handlers['skills:add']!({ skillDir: join(root, 'tools') }),
    ).rejects.toThrow();
    expect(await readFile(join(root, 'data', 'config.json'), 'utf8')).toBe(
      '{"version":999,"private":"keep"}',
    );
    expect(await readFile(join(root, 'data', 'tasks-dir.txt'), 'utf8')).toBe(
      'D:\\existing-pointer\n',
    );
  });
  it('refuses overlapping source moves instead of queuing stale requests', async () => {
    const { root, runtime } = await fixture();
    let release: (() => void) | undefined;
    vi.spyOn(runtime.core.tasks, 'setTasksDir').mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return {
        ok: true,
        value: { pointerProblems: [], config: runtime.core.store.get() },
      } as Awaited<ReturnType<typeof runtime.core.tasks.setTasksDir>>;
    });
    const first = runtime.handlers['settings:set']!({
      tasksDir: join(root, 'Tasks'),
    });
    await vi.waitFor(() => expect(release).toBeDefined());
    try {
      await expect(
        runtime.handlers['tasks:move-all']!({ from: join(root, 'Old') }),
      ).rejects.toMatchObject({ code: 'BUSY' });
    } finally {
      release!();
      await first;
    }
  });
  it('upgrades a legacy owner-style map before Skills is exposed and remains writable', async () => {
    const { root, runtime } = await fixture();
    await runtime.stop();
    const old = JSON.parse(
      await readFile(
        'tests/fixtures/settings/owner-legacy-config.json',
        'utf8',
      ),
    );
    old.projects = [];
    old.tasksDir = ''; // Fixture references stay data; never probe its machine paths.
    const original = JSON.stringify(old);
    await writeFile(join(root, 'data', 'config.json'), original);
    const next = createRuntime({
      dataDir: join(root, 'data'),
      profileDir: join(root, 'profile'),
      version: 'v1.0.0',
      worker: () => {
        throw new Error('must not collect');
      },
      changed: () => {},
    });
    cleanup.push(() => next.stop());
    await next.initialize();
    expect(await next.handlers['skills:list']!({})).toMatchObject({
      readOnly: '',
      targets: [],
    });
    await mkdir(join(root, 'tools'), { recursive: true });
    expect(
      await next.handlers['skills:add']!({
        skillDir: join(root, 'tools', 'skills'),
      }),
    ).toMatchObject({ added: expect.any(String), readOnly: '' });
    const after = JSON.parse(
      await readFile(join(root, 'data', 'config.json'), 'utf8'),
    );
    expect(Array.isArray(after.integrations)).toBe(true);
    expect(after.futureFeature).toEqual(old.futureFeature);
  });
});

describe('agent runs in the runtime', () => {
  it('prunes old runs at start, reads new reports with the plans and logs them as activity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-runs-'));
    cleanup.push(() => rm(root, { recursive: true, force: true }));
    const data = join(root, 'data');
    const tasks = join(root, 'tasks');
    const plan = join(tasks, 'ws', 'plan.md');
    await mkdir(join(tasks, 'ws'), { recursive: true });
    await mkdir(join(data, 'runs'), { recursive: true });
    await writeFile(
      plan,
      'Agent: Claude\nStatus: Implementing\n## M1: A\n- [doing] Build it <!-- Executors: Codex -->\n',
    );
    await writeFile(
      join(data, 'config.json'),
      JSON.stringify({
        version: 1,
        setupComplete: true,
        tasksDir: tasks,
        projects: [],
      }),
    );
    const old = '00000000-0000-4000-8000-000000000009';
    const ended = '2020-01-01T00:00:00.000Z';
    const line = (event: string) =>
      JSON.stringify({
        v: 1,
        runId: old,
        at: ended,
        event,
        agent: 'Codex',
        coordinator: '',
        role: 'coordinator',
        file: 'C:/gone.md',
        revision: '',
        step: null,
        result: event === 'done' ? 'x' : '',
      }) + '\n';
    await writeFile(
      join(data, 'runs', `${old}.jsonl`),
      line('start') + line('done'),
    );
    const runtime = createRuntime({
      dataDir: data,
      profileDir: join(root, 'profile'),
      version: 'v1.0.0',
      worker: () => {
        throw new Error('Injected collector should be used.');
      },
      collector: (c, signal) => collectOverview(c, { signal }),
      changed: () => {},
      reportCommand: join(root, 'Programs', 'agent-ops.exe'),
    });
    cleanup.push(() => runtime.stop());
    await runtime.start();
    expect(await readFile(join(data, 'report-command.txt'), 'utf8')).toBe(
      join(root, 'Programs', 'agent-ops.exe') + '\n',
    );
    await expect(
      readFile(join(data, 'runs', `${old}.jsonl`)),
    ).rejects.toThrow();
    const first = runtime.ledger.getState().state.plans[0]!;
    expect(first.agent).toBe('Claude');
    expect(first.steps[0]!.executors).toEqual(['Codex']);
    expect(first.runs).toBeUndefined();
    const { runReport } = await import('../runs');
    const started = await runReport(
      [
        '--agent',
        'Codex',
        '--plan-file',
        plan,
        '--step-line',
        '4',
        '--event',
        'start',
      ],
      { dataDir: data },
    );
    expect(started.stderr).toBe('');
    await runtime.ledger.refresh();
    const state = runtime.ledger.getState();
    expect(state.state.plans[0]!.runs).toMatchObject([
      {
        runId: started.stdout.trim(),
        agent: 'Codex',
        coordinator: 'Claude',
        role: 'executor',
        event: 'start',
        active: true,
        step: { line: 4, text: 'Build it', milestone: 'M1' },
      },
    ]);
    expect(state.activity[0]).toMatchObject({
      kind: 'run-started',
      actor: 'Codex',
      text: 'Build it',
      plan: 'plan',
    });
  });
});
