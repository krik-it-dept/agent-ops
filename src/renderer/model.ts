import { execution } from './agents';
import type {
  Activity,
  AgentRun,
  Milestone,
  Plan,
  PlanDiagnostic,
  Settings,
  StateResponse,
  Step,
  Overview,
} from '../shared/contracts';

export const stepLabels = {
  doing: 'In progress',
  blocked: 'Blocked',
  waiting: 'Waiting',
  partial: 'Partial',
  todo: 'To do',
  done: 'Done',
};
export const stage = (status: string) =>
  status.split(' - ')[0] || 'Not started';
export const reason = (status: string) =>
  status.includes(' - ') ? status.slice(status.indexOf(' - ') + 3) : '';
export const planKey = (plan: Pick<Plan, 'project' | 'repo' | 'name'>) =>
  [plan.project, plan.repo, plan.name].filter(Boolean).join('/');
export const fold = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, 'd')
    .replace(/[-_]/g, ' ')
    .toLowerCase();
export function statusTone(status: string) {
  const text = stage(status).toLowerCase();
  if (text === 'done') return 'done';
  if (text === 'blocked') return 'blocked';
  if (text === 'waiting for ci' || /^(reviewing|testing)$/.test(text))
    return 'review';
  if (text.startsWith('waiting')) return 'waiting';
  return /^(implementing|fixing review|shipping|in progress|partly done|dry run)$/.test(
    text,
  )
    ? 'doing'
    : 'todo';
}
export function progress(steps: Step[]) {
  return {
    done: steps.filter((s) => s.status === 'done').length,
    total: steps.length,
  };
}
export function milestoneProgress(m: Milestone) {
  const p = m.progress;
  return p &&
    Number.isInteger(p.done) &&
    Number.isInteger(p.total) &&
    p.done >= 0 &&
    p.total >= p.done
    ? p
    : progress(m.steps);
}
// A milestone heading without a recorded [state] takes its stage from its steps.
export function milestoneState(m: Milestone): Step['status'] {
  if (m.state) return m.state;
  if (m.steps.length && m.steps.every((s) => s.status === 'done'))
    return 'done';
  if (m.steps.some((s) => s.status === 'blocked')) return 'blocked';
  if (m.steps.some((s) => s.status === 'waiting')) return 'waiting';
  return m.steps.some((s) => ['doing', 'done', 'partial'].includes(s.status))
    ? 'doing'
    : 'todo';
}
export function milestoneOpen(m: Milestone) {
  return (
    milestoneState(m) !== 'done' || m.steps.some((s) => s.status !== 'done')
  );
}
export function archived(plan: Plan, settings: Settings) {
  const choices = settings.planArchive || {};
  return Object.hasOwn(choices, planKey(plan))
    ? choices[planKey(plan)] === true
    : settings.autoArchiveDone && stage(plan.status) === 'Done';
}
/**
 * A blocking report needs attention while it is still the latest word: the
 * latest report on a step that is not done, or the latest whole-plan report.
 * A Done plan or a step checked off since then no longer waits on it.
 */
function reportedBlocker(plan: Plan) {
  if (!plan.runs?.length || stage(plan.status) === 'Done') return false;
  return (
    plan.steps.some(
      (s) =>
        s.status !== 'done' && execution(plan, s).latest?.event === 'blocked',
    ) ||
    [...plan.runs]
      .filter((r) => !r.step)
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0]
      ?.event === 'blocked'
  );
}
export function needsAttention(plan: Plan, state: StateResponse) {
  return (
    /^waiting for owner/i.test(plan.status) ||
    stage(plan.status) === 'Blocked' ||
    plan.steps.some((s) => s.status === 'blocked') ||
    reportedBlocker(plan) ||
    state.stale[planKey(plan)] === true ||
    plan.questions.some((q) => q.open)
  );
}
export function findPlan<T extends Plan>(plans: T[], key: string) {
  const exact = plans.find((p) => planKey(p) === key);
  if (exact) return exact;
  const old = plans.filter((p) => p.repo + '/' + p.name === key);
  return old.length === 1 ? old[0] : undefined;
}
const objects = <T>(value: unknown): T[] =>
  Array.isArray(value)
    ? (value.filter((item: unknown) => item && typeof item === 'object') as T[])
    : [];
