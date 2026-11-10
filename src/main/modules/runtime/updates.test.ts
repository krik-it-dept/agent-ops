import { describe, expect, it, vi } from 'vitest';
import { updateHandlers, type UpdaterPort } from './updates';
import { MutationGate } from './mutation-gate';
import {
  cleanupManagedSkills,
  installedRuntime,
  requireCleanupScope,
} from './cleanup';
import { UpdaterError } from '../updater/errors';
import { mapError } from '../../ipc/errors';

describe('updater and uninstall composition ports', () => {
  it('maps all update requests without inventing state and maps typed updater refusals', async () => {
    const state = { phase: 'idle', current: 'v1.0.0' };
    const updater = {
      getState: vi.fn(() => state),
      check: vi.fn(() => state),
      apply: vi.fn(() => state),
      skip: vi.fn(async () => state),
    } as unknown as UpdaterPort;
    const handlers = updateHandlers(updater);
    expect(await handlers['updates:get']!({})).toBe(state);
    await handlers['updates:check']!({});
    await handlers['updates:apply']!({ version: 'v1.1.0' });
    await handlers['updates:skip']!({ version: 'v1.1.0' });
    expect(updater.apply).toHaveBeenCalledWith('v1.1.0');
    expect(updater.skip).toHaveBeenCalledWith('v1.1.0');
    expect(
      mapError(new UpdaterError('BUSY', 'A check is running.', true)),
    ).toEqual({
      code: 'BUSY',
      message: 'A check is running.',
      retryable: true,
    });
  });
  it('drains accepted changes before handoff, rejects new writes and can reopen after install failure', async () => {
    const gate = new MutationGate();
    let release: (() => void) | undefined;
    const accepted = gate.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    await vi.waitFor(() => expect(release).toBeDefined());
    let drained = false;
    const drain = gate.drain().then(() => {
      drained = true;
    });
    await expect(gate.run(() => {})).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    });
    expect(drained).toBe(false);
    release!();
    await accepted;
    await drain;
    expect(drained).toBe(true);
    gate.reopen();
    await expect(gate.run(() => 42)).resolves.toBe(42);
  });
  it('limits first-start migration and CLI cleanup to the actual default installed scope', () => {
    const scope = {
      packaged: true,
      overridden: false,
      localAppData: 'C:\\Users\\test\\AppData\\Local',
      dataDir: 'C:\\Users\\test\\AppData\\Local\\AgentOps',
      executable:
        'C:\\Users\\test\\AppData\\Local\\Programs\\AgentOps\\agent-ops.exe',
    };
    expect(installedRuntime(scope)).toBe(true);
    for (const change of [
      { packaged: false },
      { overridden: true },
      { dataDir: 'D:\\test' },
      { executable: 'D:\\download\\agent-ops.exe' },
    ]) {
      expect(installedRuntime({ ...scope, ...change })).toBe(false);
      expect(() => requireCleanupScope({ ...scope, ...change })).toThrow();
    }
  });
  it('CLI cleanup uses only listed targets, removes owned reminders first and aborts on a modified file', async () => {
    const run = vi.fn(async () => {});
    await cleanupManagedSkills(
      [
        { id: 'a', instructionBlock: true },
        { id: 'b', instructionBlock: false },
      ],
      run,
    );
    expect(run.mock.calls).toEqual([
      ['a', 'instructions-off'],
      ['a', 'remove'],
      ['b', 'remove'],
    ]);
    const conflict = vi.fn(async () => {
      throw new Error('Modified locally');
    });
    await expect(
      cleanupManagedSkills(
        [
          { id: 'a', instructionBlock: true },
          { id: 'b', instructionBlock: false },
        ],
        conflict,
      ),
    ).rejects.toThrow('Modified locally');
    expect(conflict).toHaveBeenCalledTimes(1);
  });
});
