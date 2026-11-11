import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  rm,
  readdir,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectOverview, parsePlan } from '../plans';
import { FileOverviewCache } from './cache';
import { LedgerService } from './service';
import {
  emptyOverview,
  type LedgerConfiguration,
  type OverviewCache,
  type Collector,
} from './types';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.useRealTimers();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-ledger-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}
const memoryCache = (): OverviewCache => ({
  load: async () => undefined,
  save: vi.fn(async () => {}),
});
function service(
  configuration: () => Promise<LedgerConfiguration>,
  collect: Collector,
  cache = memoryCache(),
  extra: Partial<ConstructorParameters<typeof LedgerService>[0]> = {},
) {
  const ledger = new LedgerService(
    { version: 'v1.0.0', configuration, collect, cache, ...extra },
    { intervalMs: 40, debounceMs: 10 },
  );
  cleanups.push(() => ledger.stop());
  return ledger;
}
describe('ledger publication, cancellation and filesystem reconciliation', () => {
  it('expires working runs without a file change or manual refresh', async () => {
    const root = await fixture();
    let now = new Date('2026-11-11T00:00:00Z');
    const collect = vi.fn<Collector>(async () => {
      const out = await collectOverview({ tasksDir: root });
      out.plans = [
        {
          ...parsePlan('- [doing] work\n', {
            project: 'tasks',
            repo: 'ws',
            name: 'p',
            mtime: now,
          }),
          runs: [
            {
              runId: '00000000-0000-4000-8000-000000000001',
              agent: 'Codex',
              coordinator: '',
              role: 'coordinator',
              event: 'start',
              active: true,
              startedAt: now.toISOString(),
              updatedAt: now.toISOString(),
              step: null,
              result: '',
            },
          ],
        },
      ];
      return out;
    });
    const changed = vi.fn();
    const ledger = service(
      async () => ({ projects: [], tasksDir: root }),
      collect,
      memoryCache(),
      { now: () => now, changed },
    );
    await ledger.start();
    const generation = ledger.getState().generation;
    now = new Date(now.getTime() + 12 * 60 * 60 * 1000 + 1);
    await vi.waitFor(() =>
      expect(ledger.getState().state.plans[0]?.runs?.[0]?.active).toBe(false),
    );
    expect(ledger.getState().generation).toBe(generation + 1);
    expect(collect).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledTimes(2);
  });
  it('starts empty without polling/collecting and never mutates sources', async () => {
    const collect = vi.fn<Collector>();
    const ledger = service(async () => ({ projects: [] }), collect);
    await ledger.start();
    vi.useFakeTimers();
    await vi.advanceTimersByTimeAsync(60000);
    expect(collect).not.toHaveBeenCalled();
    expect(ledger.getState().generation).toBe(1);
    expect(ledger.getState().state.plans).toEqual([]);
  });
  it('keeps the last good overview/time on failure and emits one revision per publication', async () => {
    const root = await fixture();
    const file = join(root, 'Tasks', 'team', 'plan.md');
    await mkdir(join(root, 'Tasks', 'team'), { recursive: true });
    await writeFile(file, 'Status: Implementing\nGoal: Ship\n- [doing] Work\n');
    let fail = false;
    const changed = vi.fn();
    const collect: Collector = (c, signal) =>
      fail
        ? Promise.reject(new Error('PRIVATE SOURCE DETAILS'))
        : collectOverview(c, {
            signal,
            now: () => new Date('2026-11-10T01:00:00Z'),
          });
    const ledger = service(
      async () => ({ projects: [], tasksDir: join(root, 'Tasks') }),
      collect,
      new FileOverviewCache(join(root, 'data')),
      { changed },
    );
    await ledger.start();
    const good = ledger.getState();
    expect(good.state.plans[0]?.goal).toBe('Ship');
    expect(
      JSON.parse(await readFile(join(root, 'data', 'overview.json'), 'utf8')),
    ).toEqual(good.state);
    fail = true;
    await ledger.refresh();
    expect(ledger.getState().state).toEqual(good.state);
    expect(ledger.getState().warnings.join()).not.toContain('PRIVATE');
    expect(ledger.getState().error).not.toBe('');
    expect(changed.mock.calls.at(-1)).toEqual([{ generation: 2 }]);
    expect(await readFile(file, 'utf8')).toContain('Goal: Ship');
  });
  it('coalesces manual requests and reads again once if invalidated while reading', async () => {
    const root = await fixture();
    let release: (() => void) | undefined;
    const collect = vi
      .fn<Collector>()
      .mockImplementationOnce(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return emptyOverview(new Date());
      })
      .mockResolvedValue(emptyOverview(new Date()));
    const ledger = service(
      async () => ({ projects: [], tasksDir: root }),
      collect,
    );
    const first = ledger.refresh();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(ledger.refresh()).toBe(first);
    ledger.invalidate();
    ledger.invalidate();
    release!();
    await first;
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(2));
  });
  it('cancels a pending read and never publishes after stop', async () => {
    const root = await fixture();
    const changed = vi.fn();
    const collect = vi.fn<Collector>().mockImplementation(
      (_c, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const ledger = service(
      async () => ({ projects: [], tasksDir: root }),
      collect,
      memoryCache(),
      { changed },
    );
    const start = ledger.start();
    await vi.waitFor(() => expect(collect).toHaveBeenCalled());
    await ledger.stop();
    await start;
    expect(changed).not.toHaveBeenCalled();
  });
  it('bounds a read deadline and exposes a retryable warning without a retry storm', async () => {
    const root = await fixture();
    const collect = vi.fn<Collector>().mockImplementation(
      (_c, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason), {
            once: true,
          }),
        ),
    );
    const ledger = service(
      async () => ({ projects: [], tasksDir: root }),
      collect,
      memoryCache(),
      { timeoutMs: 20 },
    );
    await ledger.start();
    expect(ledger.getState().error).toContain('too long');
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(collect).toHaveBeenCalledTimes(1);
  });
  it('reconciles missing Tasks roots, edits, rename and removal including dropped native events', async () => {
    const root = await fixture();
    const tasks = join(root, 'Tasks');
    const config = { projects: [], tasksDir: tasks };
    const collect = vi.fn<Collector>((c, signal) =>
      collectOverview(c, { signal }),
    );
    const ledger = service(async () => config, collect);
    await ledger.start();
    await mkdir(join(tasks, 'team'), { recursive: true });
    const file = join(tasks, 'team', 'plan.md');
    await writeFile(file, 'Status: Testing\n- [doing] Read me\n');
    await vi.waitFor(() =>
      expect(ledger.getState().state.plans).toHaveLength(1),
    );
    await writeFile(file, 'Status: Done\n- [done] Read me\n');
    await vi.waitFor(() =>
      expect(ledger.getState().state.plans[0]?.status).toBe('Done'),
    );
    await rm(file);
    await vi.waitFor(() =>
      expect(ledger.getState().state.plans).toHaveLength(0),
    );
    const count = collect.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 180));
    expect(collect.mock.calls.length).toBe(count);
  });
  it('reports an activity/cache write failure while preserving a readable fresh overview', async () => {
    const root = await fixture();
    const ledger = service(
      async () => ({ projects: [], tasksDir: root }),
      async () => emptyOverview(new Date()),
      {
        load: async () => undefined,
        save: async () => {
          throw new Error('disk full');
        },
      },
      {
        activity: {
          apply: async () => {
            throw new Error('activity full');
          },
          snapshot: () => ({ activity: [], stale: {} }),
        },
      },
    );
    await ledger.start();
    expect(ledger.getState().error).toBe('');
    expect(ledger.getState().warnings).toEqual([
      'Recent changes could not be saved.',
      'The overview could not be saved.',
    ]);
  });
  it('freezes background persistence for installer handoff and resumes after failure', async () => {
    const root = await fixture();
    const collect = vi.fn<Collector>(async () => emptyOverview(new Date()));
    const save = vi.fn(async () => {});
    const ledger = service(
      async () => ({ projects: [], tasksDir: root }),
      collect,
      { load: async () => undefined, save },
    );
    await ledger.start();
    await ledger.suspend();
    ledger.invalidate();
    await ledger.refresh();
    expect(collect).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    ledger.resumeAfterInstallFailure();
    await ledger.settled();
    expect(collect).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenCalledTimes(2);
  });
  it('ignores corrupt caches and leaves no temporary file after atomic replacement', async () => {
    const root = await fixture();
    const cache = new FileOverviewCache(root);
    await writeFile(join(root, 'overview.json'), '{bad');
    expect(await cache.load()).toBeUndefined();
    const overview = emptyOverview(new Date());
    await cache.save(overview);
    expect(await cache.load()).toEqual(overview);
    expect(await readdir(root)).toEqual(['overview.json']);
  });
});
