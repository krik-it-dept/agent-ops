import { watch, type FSWatcher } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  listPlans,
  projectRepos,
  tasksWorkspaces,
  type CollectConfig,
} from '../plans';

export interface WatchOptions {
  changed(): void;
  tick?(): void;
  intervalMs?: number;
  debounceMs?: number;
  failed?(error: unknown): void;
}
export const hasSources = (config: CollectConfig): boolean =>
  !!config.tasksDir || !!config.projects?.some((p) => p.enabled !== false);

async function inspect(
  config: CollectConfig,
): Promise<{ signature: string; roots: Set<string> }> {
  const parts: unknown[] = [];
  const roots = new Set<string>();
  const folder = async (dir: string): Promise<void> => {
    roots.add(dir);
    try {
      const names = await listPlans(dir);
      parts.push(dir, names);
      for (const name of names) {
        try {
          const s = await stat(join(dir, name));
          parts.push(name, s.size, s.mtimeMs);
        } catch {
          parts.push(name, 'missing');
        }
      }
    } catch {
      parts.push(dir, 'unreadable');
    }
  };
  if (config.tasksDir) {
    roots.add(config.tasksDir);
    try {
      const names = await tasksWorkspaces(config.tasksDir);
      parts.push(config.tasksDir, names);
      for (const name of names) await folder(join(config.tasksDir, name));
    } catch {
      parts.push(config.tasksDir, 'missing');
    }
  }
  if (config.runsDir) {
    // Agent reports: one file per run; a report appends to its file.
    roots.add(config.runsDir);
    try {
      const names = (await readdir(config.runsDir))
        .filter((name) => name.endsWith('.jsonl'))
        .sort();
      parts.push(config.runsDir, names);
      for (const name of names) {
        try {
          const s = await stat(join(config.runsDir, name));
          parts.push(name, s.size, s.mtimeMs);
        } catch {
          parts.push(name, 'missing');
        }
      }
    } catch {
      parts.push(config.runsDir, 'missing');
    }
  }
  for (const project of config.projects ?? []) {
    if (project.enabled === false) continue;
    roots.add(project.path);
    try {
      const repos = await projectRepos(project);
      parts.push(project.id, project.path, repos);
      for (const repo of repos) await folder(join(repo.root, '.tasks'));
    } catch {
      parts.push(project.id, project.path, 'missing');
    }
  }
  return { signature: JSON.stringify(parts), roots };
}
/**
 * The nearest existing folder, as its canonical long path. libuv aborts the whole
 * process (fs-event.c assertion) when a folder watched through an 8.3 short name
 * such as C:\Users\RUNNER~1 reports a change under its long name.
 */
async function ancestor(path: string): Promise<string | undefined> {
  for (let dir = path; ; dir = dirname(dir)) {
    try {
      if ((await stat(dir)).isDirectory()) return await realpath(dir);
    } catch {
      /* Try the nearest parent. */
    }
    if (dirname(dir) === dir) return undefined;
  }
}

/** Native events accelerate reads; signatures reconcile dropped Windows events and missing roots. */
export class PlanWatcher {
  private config: CollectConfig = {};
  private configKey = '';
  private signature = '';
  private watchers = new Map<string, FSWatcher>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;
  private polling: Promise<void> | undefined;
  private revision = 0;
  private stopped = false;
  constructor(private readonly options: WatchOptions) {}

  async configure(config: CollectConfig): Promise<void> {
    if (this.stopped) return;
    const key = JSON.stringify(config);
    if (key === this.configKey) return;
    this.configKey = key;
    this.config = structuredClone(config);
    this.revision++;
    if (!hasSources(config)) {
      if (this.timer) clearInterval(this.timer);
      if (this.debounce) clearTimeout(this.debounce);
      this.timer = this.debounce = undefined;
      this.closeWatchers();
      this.signature = '';
      return;
    }
    await this.reconcile(true);
    if (!this.stopped && !this.timer) {
      this.timer = setInterval(() => {
        void this.reconcile().catch((e: unknown) => this.options.failed?.(e));
        this.options.tick?.();
      }, this.options.intervalMs ?? 2000);
      this.timer.unref();
    }
  }
  async reconcile(initial = false): Promise<void> {
    if (this.polling) {
      await this.polling;
      return;
    }
    const revision = this.revision;
    const operation = async (): Promise<void> => {
      if (this.stopped || !hasSources(this.config)) return;
      const observed = await inspect(this.config);
      if (this.stopped || revision !== this.revision) return;
      const changed = this.signature !== observed.signature;
      this.signature = observed.signature;
      await this.rebuild(observed.roots, revision);
      if (changed && !initial && !this.stopped && revision === this.revision)
        this.options.changed();
    };
    this.polling = operation();
    try {
      await this.polling;
    } finally {
      this.polling = undefined;
    }
  }
  private invalidate(): void {
    if (this.stopped) return;
    if (this.debounce) clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      this.debounce = undefined;
      void this.reconcile().catch((e: unknown) => this.options.failed?.(e));
    }, this.options.debounceMs ?? 150);
    this.debounce.unref();
  }
  private async rebuild(roots: Set<string>, revision: number): Promise<void> {
    const paths = new Set<string>();
    for (const root of roots) {
      const dir = await ancestor(root);
      if (dir) paths.add(dir);
    }
    if (this.stopped || revision !== this.revision) return;
    for (const [dir, watcher] of this.watchers)
      if (!paths.has(dir)) {
        watcher.close();
        this.watchers.delete(dir);
      }
    for (const dir of paths) {
      if (this.watchers.has(dir)) continue;
      try {
        const watcher = watch(dir, { persistent: false }, () =>
          this.invalidate(),
        );
        watcher.on('error', () => {
          watcher.close();
          this.watchers.delete(dir);
          this.invalidate();
        });
        this.watchers.set(dir, watcher);
      } catch {
        /* Polling still detects reappearing roots. */
      }
    }
  }
  private closeWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.revision++;
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.closeWatchers();
    await this.polling;
  }
}
