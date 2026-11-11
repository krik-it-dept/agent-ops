import { describe, expect, it } from 'vitest';
import { plan } from './test-plans';
import {
  STALE_AFTER_MS,
  actor,
  diff,
  entryTime,
  isStale,
  matchSteps,
  movedPlans,
  planKey,
  seed,
  staleEvents,
  withoutLogged,
  type ActivityEvent,
  type Plan,
  type PlanMap,
} from './diff';

const one = (p: Plan): PlanMap => ({ [planKey(p)]: p });

function kinds(events: ActivityEvent[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of events) out[e.kind] = (out[e.kind] ?? 0) + 1;
  return out;
}

const clone = (p: Plan): Plan => JSON.parse(JSON.stringify(p)) as Plan;

describe('diff', () => {
  const cases: [string, (p: Plan) => void, Record<string, number>][] = [
    [
      'reworded step completed',
      (p) => {
        p.steps = [{ status: 'done', text: 'Hoàn thành giao diện mới' }];
        p.milestones[0]!.steps = p.steps;
      },
      { done: 1, milestone: 1 },
    ],
    [
      'new decision',
      (p) =>
        void (p.decisions = [
          {
            text: 'Use the existing design',
            key: '202611090900',
            when: '',
            ask: '',
            answer: '',
            open: false,
          },
        ]),
      { decision: 1 },
    ],
    [
      'answered question',
      (p) =>
        void (p.questions = [
          {
            ask: 'Ship today?',
            answer: 'Yes',
            open: false,
            key: '',
            when: '',
            text: '',
          },
        ]),
      { answer: 1 },
    ],
    [
      'milestone done',
      (p) => {
        p.milestones[0]!.state = 'done';
        p.milestones[0]!.summary = 'Evidence #1234';
      },
      { milestone: 1 },
    ],
    [
      'status change to waiting',
      (p) => void (p.status = 'Waiting for owner - review'),
      { status: 1, waiting: 1 },
    ],
    ['unchanged', () => undefined, {}],
  ];
  for (const [name, change, want] of cases) {
    it(name, () => {
      const old = plan({}, { status: 'doing', text: 'Xây dựng giao diện' });
      old.questions = [
        {
          ask: 'Ship today?',
          open: true,
          key: '',
          when: '',
          text: '',
          answer: '',
        },
      ];
      const cur = clone(old);
      change(cur);
      const got = diff(one(old), one(cur));
      expect(kinds(got)).toEqual(want);
      for (const e of got) expect(e.actor).toBe('Lan');
      expect(diff(one(cur), one(cur))).toEqual([]);
    });
  }

  it('a new plan announces itself, waiting, blocked steps and open questions', () => {
    const p = plan(
      { status: 'Waiting for owner' },
      { status: 'blocked', text: 'Need a key' },
    );
    p.questions = [
      {
        ask: 'Which key?',
        open: true,
        key: '',
        when: '',
        text: '',
        answer: '',
      },
    ];
    expect(kinds(diff({}, one(p)))).toEqual({
      new: 1,
      waiting: 1,
      blocked: 1,
      question: 1,
    });
  });

  it('a closed plan', () => {
    expect(kinds(diff(one(plan()), {}))).toEqual({ closed: 1 });
  });

  it('done rewording is silent', () => {
    expect(
      diff(
        one(plan({}, { status: 'done', text: 'Build UI' })),
        one(plan({}, { status: 'done', text: 'Deliver interface' })),
      ),
    ).toEqual([]);
  });

  it('insertions and duplicate text', () => {
    const a = plan(
      {},
      { status: 'done', text: 'Build UI' },
      { status: 'todo', text: 'Test UI' },
      { status: 'todo', text: 'Test UI' },
    );
    const b = plan(
      {},
      { status: 'todo', text: 'New step' },
      { status: 'done', text: 'Build UI' },
      { status: 'done', text: 'Test UI' },
      { status: 'todo', text: 'Test UI' },
    );
    expect(kinds(diff(one(a), one(b)))).toEqual({ done: 1 });
  });

  it('same text across milestones', () => {
    const a = plan({}, { status: 'done', text: 'Test' });
    a.milestones.push({
      id: 'M2',
      title: '',
      state: '',
      summary: '',
      steps: [{ status: 'todo', text: 'Test' }],
    });
    a.steps.push({ status: 'todo', text: 'Test' });
    const b = plan(
      {},
      { status: 'done', text: 'Test' },
      { status: 'done', text: 'Test' },
    );
    b.milestones = [
      {
        id: 'M1',
        title: '',
        state: '',
        summary: '',
        steps: b.steps.slice(0, 1),
      },
      { id: 'M2', title: '', state: '', summary: '', steps: b.steps.slice(1) },
    ];
    expect(kinds(diff(one(a), one(b)))).toEqual({ done: 1, milestone: 1 });
  });

  it('steps from before step metadata are grouped by their milestone field', () => {
    const a = plan(
      { milestones: [] },
      { status: 'todo', text: 'Ship', milestone: 'M1' },
    );
    const b = plan(
      { milestones: [] },
      { status: 'doing', text: 'Ship', milestone: 'M1' },
    );
    expect(kinds(diff(one(a), one(b)))).toEqual({ doing: 1 });
    expect(matchSteps([], [{ status: 'doing', text: 'x' }])).toEqual([-1]);
  });

  it('a moved plan is one moved event, not closed and new', () => {
    const legacy = plan({
      project: 'aa11aa11',
      repo: 'web',
      name: 'release',
      revision: 'abc',
      file: 'D:/repos/web/.tasks/release.md',
    });
    const moved = plan({
      project: 'tasks',
      repo: 'web',
      name: 'release',
      revision: 'abc',
      file: 'C:/tasks/web/release.md',
    });
    const got = diff(one(legacy), one(moved));
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({
      kind: 'moved',
      project: 'tasks',
      repo: 'web',
      plan: 'release',
      extra: 'D:/repos/web/.tasks/release.md',
    });
    // A different plan with the same name is not a move.
    const { movedFrom } = movedPlans(
      { 'a/web/x': plan({ name: 'x', revision: '1' }) },
      { 'tasks/web/x': plan({ name: 'x', revision: '2' }) },
    );
    expect(movedFrom.size).toBe(0);
    // Plans without a revision are never paired.
    expect(
      movedPlans(
        { 'a/web/x': plan({ name: 'x' }) },
        { 'tasks/web/x': plan({ name: 'x' }) },
      ).movedFrom.size,
    ).toBe(0);
  });
});

