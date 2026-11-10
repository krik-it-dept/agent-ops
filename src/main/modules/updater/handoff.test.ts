// The install handoff (M4), skip serialisation (m2) and GitHub rate-limit
// recognition at the real provider boundary (m4). A fake AppUpdater stands in
// for electron-updater's NsisUpdater; nothing is installed or quit.
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { HttpError } from 'builder-util-runtime';
import { GitHubProvider } from 'electron-updater/out/providers/GitHubProvider';
import type { AppUpdater } from 'electron-updater';
import { afterEach, describe, expect, it } from 'vitest';

import { electronUpdateProvider } from './electron-provider';
import { classifyUpdateError } from './errors';
import { UpdaterService, type Scheduler } from './service';
import { UpdateStore } from './store';
import type {
  DownloadProgress,
  UpdateCandidate,
  UpdateProvider,
} from './types';

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** The part of NsisUpdater the adapter touches, with scripted install outcomes. */
class FakeAppUpdater extends EventEmitter {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  autoRunAppAfterInstall = false;
  allowPrerelease = true;
  allowDowngrade = true;
  fullChangelog = true;
  disableWebInstaller = false;
  logger: unknown = null;
  quitAndInstallCalled = false;
  installs: [boolean | undefined, boolean | undefined][] = [];
  quitAndInstallCalls = 0;
  /** 'ok' | 'sync-error' (dispatchError then false) | 'late-error' (true, then error) */
  outcome: 'ok' | 'sync-error' | 'late-error' = 'ok';
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean {
    this.installs.push([isSilent, isForceRunAfter]);
    if (this.quitAndInstallCalled) return false;
    if (this.outcome === 'sync-error') {
      this.emit('error', new Error('No update filepath provided'));
      return false;
    }
    this.quitAndInstallCalled = true;
    if (this.outcome === 'late-error') {
      setTimeout(
        () =>
          this.emit(
            'error',
            Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }),
          ),
        20,
      );
    }
    return true;
  }
  quitAndInstall(): void {
    this.quitAndInstallCalls++;
  }
  setFeedURL(): void {}
  async checkForUpdates(): Promise<null> {
    return null;
  }
  async downloadUpdate(): Promise<string[]> {
    return [];
  }
}

function adapter(outcome: FakeAppUpdater['outcome']) {
  const updater = new FakeAppUpdater();
  updater.outcome = outcome;
  let quits = 0;
  const provider = electronUpdateProvider({
    updater: updater as unknown as AppUpdater,
    handoffGraceMs: 60,
    quit: () => {
      quits++;
    },
  });
  return { updater, provider, quits: () => quits };
}

describe('install handoff (electron-updater adapter)', () => {
  it('quits only after the installer started without an error report', async () => {
    const t = adapter('ok');
    await t.provider.install();
    expect(t.updater.installs).toEqual([[true, true]]);
    expect(t.updater.quitAndInstallCalls).toBe(0);
    expect(t.quits()).toBe(1);
    expect(t.updater.listenerCount('error')).toBe(0);
  });

  it('rejects a refused handoff reported through the error event, without quitting', async () => {
    const t = adapter('sync-error');
    await expect(t.provider.install()).rejects.toThrow('No update filepath');
    expect(t.quits()).toBe(0);
    expect(t.updater.listenerCount('error')).toBe(0);
  });

  it('rejects an installer start that fails after a delay, and allows a retry', async () => {
    const t = adapter('late-error');
    await expect(t.provider.install()).rejects.toThrow('spawn EPERM');
    expect(t.quits()).toBe(0);
    expect(t.updater.quitAndInstallCalled).toBe(false);
    t.updater.outcome = 'ok';
    await t.provider.install();
    expect(t.quits()).toBe(1);
  });

  it('configures the updater never to download on check or install on quit', () => {
    const t = adapter('ok');
    expect(t.updater).toMatchObject({
      autoDownload: false,
      autoInstallOnAppQuit: false,
      allowPrerelease: false,
      allowDowngrade: false,
    });
  });
});

const immediate: Scheduler = {
  setTimeout: (fn) => {
    queueMicrotask(fn);
    return 1;
  },
  clearTimeout: () => undefined,
};

function serviceWith(
  provider: UpdateProvider,
  extra: Record<string, unknown> = {},
) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-ops-handoff-'));
  roots.push(dataDir);
  const store = new UpdateStore(dataDir);
  const service = new UpdaterService({
    currentVersion: '1.2.0',
    packaged: true,
    provider,
    store,
    scheduler: immediate,
    restartDelayMs: 0,
    ...extra,
  });
  return { service, store };
}

class ScriptedProvider implements UpdateProvider {
  candidate: UpdateCandidate | null = { version: '1.3.0', notes: '' };
  installs = 0;
  installError: unknown = null;
  async check(): Promise<UpdateCandidate | null> {
    return this.candidate;
  }
  async download(
    _v: string,
    onProgress: (p: DownloadProgress) => void,
  ): Promise<void> {
    onProgress({ percent: 100, transferred: 1, total: 1, bytesPerSecond: 1 });
  }
  async install(): Promise<void> {
    this.installs++;
    if (this.installError) throw this.installError;
  }
}

