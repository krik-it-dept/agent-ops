import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import {
  createFixtureBridge,
  fixtureData,
  samplePlan,
} from './dev/fixture-bridge';
import { createClient } from './client';
import { LedgerProvider } from './store';
import { Overview } from './views/Overview';
import { WorkViews } from './views/WorkViews';
import { LIST_PAGE, TaskList } from './views/TaskList';
import { defaultNavigation } from './preferences';
import { acceptSnapshot, filterTasks, taskRows } from './model';

// 400 plans with 21 steps each: 8,400 checklist tasks.
function largeLedger() {
  const data = fixtureData();
  data.snapshot.state.plans = Array.from({ length: 400 }, (_, i) => {
    const plan = samplePlan(`Plan ${i}`, `Workspace ${i % 40}`);
    plan.revision = String(i).padStart(64, '0');
    const base = plan.steps;
    plan.steps = Array.from({ length: 21 }, (_, n) => ({
      ...base[n % base.length]!,
      text: `Task ${n} of plan ${i}`,
      line: 100 + n,
      index: n,
    }));
    return plan;
  });
  return data;
}
function render(
  data: ReturnType<typeof largeLedger>,
  element: ReturnType<typeof createElement>,
) {
  return renderToStaticMarkup(
    createElement(LedgerProvider, {
      source: { client: createClient(createFixtureBridge()), fixture: true },
      initial: data,
      children: createElement(
        MemoryRouter,
        { initialEntries: ['/'] },
        createElement(
          Routes,
          null,
          createElement(Route, { path: '/', element }),
        ),
      ),
    }),
  );
}
const list = (group: 'plan' | 'none') =>
  createElement(TaskList, {
    query: '',
    status: 'all',
    setStatus: () => undefined,
    clearQuery: () => undefined,
    navigation: { ...defaultNavigation(), group },
    setNavigation: () => undefined,
  });

describe('large ledgers', () => {
  it('bounds Board and Timeline work while retaining access to the remaining plans', () => {
    const data = largeLedger();
    for (const view of ['board', 'timeline'] as const) {
      const started = performance.now();
      const html = render(
        data,
        createElement(WorkViews, {
          view,
          query: '',
          agent: '',
          clear: () => undefined,
        }),
      );
      // The plan count is shown once, under the view title in the shell.
      expect(html).not.toMatch(/\d+ plans/);
      expect(html).toContain('Show more plans');
      expect(
        view === 'board'
          ? html.match(/class="work-card/g)
          : html.match(/<tr>/g),
      ).toHaveLength(view === 'board' ? 100 : 101);
      expect(performance.now() - started).toBeLessThan(2000);
    }
  });
  it('renders one page of the List and offers the rest on request', () => {
    const data = largeLedger();
    for (const group of ['plan', 'none'] as const) {
      const started = performance.now();
      const html = render(data, list(group));
      const elapsed = performance.now() - started;
      const rows = html.match(/<tr>/g)?.length ?? 0;
      // Task rows plus at most one group header row per shown plan.
      expect(rows).toBeLessThanOrEqual(LIST_PAGE * 2);
      expect(html).toContain(`Showing ${LIST_PAGE} of 8400 tasks`);
      expect(html).toContain(`Show ${LIST_PAGE} more`);
      expect(html).toContain('8400 of 8400 tasks');
      // Before windowing this render took about 330 ms for 8,401 rows.
      expect(elapsed).toBeLessThan(1500);
    }
  });
  it('renders and searches an Overview of 400 plans', () => {
    const data = largeLedger();
    const started = performance.now();
    const all = render(
      data,
      createElement(Overview, { query: '', clear: () => undefined }),
    );
    const found = render(
      data,
      createElement(Overview, {
        query: 'task 20 of plan 399',
        clear: () => undefined,
      }),
    );
    // Six current work cards, with the count left to the shell title.
    expect(all.match(/class="work-card/g)).toHaveLength(6);
    expect(all).not.toMatch(/of 400 plans/);
    expect(all).toContain('>400<');
    expect(found.match(/class="work-card/g)).toHaveLength(1);
    expect(found).toContain('Plan 399');
    expect(found).toContain('Clear filters');
    expect(performance.now() - started).toBeLessThan(2000);
  });
  it('keeps unchanged plans and filters thousands of tasks quickly', () => {
    const data = largeLedger();
    const first = acceptSnapshot(null, data.snapshot);
    const changed = structuredClone(data.snapshot);
    changed.generation += 1;
    changed.state.plans[7]!.revision = 'f'.repeat(64);
    const second = acceptSnapshot(first, changed);
    const kept = second.state.plans.filter(
      (p, i) => p === first.state.plans[i],
    ).length;
    expect(kept).toBe(399);
    const rows = taskRows(second.state.plans);
    const filters = {
      status: 'all' as const,
      work: '',
      plans: null,
      sort: null,
    };
    filterTasks(rows, { ...filters, query: 'plan 1' });
    const started = performance.now();
    for (const query of ['task 3', 'task 3 of plan 39', 'không có'])
      filterTasks(rows, { ...filters, query });
    expect(performance.now() - started).toBeLessThan(500);
  });
  it('re-renders only the plan whose runs changed among 400 plans with 50 runs each', () => {
    const data = largeLedger();
    const agents = ['Claude', 'Codex', 'Gemini', 'Cursor'];
    for (const plan of data.snapshot.state.plans)
      plan.runs = Array.from({ length: 50 }, (_, n) => {
        const step = plan.steps[n % plan.steps.length]!;
        const at = new Date(Date.UTC(2026, 10, 10, 0, n)).toISOString();
        return {
          runId: `${plan.name}-${n}`,
          agent: agents[n % agents.length]!,
          coordinator: 'Claude',
          role: 'executor' as const,
          event: n % 7 ? ('done' as const) : ('progress' as const),
          active: n === 49,
          startedAt: at,
          updatedAt: at,
          step: { line: step.line, text: step.text, milestone: step.milestone },
          result: `Kết quả ${n} của ${plan.name}`,
        };
      });
    data.snapshot.activity = data.snapshot.state.plans.flatMap((plan) =>
      plan.runs!.slice(0, 2).map((run) => ({
        ts: run.updatedAt,
        project: plan.project,
        repo: plan.repo,
        plan: plan.name,
        actor: run.agent,
        kind: 'doing' as const,
        text: run.result,
      })),
    );
    let snapshot = acceptSnapshot(null, data.snapshot);
    let accepted = 0;
    // Twenty run reports in a row, each on a different plan, file revisions unchanged.
    for (let i = 0; i < 20; i++) {
      const next = structuredClone(data.snapshot);
      next.generation = snapshot.generation + 1;
      next.state.plans[i * 7]!.runs![0]!.result = `Báo cáo mới ${i}`;
      const previous = snapshot;
      const started = performance.now();
      snapshot = acceptSnapshot(previous, next);
      accepted += performance.now() - started;
      expect(
        snapshot.state.plans.filter((p, n) => p !== previous.state.plans[n]),
      ).toHaveLength(1);
      data.snapshot = next;
    }
    const started = performance.now();
    const html = render(
      { ...data, snapshot },
      createElement(Overview, { query: '', clear: () => undefined }),
    );
    const rendered = performance.now() - started;
    expect(html).toContain('Agent workload');
    // Measured about 20 ms per snapshot and 150 ms for the Summary on a dev machine.
    expect(accepted / 20).toBeLessThan(150);
    expect(rendered).toBeLessThan(2000);
  });
});
