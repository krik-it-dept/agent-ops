// The updater: checks GitHub Releases on start and on demand, and applies an
// update only when the owner asks (`apply`). Applying downloads in the
// background (progress events; the notice can be minimised), lets the provider
// verify the download against latest.yml, then restarts the app by itself after
// a short notice. Nothing is downloaded or installed by a check, on an ordinary
// quit or on the next launch. Development and dev-version builds never check.

import { classifyUpdateError, UpdaterError } from './errors';
import type { UpdateStore } from './store';
import type {
  DownloadProgress,
  UpdateCandidate,
  UpdaterEvent,
  UpdateProvider,
  UpdateState,
} from './types';
import {
  isNewer,
  isStableVersion,
  notesToText,
  tagOf,
  updatesAllowed,
} from './versions';

export interface Scheduler {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface UpdaterOptions {
  /** app.getVersion(). */
  currentVersion: string;
  commit?: string;
  processId?: number;
  /** app.isPackaged; updates are off in development. */
  packaged: boolean;
  provider: UpdateProvider;
  store: UpdateStore;
  now?: () => Date;
  scheduler?: Scheduler;
  /** Delay of the first check after start (default 3 s). */
  firstCheckDelayMs?: number;
  /** Interval of scheduled checks (default 6 h). */
  intervalMs?: number;
  /** The notice shown before the automatic restart (default 5 s). */
  restartDelayMs?: number;
  /** Runs before the installer starts: stop accepting changes, flush stores. */
  beforeInstall?: () => Promise<void> | void;
  /** Runs when the installer could not be started after beforeInstall: accept changes again. */
  afterInstallFailed?: () => Promise<void> | void;
  log?: (level: 'info' | 'warn' | 'error', message: string) => void;
}

const BUSY_PHASES = new Set([
  'checking',
  'downloading',
  'verifying',
  'installing',
  'restarting',
]);
const DISABLED_TEXT =
  'Updates are checked only in the installed release of Agent Ops.';
const UP_TO_DATE_TEXT = 'Agent Ops is up to date.';

const systemScheduler: Scheduler = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) =>
    clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Marks an error from the install handoff, so it gets the install message. */
function installError(err: unknown): unknown {
  if (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: unknown }).code === 'ERR_UPDATER_INSTALL'
  ) {
    return err;
  }
  return Object.assign(
    new Error(err instanceof Error ? err.message : String(err)),
    {
      code: 'ERR_UPDATER_INSTALL',
    },
  );
}

export class UpdaterService {
  private state: UpdateState;
  private readonly enabled: boolean;
  private readonly scheduler: Scheduler;
  private readonly now: () => Date;
  private readonly stateListeners = new Set<(state: UpdateState) => void>();
  private readonly eventListeners = new Set<(event: UpdaterEvent) => void>();
  private timer: unknown = null;
  private restartTimer: unknown = null;
  private cancelRestart: (() => void) | null = null;
  private download: AbortController | null = null;
  private pending: Promise<void> = Promise.resolve();
  private started = false;
  private stopped = false;
  private skipping = false;

  constructor(private readonly options: UpdaterOptions) {
    this.enabled = updatesAllowed({
      packaged: options.packaged,
      version: options.currentVersion,
    });
    this.scheduler = options.scheduler ?? systemScheduler;
    this.now = options.now ?? (() => new Date());
    this.state = {
      current: tagOf(options.currentVersion),
      commit: options.commit ?? '',
      processId: options.processId ?? process.pid,
      latest: '',
      notes: '',
      available: false,
      skipped: false,
      phase: 'idle',
      error: '',
      message: this.enabled ? '' : DISABLED_TEXT,
      checkedAt: '',
    };
  }

  /** Whether this build takes part in updates (packaged, stable version). */
  get isEnabled(): boolean {
    return this.enabled;
  }

  getState(): UpdateState {
    return { ...this.state };
  }

  /** Subscribes to every state change; returns an idempotent unsubscribe. */
  onState(listener: (state: UpdateState) => void): () => void {
    this.stateListeners.add(listener);
    return () => {
      this.stateListeners.delete(listener);
    };
  }

