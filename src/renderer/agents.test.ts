import { describe, expect, it } from 'vitest';
import {
  agentMatches,
  agentWorkload,
  execution,
  participation,
  stepAgentMatches,
} from './agents';
import { samplePlan, fixtureData } from './dev/fixture-bridge';
import {
  acceptSnapshot,
  activityFor,
  needsAttention,
  filterTasks,
  taskRows,
} from './model';
import type { AgentRun } from '../shared/contracts';

function reported(overrides: Partial<AgentRun> = {}): AgentRun {
  const step = samplePlan().steps[2]!;
  return {
    runId: 'run-one',
    agent: 'Codex',
    coordinator: 'Claude',
    role: 'executor',
    event: 'progress',
    active: true,
    startedAt: '2026-11-10T08:00:00.000Z',
    updatedAt: '2026-11-10T09:00:00.000Z',
    step: { line: step.line, text: step.text, milestone: step.milestone },
    result: 'Đã xác minh kết quả',
    ...overrides,
  };
}
describe('reported agent participation', () => {
  it('orders reports by the actual time across timezone offsets and ignores a blank plan agent', () => {
    const p = {
      ...samplePlan(),
      agent: ' ',
      runs: [
        reported({
          updatedAt: '2026-11-10T10:00:00+07:00',
          coordinator: 'Gemini',
        }),
        reported({ coordinator: 'Claude' }),
      ],
    };
    expect(participation(p).coordinator).toBe('Claude');
    expect(execution(p, p.steps[2]!).latest?.updatedAt).toBe(
      '2026-11-10T09:00:00.000Z',
    );
  });
  it('surfaces a reported blocker without changing the source stage or checklist status', () => {
    const p = samplePlan();
    p.questions = [];
    p.steps = p.steps.filter((s) => s.status !== 'blocked');
    p.runs = [
      reported({ event: 'blocked', active: false, result: 'Need input' }),
    ];
    expect(needsAttention(p, fixtureData().snapshot)).toBe(true);
    expect(p.status).toBe('Implementing');
    expect(p.steps[2]!.status).toBe('doing');
    const resolved = {
      ...p,
      runs: [reported({ event: 'done', active: false })],
    };
    expect(needsAttention(resolved, fixtureData().snapshot)).toBe(false);
  });
  it('includes reported activity and prefers a matching collector event over a duplicate', () => {
    const data = fixtureData();
    const p = samplePlan();
    p.runs = [reported()];
    data.snapshot.state.plans = [p];
    data.snapshot.activity = [];
    const snapshot = acceptSnapshot(null, data.snapshot);
    expect(
      activityFor(snapshot, snapshot.state.plans[0]).some(
        (e) => e.text === p.runs![0]!.result,
      ),
    ).toBe(true);
    snapshot.activity.push({
      ts: p.runs[0]!.updatedAt,
      project: p.project,
      repo: p.repo,
      plan: p.name,
      actor: 'Codex',
      kind: 'doing',
      text: 'Collector event',
    });
    expect(
      activityFor(snapshot, snapshot.state.plans[0]).filter(
        (e) => e.ts === p.runs![0]!.updatedAt && e.actor === 'Codex',
      ),
    ).toHaveLength(1);
  });
  it('supports old plans without agent metadata', () => {
    const p = samplePlan();
    expect(participation(p).agents).toEqual([]);
    expect(execution(p, p.steps[0]!).latest).toBeUndefined();
    expect(agentMatches(p, 'unreported')).toBe(true);
  });
  it('prefers the plan coordinator and otherwise uses the latest reported coordinator', () => {
    expect(
      participation({ ...samplePlan(), agent: 'Gemini', runs: [reported()] })
        .coordinator,
    ).toBe('Gemini');
    expect(
      participation({
        ...samplePlan(),
        runs: [
          reported({
            coordinator: 'Claude',
            updatedAt: '2026-11-09T09:00:00Z',
          }),
          reported({ coordinator: 'Cursor' }),
        ],
      }).coordinator,
    ).toBe('Cursor');
    expect(
      participation({
        ...samplePlan(),
        runs: [
          reported({ coordinator: '', role: 'coordinator', agent: 'Copilot' }),
        ],
      }).coordinator,
    ).toBe('Copilot');
  });
  it('combines and deduplicates run and step executors while keeping coordinator separate', () => {
    const p = samplePlan();
    p.agent = 'Claude';
    p.steps[2]!.executors = ['codex', 'Gemini'];
    p.runs = [
      reported(),
      reported({ agent: 'Claude', role: 'coordinator', step: null }),
    ];
    expect(participation(p).executors).toEqual(['Codex', 'Gemini']);
    expect(agentMatches(p, 'Claude')).toBe(true);
    expect(stepAgentMatches(p, p.steps[2]!, 'Claude')).toBe(false);
  });
  it('shows only reported active agents as working and preserves checklist status', () => {
    const p = {
      ...samplePlan(),
      runs: [
        reported(),
        reported({
          runId: 'run-two',
          agent: 'Gemini',
          active: false,
          event: 'stopped',
        }),
      ],
    };
    expect(execution(p, p.steps[2]!).active).toEqual(['Codex']);
    expect(p.steps[2]!.status).toBe('doing');
  });
  it('takes the latest result including a blocking reason even when runs arrive unsorted', () => {
    const p = {
      ...samplePlan(),
      runs: [
        reported({ updatedAt: '2026-11-09T09:00:00Z' }),
        reported({
          active: false,
          event: 'blocked',
          result: 'Cần dữ liệu mẫu',
        }),
      ],
    };
    expect(execution(p, p.steps[2]!).latest?.result).toBe('Cần dữ liệu mẫu');
  });
  it('does not attach a stale report to a reused source line or another milestone', () => {
    const p = { ...samplePlan(), runs: [reported()] };
    p.steps[2]!.text = 'New task on the same line';
    expect(execution(p, p.steps[2]!).latest).toBeUndefined();
  });
  it('counts plans, assigned steps, coordination and working steps independently', () => {
    const p = { ...samplePlan(), agent: 'Claude', runs: [reported()] };
    expect(agentWorkload([p], 'Claude')).toEqual({
      plans: 1,
      tasks: 0,
      coordinating: 1,
      active: 0,
    });
    expect(agentWorkload([p], 'Codex')).toEqual({
      plans: 1,
      tasks: 1,
      coordinating: 0,
      active: 1,
    });
  });
  it('accepts run-only updates when the plan file revision is unchanged', () => {
    const data = fixtureData();
    const first = acceptSnapshot(null, data.snapshot);
    const changed = structuredClone(data.snapshot);
    changed.generation += 1;
    changed.state.plans[0]!.runs![0]!.result = 'New result';
    const second = acceptSnapshot(first, changed);
    expect(second.state.plans[0]).not.toBe(first.state.plans[0]);
    expect(second.state.plans[1]).toBe(first.state.plans[1]);
    expect(second.state.plans[0]!.runs![0]!.result).toBe('New result');
  });
  it('searches task results as well as task text', () => {
    const data = fixtureData();
    const snapshot = acceptSnapshot(null, data.snapshot);
    const rows = filterTasks(taskRows(snapshot.state.plans), {
      status: 'all',
      work: '',
      plans: null,
      sort: null,
      query: 'chu so huu cung cap',
    });
    expect(rows.length).toBeGreaterThan(0);
    expect(
      rows.every((r) => execution(r.plan, r.step).latest?.event === 'blocked'),
    ).toBe(true);
  });
  it('stops asking for attention once a blocked report is superseded by the plan', () => {
    const quiet = () => {
      const p = samplePlan();
      p.questions = [];
      p.steps = p.steps.filter((s) => s.status !== 'blocked');
      return p;
    };
    const blocked = reported({ event: 'blocked', active: false });
    const open = { ...quiet(), runs: [blocked] };
    expect(needsAttention(open, fixtureData().snapshot)).toBe(true);
    // The owner checked the step off after the agent reported the blocker.
    const checked = { ...quiet(), runs: [blocked] };
    checked.steps = checked.steps.map((s, i) =>
      i === 2 ? { ...s, status: 'done' as const } : s,
    );
    expect(needsAttention(checked, fixtureData().snapshot)).toBe(false);
    // A finished plan keeps its history without staying in Needs attention.
    const finished = {
      ...quiet(),
      status: 'Done',
      runs: [blocked, reported({ step: null, event: 'blocked' })],
    };
    expect(needsAttention(finished, fixtureData().snapshot)).toBe(false);
    // A whole-plan blocker counts while it is the latest whole-plan report.
    const planLevel = reported({ step: null, event: 'blocked', active: false });
    expect(
      needsAttention({ ...quiet(), runs: [planLevel] }, fixtureData().snapshot),
    ).toBe(true);
    expect(
      needsAttention(
        {
          ...quiet(),
          runs: [
            planLevel,
            reported({
              runId: 'later',
              step: null,
              event: 'done',
              active: false,
              updatedAt: '2026-11-10T10:00:00.000Z',
            }),
          ],
        },
        fixtureData().snapshot,
      ),
    ).toBe(false);
  });
});