describe('actor, seed and stale', () => {
  it('actor is the owner, else the repository', () => {
    expect(actor(plan())).toBe('Lan');
    expect(actor(plan({ owner: ' ' }))).toBe('sample');
  });

  it('seed uses dated entries and milestones with evidence', () => {
    const p = plan({}, { status: 'done', text: 'Done' });
    p.milestones[0]!.summary = 'Proof';
    p.decisions = [
      {
        key: '202611090930',
        text: 'Dated',
        when: '',
        ask: '',
        answer: '',
        open: false,
      },
      { key: '', text: 'Undated', when: '', ask: '', answer: '', open: false },
    ];
    p.questions = [
      {
        key: '202611089999',
        ask: 'Date only',
        open: true,
        when: '',
        text: '',
        answer: '',
      },
    ];
    const ev = seed(one(p));
    expect(kinds(ev)).toEqual({ decision: 1, question: 1, milestone: 1 });
    expect(ev.find((e) => e.kind === 'milestone')?.ts).toBe(p.mtime);
    expect(ev.find((e) => e.kind === 'question')?.ts).toBe(
      new Date(2026, 10, 8, 0, 0).toISOString(),
    );
    p.milestones[0]!.summary = '';
    expect(kinds(seed(one(p))).milestone).toBeUndefined();
  });

  it('entryTime refuses impossible dates', () => {
    expect(entryTime('202613010000')).toBeUndefined();
    expect(entryTime('2026111009')).toBeUndefined();
    expect(entryTime('202611100930')?.getMinutes()).toBe(30);
  });

  it('stale boundary', () => {
    const now = new Date();
    const at = (ms: number) => new Date(now.getTime() - ms).toISOString();
    for (const status of [
      'Planning',
      'Implementing',
      'Reviewing',
      'Fixing review',
      'Testing',
    ]) {
      expect(
        isStale(
          plan({ status: `${status} - detail`, mtime: at(STALE_AFTER_MS) }),
          now,
        ),
        status,
      ).toBe(true);
      expect(
        isStale(plan({ status, mtime: at(STALE_AFTER_MS - 1) }), now),
      ).toBe(false);
    }
    for (const status of [
      'Waiting for CI',
      'Waiting for owner',
      'Shipping',
      'Blocked',
      'Done',
      'Testing extra',
    ]) {
      expect(
        isStale(plan({ status, mtime: at(3 * 3600_000) }), now),
        status,
      ).toBe(false);
    }
  });

  it('stale once per edit; a deleted plan is forgotten; a workspace not read keeps its entries', () => {
    const now = new Date();
    const p = plan({
      mtime: new Date(now.getTime() - 3 * 3600_000).toISOString(),
    });
    const seen: Record<string, string> = {};
    expect(staleEvents(one(p), seen, now).fresh).toHaveLength(1);
    expect(
      staleEvents(one(p), seen, new Date(now.getTime() + 60_000)).fresh,
    ).toHaveLength(0);
    p.mtime = new Date(Date.parse(p.mtime) + 60_000).toISOString();
    expect(staleEvents(one(p), seen, now).fresh).toHaveLength(1);
    staleEvents({}, seen, now);
    expect(seen).toEqual({});
    seen['gone/r/p'] = p.mtime;
    staleEvents(one(plan({ project: 'other' })), seen, now);
    expect(Object.keys(seen)).toEqual(['gone/r/p']);
    const quiet = staleEvents(
      one(plan({ name: 'q', mtime: p.mtime })),
      {},
      now,
      new Set(['sample/q']),
    );
    expect(quiet.fresh).toHaveLength(1);
    expect(quiet.announce).toHaveLength(0);
  });

  it('withoutLogged skips seeded events the log already has', () => {
    const ts = new Date(2026, 10, 10, 9, 0).toISOString();
    const logged: ActivityEvent = {
      ts,
      project: 'p',
      repo: 'r',
      plan: 'plan',
      kind: 'decision',
      text: 'Use Go',
      actor: 'Lan',
    };
    const fresh: ActivityEvent = {
      ...logged,
      ts: new Date(Date.parse(ts) + 60_000).toISOString(),
      text: 'New',
    };
    // The same time written by Go with an offset is the same event.
    const goStyle = {
      ...logged,
      ts: '2026-11-10T09:00:00' + offset(new Date(ts)),
    };
    expect(
      withoutLogged([goStyle, fresh], [logged]).map((e) => e.text),
    ).toEqual(['New']);
  });
});