  /** Subscribes to typed progress events; returns an idempotent unsubscribe. */
  onEvent(listener: (event: UpdaterEvent) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /** Resolves when the operation started last has finished (tests, shutdown). */
  settled(): Promise<void> {
    return this.pending;
  }

  /**
   * Reads the result of an update that restarted the app, then schedules the
   * first check and the periodic checks. Does nothing in development builds.
   */
  async start(): Promise<void> {
    if (!this.enabled || this.started) {
      return;
    }
    this.stopped = false;
    this.started = true;
    await this.reconcileRestart();
    this.schedule(this.options.firstCheckDelayMs ?? 3000);
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.restartTimer !== null) {
      this.scheduler.clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.cancelRestart?.();
    this.cancelRestart = null;
    this.download?.abort();
  }

  /** Starts a check; returns the "checking" state at once. */
  check(): UpdateState {
    this.assertReady();
    this.pending = this.runCheck();
    return this.getState();
  }

  /** Starts download, verification and the automatic restart of the offered version. */
  apply(version: string): UpdateState {
    this.assertReady();
    const wanted = tagOf(version);
    if (!this.state.available || wanted !== this.state.latest) {
      throw new UpdaterError(
        'CONFLICT',
        'This update is no longer offered. Check for updates again.',
      );
    }
    this.set({
      phase: 'downloading',
      error: '',
      message: 'Downloading the update… 0%',
    });
    this.emit({ type: 'downloading', version: wanted, percent: 0 });
    const accepted = this.getState();
    this.pending = this.runApply(wanted);
    return accepted;
  }

  /** Remembers that the owner skipped the offered version; a newer one is offered again. */
  async skip(version: string): Promise<UpdateState> {
    this.assertReady();
    const wanted = tagOf(version);
    if (!this.state.latest || wanted !== this.state.latest) {
      throw new UpdaterError(
        'CONFLICT',
        'This update is no longer offered. Check for updates again.',
      );
    }
    // One operation at a time: check and apply are refused (BUSY) and the
    // scheduled check waits while the choice is being saved.
    this.skipping = true;
    try {
      await this.options.store.savePreferences({ skipped: wanted });
    } catch {
      throw new UpdaterError(
        'IO_ERROR',
        'Agent Ops could not save that choice. Try again.',
        true,
      );
    } finally {
      this.skipping = false;
    }
    if (this.state.latest === wanted) {
      this.set({
        skipped: true,
        phase: this.state.available ? 'available' : 'idle',
      });
    }
    return this.getState();
  }

  // ---------- internals ----------

  private assertReady(): void {
    if (!this.enabled || this.stopped) {
      throw new UpdaterError('UNAVAILABLE', DISABLED_TEXT);
    }
    if (BUSY_PHASES.has(this.state.phase) || this.skipping) {
      throw new UpdaterError(
        'BUSY',
        'An update operation is already running.',
        true,
      );
    }
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch };
    const snapshot = this.getState();
    for (const listener of [...this.stateListeners]) {
      listener(snapshot);
    }
  }

  private emit(event: UpdaterEvent): void {
    for (const listener of [...this.eventListeners]) {
      listener(event);
    }
  }

  private log(level: 'info' | 'warn' | 'error', message: string): void {
    this.options.log?.(level, message);
  }

  private schedule(delayMs: number): void {
    if (!this.started) {
      return;
    }
    if (this.timer !== null) {
      this.scheduler.clearTimeout(this.timer);
    }
    this.timer = this.scheduler.setTimeout(() => {
      this.timer = null;
      if (!BUSY_PHASES.has(this.state.phase) && !this.skipping) {
        this.pending = this.runCheck();
      }
      this.schedule(this.options.intervalMs ?? 6 * 60 * 60 * 1000);
    }, delayMs);
  }

  private async reconcileRestart(): Promise<void> {
    const result = await this.options.store.result();
    if (!result || result.phase !== 'restarting') {
      return;
    }
    const at = this.now().toISOString();
    if (result.version === this.state.current) {
      const message = `Agent Ops was updated to ${result.version}.`;
      this.set({ phase: 'updated', message, error: '' });
      this.log('info', message);
      await this.options.store
        .saveResult({ ...result, phase: 'updated', message, at })
        .catch(() => undefined);
    } else {
      const message = `The update to ${result.version} did not finish. Agent Ops is still on ${this.state.current}. Check for updates to try again.`;
      this.set({ phase: 'error', error: message, message });
      this.log('warn', message);
      await this.options.store
        .saveResult({ ...result, phase: 'failed', message, at })
        .catch(() => undefined);
    }
  }

  private async runCheck(): Promise<void> {
    this.set({
      phase: 'checking',
      error: '',
      message: 'Checking for updates…',
    });
    this.emit({ type: 'checking' });
    let candidate: UpdateCandidate | null;
    try {
      candidate = await this.options.provider.check();
    } catch (err) {
      await this.fail(err, 'check');
      return;
    }
    const checkedAt = this.now().toISOString();
    if (
      !candidate ||
      !isStableVersion(candidate.version) ||
      !isNewer(candidate.version, this.state.current)
    ) {
      this.set({
        phase: 'idle',
        available: false,
        latest: '',
        notes: '',
        skipped: false,
        message: UP_TO_DATE_TEXT,
        checkedAt,
      });
      this.emit({ type: 'not-available' });
      return;
    }
    const latest = tagOf(candidate.version);
    const notes = notesToText(candidate.notes);
    const skipped = (await this.options.store.preferences()).skipped === latest;
    this.set({
      phase: 'available',
      available: true,
      latest,
      notes,
      skipped,
      message: skipped
        ? `${latest} is available; you skipped it.`
        : `${latest} is available.`,
      checkedAt,
    });
    if (!skipped) {
      this.emit({ type: 'available', version: latest, notes });
    }
    this.log(
      'info',
      `update ${latest} available${skipped ? ' (skipped)' : ''}`,
    );
  }

