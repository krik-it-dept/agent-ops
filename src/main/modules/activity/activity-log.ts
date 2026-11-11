// ActivityLog keeps the activity feed and the stores behind it in the data
// folder: snapshot.json (the last board), activity.jsonl (bounded, append-only),
// stale.json (stale plans already announced) and seen-projects.json (workspaces
// whose history was seeded once). It applies each refresh with the baseline's
// seeding rules: plans of a workspace that appears are seeded quietly, plans of
// one that disappears are dropped quietly, and a returning workspace is never
// seeded again, so adding, disabling or enabling a workspace never floods the feed.

import { createHash } from 'node:crypto';
import path from 'node:path';
import {
  appendLines,
  readJsonLines,
  readJsonTolerant,
  writeFileAtomic,
  type SafeIoOptions,
} from '../../lib/safe-io/safe-io';
import {
  diff,
  planKey,
  seed,
  staleEvents,
  withoutLogged,
  type ActivityEvent,
  type Plan,
  type PlanMap,
} from './diff';

/** Bounds of the stores. */
export const MAX_EVENTS = 3000;
export const ACTIVITY_MAX_BYTES = 4 << 20;
export const MAX_SEEN_PROJECTS = 256;

export const STORE_FILES = {
  snapshot: 'snapshot.json',
  activity: 'activity.jsonl',
  stale: 'stale.json',
  seenProjects: 'seen-projects.json',
} as const;

/** ProjectResult is the plan reader's result for one workspace (or the Tasks folder). */
export interface ProjectResult {
  id: string;
  status: 'ok' | 'missing' | 'error' | string;
}

export interface RefreshInput {
  plans: Plan[];
  projects: ProjectResult[];
}

export interface RefreshOutcome {
  /** Changes since the last refresh, to announce. */
  fresh: ActivityEvent[];
  /** Seeded history of workspaces read for the first time; logged, never announced. */
  quiet: ActivityEvent[];
  /** Stale plans to announce; stale plans of workspaces that just appeared are logged only. */
  staleAnnounce: ActivityEvent[];
}

function isEvent(v: unknown): v is ActivityEvent {
  if (typeof v !== 'object' || v === null) return false;
  const e = v as Record<string, unknown>;
  return (
    typeof e.ts === 'string' &&
    !Number.isNaN(Date.parse(e.ts)) &&
    Date.parse(e.ts) > 0 &&
    typeof e.kind === 'string' &&
    typeof e.plan === 'string'
  );
}

function isRecordOf<T>(check: (x: unknown) => x is T) {
  return (v: unknown): Record<string, T> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      throw new Error('not an object');
    for (const x of Object.values(v))
      if (!check(x)) throw new Error('unexpected value');
    return v as Record<string, T>;
  };
}

const isString = (x: unknown): x is string => typeof x === 'string';
const isBool = (x: unknown): x is boolean => typeof x === 'boolean';
const isPlanLike = (x: unknown): x is Plan =>
  typeof x === 'object' && x !== null && typeof (x as Plan).name === 'string';

export interface ActivityLogOptions {
  dataDir: string;
  now?: () => Date;
  io?: SafeIoOptions | undefined;
  maxEvents?: number;
  maxBytes?: number;
}

export class ActivityLog {
  /** The last board, by plan key; null before the first refresh with no snapshot. */
  prev: PlanMap | null = null;
  events: ActivityEvent[] = [];
  staleSeen: Record<string, string> = {};
  seenProjects: Record<string, boolean> = {};
  /** Workspaces whose plans were part of the last refresh; null until the first one this run. */
  lastProjects: Set<string> | null = null;
  /** Warnings from load, for example a store that was unreadable and kept aside. */
  warnings: string[] = [];
  private readonly persisted = new Map<string, string>();
  private readonly maxEvents: number;
  private readonly maxBytes: number;

  constructor(private readonly opts: ActivityLogOptions) {
    this.maxEvents = opts.maxEvents ?? MAX_EVENTS;
    this.maxBytes = opts.maxBytes ?? ACTIVITY_MAX_BYTES;
  }

  private now(): Date {
    return this.opts.now ? this.opts.now() : new Date();
  }

  private file(name: string): string {
    return path.join(this.opts.dataDir, name);
  }

  /**
   * load reads the stores of the previous run. Each read tolerates a missing,
   * partial or corrupt file: that store starts empty (a corrupt one is kept
   * aside with a warning), and the rest load.
   */
  async load(): Promise<void> {
    this.warnings = [];
    const read = async <T>(
      name: string,
      label: string,
      validate: (v: unknown) => T,
    ): Promise<T | undefined> => {
      const r = await readJsonTolerant(this.file(name), {
        now: this.now(),
        validate,
        label,
        ...this.opts.io,
      });
      if (r.status === 'ok') return r.value;
      if (r.status === 'corrupt') this.warnings.push(r.warning);
      if (r.status === 'unreadable')
        this.warnings.push(`${label} could not be read (${r.reason}).`);
      return undefined;
    };
    this.prev =
      (await read(
        STORE_FILES.snapshot,
        'The activity snapshot',
        isRecordOf(isPlanLike),
      )) ?? null;
    this.staleSeen =
      (await read(
        STORE_FILES.stale,
        'The stale-plan list',
        isRecordOf(isString),
      )) ?? {};
    this.seenProjects =
      (await read(
        STORE_FILES.seenProjects,
        'The seen-workspace list',
        isRecordOf(isBool),
      )) ?? {};
    try {
      this.events = (
        await readJsonLines(
          this.file(STORE_FILES.activity),
          this.maxBytes,
          isEvent,
          this.opts.io,
        )
      ).slice(-this.maxEvents);
    } catch (err) {
      this.events = [];
      this.warnings.push(
        `The activity log could not be read (${(err as Error).message}).`,
      );
    }
  }

