import { describe, it, expect, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RotatingLogger, LOG_MAX_BYTES, LOG_FILE_COUNT } from './logger';
import { CrashService, installCrashHandlers } from './crash';
import {
  collectDiagnostics,
  createDiagnosticsService,
  diagnosticsText,
  type DiagnosticsInput,
} from './diagnostics';
import type { LogStorage } from './storage';

class MemoryStorage implements LogStorage {
  files = new Map<string, string>();
  fail = false;
  mkdir = vi.fn();
  size(path: string): number {
    return Buffer.byteLength(this.files.get(path) ?? '');
  }
  append(path: string, data: string): void {
    if (this.fail) throw new Error('storage unavailable');
    this.files.set(path, (this.files.get(path) ?? '') + data);
  }
  move(from: string, to: string): void {
    if (this.fail) throw new Error('locked');
    const value = this.files.get(from);
    if (value !== undefined) {
      this.files.set(to, value);
      this.files.delete(from);
    }
  }
  remove(path: string): void {
    if (this.fail) throw new Error('locked');
    this.files.delete(path);
  }
  read(path: string, max: number): string | null {
    return this.size(path) <= max ? (this.files.get(path) ?? null) : null;
  }
  writeAtomic(path: string, data: string): void {
    if (this.fail) throw new Error('storage unavailable');
    this.files.set(path, data);
  }
}
function input(): DiagnosticsInput {
  return {
    versions: {
      app: '0.0.0',
      electron: '45.2.3',
      chromium: '147.0.1',
      node: '24.19.0',
      os: '10.0.26100',
    },
    counts: {
      projects: 2,
      enabledProjects: 1,
      folderProjects: 1,
      plans: 3,
      diagnostics: 0,
      crashes: 0,
    },
    settings: {
      notifications: true,
      startup: false,
      tasksConfigured: true,
      setupComplete: true,
      registrationManaged: false,
      readOnly: false,
      updateChecks: false,
      shortcuts: true,
    },
  };
}
describe('rotating local logging', () => {
  it('keeps the active file and four rotations within their byte cap', () => {
    const storage = new MemoryStorage(),
      logger = new RotatingLogger('profile', {
        storage,
        maxBytes: 220,
        now: () => new Date(0),
      });
    for (let i = 0; i < 12; i++)
      expect(logger.info(`Entry ${i}`, { index: i })).toBe(true);
    expect(storage.files.size).toBe(LOG_FILE_COUNT);
    for (const [path, data] of storage.files) {
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(220);
      expect(path).toContain('logs');
    }
    expect(storage.files.get(join('profile/logs/agent-ops.log'))).toContain(
      'Entry 11',
    );
    expect([...storage.files.values()].join('')).not.toContain('Entry 0"');
    expect(LOG_MAX_BYTES).toBe(1 << 20);
  });
  it('bounds huge Unicode records and keeps app/update files separate', () => {
    const storage = new MemoryStorage();
    const logger = new RotatingLogger('profile', { storage, maxBytes: 200 });
    expect(
      logger.warn('私'.repeat(10000), {
        message: 'x'.repeat(10000),
        invalid: NaN,
      }),
    ).toBe(true);
    expect(
      storage.size(join('profile/logs/agent-ops.log')),
    ).toBeLessThanOrEqual(200);
    new RotatingLogger('profile', { storage, name: 'update' }).info('Update');
    expect(storage.files.has(join('profile/logs/update.log'))).toBe(true);
  });
  it('does not throw or recurse after append or rotation failures', () => {
    const storage = new MemoryStorage(),
      logger = new RotatingLogger('profile', { storage, maxBytes: 128 });
    logger.info('First');
    storage.fail = true;
    expect(logger.error('Second')).toBe(false);
    expect(logger.error('Still failing')).toBe(false);
  });
  it('writes the Node adapter only inside a temporary profile', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-ops-log-unit-'));
    try {
      const logger = new RotatingLogger(root, { maxBytes: 160 });
      for (let i = 0; i < 8; i++) logger.info(`Entry ${i}`);
      expect(await readdir(join(root, 'logs'))).toHaveLength(5);
      const crashes = new CrashService(root, '0.0.0', logger);
      expect(
        crashes.record('uncaught-exception', new Error('local only')),
      ).toBe(true);
      expect(
        JSON.parse(await readFile(join(root, 'crash.json'), 'utf8')),
      ).toMatchObject({ count: 1, kind: 'uncaught-exception' });
      expect((await readdir(root)).some((name) => name.endsWith('.tmp'))).toBe(
        false,
      );
      crashes.dismissCrash();
      expect(crashes.readCrash()).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
describe('crash recovery and redacted diagnostics', () => {
  it('retains a previous Go crash notice without exposing or rewriting its local detail fields', () => {
    const storage = new MemoryStorage();
    const raw = JSON.stringify({
      time: new Date(0).toISOString(),
      version: '0.5.0',
      kind: 'panic',
      count: 4,
      where: 'private handler',
      message: 'private-plan',
    });
    storage.files.set(join('profile/crash.json'), raw);
    const service = new CrashService(
      'profile',
      '0.0.0',
      new RotatingLogger('profile', { storage }),
      storage,
    );
    expect(service.readCrash()).toEqual({
      time: new Date(0).toISOString(),
      version: '0.5.0',
      kind: 'panic',
      count: 4,
    });
    expect(storage.files.get(join('profile/crash.json'))).toBe(raw);
  });
  it('reads a previous marker, increments it and never stores error prose in the notice', () => {
    const storage = new MemoryStorage(),
      logger = new RotatingLogger('profile', { storage });
    const first = new CrashService(
      'profile',
      '1.2.3',
      logger,
      storage,
      () => new Date(0),
    );
    expect(
      first.record('renderer-gone', new Error('private-plan C:\\private')),
    ).toBe(true);
    const next = new CrashService(
      'profile',
      '1.2.4',
      logger,
      storage,
      () => new Date(1),
    );
    expect(next.readCrash()).toEqual({
      time: new Date(0).toISOString(),
      version: '1.2.3',
      kind: 'renderer-gone',
      count: 1,
    });
    next.record('unhandled-rejection', 'local details');
    expect(next.readCrash()).toMatchObject({ count: 2, version: '1.2.4' });
    expect(storage.files.get(join('profile/crash.json'))).not.toContain(
      'private',
    );
    expect(storage.files.get(join('profile/logs/agent-ops.log'))).toContain(
      'private-plan',
    );
    next.dismissCrash();
    expect(next.readCrash()).toBeNull();
  });
  it.each([
    '{',
    '{}',
    '{"kind":"unknown"}',
    'x'.repeat(65537),
    '{"kind":"renderer-gone","time":"invalid","version":"1","count":1}',
  ])('ignores malformed or oversized marker %#', (raw) => {
    const storage = new MemoryStorage();
    storage.files.set(join('profile/crash.json'), raw);
    expect(
      new CrashService(
        'profile',
        '1',
        new RotatingLogger('profile', { storage }),
        storage,
      ).readCrash(),
    ).toBeNull();
  });
  it('handles process exceptions and rejections through injected handlers then exits', () => {
    const storage = new MemoryStorage(),
      crashes = new CrashService(
        'profile',
        '1',
        new RotatingLogger('profile', { storage }),
        storage,
      );
    let exception: (value: unknown) => void = () => {},
      rejection: (value: unknown) => void = () => {};
    const offE = vi.fn(),
      offR = vi.fn(),
      exit = vi.fn();
    const dispose = installCrashHandlers(
      {
        onException(callback) {
          exception = callback;
          return offE;
        },
        onRejection(callback) {
          rejection = callback;
          return offR;
        },
        exit,
      },
      crashes,
    );
    rejection(new Error('private failure'));
    expect(crashes.readCrash()?.kind).toBe('unhandled-rejection');
    exception(new Error('recursive'));
    expect(exit).toHaveBeenCalledTimes(2);
    dispose();
    expect(offE).toHaveBeenCalledOnce();
    expect(offR).toHaveBeenCalledOnce();
    const other = installCrashHandlers(
      {
        onException(callback) {
          exception = callback;
          return () => {};
        },
        onRejection: () => () => {},
        exit,
      },
      crashes,
    );
    exception(new Error('uncaught'));
    expect(crashes.readCrash()?.kind).toBe('uncaught-exception');
    other();
  });
  it('never recursively fails when recording a crash fails', () => {
    const storage = new MemoryStorage(),
      crashes = new CrashService(
        'profile',
        '1',
        new RotatingLogger('profile', { storage }),
        storage,
      );
    storage.fail = true;
    expect(crashes.record('child-process-gone', new Error('x'))).toBe(false);
  });
  it('projects only fixed versions, counts and booleans and copies only generated text', () => {
    const raw = {
      ...input(),
      plan: 'SENSITIVE_NAME',
      path: 'C:\\SENSITIVE_PATH',
      error: 'SENSITIVE_PROSE',
    };
    Object.assign(raw.counts, {
      plans: -1,
      diagnostics: Infinity,
      extra: 'SENSITIVE_EXTRA',
    });
    Object.assign(raw.versions, {
      app: 'C:\\SENSITIVE_VERSION',
      other: 'SENSITIVE_OTHER',
    });
    Object.assign(raw.settings, { notifications: 'SENSITIVE_SETTING' });
    const data = collectDiagnostics(raw);
    expect(data.versions.app).toBe('unknown');
    expect(data.counts.plans).toBe(0);
    expect(data.counts.diagnostics).toBe(0);
    expect(data.settings.notifications).toBe(false);
    expect(JSON.stringify(data)).not.toContain('SENSITIVE');
    const clipboard = { writeText: vi.fn() };
    const service = createDiagnosticsService(() => raw, clipboard);
    expect(service.copy()).toEqual({ copied: true });
    expect(clipboard.writeText).toHaveBeenCalledWith(service.get().text);
    expect(service.get().text).toBe(diagnosticsText(raw));
    expect(service.get().text).not.toContain('SENSITIVE');
  });
});
