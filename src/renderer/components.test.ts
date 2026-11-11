import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { Glyph, Progress, Status } from './components/ui';
import { AgentChain } from './components/Agents';
import {
  createFixtureBridge,
  fixtureData,
  samplePlan,
} from './dev/fixture-bridge';
import { createClient } from './client';
import { LedgerProvider } from './store';
import { Sidebar } from './components/Sidebar';
import { acceptSnapshot } from './model';
import { Overview, COLUMNS, columnOf } from './views/Overview';
import { PlanPage } from './views/PlanPage';
import { defaultNavigation } from './preferences';
import { SettingsPage } from './settings/Settings';
import { updateDockWanted, updateRetryAction } from './components/Updates';

function render(
  path: string,
  view: 'overview' | 'plan' | 'settings' = 'overview',
  mutate?: (data: ReturnType<typeof fixtureData>) => void,
) {
  const data = fixtureData();
  mutate?.(data);
  const element =
    view === 'plan'
      ? createElement(PlanPage, {
          query: '',
          navigation: defaultNavigation(),
          setNavigation: () => undefined,
        })
      : view === 'settings'
        ? createElement(SettingsPage)
        : createElement(Overview, { query: '', clear: () => undefined });
  const routes = createElement(
    MemoryRouter,
    { initialEntries: [path] },
    createElement(
      Routes,
      null,
      createElement(Route, {
        path:
          view === 'plan'
            ? '/plan/:key/:section'
            : view === 'settings'
              ? '/settings/:section'
              : '/',
        element,
      }),
    ),
  );
  return renderToStaticMarkup(
    createElement(LedgerProvider, {
      source: { client: createClient(createFixtureBridge()), fixture: true },
      initial: data,
      children: routes,
    }),
  );
}
describe('React screen components', () => {
  it('keeps a failed manual check or skip from turning Try again into an install', () => {
    const update = fixtureData().update;
    expect(updateRetryAction(update, 'check')).toBe('check');
    expect(updateRetryAction(update, 'skip')).toBe('check');
    expect(updateRetryAction(update, 'apply')).toBe('apply');
    expect(updateRetryAction(update, null)).toBe('apply');
  });
  it('keeps scheduled update checks and their failures out of the update card', () => {
    const base = {
      ...fixtureData().update,
      available: false,
      phase: 'idle' as const,
    };
    const checking = { ...base, phase: 'checking' as const };
    const failed = { ...base, phase: 'error' as const, error: 'Offline' };
    expect(updateDockWanted(checking, false, '')).toBe(false);
    expect(updateDockWanted(failed, false, '')).toBe(false);
    expect(updateDockWanted(checking, true, '')).toBe(true);
    expect(updateDockWanted(failed, true, '')).toBe(true);
    expect(updateDockWanted(failed, true, 'error:Offline')).toBe(false);
    expect(updateDockWanted({ ...failed, available: true }, false, '')).toBe(
      true,
    );
    expect(
      updateDockWanted({ ...base, phase: 'downloading' }, false, 'v0.5.1'),
    ).toBe(true);
    expect(updateDockWanted({ ...base, available: true }, false, '')).toBe(
      true,
    );
  });
  it('renders static stage glyphs and accessible source progress', () => {
    const html = renderToStaticMarkup(
      createElement(
        'div',
        null,
        createElement(Glyph, { value: 'Waiting for owner' }),
        createElement(Status, { value: 'Done' }),
        createElement(Progress, {
          done: 1,
          total: 3,
          label: 'Milestone progress',
        }),
      ),
    );
    expect(html).toContain('aria-label="Waiting for owner"');
    expect(html).toContain('aria-valuetext="1 of 3 steps"');
    expect(html).not.toMatch(/animation|spin/);
  });
  it('escapes plan and diagnostic text and omits private metadata from Overview', () => {
    const html = render('/', 'overview', (data) => {
      data.snapshot.state.plans[0]!.name = '<script>alert(1)</script>';
      data.snapshot.state.repos = [
        {
          project: 'studio',
          name: 'Ledger',
          root: 'C:/secret',
          gh: '',
          plans: 1,
          worktrees: [{ path: 'C:/hidden-tree', branch: 'private-branch' }],
        },
      ];
    });
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
    expect(html).not.toMatch(/hidden-tree|private-branch|Detached HEAD/);
    expect(html).toContain('In workspace');
    expect(html).toContain('Plan warning');
  });
  it('preserves milestone order, includes loose steps once and puts blockers before Next', () => {
    const key = encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm');
    const html = render(`/plan/${key}/summary`, 'plan', (data) => {
      data.snapshot.state.plans[0]!.status = 'Blocked - Source unavailable';
    });
    expect(html.indexOf('Prepare the source')).toBeLessThan(
      html.indexOf('Release and verify'),
    );
    expect(html.indexOf('Source unavailable')).toBeLessThan(
      html.indexOf('<strong>Next'),
    );
    expect(html).toContain('Other steps');
    expect(html.match(/Giữ tiếng Việt trong kết quả/g)).toHaveLength(1);
    expect(html).not.toMatch(/draggable|contenteditable|data-agent/);
  });
  it('shows finished milestones without a recorded state as done and skips them as the current milestone', () => {
    const key = encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm');
    const unmark = (data: ReturnType<typeof fixtureData>) => {
      const plan = data.snapshot.state.plans[0]!;
      for (const m of plan.milestones) m.state = '';
      plan.milestones[0]!.steps = plan.milestones[0]!.steps.map((s) => ({
        ...s,
        status: 'done',
      }));
      plan.milestones[0]!.progress = {
        done: plan.milestones[0]!.steps.length,
        total: plan.milestones[0]!.steps.length,
      };
    };
    const page = render(`/plan/${key}/summary`, 'plan', unmark);
    expect(page).toContain(
      '<details class="milestone"><summary><span class="glyph status-done" role="img" aria-label="Done">✓</span><code>M1</code>',
    );
    const overview = render('/', 'overview', unmark);
    const row = overview.slice(
      overview.indexOf('Cải thiện tìm kiếm'),
      overview.indexOf('Plan progress for Cải thiện tìm kiếm'),
    );
    expect(row).toContain('M2 · Release and verify');
    expect(row).not.toContain('M1 · Prepare the source');
  });
  it('dates the plan update so an old plan does not read as changed today', () => {
    const key = encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm');
    const old = render(`/plan/${key}/summary`, 'plan', (data) => {
      data.snapshot.state.plans[0]!.mtime = '2026-10-05T03:15:00.000Z';
    });
    expect(old).toMatch(/Updated Monday,? 05\/10 10:15 · /);
    const today = render(`/plan/${key}/summary`, 'plan');
    expect(today).toContain('Updated Today 16:30 · ');
  });
  it('links #123 in the blocked reason and in question answers', () => {
    const key = encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm');
    const html = render(`/plan/${key}/questions`, 'plan', (data) => {
      const plan = data.snapshot.state.plans[0]!;
      plan.status = 'Blocked - Waiting for #41 to merge';
      plan.questions = [
        {
          key: '',
          when: 'today',
          ask: 'Ready?',
          answer: 'After #42',
          open: false,
        },
      ];
    });
    expect(html).toContain('<button class="link-button">#41</button>');
    expect(html).toContain('<button class="link-button">#42</button>');
  });
  it('explains where plans come from when the Tasks folder is empty', () => {
    const html = render('/', 'overview', (data) => {
      data.snapshot.state.plans = [];
    });
    expect(html).toContain(
      'Plans appear here when an AI tool saves one to your Tasks folder.',
    );
    expect(html).not.toContain('source file');
  });
  it('shows only the stage, not the recorded reason, in the sidebar', () => {
    const data = fixtureData();
    const snapshot = acceptSnapshot(null, data.snapshot);
    const html = renderToStaticMarkup(
      createElement(LedgerProvider, {
        source: { client: createClient(createFixtureBridge()), fixture: true },
        initial: data,
        children: createElement(
          MemoryRouter,
          null,
          createElement(Sidebar, {
            plans: snapshot.state.plans,
            navigation: defaultNavigation(),
            setNavigation: () => undefined,
            current: null,
            openCommands: () => undefined,
            openHelp: () => undefined,
          }),
        ),
      }),
    );
    expect(html).toContain('steps · Waiting for owner</small>');
    expect(html).not.toContain('Please confirm the release wording');
    // Settings and shortcut help live in the sidebar footer beside Archive.
    const footer = html.slice(html.indexOf('<footer'));
    expect(footer).toMatch(
      /aria-label="Settings"[^>]*href="\/settings\/general"|href="\/settings\/general"[^>]*aria-label="Settings"/,
    );
    expect(footer).toContain('aria-label="Keyboard shortcuts"');
    expect(footer).toContain('Archive');
  });
  it('does not mix decisions and questions into the milestone work', () => {
    const key = encodeURIComponent('studio/Ledger/Cải thiện tìm kiếm');
    const work = render(`/plan/${key}/summary`, 'plan');
    const decisions = render(`/plan/${key}/decisions`, 'plan');
    expect(work).not.toContain('Giữ tiếng Việt và thứ tự nguồn');
    expect(decisions).toContain('Giữ tiếng Việt và thứ tự nguồn');
    expect(decisions).not.toContain('Đối chiếu nội dung hiện có');
  });
  it('shows unavailable plans without silently opening a neighboring plan', () => {
    const html = render('/plan/missing%2Fplan/summary', 'plan');
    expect(html).toContain('Plan unavailable');
    expect(html).not.toContain('Prepare the source');
  });
  it.each(['general', 'projects', 'tasks', 'about'])(
    'renders the %s Settings section with plain UI copy',
    (section) => {
      const html = render('/settings/' + section, 'settings');
      expect(html).toContain('Settings');
      expect(html).not.toMatch(
        />[^<]*(?:repository|GitHub|worktree|Detached HEAD|main checkout)[^<]*</i,
      );
    },
  );
  describe('agent chain', () => {
    const chain = (coordinator: string, executors: string[]) => {
      const plan = samplePlan();
      plan.agent = coordinator;
      plan.runs = executors.map((agent, n) => ({
        runId: `r${n}`,
        agent,
        coordinator,
        role: 'executor' as const,
        event: 'done' as const,
        active: false,
        startedAt: `2026-11-10T0${n}:00:00.000Z`,
        updatedAt: `2026-11-10T0${n}:30:00.000Z`,
        step: null,
        result: '',
      }));
      plan.steps = plan.steps.map((s) => ({ ...s, executors: [] }));
      return renderToStaticMarkup(createElement(AgentChain, { plan }));
    };
    it('shows one badge when the coordinator is the only executor', () => {
      const html = chain('Claude', ['Claude']);
      expect(html.match(/class="agent-chip"/g)).toHaveLength(1);
      expect(html).not.toContain('→');
      expect(html).toContain(
        'aria-label="Coordinator: Claude; Executed by: Claude"',
      );
    });
    it('separates two executors and collapses more into Multi with the full list named', () => {
      const two = chain('Claude', ['Codex', 'Gemini']);
      expect(two.match(/class="agent-chip"/g)).toHaveLength(3);
      expect(two).toContain('class="agent-sep"');
      const many = chain('Claude', ['Codex', 'Gemini', 'Cursor']);
      expect(many).toContain('<span>Multi</span>');
      expect(many.match(/class="agent-chip"/g)).toHaveLength(1);
      // The tooltip and the accessible name both list every executor.
      const names = many.match(
        /aria-label="Coordinator: Claude; Executed by: ([^"]*)"/,
      )?.[1];
      expect(names?.split(', ').sort()).toEqual(['Codex', 'Cursor', 'Gemini']);
      expect(many).toContain(
        `title="Coordinator: Claude; Executed by: ${names}"`,
      );
      expect(many).toMatch(/class="sr-only">: [^<]*Cursor/);
    });
  });
  describe('agent workload', () => {
    const summary = (agent: string) => {
      const data = fixtureData();
      return renderToStaticMarkup(
        createElement(LedgerProvider, {
          source: {
            client: createClient(createFixtureBridge()),
            fixture: true,
          },
          initial: data,
          children: createElement(
            MemoryRouter,
            { initialEntries: ['/'] },
            createElement(
              Routes,
              null,
              createElement(Route, {
                path: '/',
                element: createElement(Overview, {
                  query: '',
                  agent,
                  clear: () => undefined,
                }),
              }),
            ),
          ),
        }),
      );
    };
    it('uses plural forms, a workload bar and marks the filtered agent as pressed', () => {
      const html = summary('Codex');
      const rows = html.match(/<button class="workload-row"[^>]*>/g) ?? [];
      expect(rows.length).toBeGreaterThan(0);
      expect(html).toMatch(/class="workload-bar"/);
      expect(html).toMatch(/\d+ plans? · \d+ tasks?/);
      expect(html).not.toMatch(/(?<![\d])1 (plans|tasks|active tasks)/);
      expect(
        rows.filter((r) => r.includes('aria-pressed="true"')),
      ).toHaveLength(1);
      expect(summary('').match(/aria-pressed="true"/)).toBeNull();
    });
  });
  describe('board and chart columns', () => {
    const plan = (status: string, blocked: boolean) => ({
      ...samplePlan(),
      status,
      steps: samplePlan().steps.map((s) => ({
        ...s,
        status: blocked ? ('blocked' as const) : ('todo' as const),
      })),
      diagnostics: [],
    });
    it('puts an unrecognised stage with blocked steps in Waiting, as the beta did', () => {
      expect(COLUMNS[3]).toBe('Waiting');
      expect(columnOf(plan('Parked', true))).toBe(3);
      expect(columnOf(plan('Parked', false))).toBe(0);
      expect(columnOf(plan('Planning', true))).toBe(0);
      expect(columnOf(plan('Blocked', false))).toBe(3);
      expect(columnOf(plan('Implementing', true))).toBe(1);
      expect(columnOf(plan('Done', true))).toBe(4);
    });
  });
});