describe('install failures reach the updater state', () => {
  it('clears the restarting marker, reports a typed error, lifts the barrier and allows a retry', async () => {
    const provider = new ScriptedProvider();
    provider.installError = new Error('spawn EPERM');
    const hooks: string[] = [];
    const t = serviceWith(provider, {
      beforeInstall: () => {
        hooks.push('before');
      },
      afterInstallFailed: () => {
        hooks.push('after-failed');
      },
    });
    const events: string[] = [];
    t.service.onEvent((e) =>
      events.push(e.type === 'error' ? `error:${e.kind}` : e.type),
    );
    t.service.check();
    await t.service.settled();
    t.service.apply('v1.3.0');
    await t.service.settled();
    const state = t.service.getState();
    expect(state).toMatchObject({
      phase: 'error',
      available: true,
      latest: 'v1.3.0',
    });
    expect(state.error).toContain('installer could not be started');
    expect(state.error).not.toContain('EPERM');
    expect(events).toContain('error:install');
    expect(hooks).toEqual(['before', 'after-failed']);
    expect(JSON.parse(readFileSync(t.store.resultFile, 'utf8'))).toMatchObject({
      phase: 'error',
      version: 'v1.3.0',
    });
    // Not BUSY: the owner can try again, and a successful handoff proceeds.
    provider.installError = null;
    t.service.apply('v1.3.0');
    await t.service.settled();
    expect(provider.installs).toBe(2);
    expect(t.service.getState().phase).toBe('restarting');
  });
});

describe('skip is serialised with check and apply', () => {
  it('refuses check and apply while the choice is being saved, and never marks a newer offer', async () => {
    const provider = new ScriptedProvider();
    const t = serviceWith(provider);
    t.service.check();
    await t.service.settled();
    let release!: () => void;
    const saving = new Promise<void>((r) => {
      release = r;
    });
    const save = t.store.savePreferences.bind(t.store);
    t.store.savePreferences = async (p) => {
      await saving;
      await save(p);
    };
    const skip = t.service.skip('v1.3.0');
    expect(() => t.service.check()).toThrow(
      expect.objectContaining({ code: 'BUSY' }),
    );
    expect(() => t.service.apply('v1.3.0')).toThrow(
      expect.objectContaining({ code: 'BUSY' }),
    );
    release();
    expect(await skip).toMatchObject({ skipped: true, latest: 'v1.3.0' });
    // A newer version is offered again, not hidden by the old skip.
    provider.candidate = { version: '1.4.0', notes: '' };
    t.service.check();
    await t.service.settled();
    expect(t.service.getState()).toMatchObject({
      latest: 'v1.4.0',
      skipped: false,
    });
  });
});

describe('GitHub rate limits through the real provider', () => {
  it('classifies a rate-limited latest-release request wrapped by GitHubProvider', async () => {
    const atom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><entry><id>tag:github.com,2008:Repository/1/v1.3.0</id>
<link rel="alternate" type="text/html" href="https://github.com/krik-it-dept/agent-ops/releases/tag/v1.3.0"/>
<title>v1.3.0</title><content type="html">notes</content></entry></feed>`;
    const requests: string[] = [];
    const executor = {
      request: async (options: { path?: string; hostname?: string }) => {
        requests.push(`${options.hostname}${options.path}`);
        if (requests.length === 1) return atom;
        throw new HttpError(
          403,
          '403 Forbidden\n"API rate limit exceeded for 203.0.113.9."\nHeaders: {"x-ratelimit-remaining": "0"}',
        );
      },
    };
    const provider = new GitHubProvider(
      { provider: 'github', owner: 'krik-it-dept', repo: 'agent-ops' },
      {
        channel: null,
        allowPrerelease: false,
        currentVersion: '1.2.0',
      } as never,
      {
        executor,
        isUseMultipleRangeRequest: false,
        platform: 'win32',
      } as never,
    );
    const error = await provider.getLatestVersion().then(
      () => null,
      (e: unknown) => e,
    );
    expect(requests).toHaveLength(2);
    expect((error as { code?: string }).code).toBe(
      'ERR_UPDATER_INVALID_RELEASE_FEED',
    );
    expect((error as { statusCode?: number }).statusCode).toBeUndefined();
    const classified = classifyUpdateError(error);
    expect(classified.kind).toBe('rate-limited');
    expect(classified.message).not.toMatch(/203\.0\.113|403|github\.com/);
  });

  it('still treats an unrelated feed error as a plain failure', () => {
    expect(
      classifyUpdateError(
        Object.assign(
          new Error(
            'Cannot parse releases feed: unexpected token 403 at line 2',
          ),
          {
            code: 'ERR_UPDATER_INVALID_RELEASE_FEED',
          },
        ),
      ).kind,
    ).not.toBe('rate-limited');
  });
});
