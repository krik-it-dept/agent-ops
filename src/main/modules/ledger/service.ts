import {
  emptyOverview,
  isOverview,
  planKey,
  type LedgerConfiguration,
  type LedgerOptions,
  type LedgerState,
} from './types';
import { hasSources, PlanWatcher, type WatchOptions } from './watch';
import type { Overview, Plan } from '../plans';

export class LedgerService {
  private overview: Overview;
  private config: LedgerConfiguration = { projects: [] };
  private generation = 0;
  private error = '';
  private warnings: string[] = [];
  private active: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private closed = false;
  private trailing = false;
  private lastFailure = 0;
  private ticking = false;
  private tickPending: Promise<void> | undefined;
  private suspended = false;
  private paused = false;
  private resume: Promise<void> | undefined;
  private resumeNow: (() => void) | undefined;
  private actions: Promise<unknown> = Promise.resolve();
  private readonly watcher: PlanWatcher;
  constructor(
    private readonly options: LedgerOptions,
    watchOptions: Partial<Pick<WatchOptions, 'intervalMs' | 'debounceMs'>> = {},
  ) {
    this.overview = emptyOverview(this.now());
    this.watcher = new PlanWatcher({
      ...watchOptions,
      changed: () => this.invalidate(),
      tick: () => this.tick(),
      failed: (e) => options.log?.('watch failed', e),
    });
  }
  private now(): Date {
    return this.options.now?.() ?? new Date();
  }
  async start(): Promise<void> {
    try {
      const cached = await this.options.cache.load();
      if (cached) this.overview = cached;
    } catch (e) {
      this.warn('The saved overview could not be read.', e);
    }
    try {
      await this.options.activity?.load?.();
    } catch (e) {
      this.warn('Saved activity could not be read.', e);
    }
    await this.refresh();
  }
  /** Manual refreshes coalesce; invalidations during a read get one trailing read. */
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.suspended) {
      this.trailing = true;
      return Promise.resolve();
    }
    if (this.paused) return this.resume!.then(() => this.refresh());
    if (this.active) return this.active;
    this.active = this.read().finally(() => {
      this.active = undefined;
      if (this.trailing && !this.closed) {
        this.trailing = false;
        void this.refresh();
      }
    });
    return this.active;
  }
  invalidate(): void {
    if (this.closed) return;
    if (this.active || this.paused || this.suspended) this.trailing = true;
    else void this.refresh();
  }
  async settled(): Promise<void> {
    while (this.active) await this.active;
  }
  /** Freeze background writers for installer handoff; a failed handoff can resume them. */
  async suspend(): Promise<void> {
    this.suspended = true;
    await this.settled();
    await this.tickPending;
  }
  resumeAfterInstallFailure(): void {
    this.suspended = false;
    if (this.trailing && !this.closed) {
      this.trailing = false;
      this.invalidate();
    }
  }
  /** Do not publish a partially moved source set or recycle against a changing overview. */
  withPlanAction<T>(action: () => Promise<T>): Promise<T> {
    const run = this.actions.then(async () => {
      if (this.closed) throw new Error('The app is closing.');
      this.paused = true;
      this.resume = new Promise((resolve) => {
        this.resumeNow = resolve;
      });
      try {
        await this.active;
        return await action();
      } finally {
        this.paused = false;
        this.resumeNow?.();
        this.resume = undefined;
        this.resumeNow = undefined;
        if (this.trailing && !this.closed) {
          this.trailing = false;
          void this.refresh();
        }
      }
    });
    this.actions = run.catch(() => {});
    return run;
  }
  private async read(): Promise<void> {
    const controller = new AbortController();
    this.controller = controller;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = await this.options.configuration();
      if (this.closed) return;
      this.config = structuredClone(config);
      await this.watcher.configure(config);
      if (this.closed) return;
      timeout = setTimeout(
        () => controller.abort(new Error('Plan read timed out.')),
        this.options.timeoutMs ?? 30000,
      );
      const next = hasSources(config)
        ? await this.options.collect(config, controller.signal)
        : emptyOverview(this.now());
      if (this.closed || controller.signal.aborted)
        throw controller.signal.reason;
      if (!isOverview(next)) throw new Error('Invalid plan overview.');
      const warnings: string[] = [];
      try {
        await this.options.activity?.apply(next);
      } catch (e) {
        warnings.push('Recent changes could not be saved.');
        this.options.log?.('activity failed', e);
      }
      if (this.closed) return;
      try {
        await this.options.cache.save(next);
      } catch (e) {
        warnings.push('The overview could not be saved.');
        this.options.log?.('overview save failed', e);
      }
      if (this.closed) return;
      this.overview = next;
      this.error = '';
      this.lastFailure = 0;
      this.warnings = warnings;
      this.publish();
    } catch (e) {
      if (this.closed) return;
      this.error = controller.signal.aborted
        ? 'Reading plans took too long. Try Refresh again.'
        : 'Plans could not be read. Try Refresh again.';
      this.warnings = [this.error];
      this.lastFailure = Date.now();
      this.options.log?.(
        controller.signal.aborted ? 'refresh timeout' : 'refresh failed',
        e,
      );
      this.publish();
    } finally {
      if (timeout) clearTimeout(timeout);
      if (this.controller === controller) this.controller = undefined;
    }
  }
  private warn(message: string, error: unknown): void {
    this.warnings.push(message);
    this.options.log?.(message, error);
  }
  private publish(): void {
    this.generation++;
    try {
      this.options.changed?.({ generation: this.generation });
    } catch (e) {
      this.options.log?.('state event failed', e);
    }
  }
  private tick(): void {
    if (this.closed || this.suspended) return;
    if (
      this.lastFailure &&
      Date.now() - this.lastFailure >= 10000 &&
      hasSources(this.config)
    )
      this.invalidate();
    if (
      !this.ticking &&
      !this.active &&
      !this.paused &&
      this.options.activity?.tick
    ) {
      this.ticking = true;
      this.tickPending = this.options.activity
        .tick()
        .then((changed) => {
          if (changed && !this.closed) this.publish();
        })
        .catch((e: unknown) => this.options.log?.('activity tick failed', e))
        .finally(() => {
          this.ticking = false;
        });
    }
  }
  getState(): LedgerState {
    const activity = this.options.activity?.snapshot() ?? {
      activity: [],
      stale: {},
    };
    const warnings = [
      ...(this.config.warnings ?? []),
      ...this.warnings,
      ...(activity.warnings ?? []),
    ];
    for (const project of this.overview.projects)
      if (project.status !== 'ok')
        warnings.push(
          project.message || 'A workspace folder cannot be opened.',
        );
    for (const diagnostic of this.overview.diagnostics.slice(0, 5))
      warnings.push(diagnostic.message);
    if (this.overview.diagnostics.length > 5)
      warnings.push(
        `${this.overview.diagnostics.length - 5} more plan problems.`,
      );
    const projects: LedgerState['projects'] = this.config.projects.map((p) => {
      const result = this.overview.projects.find((r) => r.id === p.id);
      return {
        id: p.id,
        name: p.name ?? p.path,
        path: p.path,
        kind: p.kind,
        enabled: p.enabled !== false,
        status:
          p.enabled === false ? 'disabled' : (result?.status ?? 'pending'),
        repos: result?.repos ?? 0,
        plans: result?.plans ?? 0,
        ...(result?.message ? { message: result.message } : {}),
      };
    });
    return structuredClone({
      generation: this.generation,
      appVersion: this.options.version,
      state: this.overview,
      ...activity,
      now: this.now().toISOString(),
      error: this.error,
      setupRequired: this.config.setupRequired ?? false,
      projects,
      warnings: [...new Set(warnings)],
      crash: null,
      planArchive: this.config.planArchive ?? null,
    });
  }
  findPlan(key: string): Plan | undefined {
    const found = this.overview.plans.find((p) => planKey(p) === key);
    return found ? structuredClone(found) : undefined;
  }
  async stop(): Promise<void> {
    this.closed = true;
    this.trailing = false;
    this.controller?.abort(new Error('Plan read cancelled.'));
    await Promise.all([
      this.watcher.stop(),
      this.active,
      this.actions,
      this.tickPending,
    ]);
  }
}
