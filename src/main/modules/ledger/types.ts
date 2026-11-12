import type { CollectConfig, Overview, Plan, Project } from '../plans';
import type { Activity } from '../../../shared/contracts';

export interface LedgerConfiguration extends CollectConfig {
  projects: Project[];
  setupRequired?: boolean;
  planArchive?: Record<string, boolean>;
  warnings?: string[];
}
export interface ActivitySnapshot {
  activity: Activity[];
  stale: Record<string, boolean>;
  warnings?: string[];
}
/** The activity owner supplies diff/seed/stale/store semantics through this boundary. */
export interface ActivityPort {
  load?(): Promise<void>;
  apply(overview: Overview): Promise<void>;
  snapshot(): ActivitySnapshot;
  tick?(): Promise<boolean>;
  /** record logs an event the app caused; status updates the last board for that plan. */
  record?(
    event: Activity,
    status?: { key: string; value: string },
  ): Promise<void>;
}
export interface OverviewCache {
  load(): Promise<Overview | undefined>;
  save(overview: Overview): Promise<void>;
}
export interface LedgerState {
  generation: number;
  appVersion: string;
  state: Overview;
  activity: Activity[];
  now: string;
  error: string;
  stale: Record<string, boolean>;
  setupRequired: boolean;
  projects: {
    id: string;
    name: string;
    path: string;
    kind: 'repo' | 'folder';
    enabled: boolean;
    status: 'ok' | 'missing' | 'error' | 'disabled' | 'pending';
    message?: string;
    repos: number;
    plans: number;
  }[];
  warnings: string[];
  crash: null;
  planArchive: Record<string, boolean> | null;
}
export type Collector = (
  config: CollectConfig,
  signal: AbortSignal,
) => Promise<Overview>;
export interface LedgerOptions {
  version: string;
  configuration(): Promise<LedgerConfiguration>;
  collect: Collector;
  cache: OverviewCache;
  activity?: ActivityPort;
  now?: () => Date;
  timeoutMs?: number;
  changed?(event: { generation: number }): void;
  log?(category: string, error?: unknown): void;
}
export const planKey = (plan: Plan): string =>
  `${plan.project}/${plan.repo}/${plan.name}`;
export function emptyOverview(now: Date): Overview {
  return {
    generatedAt: now.toISOString(),
    projects: [],
    repos: [],
    plans: [],
    diagnostics: [],
  };
}

/** Validate worker/cache data before publication; a bad cache must not hide other plans. */
export function isOverview(value: unknown): value is Overview {
  if (!value || typeof value !== 'object') return false;
  const v = value as Partial<Overview>;
  if (
    typeof v.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(v.generatedAt)) ||
    !Array.isArray(v.projects) ||
    !Array.isArray(v.repos) ||
    !Array.isArray(v.plans) ||
    !Array.isArray(v.diagnostics)
  )
    return false;
  const keys = new Set<string>();
  return v.plans.every((p) => {
    if (
      !p ||
      typeof p !== 'object' ||
      typeof p.project !== 'string' ||
      typeof p.repo !== 'string' ||
      !p.repo ||
      typeof p.name !== 'string' ||
      !p.name ||
      typeof p.revision !== 'string' ||
      !/^[a-f0-9]{64}$/.test(p.revision) ||
      typeof p.mtime !== 'string' ||
      !Number.isFinite(Date.parse(p.mtime)) ||
      !Array.isArray(p.steps) ||
      !Array.isArray(p.milestones) ||
      !Array.isArray(p.questions) ||
      !Array.isArray(p.decisions)
    )
      return false;
    const key = planKey(p);
    if (keys.has(key)) return false;
    keys.add(key);
    const step = (s: Plan['steps'][number]): boolean =>
      !!s &&
      ['todo', 'doing', 'done', 'partial', 'blocked', 'waiting'].includes(
        s.status,
      ) &&
      typeof s.text === 'string' &&
      Number.isSafeInteger(s.line);
    return (
      p.steps.every(step) &&
      p.milestones.every(
        (m) => m && Array.isArray(m.steps) && m.steps.every(step),
      )
    );
  });
}
