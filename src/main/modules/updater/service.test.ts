import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { UpdaterError } from './errors';
import { UpdaterService, type Scheduler, type UpdaterOptions } from './service';
import { UpdateStore } from './store';
import type {
  DownloadProgress,
  UpdateCandidate,
  UpdaterEvent,
  UpdateProvider,
  UpdateState,
} from './types';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** Timers that run only when the test advances the clock. */
class FakeScheduler implements Scheduler {
  now = 0;
  private timers: { at: number; fn: () => void; id: number }[] = [];
  private next = 1;
  setTimeout(fn: () => void, ms: number): unknown {
    const id = this.next++;
    this.timers.push({ at: this.now + ms, fn, id });
    return id;
  }
  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter((t) => t.id !== handle);
  }
  get pending(): number {
    return this.timers.length;
  }
  advance(ms: number): void {
    const until = this.now + ms;
    for (;;) {
      const due = this.timers
        .filter((t) => t.at <= until)
        .sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.now = due.at;
      due.fn();
    }
    this.now = until;
  }
}

class FakeProvider implements UpdateProvider {
  checks = 0;
  installs = 0;
  downloads: string[] = [];
  candidate: UpdateCandidate | null = null;
  checkError: unknown = null;
  downloadError: unknown = null;
  progress: number[] = [50, 100];
  /** When set, download waits until release() is called. */
  hold: { release: () => void } | null = null;
  holdNext = false;
  async check(): Promise<UpdateCandidate | null> {
    this.checks++;
    if (this.checkError) throw this.checkError;
    return this.candidate;
  }
  async download(
    version: string,
    onProgress: (p: DownloadProgress) => void,
    signal: AbortSignal,
  ): Promise<void> {
    this.downloads.push(version);
    if (this.holdNext) {
      await new Promise<void>((resolve, reject) => {
        this.hold = { release: resolve };
        signal.addEventListener('abort', () => reject(new Error('cancelled')));
      });
    }
    for (const percent of this.progress) {
      onProgress({
        percent,
        transferred: percent,
        total: 100,
        bytesPerSecond: 1,
      });
    }
    if (this.downloadError) throw this.downloadError;
  }
  async install(): Promise<void> {
    this.installs++;
  }
}

function setup(overrides: Partial<UpdaterOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-ops-updater-'));
  roots.push(dataDir);
  const provider = new FakeProvider();
  const scheduler = new FakeScheduler();
  const store = new UpdateStore(dataDir);
  const events: UpdaterEvent[] = [];
  const states: UpdateState[] = [];
  const service = new UpdaterService({
    currentVersion: '1.2.0',
    commit: 'abc1234',
    processId: 4242,
    packaged: true,
    provider,
    store,
    scheduler,
    now: () => new Date('2026-11-10T10:00:00Z'),
    ...overrides,
  });
  service.onEvent((e) => events.push(e));
  service.onState((s) => states.push(s));
  return { dataDir, provider, scheduler, store, service, events, states };
}

function expectError(fn: () => unknown, code: UpdaterError['code']): void {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(UpdaterError);
  expect((caught as UpdaterError).code).toBe(code);
}

