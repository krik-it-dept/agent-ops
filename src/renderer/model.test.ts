import { describe, expect, it } from 'vitest';
import {
  acceptSnapshot,
  activityFor,
  archived,
  dayLabel,
  filterTasks,
  findPlan,
  looseSteps,
  milestoneOpen,
  milestoneProgress,
  milestoneState,
  needsAttention,
  planKey,
  progress,
  protocolPlanLink,
  statusTone,
  taskRows,
  whenLabel,
} from './model';
import { settingsGate } from './store';
import { fixtureData, samplePlan } from './dev/fixture-bridge';
import {
  defaultNavigation,
  migrateNavigation,
  normalizeNavigation,
  visitPlan,
} from './preferences';
import { openingHash } from './routes';
import type { Step } from '../shared/contracts';

describe('source-backed ledger state', () => {
  it('retains old snapshots without revisions without inventing a task status', () => {
    const data = fixtureData();
    data.snapshot.state.plans[0]!.revision = '';
    const before = acceptSnapshot(null, data.snapshot);
    expect(
      acceptSnapshot(before, structuredClone(data.snapshot)).state.plans[0],
    ).toBe(before.state.plans[0]);
    Object.assign(data.snapshot.state.plans[0]!.steps[0]!, {
      status: 'unknown',
    });
    const unknown = acceptSnapshot(null, data.snapshot).state.plans[0]!
      .steps[0]!;
    expect(unknown.status).toBe('unknown');
    expect(unknown.index).toBe(data.snapshot.state.plans[0]!.steps[0]!.index);
  });
  it('retains unchanged plan objects across generations and replaces only changed revisions', () => {
    const data = fixtureData();
    const before = acceptSnapshot(null, data.snapshot);
    const next = structuredClone(data.snapshot);
    next.generation++;
    next.state.plans[1]!.revision = 'b'.repeat(64);
    next.state.plans[1]!.next = 'Changed source';
    const after = acceptSnapshot(before, next);
    expect(after.state.plans[0]).toBe(before.state.plans[0]);
    expect(after.state.plans[1]).not.toBe(before.state.plans[1]);
    expect(after.state.plans[1]!.next).toBe('Changed source');
    expect(acceptSnapshot(after, data.snapshot)).toBe(after);
  });
  it('attaches diagnostics only to the matching project and plan and keeps source fields intact', () => {
    const data = fixtureData();
    const raw = JSON.stringify(data.snapshot);
    const state = acceptSnapshot(null, data.snapshot);
    expect(
      state.state.plans.find((p) => p.source === 'legacy')!.diagnostics,
    ).toHaveLength(1);
    expect(state.state.plans[0]!.diagnostics).toEqual([]);
    expect(JSON.stringify(data.snapshot)).toBe(raw);
  });
  it('renders nested-only and duplicate flat/nested steps once, with loose source steps separate', () => {
    const data = fixtureData();
    const p = data.snapshot.state.plans[0]!;
    const all = p.steps.length;
    const state = acceptSnapshot(null, data.snapshot);
    expect(state.state.plans[0]!.steps).toHaveLength(all);
    expect(looseSteps(state.state.plans[0]!)).toHaveLength(1);
    p.steps = [];
    const nested = acceptSnapshot(null, data.snapshot).state.plans[0]!;
    expect(nested.steps).toHaveLength(4);
    expect(looseSteps(nested)).toEqual([]);
  });
  it('accepts absent newer overview fields and malformed neighboring arrays without breaking readable plans', () => {
    const data = fixtureData();
    const plan = samplePlan();
    Object.assign(plan, {
      milestones: null,
      questions: null,
      decisions: null,
      steps: null,
    });
    data.snapshot.state.plans = [plan, samplePlan('Readable')];
    const state = acceptSnapshot(null, data.snapshot);
    expect(state.state.plans[0]!.steps).toEqual([]);
    expect(state.state.plans[1]!.name).toBe('Readable');
  });
  it('keeps explicit plan and milestone stages independent of unfinished children', () => {
    const p = samplePlan();
    p.status = 'Done';
    p.milestones[1]!.state = 'done';
    expect(progress(p.steps)).toEqual({ done: 2, total: 5 });
    expect(milestoneOpen(p.milestones[1]!)).toBe(true);
    expect(p.status).toBe('Done');
  });
  it('derives the stage of a milestone heading without a recorded state from its steps', () => {
    const m = samplePlan().milestones[0]!;
    const steps = (...statuses: Step['status'][]) =>
      statuses.map((status, index) => ({
        status,
        text: 'Step ' + index,
        line: index + 1,
        milestone: m.id,
        index,
      }));
    expect(
      milestoneState({ ...m, state: '', steps: steps('done', 'done') }),
    ).toBe('done');
    expect(
      milestoneOpen({ ...m, state: '', steps: steps('done', 'done') }),
    ).toBe(false);
    expect(
      milestoneState({ ...m, state: '', steps: steps('done', 'blocked') }),
    ).toBe('blocked');
    expect(
      milestoneState({ ...m, state: '', steps: steps('done', 'todo') }),
    ).toBe('doing');
    expect(milestoneState({ ...m, state: '', steps: steps('todo') })).toBe(
      'todo',
    );
    expect(milestoneState({ ...m, state: '', steps: [] })).toBe('todo');
    expect(
      milestoneState({ ...m, state: 'partial', steps: steps('done') }),
    ).toBe('partial');
  });
  it('trusts valid recorded milestone progress and conservatively falls back on malformed progress', () => {
    const milestone = samplePlan().milestones[1]!;
    milestone.progress = { done: 4, total: 7 };
    expect(milestoneProgress(milestone)).toEqual({ done: 4, total: 7 });
    for (const p of [
      { done: -1, total: 2 },
      { done: 3, total: 2 },
      { done: 1.5, total: 2 },
    ]) {
      milestone.progress = p;
      expect(milestoneProgress(milestone)).toEqual({ done: 0, total: 2 });
    }
  });
  it.each([
    ['Planning', 'todo'],
    ['Implementing', 'doing'],
    ['Fixing review', 'doing'],
    ['Shipping', 'doing'],
    ['Reviewing', 'review'],
    ['Testing', 'review'],
    ['Waiting for CI', 'review'],
    ['Waiting for owner', 'waiting'],
    ['Blocked', 'blocked'],
    ['Done', 'done'],
  ])('labels %s without animation or inferred completion', (stage, tone) => {
    expect(statusTone(stage!)).toBe(tone);
  });
  it('archives only by explicit choice or source Done, with false overriding automatic archiving', () => {
    const { settings } = fixtureData();
    const p = samplePlan();
    settings.autoArchiveDone = true;
    expect(archived(p, settings)).toBe(false);
    p.status = 'Done';
    expect(archived(p, settings)).toBe(true);
    settings.planArchive = { [planKey(p)]: false };
    expect(archived(p, settings)).toBe(false);
    p.status = 'Implementing';
    settings.planArchive[planKey(p)] = true;
    expect(archived(p, settings)).toBe(true);
    expect(p.status).toBe('Implementing');
  });
  it('counts blocked/waiting/open questions/stale plans as attention without filtering individual tasks', () => {
    const data = fixtureData(),
      p = samplePlan();
    expect(needsAttention(p, data.snapshot)).toBe(true);
    p.questions = [];
    p.steps = [];
    expect(needsAttention(p, data.snapshot)).toBe(false);
    p.status = 'Waiting for owner - Wording';
    expect(needsAttention(p, data.snapshot)).toBe(true);
    p.status = 'Testing';
    data.snapshot.stale[planKey(p)] = true;
    expect(needsAttention(p, data.snapshot)).toBe(true);
  });
  it('resolves legacy plan keys only when unambiguous across projects', () => {
    const a = samplePlan('Same'),
      b = samplePlan('Same', 'Ledger', 'personal');
    expect(findPlan([a], a.repo + '/' + a.name)).toBe(a);
    expect(findPlan([a, b], a.repo + '/' + a.name)).toBeUndefined();
    expect(findPlan([a, b], planKey(b))).toBe(b);
  });
});
describe('task filters and natural sorting', () => {
  const data = fixtureData();
  const plans = acceptSnapshot(null, data.snapshot).state.plans;
  const rows = taskRows(plans);
  const base = {
    status: 'all' as const,
    work: '',
    plans: null,
    query: '',
    sort: null,
  };
  it('lists real checklist tasks independent of parent stage and combines all filters', () => {
    const p = { ...plans[0]!, status: 'Done' };
    const result = filterTasks(taskRows([p]), {
      ...base,
      status: 'doing',
      plans: [planKey(p)],
      query: 'kiểm',
      work: 'tìm',
    });
    expect(result).toHaveLength(1);
    expect(result[0]!.step.status).toBe('doing');
    expect(result[0]!.plan.status).toBe('Done');
    expect(filterTasks(rows, { ...base, plans: [] })).toEqual([]);
  });
  it('naturally sorts every column in either direction without mutating source rows', () => {
    const original = JSON.stringify(rows);
    for (const column of ['work', 'plan', 'status'] as const) {
      const asc = filterTasks(rows, {
        ...base,
        sort: { column, direction: 'asc' },
      });
      const desc = filterTasks(rows, {
        ...base,
        sort: { column, direction: 'desc' },
      });
      expect(asc).toHaveLength(rows.length);
      expect(desc).toHaveLength(rows.length);
      expect(asc[0]).not.toBe(desc[0]);
    }
    expect(JSON.stringify(rows)).toBe(original);
  });
  it('uses Vietnamese accent folding and natural numeric text order', () => {
    const many = [samplePlan('Plan 10'), samplePlan('Plan 2')];
    const data = fixtureData();
    data.snapshot.state.plans = many;
    const r = taskRows(acceptSnapshot(null, data.snapshot).state.plans);
    expect(filterTasks(r, { ...base, query: 'xac minh' })).toHaveLength(2);
    expect(
      filterTasks(r, {
        ...base,
        sort: { column: 'plan', direction: 'asc' },
      })[0]!.plan.name,
    ).toBe('Plan 2');
  });
});
describe('private navigation and history', () => {
  it('restores the previous view on reopen, clears saved filters and respects explicit deep links', () => {
    expect(openingHash('', { route: '/list?status=done&q=old' })).toBe(
      '#/list',
    );
    for (const route of ['/attention', '/board', '/timeline'])
      expect(openingHash('', { route })).toBe('#' + route);
    expect(openingHash('', { layout: 'list' })).toBe('#/list');
    expect(openingHash('#/plan/explicit/summary', { route: '/list' })).toBe(
      '#/plan/explicit/summary',
    );
    expect(openingHash('', { route: '//foreign-host' })).toBe('#/');
  });
  it('bounds tabs/recent, deduplicates deliberate visits and retains unavailable stars', () => {
    let nav = normalizeNavigation({
      starred: ['missing/old', 'missing/old'],
      recent: [],
    });
    for (let i = 0; i < 15; i++)
      nav = visitPlan(nav, 'Plan ' + i, new Date().toISOString());
    expect(nav.recent).toHaveLength(12);
    expect(nav.openPlans).toHaveLength(8);
    nav = visitPlan(nav, 'Plan 14', new Date().toISOString());
    expect(nav.recent).toHaveLength(12);
    expect(nav.starred).toEqual(['missing/old']);
  });
  it('migrates old keys only after plans exist and retains ambiguous keys', () => {
    const a = samplePlan(),
      b = samplePlan(a.name, 'Ledger', 'personal'),
      old = a.repo + '/' + a.name,
      nav = { ...defaultNavigation(), starred: [old], groups: { [old]: true } };
    expect(migrateNavigation(nav, [])).toBe(nav);
    expect(migrateNavigation(nav, [a]).starred).toEqual([planKey(a)]);
    expect(migrateNavigation(nav, [a, b]).starred).toEqual([old]);
  });
  it('accepts only the bounded agent-ops plan activation shape', () => {
    const key = 'studio/Ledger/Plan / ? # ü';
    expect(
      protocolPlanLink('agent-ops:open?plan=' + encodeURIComponent(key)),
    ).toBe(key);
    for (const link of [
      'https://example.com',
      'agent-ops:open?file=C:/a',
      'agent-ops:run?plan=x',
      'agent-ops:open?plan=a&plan=b',
      'agent-ops:open?plan=a&command=run',
    ])
      expect(protocolPlanLink(link)).toBeNull();
  });
  it('uses Vietnam day boundaries, including leap-day Yesterday', () => {
    expect(dayLabel('2026-11-09T17:30:00Z', '2026-11-10T01:00:00Z')).toBe(
      'Today',
    );
    expect(dayLabel('2024-02-29T10:00:00Z', '2024-03-01T01:00:00Z')).toBe(
      'Yesterday',
    );
  });
  it('keeps historical entries separate across plans without attributing agents', () => {
    const data = fixtureData();
    const a = samplePlan('Alpha'),
      b = samplePlan('Beta');
    data.snapshot.state.plans = [a, b];
    data.snapshot.activity = [];
    const events = activityFor(acceptSnapshot(null, data.snapshot));
    expect(events).toHaveLength(4);
    expect(new Set(events.map((e) => e.plan))).toEqual(
      new Set(['Alpha', 'Beta']),
    );
    expect(events.every((e) => e.actor === 'Minh')).toBe(true);
  });
});
describe('settings ordering and time labels', () => {
  it('drops a settings read that started before a newer settings change', () => {
    const gate = settingsGate();
    const stale = gate.begin();
    gate.changed();
    expect(gate.current(stale)).toBe(false);
    const fresh = gate.begin();
    expect(gate.current(fresh)).toBe(true);
  });
  it('labels a time with its day, and nothing when the time is unknown', () => {
    const now = '2026-11-10T09:30:00.000Z';
    expect(whenLabel('2026-11-10T02:00:00.000Z', now)).toBe('Today 09:00');
    expect(whenLabel('2026-11-09T02:00:00.000Z', now)).toBe('Yesterday 09:00');
    expect(whenLabel('2026-10-05T03:15:00.000Z', now)).toMatch(
      /^Monday,? 05\/10 10:15$/,
    );
    expect(whenLabel('', now)).toBe('');
  });
});