const runEvents = ['start', 'progress', 'done', 'blocked', 'stopped'];
const text = (value: unknown) => (typeof value === 'string' ? value : '');
/** Agent names are plain strings; anything else is treated as not reported. */
const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
/**
 * Keeps only usable reported runs: an object with an agent, a known event and
 * a readable update time. Other fields are coerced like the rest of the plan.
 */
export function normalizeRuns(value: unknown): AgentRun[] {
  return objects<Record<string, unknown>>(value).flatMap((run) => {
    const agent = text(run.agent).trim();
    if (
      !agent ||
      !runEvents.includes(run.event as string) ||
      !Number.isFinite(Date.parse(text(run.updatedAt)))
    )
      return [];
    const step = run.step;
    const at = step && typeof step === 'object' ? step : null;
    return [
      {
        runId: text(run.runId),
        agent,
        coordinator: text(run.coordinator),
        role: run.role === 'coordinator' ? 'coordinator' : 'executor',
        event: run.event as AgentRun['event'],
        active: run.active === true,
        startedAt: Number.isFinite(Date.parse(text(run.startedAt)))
          ? text(run.startedAt)
          : text(run.updatedAt),
        updatedAt: text(run.updatedAt),
        step: at
          ? {
              line: Number.isSafeInteger((at as Step).line)
                ? (at as Step).line
                : 0,
              text: text((at as Step).text),
              milestone: text((at as Step).milestone),
            }
          : null,
        result: text(run.result),
      },
    ];
  });
}
function normalizePlan(input: Plan): Plan {
  const plan = { ...input };
  for (const key of [
    'project',
    'projectName',
    'repo',
    'name',
    'root',
    'gh',
    'goal',
    'spec',
    'next',
    'status',
    'owner',
    'revision',
    'mtime',
    'workspace',
    'file',
  ] as const)
    plan[key] = String(plan[key] || '');
  plan.agent = text(plan.agent);
  plan.runs = normalizeRuns(plan.runs);
  plan.steps = objects<Step>(plan.steps).map((s, index) => ({
    ...s,
    executors: strings(s.executors),
    text: String(s.text || ''),
    status: Object.hasOwn(stepLabels, s.status)
      ? s.status
      : ('unknown' as Step['status']),
    line: Number.isSafeInteger(s.line) ? s.line : 0,
    milestone: s.milestone || '',
    index: Number.isInteger(s.index) ? s.index : index,
  }));
  const used = new Set<Step>();
  plan.milestones = objects<Milestone>(plan.milestones).map((m) => ({
    ...m,
    id: String(m.id || ''),
    title: String(m.title || ''),
    summary: String(m.summary || ''),
    steps: objects<Step>(m.steps).map((s, index) => {
      const existing = plan.steps.find(
        (t) =>
          !used.has(t) &&
          (s.line > 0
            ? t.line === s.line
            : t.text === s.text &&
              t.status === s.status &&
              (!t.milestone || t.milestone === m.id)),
      );
      if (existing) {
        used.add(existing);
        return existing;
      }
      return {
        ...s,
        executors: strings(s.executors),
        text: String(s.text || ''),
        status: Object.hasOwn(stepLabels, s.status)
          ? s.status
          : ('unknown' as Step['status']),
        line: s.line || 0,
        milestone: m.id,
        index: Number.isInteger(s.index) ? s.index : index,
      };
    }),
  }));
  if (!plan.steps.length) plan.steps = plan.milestones.flatMap((m) => m.steps);
  plan.decisions = objects<Plan['decisions'][number]>(plan.decisions).map(
    (d) => ({
      key: String(d.key || ''),
      when: String(d.when || ''),
      text: String(d.text || ''),
    }),
  );
  plan.questions = objects<Plan['questions'][number]>(plan.questions).map(
    (q) => ({
      key: String(q.key || ''),
      when: String(q.when || ''),
      ask: String(q.ask || ''),
      answer: String(q.answer || ''),
      open: q.open === true,
    }),
  );
  return plan;
}
export type DisplayPlan = Plan & { diagnostics: PlanDiagnostic[] };
export type Snapshot = Omit<StateResponse, 'state'> & {
  state: Omit<Overview, 'plans'> & { plans: DisplayPlan[] };
};
export function acceptSnapshot(
  previous: Snapshot | null,
  incoming: StateResponse,
): Snapshot {
  if (previous && incoming.generation < previous.generation) return previous;
  const old = new Map(previous?.state.plans.map((p) => [planKey(p), p]));
  const diagnostics = objects<PlanDiagnostic>(incoming.state.diagnostics);
  const plans = objects<Plan>(incoming.state.plans).map(
    (input): DisplayPlan => {
      let problems = diagnostics.filter(
        (d) =>
          d.plan &&
          planKey({ project: d.project, repo: d.repo, name: d.plan }) ===
            planKey(input),
      );
      const local = (input as Plan & { diagnostics?: unknown }).diagnostics;
      if (!problems.length && Array.isArray(local))
        problems = local
          .filter(
            (d: unknown) =>
              typeof d === 'string' || (d && typeof d === 'object'),
          )
          .map((d: unknown) => ({
            project: input.project,
            repo: input.repo,
            plan: input.name,
            file: input.file,
            kind: 'unreadable' as const,
            message:
              typeof d === 'string'
                ? d
                : String(
                    (d as { message?: unknown }).message ||
                      'Could not read part of this plan',
                  ),
          }));
      const before = old.get(planKey(input));
      if (
        before &&
        (input.revision
          ? before.revision === input.revision
          : JSON.stringify(normalizePlan(input)) ===
            JSON.stringify(
              (({ diagnostics: _diagnostics, ...content }) => {
                void _diagnostics;
                return content;
              })(before),
            )) &&
        JSON.stringify(before.runs) ===
          JSON.stringify(normalizeRuns(input.runs)) &&
        before.agent === text(input.agent) &&
        before.source === input.source &&
        before.root === input.root &&
        before.projectName === input.projectName &&
        before.workspace === input.workspace &&
        before.gh === input.gh &&
        JSON.stringify(before.diagnostics) === JSON.stringify(problems)
      )
        return before;
      return { ...normalizePlan(input), diagnostics: problems };
    },
  );
  return {
    ...incoming,
    activity: objects(incoming.activity),
    warnings: incoming.warnings || [],
    stale: incoming.stale || {},
    state: {
      generatedAt: '',
      projects: [],
      repos: [],
      ...incoming.state,
      plans,
      diagnostics,
    },
  };
}
export function looseSteps(plan: Plan) {
  return plan.steps.filter(
    (s) =>
      !plan.milestones.some(
        (m) =>
          m.id === s.milestone ||
          m.steps.some((t) => t === s || (s.line > 0 && t.line === s.line)),
      ),
  );
}
export const workflow = {
  doing: 0,
  blocked: 1,
  waiting: 2,
  partial: 3,
  todo: 4,
  done: 5,
};
export interface TaskRow {
  plan: DisplayPlan;
  step: Step;
  index: number;
}
export interface ListFilters {
  status: 'all' | Step['status'];
  work: string;
  plans: string[] | null;
  query: string;
  sort: {
    column: 'work' | 'plan' | 'status';
    direction: 'asc' | 'desc';
  } | null;
}
export function taskRows(plans: DisplayPlan[]): TaskRow[] {
  return plans.flatMap((plan) =>
    plan.steps.map((step, index) => ({ plan, step, index })),
  );
}
// acceptSnapshot keeps plan and step objects while their revision is
// unchanged, so folded search text can be cached per object.
const planText = new WeakMap<Plan, string>();
export function planSearchText(p: Plan) {
  let text = planText.get(p);
  if (text === undefined) {
    text = fold(
      [
        p.name,
        p.repo,
        p.projectName,
        p.goal,
        p.next,
        p.status,
        p.owner,
        p.agent || '',
        ...(p.runs || []).map((r) =>
          [r.agent, r.coordinator, r.result].join(' '),
        ),
        ...p.steps.flatMap((s) => s.executors || []),
        ...p.steps.map((s) => s.text),
        ...p.decisions.map((d) => d.text),
        ...p.questions.map((q) => q.ask + ' ' + q.answer),
      ].join(' '),
    );
    planText.set(p, text);
  }
  return text;
}
const stepText = new WeakMap<Step, { work: string; all: string }>();
function taskSearchText({ plan: p, step: s }: TaskRow) {
  let text = stepText.get(s);
  if (!text) {
    text = {
      work: fold(s.text),
      all: fold(
        [
          s.text,
          ...execution(p, s).agents,
          execution(p, s).latest?.result || '',
          stepLabels[s.status],
          p.name,
          p.repo,
          s.milestone,
          p.milestones.find((m) => m.id === s.milestone)?.title,
        ].join(' '),
      ),
    };
    stepText.set(s, text);
  }
  return text;
}
export function filterTasks(rows: TaskRow[], filters: ListFilters) {
  const collator = new Intl.Collator('vi', {
    numeric: true,
    sensitivity: 'base',
  });
  const work = fold(filters.work);
  const query = fold(filters.query);
  const chosen = filters.plans === null ? null : new Set(filters.plans);
  return rows
    .filter((row) => {
      if (filters.status !== 'all' && row.step.status !== filters.status)
        return false;
      if (chosen && !chosen.has(planKey(row.plan))) return false;
      const text = taskSearchText(row);
      return (
        (!work || text.work.includes(work)) &&
        (!query || text.all.includes(query))
      );
    })
    .sort((a, b) => {
      const sort = filters.sort;
      if (!sort)
        return (
          (workflow[a.step.status] ?? 99) - (workflow[b.step.status] ?? 99) ||
          b.plan.mtime.localeCompare(a.plan.mtime) ||
          planKey(a.plan).localeCompare(planKey(b.plan)) ||
          a.index - b.index
        );
      const value = (r: TaskRow) =>
        sort.column === 'status'
          ? workflow[r.step.status]
          : sort.column === 'work'
            ? r.step.text
            : r.plan.name + ' ' + r.plan.repo;
      const order =
        sort.column === 'status'
          ? Number(value(a)) - Number(value(b))
          : collator.compare(String(value(a)), String(value(b)));
      return (sort.direction === 'desc' ? -order : order) || a.index - b.index;
    });
}
export function dayKey(value: string | Date) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Ho_Chi_Minh',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(value));
}
export function dayLabel(value: string, current: string) {
  if (!Number.isFinite(Date.parse(value))) return 'Date not recorded';
  if (!Number.isFinite(Date.parse(current))) current = new Date().toISOString();
  const today = dayKey(current);
  const yesterday = new Date(today + 'T12:00:00+07:00');
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return dayKey(value) === today
    ? 'Today'
    : dayKey(value) === dayKey(yesterday)
      ? 'Yesterday'
      : new Date(value).toLocaleDateString('en-GB', {
          timeZone: 'Asia/Ho_Chi_Minh',
          weekday: 'long',
          day: '2-digit',
          month: '2-digit',
        });
}
/** "Today 16:30", "Yesterday 09:05" or "Monday 05/10 10:15"; empty when unknown. */
export function whenLabel(value: string, current: string) {
  return Number.isFinite(Date.parse(value))
    ? `${dayLabel(value, current)} ${timeLabel(value)}`
    : '';
}
export const timeLabel = (value: string) =>
  Number.isFinite(Date.parse(value))
    ? new Date(value).toLocaleTimeString('en-GB', {
        timeZone: 'Asia/Ho_Chi_Minh',
        hour: '2-digit',
        minute: '2-digit',
      })
    : '';