  private async runApply(version: string): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.download = controller;
    let lastPercent = 0;
    const onProgress = (progress: DownloadProgress): void => {
      if (controller.signal.aborted) return;
      const percent = Math.max(0, Math.min(100, Math.floor(progress.percent)));
      if (percent === lastPercent || this.state.phase !== 'downloading') {
        return;
      }
      lastPercent = percent;
      if (percent >= 100) {
        this.set({
          phase: 'verifying',
          message: 'Checking the downloaded update…',
        });
        this.emit({ type: 'verifying', version });
        return;
      }
      this.set({ message: `Downloading the update… ${percent}%` });
      this.emit({ type: 'downloading', version, percent });
    };
    try {
      await this.options.provider.download(
        version.slice(1),
        onProgress,
        controller.signal,
      );
    } catch (err) {
      this.download = null;
      if (controller.signal.aborted) {
        this.set({ phase: 'available', message: 'The download was stopped.' });
        return;
      }
      await this.fail(err, 'download', version);
      return;
    }
    // Cancellation can race with a successful provider resolution. Keep the
    // controller alive through the notice and the asynchronous install handoff.
    if (controller.signal.aborted) {
      this.download = null;
      this.set({ phase: 'available', message: 'The download was stopped.' });
      return;
    }
    const restartInMs = this.options.restartDelayMs ?? 5000;
    const seconds = Math.max(1, Math.round(restartInMs / 1000));
    this.set({
      phase: 'installing',
      message: `The update is ready. Agent Ops restarts in ${seconds} seconds to install ${version}.`,
    });
    this.emit({ type: 'ready', version, restartInMs });
    if (controller.signal.aborted) {
      this.download = null;
      this.set({ phase: 'available', message: 'The restart was cancelled.' });
      return;
    }
    const proceed = await new Promise<boolean>((resolve) => {
      this.cancelRestart = () => resolve(false);
      this.restartTimer = this.scheduler.setTimeout(() => {
        this.restartTimer = null;
        this.cancelRestart = null;
        resolve(true);
      }, restartInMs);
    });
    if (!proceed) {
      this.download = null;
      this.set({ phase: 'available', message: 'The restart was cancelled.' });
      return; // stopped during the notice
    }
    const cancelled = async (): Promise<void> => {
      const message = 'The restart was cancelled.';
      this.set({ phase: 'available', message });
      await this.options.store.saveResult({
        phase: 'failed',
        version,
        from: this.state.current,
        message,
        at: this.now().toISOString(),
      });
    };
    try {
      if (controller.signal.aborted) {
        await cancelled();
        return;
      }
      await this.options.store.saveResult({
        phase: 'restarting',
        version,
        from: this.state.current,
        message: '',
        at: this.now().toISOString(),
      });
      if (controller.signal.aborted) {
        await cancelled();
        return;
      }
      await this.options.beforeInstall?.();
      if (controller.signal.aborted) {
        await cancelled();
        return;
      }
      this.set({
        phase: 'restarting',
        message: 'Restarting to install the update…',
      });
      this.emit({ type: 'installing', version });
      this.log('info', `installing update ${version}`);
      if (controller.signal.aborted) {
        await cancelled();
        return;
      }
      // A void return is not success: the provider resolves only after the
      // installer started and the app was told to quit, and rejects otherwise.
      await this.options.provider.install();
    } catch (err) {
      await this.fail(installError(err), 'install', version);
      try {
        await this.options.afterInstallFailed?.();
      } catch (hookError) {
        this.log('error', `after a failed install: ${String(hookError)}`);
      }
    } finally {
      this.download = null;
    }
  }

  private async fail(
    err: unknown,
    operation: string,
    version = '',
  ): Promise<void> {
    const { kind, message } = classifyUpdateError(err);
    this.log(
      'warn',
      `update ${operation} failed (${kind}): ${err instanceof Error ? err.message : String(err)}`,
    );
    this.set({ phase: 'error', error: message, message });
    this.emit({ type: 'error', kind, message });
    if (version) {
      await this.options.store
        .saveResult({
          phase: 'error',
          version,
          from: this.state.current,
          message,
          at: this.now().toISOString(),
        })
        .catch(() => undefined);
    }
  }
}
