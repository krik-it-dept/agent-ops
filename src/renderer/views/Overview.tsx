import { memo, useMemo, type DragEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  archived,
  fold,
  milestoneOpen,
  needsAttention,
  placeLabel,
  planSearchText,
  planKey,
  progress,
  stage,
  type DisplayPlan,
} from '../model';
import { agentMatches, agentWorkload, participation } from '../agents';
import { useLedger } from '../store';
import {
  Empty,
  PlanActions,
  PlanLink,
  Progress,
  SourceLabel,
  Status,
  Warning,
} from '../components/ui';
import { AgentBadge, AgentChain } from '../components/Agents';
import { ActivityFeed } from './PlanPage';

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
}: {
  plan: DisplayPlan;
  attention?: boolean;
  /** On the Board, a card that can be dragged to Done. */
  drag?: { start(plan: DisplayPlan): void; end(): void } | undefined;
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
        <Status value={plan.status} />
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
        <Progress
          {...progress(plan.steps)}
          label={`Plan progress for ${plan.name}`}
        />
      </div>
      <Warning plan={plan} />
    </article>
  );
});
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
  const steps = progress(plans.flatMap((p) => p.steps));
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
          <div className="summary-grid">
            <section className="summary-panel summary-focus">
              <div className="panel-heading">
                <h2>Current work</h2>
                <Link
                  to={`/list?${new URLSearchParams({ ...Object.fromEntries(search), status: 'all' })}`}
                >
                  View tasks →
                </Link>
              </div>
              <p className="muted">
                Active plans, with items needing attention first
              </p>
              {active.length ? (
                active
                  .slice(0, 6)
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
              {active.length > 6 && (
                <Link to={`/board?${search}`}>View all plans →</Link>
              )}
            </section>
            <section className="summary-panel">
              <h2>Status overview</h2>
              <p className="muted">Current state of your plans</p>
              <StatusOverview plans={plans} />
              <div className="summary-step-progress">
                <h2>Step progress</h2>
                <strong>
                  {steps.done} <span className="muted">/ {steps.total}</span>
                </strong>
                <Progress {...steps} label="Step progress" />
              </div>
              {attention > 0 && (
                <>
                  <h3>Needs attention</h3>
                  {plans
                    .filter((p) => needsAttention(p, snapshot))
                    .slice(0, 3)
                    .map((p) => (
                      <div className="attention-row" key={planKey(p)}>
                        <PlanLink plan={p} />
                        <small className="muted">{placeLabel(p)}</small>
                      </div>
                    ))}
                </>
              )}
            </section>
            <section className="summary-panel">
              <h2>Agent workload</h2>
              <p className="muted">
                Reported participation · select an agent to view work
              </p>
              <div className="agent-workload">
                {agents.map((name) => {
                  const workload = agentWorkload(plans, name);
                  const counts = `${plural(workload.plans, 'plan')} · ${plural(workload.tasks, 'task')}`;
                  return (
                    <button
                      key={name}
                      className="workload-row"
                      aria-pressed={agent === name}
                      disabled={!workload.plans}
                      onClick={() => {
                        const next = new URLSearchParams(search);
                        next.set('agent', name);
                        setSearch(next);
                      }}
                    >
                      <AgentBadge name={name} />
                      <span
                        className="workload-bar"
                        title={`${plural(workload.plans, 'plan')} of ${plans.length} matching`}
                      >
                        <i
                          style={{
                            width: `${plans.length ? (workload.plans / plans.length) * 100 : 0}%`,
                          }}
                        />
                      </span>
                      <span className="workload-counts">
                        <strong>{counts}</strong>
                        <small>
                          {workload.coordinating} coordinating ·{' '}
                          {plural(workload.active, 'active task')}
                        </small>
                      </span>
                    </button>
                  );
                })}
                {!agents.length && <p className="muted">Not reported</p>}
              </div>
            </section>
            <section className="summary-panel">
              <h2>Recent activity</h2>
              <ActivityFeed plans={plans} limit={8} />
            </section>
          </div>
        </>
      )}
    </div>
  );
}
