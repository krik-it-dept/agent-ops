import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlatformServices } from '../platform';
import { PlatformError } from '../platform/types';
import { collectOverview } from '../plans';
import { createRuntime } from './services';
import {
  activationKey,
  diagnosticSnapshot,
  environmentAdapter,
  fixedDriveProbe,
  pathPolicy,
  platformHandlers,
  RELEASES,
  startupAdapter,
} from './platform';
import { writeTasksEnv } from '../tasks';
import { mapError } from '../../ipc/errors';
import { shortPath } from '../../lib/safe-io/test-helpers';

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) await fn();
});
async function fixture(shortName = false) {
  const root = await mkdtemp(join(tmpdir(), 'agent-ops-platform-composition-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runtime = createRuntime({
    dataDir: join(root, 'data'),
    profileDir: join(root, 'profile'),
    version: 'v1.0.0',
    worker: () => {
      throw new Error('Use injected collector');
    },
    collector: (c, signal) => collectOverview(c, { signal }),
    changed: () => {},
  });
  cleanups.push(() => runtime.stop());
  await runtime.start();
  const workspace = join(root, 'workspace');
  await mkdir(join(workspace, '.tasks'), { recursive: true });
  await writeFile(
    join(workspace, '.tasks', 'plan.md'),
    'Status: Implementing\nGoal: Test integration\n- [doing] Check ports\n',
  );
  await runtime.handlers['workspaces:add']!({
    path: shortName ? shortPath(workspace) : workspace,
  });
  return { root, runtime, workspace };
}

