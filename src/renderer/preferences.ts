import { findPlan, planKey } from './model';
import type { Plan } from '../shared/contracts';
export interface Navigation {
  starred: string[];
  recent: { key: string; openedAt: string }[];
  openPlans: string[];
  collapsed: boolean;
  folders: Record<string, boolean>;
  disclosures: Record<string, boolean>;
  groups: Record<string, boolean>;
  collection: 'all' | 'starred' | 'recent';
  group: 'plan' | 'none';
}
export const defaultNavigation = (): Navigation => ({
  starred: [],
  recent: [],
  openPlans: [],
  collapsed: false,
  folders: {},
  disclosures: {},
  groups: {},
  collection: 'all',
  group: 'plan',
});
export function loadPreference<T>(key: string, fallback: T): T {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || 'null');
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? { ...fallback, ...parsed }
      : fallback;
  } catch {
    return fallback;
  }
}
export function savePreference(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Navigation remains usable when local storage is unavailable. */
  }
}
export function normalizeNavigation(value: Partial<Navigation>): Navigation {
  const base = { ...defaultNavigation(), ...value };
  const strings = (v: unknown) =>
    Array.isArray(v)
      ? [
          ...new Set(
            v.filter((x: unknown): x is string => typeof x === 'string'),
          ),
        ]
      : [];
  const flags = (v: unknown): Record<string, boolean> =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(
          Object.entries(v).filter(([, on]) => typeof on === 'boolean'),
        )
      : {};
  return {
    ...base,
    starred: strings(base.starred).slice(0, 200),
    openPlans: strings(base.openPlans).slice(-8),
    recent: Array.isArray(base.recent)
      ? base.recent
          .filter(
            (r, i, all) =>
              r &&
              typeof r.key === 'string' &&
              Number.isFinite(Date.parse(r.openedAt)) &&
              all.findIndex((a) => a?.key === r.key) === i,
          )
          .slice(0, 12)
      : [],
    collapsed: base.collapsed === true,
    folders: flags(base.folders),
    disclosures: flags(base.disclosures),
    groups: flags(base.groups),
    collection: ['starred', 'recent'].includes(base.collection)
      ? base.collection
      : 'all',
    group: base.group === 'none' ? 'none' : 'plan',
  };
}
export function migrateNavigation(nav: Navigation, plans: Plan[]): Navigation {
  if (!plans.length) return nav;
  const key = (value: string) => {
    const p = findPlan(plans, value);
    return p ? planKey(p) : value;
  };
  return normalizeNavigation({
    ...nav,
    starred: nav.starred.map(key),
    recent: nav.recent.map((r) => ({ ...r, key: key(r.key) })),
    openPlans: nav.openPlans.map(key),
    groups: Object.fromEntries(
      Object.entries(nav.groups).map(([k, v]) => [key(k), v]),
    ),
  });
}
export function visitPlan(
  nav: Navigation,
  key: string,
  at: string,
): Navigation {
  return {
    ...nav,
    openPlans: nav.openPlans.includes(key)
      ? nav.openPlans
      : [...nav.openPlans, key].slice(-8),
    recent: [
      { key, openedAt: at },
      ...nav.recent.filter((r) => r.key !== key),
    ].slice(0, 12),
  };
}
