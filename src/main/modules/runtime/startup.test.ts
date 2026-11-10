import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../../lib/safe-io/test-helpers';
import { assertNoLegacyInstance } from './legacy-instance';
import { prepareDataFolder, retireLegacySession } from './startup';
describe('installed beta cutover sequencing', () => {
  it('lets the guarded mover stop the old runtime before testing its session', async () => {
    let live = true;
    const guard = vi.fn(() => {
      if (live) throw new Error('still running');
    });
    const move = vi.fn(async () => {
      live = false;
      return { completed: true };
    });
    await prepareDataFolder({
      dataDir: 'injected',
      installed: true,
      cleanup: false,
      move,
      guard,
    });
    expect(move).toHaveBeenCalledOnce();
    expect(guard).toHaveBeenCalledOnce();
  });
  it('never migrates an isolated run or uninstall and fails before writers after a failed move', async () => {
    const move = vi.fn(async () => ({ completed: false }));
    const guard = vi.fn();
    await prepareDataFolder({
      dataDir: 'injected',
      installed: false,
      cleanup: false,
      move,
      guard,
    });
    await prepareDataFolder({
      dataDir: 'injected',
      installed: true,
      cleanup: true,
      move,
      guard,
    });
    expect(move).not.toHaveBeenCalled();
    guard.mockClear();
    await expect(
      prepareDataFolder({
        dataDir: 'injected',
        installed: true,
        cleanup: false,
        move,
        guard,
      }),
    ).rejects.toThrow('safely');
    expect(guard).not.toHaveBeenCalled();
  });
  it('retires the beta session file after a completed move so a reused process id cannot block start', async () => {
    const dataDir = tempDir();
    // A live process id: this test process stands in for an unrelated program.
    writeFileSync(
      join(dataDir, 'session.json'),
      JSON.stringify({ pid: process.pid, addr: '127.0.0.1:7790' }),
    );
    expect(() => assertNoLegacyInstance(dataDir)).toThrow();
    await prepareDataFolder({
      dataDir,
      installed: true,
      cleanup: false,
      move: async () => ({ completed: true }),
    });
    expect(existsSync(join(dataDir, 'session.json'))).toBe(false);
    expect(readdirSync(join(dataDir, 'legacy-move'))).toEqual([
      expect.stringMatching(/^session-.+\.json$/),
    ]);
  });
  it('keeps the session file of an isolated run and when no move completed', async () => {
    const dataDir = tempDir();
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, 'session.json'), '{"pid":1}');
    await prepareDataFolder({
      dataDir,
      installed: false,
      cleanup: false,
      move: async () => ({ completed: true }),
      guard: () => {},
    });
    await expect(
      prepareDataFolder({
        dataDir,
        installed: true,
        cleanup: false,
        move: async () => ({ completed: false }),
        guard: () => {},
      }),
    ).rejects.toThrow('safely');
    expect(existsSync(join(dataDir, 'session.json'))).toBe(true);
    retireLegacySession(join(dataDir, 'missing'));
    expect(existsSync(join(dataDir, 'missing'))).toBe(false);
  });
});