  /**
   * apply records one successful refresh and returns the events it produced.
   * knownProjects are the configured workspace ids, used to prune the stores;
   * pass null for a run that reads another folder and must not prune.
   */
  async apply(
    input: RefreshInput,
    knownProjects: string[] | null,
  ): Promise<RefreshOutcome> {
    const now = this.now();
    const readable = new Set(
      input.projects.filter((p) => p.status === 'ok').map((p) => p.id),
    );
    const cur: PlanMap = {};
    for (const p of input.plans) cur[planKey(p)] = p;
    const last = this.lastProjects;
    let fresh: ActivityEvent[] = [];
    let quiet: ActivityEvent[];
    if (this.prev) {
      const before: PlanMap = {};
      const changed: PlanMap = {};
      const added: PlanMap = {};
      for (const [k, p] of Object.entries(this.prev)) {
        if (
          !p.project ||
          (readable.has(p.project) && (last === null || last.has(p.project)))
        )
          before[k] = p;
      }
      for (const [k, p] of Object.entries(cur)) {
        if (!p.project || last === null || last.has(p.project)) changed[k] = p;
        else if (!this.seenProjects[p.project]) added[k] = p;
      }
      fresh = diff(before, changed, now);
      quiet = withoutLogged(seed(added), this.events);
    } else {
      quiet = withoutLogged(seed(cur), this.events);
    }
    for (const id of readable) this.seenProjects[id] = true;
    // Plans that appear in this refresh (a workspace added or enabled, or a
    // first run with no snapshot) are logged as stale once but never announced.
    const quietStale = new Set<string>();
    for (const [k, p] of Object.entries(cur)) {
      if (
        this.prev === null ||
        (p.project && last !== null && !last.has(p.project))
      )
        quietStale.add(k);
    }
    this.lastProjects = readable;
    this.prev = cur;
    const all = [...quiet, ...fresh];
    this.remember(all);
    await this.persist(all, knownProjects);
    const stale = await this.recordStale(quietStale, knownProjects, now);
    return { fresh, quiet, staleAnnounce: stale };
  }

  /**
   * record logs an event the app itself caused, such as the owner marking a
   * plan Done. When status is given, the last board takes it as the plan's
   * status too, so the next refresh does not log the same change again.
   */
  async record(
    event: ActivityEvent,
    status?: { key: string; value: string },
  ): Promise<void> {
    this.remember([event]);
    const before = status ? this.prev?.[status.key] : undefined;
    if (before && status)
      this.prev![status.key] = { ...before, status: status.value };
    await this.persist([event], null);
  }

  /** checkStale logs plans that went stale since the last check and returns the ones to announce. */
  checkStale(knownProjects: string[] | null): Promise<ActivityEvent[]> {
    return this.recordStale(new Set(), knownProjects, this.now());
  }

  private async recordStale(
    quiet: Set<string>,
    knownProjects: string[] | null,
    now: Date,
  ): Promise<ActivityEvent[]> {
    const { fresh, announce } = staleEvents(
      this.prev ?? {},
      this.staleSeen,
      now,
      quiet,
    );
    this.remember(fresh);
    if (fresh.length > 0) await this.persist(fresh, knownProjects);
    return announce;
  }

  private remember(events: ActivityEvent[]): void {
    this.events.push(...events);
    if (this.events.length > this.maxEvents)
      this.events = this.events.slice(-this.maxEvents);
  }

  /** pruneStores drops stale entries of workspaces no longer configured and bounds the seen list. */
  pruneStores(knownProjects: string[]): void {
    const known = new Set(knownProjects);
    for (const k of Object.keys(this.staleSeen)) {
      const slash = k.indexOf('/');
      if (
        slash > 0 &&
        k.indexOf('/', slash + 1) > 0 &&
        !known.has(k.slice(0, slash))
      )
        delete this.staleSeen[k];
    }
    const ids = Object.keys(this.seenProjects);
    let count = ids.length;
    for (const id of ids) {
      if (count <= MAX_SEEN_PROJECTS) break;
      if (!known.has(id)) {
        delete this.seenProjects[id];
        count--;
      }
    }
  }

  /**
   * persist writes the stores. Each JSON store is replaced atomically and only
   * when it changed; activity.jsonl is appended and compacted to the events in
   * memory once it grows past the bound.
   */
  async persist(
    fresh: ActivityEvent[],
    knownProjects: string[] | null,
  ): Promise<string[]> {
    if (knownProjects) this.pruneStores(knownProjects);
    const problems: string[] = [];
    const write = async (name: string, value: unknown) => {
      const text = JSON.stringify(value);
      const sum = createHash('sha256').update(text).digest('hex');
      if (this.persisted.get(name) === sum) return;
      try {
        await writeFileAtomic(this.file(name), text, this.opts.io);
        this.persisted.set(name, sum);
      } catch (err) {
        problems.push(`could not save ${name}: ${(err as Error).message}`);
      }
    };
    await write(STORE_FILES.snapshot, this.prev ?? {});
    await write(STORE_FILES.stale, this.staleSeen);
    await write(STORE_FILES.seenProjects, this.seenProjects);
    if (fresh.length > 0) {
      try {
        await appendLines(
          this.file(STORE_FILES.activity),
          fresh.map((e) => JSON.stringify(e)),
          {
            maxBytes: this.maxBytes,
            compact: () => this.events.map((e) => JSON.stringify(e)),
            ...this.opts.io,
          },
        );
      } catch (err) {
        problems.push(
          `could not append to ${STORE_FILES.activity}: ${(err as Error).message}`,
        );
      }
    }
    return problems;
  }
}