export type DisplayActivity = Omit<Activity, 'kind'> & {
  kind: Activity['kind'] | 'reported-run';
};
export function activityFor(state: Snapshot, plan?: Plan): DisplayActivity[] {
  const events = state.activity.filter(
    (e) =>
      !plan ||
      (e.repo === plan.repo &&
        e.plan === plan.name &&
        (!e.project || e.project === plan.project)),
  );
  const known = new Set(
    events.map((e) => [e.project, e.repo, e.plan, e.kind, e.text].join('|')),
  );
  // A run the collector already announced (run-started, run-finished,
  // run-blocked, stamped when it noticed the report) or an event recorded at
  // the report's own time must not be listed twice. Older collectors without
  // run events still get one entry per reported run.
  const exact = new Set<string>();
  const announced = new Map<string, number>();
  for (const e of events) {
    const key = [e.project || '', e.repo, e.plan, e.actor || ''].join('|');
    exact.add(key + '|' + e.ts);
    if (String(e.kind).startsWith('run-')) {
      const at = Date.parse(e.ts);
      if (at > (announced.get(key) ?? -Infinity)) announced.set(key, at);
    }
  }
  const historical: DisplayActivity[] = [];
  for (const p of plan ? [plan] : state.state.plans) {
    for (const run of p.runs || []) {
      const keys = [p.project, ''].map((project) =>
        [project, p.repo, p.name, run.agent].join('|'),
      );
      if (
        keys.some(
          (key) =>
            exact.has(key + '|' + run.updatedAt) ||
            (announced.get(key) ?? -Infinity) >= Date.parse(run.startedAt),
        )
      )
        continue;
      historical.push({
        ts: run.updatedAt,
        project: p.project,
        repo: p.repo,
        plan: p.name,
        kind: 'reported-run',
        text: run.result || (run.active ? 'Working now' : 'No result reported'),
        extra: run.step?.text || '',
        actor: run.agent,
      });
    }
    for (const entry of [
      ...p.decisions.map((d) => ({
        ...d,
        kind: 'decision' as const,
        extra: '',
      })),
      ...p.questions.map((q) => ({
        ...q,
        kind: 'question' as const,
        text: q.ask,
        extra: q.open ? '' : q.answer,
      })),
    ]) {
      if (
        !/^\d{12}$/.test(entry.key) ||
        known.has([p.project, p.repo, p.name, entry.kind, entry.text].join('|'))
      )
        continue;
      const key = entry.key;
      const hour =
        key.slice(8) === '9999'
          ? '00:00'
          : key.slice(8, 10) + ':' + key.slice(10, 12);
      const ts = `${key.slice(0, 4)}-${key.slice(4, 6)}-${key.slice(6, 8)}T${hour}:00+07:00`;
      if (Number.isFinite(Date.parse(ts)))
        historical.push({
          ts,
          project: p.project,
          repo: p.repo,
          plan: p.name,
          kind: entry.kind,
          text: entry.text,
          extra: entry.extra,
          actor: p.owner || p.repo,
        });
    }
  }
  return [...events, ...historical].sort(
    (a, b) => Date.parse(b.ts) - Date.parse(a.ts),
  );
}
export function protocolPlanLink(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (
      url.protocol !== 'agent-ops:' ||
      url.pathname !== 'open' ||
      [...url.searchParams.keys()].some((k) => k !== 'plan') ||
      url.searchParams.getAll('plan').length !== 1
    )
      return null;
    const key = url.searchParams.get('plan');
    return key && new TextEncoder().encode(key).length <= 1024 ? key : null;
  } catch {
    return null;
  }
}

/** placeLabel names where a plan lives: its workspace, or for older plans inside a workspace folder, folder / workspace. */
export function placeLabel(p: {
  source?: string | undefined;
  projectName: string;
  repo: string;
}): string {
  return p.source === 'tasks' ? p.repo : `${p.projectName} / ${p.repo}`;
}