describe('platform composition adapters', () => {
  it('binds pick/cancel to a trusted sender scope and constructs only known links', async () => {
    const { runtime } = await fixture();
    const pick = vi.fn(async () => ({ cancelled: true }));
    const cancelPick = vi.fn(async () => ({ cancelled: true }));
    const openExternal = vi.fn(async () => {});
    const activate = vi.fn();
    const platform = {
      picker: { pick, cancelPick },
      diagnostics: {
        get: () => ({ text: 'redacted' }),
        copy: () => ({ copied: true }),
      },
      crashes: { dismissCrash: vi.fn() },
    } as unknown as PlatformServices;
    const handlers = platformHandlers({
      platform,
      core: runtime.core,
      ledger: runtime.ledger,
      senderScope: 'main-window-7',
      activate,
      openExternal,
    });
    await handlers['shell:pick']!({ requestId: 'one', purpose: 'tasks' });
    await handlers['shell:cancel-pick']!({ requestId: 'one' });
    expect(pick).toHaveBeenCalledWith(
      { requestId: 'one', purpose: 'tasks' },
      'main-window-7',
    );
    expect(cancelPick).toHaveBeenCalledWith(
      { requestId: 'one' },
      'main-window-7',
    );
    await handlers['shell:open-external']!({
      target: 'release',
      version: 'v1.2.3',
    });
    expect(openExternal).toHaveBeenCalledWith(RELEASES + 'v1.2.3');
    await expect(
      handlers['shell:open-external']!({
        target: 'pull-request',
        key: 'unknown/plan',
        number: 1,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await handlers['app:open']!({ plan: 'workspace/plan' });
    expect(activate).toHaveBeenCalledWith({
      plan: activationKey(runtime.ledger, 'workspace/plan'),
    });
    expect(await handlers['diagnostics:get']!({})).toEqual({
      text: 'redacted',
    });
    expect(
      mapError(new PlatformError('TIMEOUT', 'The picker timed out.', true)),
    ).toEqual({
      code: 'TIMEOUT',
      message: 'The picker timed out.',
      retryable: true,
    });
  });
  it('allows only configured directories and unchanged regular plan files on a fixed drive', async () => {
    const { root, runtime, workspace } = await fixture();
    const fixedDrive = vi.fn(async () => true);
    const allow = pathPolicy({
      dataDir: runtime.core.dataDir,
      core: () => runtime.core,
      ledger: () => runtime.ledger,
      fixedDrive,
    });
    expect(await allow(root, 'open-folder')).toBe(false);
    expect(await allow(workspace, 'open-folder')).toBe(true);
    const file = join(workspace, '.tasks', 'plan.md');
    expect(await allow(file, 'trash')).toBe(true);
    await writeFile(file, 'Status: Done\n- [done] Changed before deletion\n');
    expect(await allow(file, 'trash')).toBe(false);
    expect(await allow('\\\\server\\share\\plan.md', 'trash')).toBe(false);
    fixedDrive.mockResolvedValue(false);
    expect(await allow(file, 'trash')).toBe(false);
  });
  it('opens a pull request of the repository the reader recorded', async () => {
    const openExternal = vi.fn(async () => {});
    const gh: Record<string, string> = {
      'w/r/plan': 'https://github.com/owner/repo.name',
      'w/r/local': '',
      'w/r/odd': 'https://github.com/owner/..',
    };
    const handlers = platformHandlers({
      platform: {} as PlatformServices,
      core: {} as never,
      ledger: {
        findPlan: (key: string) =>
          key in gh ? ({ gh: gh[key] } as never) : undefined,
      } as never,
      senderScope: '1',
      activate: vi.fn(),
      openExternal,
    });
    await handlers['shell:open-external']!({
      target: 'pull-request',
      key: 'w/r/plan',
      number: 42,
    });
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/owner/repo.name/pull/42',
    );
    for (const key of ['w/r/local', 'w/r/odd', 'w/r/missing'])
      await expect(
        handlers['shell:open-external']!({
          target: 'pull-request',
          key,
          number: 1,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect(openExternal).toHaveBeenCalledOnce();
  });
  it('allows the Recycle Bin for a plan of a workspace added by its 8.3 short name', async () => {
    const { runtime, workspace } = await fixture(true);
    const allow = pathPolicy({
      dataDir: runtime.core.dataDir,
      core: () => runtime.core,
      ledger: () => runtime.ledger,
      fixedDrive: async () => true,
    });
    const file = join(workspace, '.tasks', 'plan.md');
    expect(await allow(file, 'trash')).toBe(true);
    expect(await allow(shortPath(file), 'trash')).toBe(true);
  });
  it('delegates environment clearing and deduplication to the platform writer with one broadcast', async () => {
    const setUserEnv = vi.fn(async () => ({ managed: true, changed: true }));
    const platform = {
      environment: { setUserEnv },
    } as unknown as PlatformServices;
    await writeTasksEnv(environmentAdapter(platform), '');
    await writeTasksEnv(environmentAdapter(platform), 'D:\\Tasks');
    expect(setUserEnv.mock.calls).toEqual([
      ['AGENT_OPS_TASKS', null],
      ['AGENT_OPS_TASKS', 'D:\\Tasks'],
    ]);
  });
  it('adapts startup readback, aggregates diagnostics and passes drive values as data', async () => {
    const { runtime } = await fixture();
    const changed = vi.fn();
    const set = vi.fn();
    const platform = {
      startup: {
        managed: true,
        get: () => ({ enabled: true, managed: true }),
        set,
      },
    } as unknown as PlatformServices;
    const startup = startupAdapter(platform, changed);
    expect(await startup.get()).toBe(true);
    await startup.set(false);
    expect(set).toHaveBeenCalledWith(false);
    expect(changed).toHaveBeenCalledOnce();
    const snapshot = diagnosticSnapshot(runtime.core, runtime.ledger, false);
    expect(snapshot.counts?.plans).toBe(1);
    expect(snapshot.settings?.updateChecks).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('workspace');
    const run = vi.fn<
      (script: string, env: NodeJS.ProcessEnv) => Promise<number>
    >(async () => 0);
    const probe = fixedDriveProbe(run);
    expect(await probe('C:\\Tasks\\one.md')).toBe(true);
    expect(run.mock.calls[0]?.[1]).toMatchObject({ AGENT_OPS_DRIVE: 'C:\\' });
    expect(await probe('\\\\host\\share\\one.md')).toBe(false);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
