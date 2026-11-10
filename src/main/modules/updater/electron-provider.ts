// The production UpdateProvider: electron-updater with the GitHub provider of
// electron-builder.yml (public krik-it-dept/agent-ops releases, no credentials).
// Drafts and prereleases are never offered. Downloads are checked against the
// SHA-512 in latest.yml by electron-updater; the installer is unsigned by owner
// decision, so no publisher check runs. Only this file imports electron-updater.

import {
  autoUpdater,
  CancellationToken,
  type AppUpdater,
  type ProgressInfo,
} from 'electron-updater';

import { UpdaterService, type UpdaterOptions } from './service';
import { UpdateStore } from './store';
import type { UpdateProvider } from './types';

/** Only a loopback test feed may replace GitHub, and only at an isolated launch. */
const TEST_FEED = /^http:\/\/127\.0\.0\.1:\d{1,5}\/?$/;

export interface ElectronProviderOptions {
  /** Isolated update tests only: http://127.0.0.1:<port>. Never from IPC. */
  testFeedUrl?: string;
  updater?: AppUpdater;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
  /**
   * How long to wait for an installer start error that electron-updater reports
   * asynchronously (a failed spawn) before quitting the app (default 2 s).
   */
  handoffGraceMs?: number;
  /** Quits the app for the installer; default: Electron's before-quit-for-update and app.quit(). */
  quit?: () => void | Promise<void>;
}

/** The part of electron-updater's BaseUpdater the install handoff uses (pinned 6.8.x). */
interface InstallingUpdater {
  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean;
  quitAndInstallCalled?: boolean;
}

async function electronQuit(): Promise<void> {
  const electron = await import('electron');
  electron.autoUpdater.emit('before-quit-for-update');
  electron.app.quit();
}

function notesText(notes: unknown): string {
  if (typeof notes === 'string') {
    return notes;
  }
  if (Array.isArray(notes)) {
    return notes
      .map((n: unknown) =>
        typeof n === 'object' &&
        n !== null &&
        typeof (n as { note?: unknown }).note === 'string'
          ? (n as { note: string }).note
          : '',
      )
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

export function electronUpdateProvider(
  options: ElectronProviderOptions = {},
): UpdateProvider {
  const updater = options.updater ?? autoUpdater;
  updater.autoDownload = false; // a check never downloads
  updater.autoInstallOnAppQuit = false; // an ordinary quit never installs
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.fullChangelog = false;
  updater.disableWebInstaller = true;
  const log = options.log;
  updater.logger = {
    info: (message?: unknown) => log?.('info', String(message)),
    warn: (message?: unknown) => log?.('warn', String(message)),
    error: (message?: unknown) => log?.('error', String(message)),
    debug: () => undefined,
  };
  if (options.testFeedUrl !== undefined) {
    if (!TEST_FEED.test(options.testFeedUrl)) {
      throw new Error('The update test feed must be http://127.0.0.1:<port>.');
    }
    updater.setFeedURL({ provider: 'generic', url: options.testFeedUrl });
  }
  return {
    async check() {
      const result = await updater.checkForUpdates();
      if (!result || !result.isUpdateAvailable) {
        return null;
      }
      return {
        version: result.updateInfo.version,
        notes: notesText(result.updateInfo.releaseNotes),
      };
    },
    async download(_version, onProgress, signal) {
      const token = new CancellationToken();
      const abort = (): void => token.cancel();
      const progress = (p: ProgressInfo): void =>
        onProgress({
          percent: p.percent,
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond,
        });
      signal.addEventListener('abort', abort);
      updater.on('download-progress', progress);
      try {
        await updater.downloadUpdate(token);
      } finally {
        updater.off('download-progress', progress);
        signal.removeEventListener('abort', abort);
      }
    },
    async install() {
      // Not quitAndInstall(): it quits on a later tick even when the installer
      // spawn then fails, and its errors only reach the 'error' event. Start the
      // installer here, collect every error it reports, and quit only when none
      // arrived within the grace period.
      const target = updater as unknown as InstallingUpdater;
      if (typeof target.install !== 'function') {
        throw new Error('This updater cannot start an installer.');
      }
      const errors: unknown[] = [];
      const onError = (error: unknown): void => {
        errors.push(error);
      };
      updater.on('error', onError);
      try {
        const started = target.install(true, true); // silent; the installer restarts the app
        if (started) {
          await new Promise((resolve) =>
            setTimeout(resolve, options.handoffGraceMs ?? 2000),
          );
        }
        if (!started || errors.length > 0) {
          // Allow a later retry: electron-updater ignores install() while this is set.
          if ('quitAndInstallCalled' in target)
            target.quitAndInstallCalled = false;
          throw errors[0] ?? new Error('The installer could not be started.');
        }
      } finally {
        updater.off('error', onError);
      }
      await (options.quit ?? electronQuit)();
    },
  };
}

export interface ElectronUpdaterOptions
  extends Omit<UpdaterOptions, 'provider' | 'store'>, ElectronProviderOptions {
  dataDir: string;
}

/** The updater for the main process. Call start() after the window opens. */
export function createElectronUpdater(
  options: ElectronUpdaterOptions,
): UpdaterService {
  const { dataDir, testFeedUrl, updater, handoffGraceMs, quit, ...rest } =
    options;
  void handoffGraceMs;
  void quit;
  const providerOptions: ElectronProviderOptions = {};
  if (testFeedUrl !== undefined) providerOptions.testFeedUrl = testFeedUrl;
  if (updater !== undefined) providerOptions.updater = updater;
  if (rest.log !== undefined) providerOptions.log = rest.log;
  if (options.handoffGraceMs !== undefined)
    providerOptions.handoffGraceMs = options.handoffGraceMs;
  if (options.quit !== undefined) providerOptions.quit = options.quit;
  return new UpdaterService({
    ...rest,
    provider: electronUpdateProvider(providerOptions),
    store: new UpdateStore(dataDir),
  });
}
