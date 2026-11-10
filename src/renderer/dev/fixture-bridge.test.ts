import { afterEach, describe, expect, it, vi } from 'vitest';
import { BridgeFailure, createClient } from '../client';
import { createFixtureBridge, fixtureData } from './fixture-bridge';

afterEach(() => vi.useRealTimers());
describe('fixture and real clients share the same contract', () => {
  it('provides Vietnamese, many workspaces, legacy, blockers, warnings and update data', () => {
    const data = fixtureData();
    expect(data.snapshot.state.plans.length).toBeGreaterThan(12);
    expect(data.snapshot.state.plans.some((p) => p.source === 'legacy')).toBe(
      true,
    );
    expect(
      data.snapshot.state.plans.some((p) => p.status.startsWith('Blocked')),
    ).toBe(true);
    expect(data.snapshot.state.diagnostics).toHaveLength(1);
    expect(data.update.available).toBe(true);
    expect(data.skills.targets.map((t) => t.state)).toEqual([
      'installed',
      'modified',
      'update-available',
    ]);
  });
  it('publishes coherent changes and supports idempotent subscription cleanup', async () => {
    const bridge = createFixtureBridge();
    const client = createClient(bridge);
    const events = vi.fn(),
      settings = vi.fn();
    const off = client.state.onChanged(events),
      offSettings = client.settings.onChanged(settings);
    await client.settings.set({ theme: 'dark' });
    expect(events).toHaveBeenCalledOnce();
    expect(settings).toHaveBeenCalledWith(
      expect.objectContaining({ theme: 'dark' }),
    );
    off();
    off();
    offSettings();
    await client.settings.set({ theme: 'light' });
    expect(events).toHaveBeenCalledOnce();
    expect((await client.settings.get({})).theme).toBe('light');
  });
  it('preserves plan source status when archiving and returns revision conflicts for stale recycle requests', async () => {
    const client = createClient(createFixtureBridge());
    const before = await client.state.get({}),
      plan = before.state.plans[0]!,
      key = `${plan.project}/${plan.repo}/${plan.name}`;
    await client.plans.archive({ key, archived: true });
    expect((await client.state.get({})).state.plans[0]).toEqual(plan);
    await expect(
      client.plans.recycle({ key, revision: 'b'.repeat(64), confirm: true }),
    ).rejects.toMatchObject({ detail: { code: 'REVISION_CHANGED' } });
    await client.plans.recycle({ key, revision: plan.revision, confirm: true });
    expect((await client.state.get({})).state.plans).toHaveLength(
      before.state.plans.length - 1,
    );
  });
  it('uses structured error codes for inside-workspace confirmation and reports every move result', async () => {
    const client = createClient(createFixtureBridge());
    await expect(
      client.settings.set({ tasksDir: 'C:\\InsideWorkspace\\Tasks' }),
    ).rejects.toBeInstanceOf(BridgeFailure);
    await expect(
      client.settings.set({ tasksDir: 'C:\\InsideWorkspace\\Tasks' }),
    ).rejects.toMatchObject({ detail: { code: 'INSIDE_WORKSPACE' } });
    expect(
      (
        await client.settings.set({
          tasksDir: 'C:\\InsideWorkspace\\Tasks',
          allowInsideWorkspace: true,
        })
      ).tasksDir,
    ).toContain('InsideWorkspace');
    const move = await client.tasks.moveLegacy({});
    expect(move.results).toHaveLength(2);
    expect(move.failed).toBe(1);
    expect(move.results[1]!.error).toContain('left in place');
  });
  it('cancels native picker simulations with a successful cancellation result', async () => {
    vi.useFakeTimers();
    const client = createClient(createFixtureBridge());
    const pending = client.shell.pick({
      requestId: 'picker-1',
      purpose: 'workspace',
    });
    expect(await client.shell.cancelPick({ requestId: 'picker-1' })).toEqual({
      cancelled: true,
    });
    expect(await pending).toEqual({ cancelled: true });
    expect(await client.shell.cancelPick({ requestId: 'picker-1' })).toEqual({
      cancelled: false,
    });
  });
  it('normalizes the update sequence without executing a restart or touching files', async () => {
    vi.useFakeTimers();
    const client = createClient(createFixtureBridge());
    const phases: string[] = [];
    const off = client.updates.onChanged((value) => phases.push(value.phase));
    await client.updates.apply({ version: 'v0.5.1' });
    await vi.runAllTimersAsync();
    off();
    expect(phases).toEqual([
      'downloading',
      'verifying',
      'installing',
      'restarting',
      'updated',
    ]);
    expect((await client.updates.get({})).current).toBe('v0.5.1');
  });
  it('retains previous state and last successful timestamp after a refresh failure', async () => {
    const client = createClient(createFixtureBridge('error'));
    const before = await client.state.get({});
    await expect(client.state.refresh({})).rejects.toMatchObject({
      detail: { code: 'REFRESH_FAILED' },
    });
    expect(await client.state.get({})).toEqual(before);
  });
});
