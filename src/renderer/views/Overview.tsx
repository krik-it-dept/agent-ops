import { memo, useMemo, useState, type DragEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import {
  archived,
  fold,
  milestoneOpen,
  needsAttention,
  placeLabel,
  planSearchText,
  planKey,
  stage,
  type DisplayPlan,
} from '../model';
import {
  agentMatches,
  agentWorkload,
  participation,
  stepAgentMatches,
} from '../agents';
import { useLedger } from '../store';
import {
  Empty,
  PlanActions,
  PlanLink,
  SourceLabel,
  Warning,
} from '../components/ui';
import { AgentBadge, AgentChain } from '../components/Agents';
import { ActivityFeed } from './PlanPage';
import {
  TaskOverview,
  SegmentedProgress,
  taskSummary,
} from '../components/TaskProgress';
import { PlanStatePicker, PlanPinButton } from '../components/PlanControls';

/** "1 plan", "3 plans". */
export const plural = (count: number, noun: string) =>
  `${count} ${noun}${count === 1 ? '' : 's'}`;
export const COLUMNS = [
  'To do',
  'In progress',
  'Review & test',
  'Waiting',
  'Done',
];
export function columnOf(plan: DisplayPlan) {
  const status = stage(plan.status).toLowerCase();
  if (status === 'done') return 4;
  if (status.startsWith('waiting') || status === 'blocked') return 3;
  if (/^(reviewing|fixing review|testing)$/.test(status)) return 2;
  if (/^(implementing|shipping|in progress|partly done|dry run)$/.test(status))
    return 1;
  // A stage the app does not recognise but with blocked steps is waiting on something.
  if (status !== 'planning' && plan.steps.some((s) => s.status === 'blocked'))
    return 3;
  return 0;
}
/** The drag data type of a Board card: its plan key. */
export const PLAN_DRAG_TYPE = 'application/x-agent-ops-plan';
export const PlanCard = memo(function PlanCard({
  plan,
  attention = false,
  drag,
  pin,
}: {
  plan: DisplayPlan;
  attention?: boolean;
  /** On the Board, a card that can be dragged to Done. */
  drag?: { start(plan: DisplayPlan): void; end(): void } | undefined;
  pin?: { pinned: boolean; toggle(): void } | undefined;
}) {
  const current = plan.milestones.find(milestoneOpen);
  const key = planKey(plan);
  return (
    <article
      className={`work-card${attention ? ' needs-attention' : ''}`}
      data-plan-key={key}
      {...(drag
        ? {
            draggable: true,
            onDragStart: (event: DragEvent) => {
              event.dataTransfer.setData(PLAN_DRAG_TYPE, key);
              event.dataTransfer.effectAllowed = 'move';
              drag.start(plan);
            },
            onDragEnd: () => drag.end(),
          }
        : {})}
    >
      <div className="card-heading">
        <PlanLink plan={plan} />
        <PlanStatePicker plan={plan} showLabel />
        {pin && (
          <PlanPinButton
            name={plan.name}
            pinned={pin.pinned}
            toggle={pin.toggle}
          />
        )}
        <PlanActions plan={plan} />
      </div>
      <div className="card-place">
        <span>{placeLabel(plan)}</span>
        <SourceLabel plan={plan} />
      </div>
      <p className="card-next">{plan.next || 'No next action recorded'}</p>
      <small className="muted">
        {current ? `${current.id} · ${current.title}` : 'No open milestone'}
      </small>
      <div className="card-footer">
        <AgentChain plan={plan} />
        <Link
          className="card-tasks-link"
          to={`/list?${new URLSearchParams({ plan: key, status: 'all' })}`}
        >
          Tasks →
        </Link>
        <SegmentedProgress
          summary={taskSummary(plan.steps)}
          label={`Task progress for ${plan.name}`}
          detail
        />
      </div>
      <Warning plan={plan} />
    </article>
  );
});
/** Agent workload as a table: every agent on one row each, no scrolling. */
function AgentWorkloadTable({
  plans,
  agents,
  selected,
  select,
}: {
  plans: DisplayPlan[];
  agents: string[];
  selected: string;
  select(name: string): void;
}) {
  const rows = agents.map((name) => ({
    name,
    ...agentWorkload(plans, name),
  }));
  const totals = [
    ['Total agents', rows.filter((r) => r.plans).length],
    ['Total tasks', rows.reduce((n, r) => n + r.tasks, 0)],
    ['Active', rows.reduce((n, r) => n + r.active, 0)],
    ['Coordinating', rows.reduce((n, r) => n + r.coordinating, 0)],
  ] as const;
  const percent = (part: number, whole: number) =>
    whole ? Math.round((part / whole) * 100) : 0;
  return (
    <section className="summary-panel summary-workload">
      <div className="workload-head">
        <div>
          <h2>Agent workload</h2>
          <p className="muted">
            Reported participation · select an agent to view its work
          </p>
        </div>
        <dl className="workload-totals">
          {totals.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="workload-table-wrap">
        <table className="workload-table">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Workload</th>
              <th scope="col">Plans</th>
              <th scope="col">Tasks</th>
              <th scope="col">Coordinating</th>
              <th scope="col">Active</th>
              <th scope="col">Completion</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const share = percent(r.plans, plans.length);
              const done = percent(r.done, r.tasks);
              return (
                <tr
                  key={r.name}
                  className={selected === r.name ? 'selected' : undefined}
                >
                  <th scope="row">
                    <button
                      className="workload-row"
                      aria-pressed={selected === r.name}
                      disabled={!r.plans}
                      onClick={() => select(r.name)}
                    >
                      <AgentBadge name={r.name} />
                    </button>
                  </th>
                  <td>
                    <span
                      className="workload-share"
                      title={`${plural(r.plans, 'plan')} of ${plans.length} matching`}
                    >
                      <span className="workload-bar">
                        <i style={{ width: `${share}%` }} />
                      </span>
                      <span>{share}%</span>
                    </span>
                  </td>
                  <td>
                    <span className="workload-num">{r.plans}</span>
                  </td>
                  <td>
                    <span className="workload-num">{r.tasks}</span>
                  </td>
                  <td>
                    <span className="workload-num">{r.coordinating}</span>
                  </td>
                  <td>
                    <span className="workload-num">{r.active}</span>
                  </td>
                  <td>
                    <span
                      className={`workload-done${r.tasks && r.done ? ' some' : ''}`}
                    >
                      {r.done} / {r.tasks} ({done}%)
                    </span>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
function StatusOverview({ plans }: { plans: DisplayPlan[] }) {
  const counts = COLUMNS.map(
    (_, i) => plans.filter((p) => columnOf(p) === i).length,
  );
  let end = 0;
  const colors = [
    'var(--st-todo)',
    'var(--info)',
    'var(--review)',
    'var(--warning)',
    'var(--success)',
  ];
  const gradient = counts
    .map((count, i) => {
      const start = end;
      end += plans.length ? (count / plans.length) * 100 : 0;
      return `${colors[i]} ${start}% ${end}%`;
    })
    .join(', ');
  return (
    <div className="status-overview">
      <div
        className="status-donut"
        role="img"
        aria-label={COLUMNS.map((label, i) => `${label}: ${counts[i]}`).join(
          ', ',
        )}
        style={{
          background: plans.length
            ? `conic-gradient(${gradient})`
            : 'var(--border)',
        }}
      >
        <span>
          <strong>{plans.length}</strong>
          <small>plans</small>
        </span>
      </div>
      <ul className="status-legend">
        {COLUMNS.map((label, i) => (
          <li key={label}>
            <i style={{ background: colors[i] }} />
            {label}
            <strong>{counts[i]}</strong>
          </li>
        ))}
      </ul>
    </div>
  );
}
export function Overview({
  query,
  view = 'overview',
  clear,
  agent = '',
}: {
  query: string;
  view?: 'overview' | 'attention' | 'archive';
  clear(): void;
  agent?: string;
}) {
  const { snapshot, settings } = useLedger();
  const [search, setSearch] = useSearchParams();
  const navigate = useNavigate();
  const [morePlans, setMorePlans] = useState(false);
  const [moreActivity, setMoreActivity] = useState(false);
  const all = useMemo(
    () =>
      snapshot && settings
        ? snapshot.state.plans.filter(
            (p) => archived(p, settings) === (view === 'archive'),
          )
        : [],
    [snapshot, settings, view],
  );
  const plans = useMemo(
    () =>
      all
        .filter(
          (p) =>
            (view !== 'attention' ||
              (snapshot && needsAttention(p, snapshot))) &&
            planSearchText(p).includes(fold(query)) &&
            agentMatches(p, agent),
        )
        .sort(
          (a, b) =>
            Number(needsAttention(b, snapshot!)) -
              Number(needsAttention(a, snapshot!)) ||
            Date.parse(participation(b).updated) -
              Date.parse(participation(a).updated),
        ),
    [all, view, snapshot, query, agent],
  );
  if (!snapshot || !settings) return null;
  if (
    !all.length &&
    view !== 'archive' &&
    !settings.tasksDir &&
    !settings.projects.some((p) => p.enabled)
  )
    return (
      <Empty
        title={
          settings.projects.length
            ? 'All workspace folders are hidden'
            : 'Add a workspace to start'
        }
      >
        <p>
          Choose where your work lives, then keep every plan in one Tasks
          folder.
        </p>
        <Link className="button primary" to="/settings/projects">
          Add workspace
        </Link>{' '}
        <Link to="/settings/general">Open settings</Link>
      </Empty>
    );
  const done = plans.filter((p) => stage(p.status) === 'Done').length;
  const attention = plans.filter((p) => needsAttention(p, snapshot)).length;
  const updated = plans.filter((p) => {
    const age = Date.parse(snapshot.now) - Date.parse(participation(p).updated);
    return age >= 0 && age <= 7 * 86400000;
  }).length;
  const steps = plans.flatMap((p) =>
    p.steps.filter((step) => stepAgentMatches(p, step, agent)),
  );
  const agents = [
    ...new Set(plans.flatMap((p) => participation(p).agents)),
  ].sort();
  const active = plans.filter((p) => stage(p.status) !== 'Done');
  return (
    <div className="work-summary">
      {/* The plan count sits under the view title; this only offers the reset. */}
      {(query || agent) && (
        <div className="filter-notice" role="status">
          Filtered{' '}
          <button className="link-button" onClick={clear}>
            Clear filters
          </button>
        </div>
      )}
      {!plans.length ? (
        <Empty
          title={
            query || agent
              ? 'No matching work'
              : view === 'archive'
                ? 'No archived plans'
                : 'No active plan'
          }
        >
          <p>
            {view === 'archive'
              ? 'Archive a plan from its actions menu to keep it here.'
              : 'Plans appear here when an AI tool saves one to your Tasks folder.'}
          </p>
        </Empty>
      ) : view !== 'overview' ? (
        <>
          <p className="muted">
            {view === 'archive'
              ? 'Archived plans, kept for reference.'
              : 'Plans needing your attention'}
          </p>
          <div className="plan-card-grid">
            {plans.map((p) => (
              <PlanCard
                key={planKey(p)}
                plan={p}
                attention={view === 'attention'}
              />
            ))}
          </div>
        </>
      ) : (
        <>
          <div className="summary-stats">
            {[
              ['Active plans', plans.length - done, 'Current'],
              ['Done', done, 'Current'],
              ['Updated', updated, 'Last 7 days'],
              ['Needs attention', attention, 'Current'],
            ].map(([label, value, hint]) => (
              <div className="summary-stat" key={label}>
                <span>{label}</span>
                <strong>{value}</strong>
                <small className="muted">{hint}</small>
              </div>
            ))}
          </div>
          <div className="summary-blocks">
            <section className="summary-panel summary-task-progress">
              <div className="panel-heading">
                <h2>Task progress</h2>
                <Link
                  to={`/list?${new URLSearchParams({ ...Object.fromEntries(search), plan: 'all', status: 'all' })}`}
                >
                  View tasks →
                </Link>
              </div>
              <p className="muted">
                Checklist tasks · select a status to open List
              </p>
              <TaskOverview
                steps={steps}
                selected="all"
                onSelect={(status) =>
                  navigate(
                    `/list?${new URLSearchParams({ ...Object.fromEntries(search), plan: 'all', status })}`,
                  )
                }
              />
              <div className="summary-quick-links">
                <Link
                  to={`/list?${new URLSearchParams({ ...Object.fromEntries(search), plan: 'all', status: 'doing' })}`}
                >
                  In progress tasks →
                </Link>
                <Link
                  to={`/list?${new URLSearchParams({ ...Object.fromEntries(search), plan: 'all', status: 'blocked' })}`}
                >
                  Blocked tasks →
                </Link>
                {attention > 0 && (
                  <Link to={`/attention?${search}`}>
                    {plural(attention, 'plan')}{' '}
                    {attention === 1 ? 'needs' : 'need'} attention →
                  </Link>
                )}
              </div>
            </section>
            <AgentWorkloadTable
              plans={plans}
              agents={agents}
              selected={agent}
              select={(name) => {
                const next = new URLSearchParams(search);
                next.set('agent', name);
                setSearch(next);
              }}
            />
          </div>
          <div className="summary-grid">
            <section className="summary-panel summary-focus summary-bounded">
              <div className="panel-heading">
                <h2>Current work</h2>
                <Link to={`/board?${search}`}>View all plans →</Link>
              </div>
              <p className="muted">
                Active plans, with items needing attention first
              </p>
              <div className="summary-panel-body">
                {active.length ? (
                  active
                    .slice(0, morePlans ? active.length : 3)
                    .map((p) => (
                      <PlanCard
                        key={planKey(p)}
                        plan={p}
                        attention={needsAttention(p, snapshot)}
                      />
                    ))
                ) : (
                  <p>All plans are complete</p>
                )}
              </div>
              <footer>
                {active.length > 3 && (
                  <button
                    className="link-button"
                    aria-expanded={morePlans}
                    onClick={() => setMorePlans(!morePlans)}
                  >
                    {morePlans
                      ? 'Show fewer plans'
                      : `Show more plans (${active.length - 3})`}
                  </button>
                )}
              </footer>
            </section>
            <section className="summary-panel summary-recent summary-bounded">
              <div className="panel-heading">
                <h2>Recent activity</h2>
                <Link to={`/timeline?${search}`}>View timeline →</Link>
              </div>
              <p className="muted">Recorded updates across matching plans</p>
              <div className="summary-panel-body">
                <ActivityFeed plans={plans} limit={moreActivity ? 40 : 4} />
              </div>
              <footer>
                <button
                  className="link-button"
                  aria-expanded={moreActivity}
                  onClick={() => setMoreActivity(!moreActivity)}
                >
                  {moreActivity ? 'Show less activity' : 'Show more activity'}
                </button>
              </footer>
            </section>
          </div>
          <details className="summary-plan-states">
            <summary>Plan states</summary>
            <StatusOverview plans={plans} />
          </details>
        </>
      )}
    </div>
  );
}
