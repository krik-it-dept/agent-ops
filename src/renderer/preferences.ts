import { findPlan, planKey } from './model';
import type { Plan } from '../shared/contracts';
export interface Navigation {
  starred: string[];
  recent: { key: string; openedAt: string }[];
  openPlans: string[];
  pinnedPlans: string[];
  pinnedCards: string[];
  sidebarWidth: number;
  sidebarOrder: string[];
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
  pinnedPlans: [],
  pinnedCards: [],
  sidebarWidth: 244,
  sidebarOrder: [],
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
  const open = strings(base.openPlans);
  const pinned = strings(base.pinnedPlans)
    .filter((key) => open.includes(key))
    .slice(0, 8);
  return {
    ...base,
    starred: strings(base.starred).slice(0, 200),
    pinnedPlans: pinned,
    pinnedCards: strings(base.pinnedCards).slice(0, 200),
    sidebarOrder: strings(base.sidebarOrder).slice(0, 2000),
    openPlans: [
      ...open.filter((key) => pinned.includes(key)),
      ...open.filter((key) => !pinned.includes(key)).slice(-8),
    ],
    sidebarWidth:
      typeof base.sidebarWidth === 'number' &&
      Number.isFinite(base.sidebarWidth)
        ? Math.round(Math.max(185, Math.min(420, base.sidebarWidth)))
        : 244,
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
    pinnedPlans: nav.pinnedPlans.map(key),
    pinnedCards: nav.pinnedCards.map(key),
    sidebarOrder: nav.sidebarOrder.map(key),
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
  return normalizeNavigation({
    ...nav,
    openPlans: nav.openPlans.includes(key)
      ? nav.openPlans
      : [...nav.openPlans, key],
    recent: [
      { key, openedAt: at },
      ...nav.recent.filter((r) => r.key !== key),
    ].slice(0, 12),
  });
}

export function pinPlanTab(
  nav: Navigation,
  key: string,
  pinned: boolean,
): Navigation {
  if (!nav.openPlans.includes(key) || (pinned && nav.pinnedPlans.length >= 8))
    return nav;
  return normalizeNavigation({
    ...nav,
    pinnedPlans: pinned
      ? [...nav.pinnedPlans, key]
      : nav.pinnedPlans.filter((k) => k !== key),
  });
}

/** Sidebar ordering is private presentation; it never moves a file or changes Plan state. */
export function moveSidebarPlan(
  nav: Navigation,
  keys: string[],
  source: string,
  target: string,
  after: boolean,
): Navigation {
  if (source === target || !keys.includes(source) || !keys.includes(target))
    return nav;
  const rank = new Map(nav.sidebarOrder.map((key, index) => [key, index]));
  const ordered = [...new Set(keys)].sort(
    (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity),
  );
  const next = ordered.filter((key) => key !== source);
  next.splice(next.indexOf(target) + (after ? 1 : 0), 0, source);
  if (next.every((key, index) => key === ordered[index])) return nav;
  return {
    ...nav,
    sidebarOrder: [
      ...nav.sidebarOrder.filter((key) => !keys.includes(key)),
      ...next,
    ].slice(-2000),
  };
}

export function movePlanTab(
  nav: Navigation,
  key: string,
  target: string,
): Navigation {
  const from = nav.openPlans.indexOf(key),
    to = nav.openPlans.indexOf(target);
  if (
    from < 0 ||
    to < 0 ||
    from === to ||
    nav.pinnedPlans.includes(key) !== nav.pinnedPlans.includes(target)
  )
    return nav;
  const openPlans = [...nav.openPlans];
  openPlans.splice(from, 1);
  openPlans.splice(to, 0, key);
  return { ...nav, openPlans };
}