describe('UpdaterService', () => {
  it('is off in development and for dev versions, and never calls the provider', async () => {
    for (const options of [
      { packaged: false },
      { currentVersion: '0.0.0' },
      { currentVersion: '1.3.0-dev.12' },
      { currentVersion: '1.3.0-beta.1' },
    ]) {
      const t = setup(options);
      await t.service.start();
      expect(t.service.isEnabled).toBe(false);
      expect(t.scheduler.pending).toBe(0);
      expect(t.service.getState()).toMatchObject({
        phase: 'idle',
        message: expect.stringContaining('installed release'),
      });
      expectError(() => t.service.check(), 'UNAVAILABLE');
      expectError(() => t.service.apply('v1.3.0'), 'UNAVAILABLE');
      await expect(t.service.skip('v1.3.0')).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      });
      expect(t.provider.checks).toBe(0);
    }
  });

  it('checks shortly after start and every six hours, without downloading', async () => {
    const t = setup();
    t.provider.candidate = {
      version: '1.3.0',
      notes: '<p>Faster <b>ledger</b> &amp; fixes</p><ul><li>One</li></ul>',
    };
    await t.service.start();
    expect(t.service.getState()).toMatchObject({
      current: 'v1.2.0',
      commit: 'abc1234',
      processId: 4242,
      phase: 'idle',
    });
    t.scheduler.advance(2999);
    expect(t.provider.checks).toBe(0);
    t.scheduler.advance(1);
    await t.service.settled();
    expect(t.provider.checks).toBe(1);
    expect(t.service.getState()).toMatchObject({
      phase: 'available',
      available: true,
      latest: 'v1.3.0',
      skipped: false,
      notes: 'Faster ledger & fixes\n- One',
      checkedAt: '2026-11-10T10:00:00.000Z',
    });
    expect(t.events).toEqual([
      { type: 'checking' },
      {
        type: 'available',
        version: 'v1.3.0',
        notes: 'Faster ledger & fixes\n- One',
      },
    ]);
    t.scheduler.advance(6 * 60 * 60 * 1000);
    await t.service.settled();
    expect(t.provider.checks).toBe(2);
    expect(t.provider.downloads).toEqual([]);
    expect(t.provider.installs).toBe(0);
    t.service.stop();
    expect(t.scheduler.pending).toBe(0);
  });

  it('never offers an older, equal or prerelease version', async () => {
    for (const version of ['1.2.0', '1.1.9', '1.3.0-beta.1', 'garbage']) {
      const t = setup();
      t.provider.candidate = { version, notes: '' };
      t.service.check();
      await t.service.settled();
      expect(t.service.getState()).toMatchObject({
        phase: 'idle',
        available: false,
        latest: '',
        message: 'Agent Ops is up to date.',
      });
      expect(t.events.at(-1)).toEqual({ type: 'not-available' });
      expectError(() => t.service.apply(version), 'CONFLICT');
    }
  });

  it('applies only the offered version: download, verify, notice, then restart', async () => {
    const t = setup({ restartDelayMs: 5000, beforeInstall: () => undefined });
    t.provider.candidate = { version: '1.3.0', notes: 'n' };
    t.service.check();
    await t.service.settled();
    expectError(() => t.service.apply('v1.4.0'), 'CONFLICT');
    t.provider.progress = [0, 12.7, 12.9, 55, 100];
    const accepted = t.service.apply('1.3.0');
    expect(accepted.phase).toBe('downloading');
    expectError(() => t.service.check(), 'BUSY');
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(t.provider.downloads).toEqual(['1.3.0']);
    expect(t.service.getState().phase).toBe('installing');
    expect(t.service.getState().message).toContain('restarts in 5 seconds');
    expect(t.provider.installs).toBe(0);
    expectError(() => t.service.apply('v1.3.0'), 'BUSY');
    t.scheduler.advance(5000);
    await t.service.settled();
    expect(t.provider.installs).toBe(1);
    expect(t.service.getState().phase).toBe('restarting');
    expect(
      t.events.filter((e) => e.type !== 'checking' && e.type !== 'available'),
    ).toEqual([
      { type: 'downloading', version: 'v1.3.0', percent: 0 },
      { type: 'downloading', version: 'v1.3.0', percent: 12 },
      { type: 'downloading', version: 'v1.3.0', percent: 55 },
      { type: 'verifying', version: 'v1.3.0' },
      { type: 'ready', version: 'v1.3.0', restartInMs: 5000 },
      { type: 'installing', version: 'v1.3.0' },
    ]);
    expect(JSON.parse(readFileSync(t.store.resultFile, 'utf8'))).toMatchObject({
      phase: 'restarting',
      version: 'v1.3.0',
      from: 'v1.2.0',
    });
    const phases = t.states.map((s) => s.phase);
    expect(phases).toEqual(
      expect.arrayContaining([
        'checking',
        'available',
        'downloading',
        'verifying',
        'installing',
        'restarting',
      ]),
    );
  });

  it('cancels the pending restart when stopped during the notice', async () => {
    const t = setup();
    t.provider.candidate = { version: '1.3.0', notes: '' };
    t.service.check();
    await t.service.settled();
    t.service.apply('v1.3.0');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.service.getState().phase).toBe('installing');
    t.service.stop();
    await t.service.settled();
    expect(t.provider.installs).toBe(0);
    expect(t.service.getState().phase).toBe('available');
  });

  it('remembers a skipped version, and offers a newer one again', async () => {
    const t = setup();
    t.provider.candidate = { version: '1.3.0', notes: '' };
    t.service.check();
    await t.service.settled();
    await expect(t.service.skip('v1.2.9')).rejects.toMatchObject({
      code: 'CONFLICT',
    });
    const state = await t.service.skip('v1.3.0');
    expect(state).toMatchObject({ skipped: true, latest: 'v1.3.0' });
    expect(JSON.parse(readFileSync(t.store.preferencesFile, 'utf8'))).toEqual({
      skipped: 'v1.3.0',
    });

    const next = setup();
    writeFileSync(
      next.store.preferencesFile,
      JSON.stringify({ skipped: 'v1.3.0', keep: 1 }),
    );
    next.provider.candidate = { version: '1.3.0', notes: '' };
    next.service.check();
    await next.service.settled();
    expect(next.service.getState()).toMatchObject({
      available: true,
      skipped: true,
    });
    expect(next.events.some((e) => e.type === 'available')).toBe(false); // no notice for a skipped version
    next.provider.candidate = { version: '1.3.1', notes: '' };
    next.service.check();
    await next.service.settled();
    expect(next.service.getState()).toMatchObject({
      latest: 'v1.3.1',
      skipped: false,
    });
    expect(next.events.at(-1)).toMatchObject({
      type: 'available',
      version: 'v1.3.1',
    });
    await next.service.skip('v1.3.1');
    expect(
      JSON.parse(readFileSync(next.store.preferencesFile, 'utf8')),
    ).toEqual({ skipped: 'v1.3.1', keep: 1 });
  });

  it('reports offline, rate-limit, checksum and metadata errors in plain words and keeps running', async () => {
    const cases: [unknown, string, string][] = [
      [
        Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), {
          code: 'ENOTFOUND',
        }),
        'offline',
        'internet connection',
      ],
      [
        new Error('net::ERR_INTERNET_DISCONNECTED'),
        'offline',
        'internet connection',
      ],
      [
        Object.assign(
          new Error('HttpError: 429 Too Many Requests "secret body"'),
          { statusCode: 429 },
        ),
        'rate-limited',
        'limiting',
      ],
      [
        Object.assign(new Error('API rate limit exceeded'), {
          statusCode: 403,
        }),
        'rate-limited',
        'limiting',
      ],
      [
        Object.assign(
          new Error('Cannot find latest.yml in the latest release artifacts'),
          { code: 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND' },
        ),
        'metadata',
        'update information',
      ],
      [
        Object.assign(new Error('No published versions on GitHub'), {
          code: 'ERR_UPDATER_NO_PUBLISHED_VERSIONS',
        }),
        'no-release',
        'No published release',
      ],
      [
        new Error('C:\\Users\\me\\secret.txt exploded'),
        'failed',
        'could not be completed',
      ],
    ];
    for (const [error, kind, words] of cases) {
      const t = setup();
      t.provider.checkError = error;
      t.service.check();
      await t.service.settled();
      const state = t.service.getState();
      expect(state.phase).toBe('error');
      expect(state.error).toContain(words);
      expect(state.error).not.toMatch(/secret|C:\\|429|github\.com/);
      expect(t.events.at(-1)).toMatchObject({ type: 'error', kind });
      // The error stays until a manual or scheduled retry, which is allowed.
      t.provider.checkError = null;
      t.service.check();
      await t.service.settled();
      expect(t.service.getState().phase).toBe('idle');
    }
  });

  it('keeps the app running after a checksum failure and lets the owner retry', async () => {
    const t = setup();
    t.provider.candidate = { version: '1.3.0', notes: '' };
    t.service.check();
    await t.service.settled();
    t.provider.downloadError = new Error(
      'sha512 checksum mismatch, expected abc, got def',
    );
    t.service.apply('v1.3.0');
    await t.service.settled();
    expect(t.service.getState()).toMatchObject({
      phase: 'error',
      available: true,
    });
    expect(t.service.getState().error).toContain('checksum');
    expect(t.provider.installs).toBe(0);
    expect(JSON.parse(readFileSync(t.store.resultFile, 'utf8'))).toMatchObject({
      phase: 'error',
      version: 'v1.3.0',
    });
    t.provider.downloadError = null;
    t.service.apply('v1.3.0');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.service.getState().phase).toBe('installing');
  });

  it('reports the restart result once after the update', async () => {
    const updated = setup({ currentVersion: '1.3.0' });
    await updated.store.saveResult({
      phase: 'restarting',
      version: 'v1.3.0',
      from: 'v1.2.0',
      message: '',
      at: 'x',
    });
    await updated.service.start();
    expect(updated.service.getState()).toMatchObject({
      phase: 'updated',
      message: 'Agent Ops was updated to v1.3.0.',
    });
    expect((await updated.store.result())?.phase).toBe('updated');
    const again = new UpdaterService({
      currentVersion: '1.3.0',
      packaged: true,
      provider: new FakeProvider(),
      store: updated.store,
      scheduler: new FakeScheduler(),
    });
    await again.start();
    expect(again.getState().phase).toBe('idle');

    const failed = setup({ currentVersion: '1.2.0' });
    await failed.store.saveResult({
      phase: 'restarting',
      version: 'v1.3.0',
      from: 'v1.2.0',
      message: '',
      at: 'x',
    });
    await failed.service.start();
    expect(failed.service.getState()).toMatchObject({ phase: 'error' });
    expect(failed.service.getState().error).toContain('did not finish');
    expect((await failed.store.result())?.phase).toBe('failed');
  });

  it('refuses a skip it cannot save', async () => {
    const t = setup();
    t.provider.candidate = { version: '1.3.0', notes: '' };
    t.service.check();
    await t.service.settled();
    const broken = new UpdateStore(join(t.dataDir, 'missing'));
    broken.savePreferences = async () => {
      throw new Error('disk full');
    };
    const service = new UpdaterService({
      currentVersion: '1.2.0',
      packaged: true,
      provider: t.provider,
      store: broken,
      scheduler: new FakeScheduler(),
    });
    service.check();
    await service.settled();
    await expect(service.skip('v1.3.0')).rejects.toMatchObject({
      code: 'IO_ERROR',
      retryable: true,
    });
    expect(service.getState().skipped).toBe(false);
  });

  it('stops an active download when stopped', async () => {
    const t = setup();
    t.provider.candidate = { version: '1.3.0', notes: '' };
    t.service.check();
    await t.service.settled();
    t.provider.holdNext = true;
    t.service.apply('v1.3.0');
    await new Promise((r) => setTimeout(r, 0));
    expect(t.service.getState().phase).toBe('downloading');
    t.service.stop();
    await t.service.settled();
    expect(t.service.getState()).toMatchObject({
      phase: 'available',
      message: 'The download was stopped.',
    });
    expect(t.provider.installs).toBe(0);
  });

  it('does not restart if download resolves successfully after stop', async () => {
    const t = setup();
    let finish!: () => void;
    t.provider.download = () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      });
    t.provider.candidate = { version: '1.3.0', notes: '' };
    t.service.check();
    await t.service.settled();
    t.service.apply('v1.3.0');
    t.service.stop();
    finish();
    await new Promise((r) => setTimeout(r, 0));
    t.scheduler.advance(5000);
    await t.service.settled();
    expect(t.provider.installs).toBe(0);
    expect(t.events.some((e) => e.type === 'ready')).toBe(false);
  });

  it.each(['result-save', 'before-install'] as const)(
    'does not install when stopped during %s',
    async (stage) => {
      let release!: () => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const hold = () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        });
      const t = setup(
        stage === 'before-install' ? { beforeInstall: hold } : {},
      );
      if (stage === 'result-save') {
        const save = t.store.saveResult.bind(t.store);
        t.store.saveResult = async (result) => {
          if (result.phase === 'restarting') await hold();
          await save(result);
        };
      }
      t.provider.candidate = { version: '1.3.0', notes: '' };
      t.service.check();
      await t.service.settled();
      t.service.apply('v1.3.0');
      await new Promise((r) => setTimeout(r, 0));
      t.scheduler.advance(5000);
      await started;
      t.service.stop();
      release();
      await t.service.settled();
      expect(t.provider.installs).toBe(0);
      expect((await t.store.result())?.phase).not.toBe('restarting');
    },
  );

  it('unsubscribes idempotently', () => {
    const t = setup();
    let count = 0;
    const off = t.service.onState(() => count++);
    off();
    off();
    t.service.check();
    expect(count).toBe(0);
  });
});