function offset(d: Date): string {
  const m = -d.getTimezoneOffset();
  const sign = m >= 0 ? '+' : '-';
  const a = Math.abs(m);
  return `${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`;
}

describe('reported runs', () => {
  const mark = (runId: string, event: string, over = {}) => ({
    runId,
    event,
    agent: 'Codex',
    step: 'Build it',
    result: '',
    ...over,
  });
  const T = new Date('2026-11-11T05:00:00Z');
  it('announces a run started, finished and blocked, by the agent that reported it', () => {
    const old = plan({ runs: [mark('a', 'start'), mark('b', 'progress')] });
    const cur = plan({
      runs: [
        mark('c', 'start', { agent: 'Claude', step: '' }),
        mark('b', 'blocked', { result: 'Thiếu quyền' }),
        mark('a', 'done', { result: 'PR #3' }),
        mark('d', 'stopped', { result: 'Dừng' }),
      ],
    });
    const events = diff(one(old), one(cur), T);
    expect(events.map((e) => [e.kind, e.actor, e.text, e.extra ?? ''])).toEqual(
      [
        ['run-finished', 'Codex', 'Build it', 'Dừng'],
        ['run-finished', 'Codex', 'Build it', 'PR #3'],
        ['run-blocked', 'Codex', 'Build it', 'Thiếu quyền'],
        ['run-started', 'Claude', 'Cả plan', ''],
      ],
    );
    expect(events.every((e) => e.ts === T.toISOString())).toBe(true);
  });
  it('announces nothing for unchanged runs or a snapshot from before runs', () => {
    const cur = plan({ runs: [mark('a', 'progress'), mark('b', 'done')] });
    expect(diff(one(cur), one(clone(cur)), T)).toEqual([]);
    const before = plan();
    expect(diff(one(before), one(cur), T)).toEqual([]);
    const ended = plan({ runs: [mark('b', 'done', { result: 'x' })] });
    expect(
      diff(one(ended), one(plan({ runs: [mark('b', 'done')] })), T),
    ).toEqual([]);
  });
  it('announces runs of a new plan after the plan itself', () => {
    const p = plan({ runs: [mark('a', 'start')] });
    expect(kinds(diff({}, one(p), T))).toEqual({ new: 1, 'run-started': 1 });
  });
});
