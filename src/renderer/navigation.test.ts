import { describe, expect, it } from 'vitest';
import { sidebarPlans } from './components/Sidebar';
import { samplePlan } from './dev/fixture-bridge';
import { planKey } from './model';
import {
  defaultNavigation,
  normalizeNavigation,
  visitPlan,
  movePlanTab,
  pinPlanTab,
  moveSidebarPlan,
} from './preferences';

describe('workspace navigation preferences', () => {
  it('reorders sidebar cards before or after a target without changing tab or pin preferences', () => {
    const nav = {
      ...defaultNavigation(),
      openPlans: ['B', 'A'],
      pinnedCards: ['A'],
      sidebarOrder: ['outside'],
    };
    const moved = moveSidebarPlan(nav, ['A', 'B', 'C'], 'A', 'C', true);
    expect(moved.sidebarOrder).toEqual(['outside', 'B', 'C', 'A']);
    expect(moved.openPlans).toEqual(nav.openPlans);
    expect(moved.pinnedCards).toEqual(nav.pinnedCards);
    expect(
      moveSidebarPlan(moved, ['A', 'B', 'C'], 'A', 'B', false).sidebarOrder,
    ).toEqual(['outside', 'A', 'B', 'C']);
    const ordered = moveSidebarPlan(moved, ['A', 'B', 'C'], 'A', 'B', false);
    expect(moveSidebarPlan(ordered, ['A', 'B', 'C'], 'A', 'B', false)).toBe(
      ordered,
    );
    expect(moveSidebarPlan(nav, ['A', 'B'], 'missing', 'B', false)).toBe(nav);
    expect(
      normalizeNavigation({ sidebarOrder: ['A', 'A', 'B'] }).sidebarOrder,
    ).toEqual(['A', 'B']);

    const plans = ['One', 'Two', 'Three'].map((name) => ({
      ...samplePlan(name),
      diagnostics: [],
    }));
    const keys = plans.map(planKey);
    const reordered = moveSidebarPlan(
      {
        ...defaultNavigation(),
        starred: [keys[0]!, keys[2]!],
        recent: [
          { key: keys[0]!, openedAt: '2026-11-12T09:00:00.000Z' },
          { key: keys[2]!, openedAt: '2026-11-12T08:00:00.000Z' },
        ],
      },
      keys,
      keys[2]!,
      keys[0]!,
      false,
    );
    expect(sidebarPlans(plans, reordered).map((p) => p.name)).toEqual([
      'Three',
      'One',
      'Two',
    ]);
    expect(
      sidebarPlans(plans, { ...reordered, collection: 'starred' }).map(
        (p) => p.name,
      ),
    ).toEqual(['Three', 'One']);
    expect(
      sidebarPlans(plans, { ...reordered, collection: 'recent' }).map(
        (p) => p.name,
      ),
    ).toEqual(['One', 'Three']);
  });
  it('bounds sidebar width and rejects malformed values', () => {
    expect(normalizeNavigation({ sidebarWidth: 900 }).sidebarWidth).toBe(420);
    expect(normalizeNavigation({ sidebarWidth: -1 }).sidebarWidth).toBe(185);
    expect(normalizeNavigation({ sidebarWidth: NaN }).sidebarWidth).toBe(244);
    expect(normalizeNavigation({}).sidebarWidth).toBe(244);
  });
  it('pins tabs ahead of unpinned tabs and preserves pins when new plans open', () => {
    let nav = { ...defaultNavigation(), openPlans: ['A', 'B', 'C'] };
    nav = pinPlanTab(nav, 'B', true);
    expect(nav.openPlans).toEqual(['B', 'A', 'C']);
    for (let i = 0; i < 12; i++)
      nav = visitPlan(nav, `Plan ${i}`, new Date().toISOString());
    expect(nav.openPlans[0]).toBe('B');
    expect(nav.pinnedPlans).toEqual(['B']);
    expect(nav.openPlans).toHaveLength(9);
    expect(pinPlanTab(nav, 'missing', true)).toBe(nav);
    expect(pinPlanTab(nav, 'B', false).pinnedPlans).toEqual([]);
  });
  it('reorders only existing tabs within the same pin group', () => {
    const nav = {
      ...defaultNavigation(),
      openPlans: ['P', 'A', 'B', 'C'],
      pinnedPlans: ['P'],
    };
    expect(movePlanTab(nav, 'C', 'A').openPlans).toEqual(['P', 'C', 'A', 'B']);
    expect(movePlanTab(nav, 'A', 'C').openPlans).toEqual(['P', 'B', 'C', 'A']);
    expect(movePlanTab(nav, 'A', 'P')).toBe(nav);
    expect(movePlanTab(nav, 'missing', 'A')).toBe(nav);
  });
});
