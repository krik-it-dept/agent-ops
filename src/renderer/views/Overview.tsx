import { memo, useMemo } from 'react';
import { Link } from 'react-router-dom';
import {
  archived,
  fold,
  milestoneOpen,
  needsAttention,
  planSearchText,
  planKey,
  progress,
  reason,
  type DisplayPlan,
} from '../model';
import { useLedger } from '../store';
import {
  Empty,
  Glyph,
  PlanActions,
  PlanLink,
  Progress,
  SourceLabel,
  Status,
  Warning,
} from '../components/ui';

const PlanRow = memo(function PlanRow({
  plan,
  attention,
}: {
  plan: DisplayPlan;
  attention: boolean;
}) {
  const current = plan.milestones.find(milestoneOpen);
  const count = progress(plan.steps);
  return (
    <article className="plan-row" data-plan-key={planKey(plan)} role="row">
      <div role="cell">
        <div className="row">
          <Glyph value={plan.status} />
          <PlanLink plan={plan} />
          <SourceLabel plan={plan} />
        </div>
        <p className="muted">
          {attention
            ? reason(plan.status) ||
              plan.questions.find((q) => q.open)?.ask ||
              (plan.steps.some((s) => s.status === 'blocked')
                ? 'A step is blocked'
                : 'No recent progress')
            : plan.next || 'No next action recorded'}
        </p>
        <Warning plan={plan} />
      </div>
      <div className="row" role="cell">
        <Status value={plan.status} />
        <PlanActions plan={plan} />
      </div>
      <div className="muted" role="cell">
        {current ? `${current.id} · ${current.title}` : 'No open milestone'}
      </div>
      <div role="cell">
        <Progress {...count} label={`Plan progress for ${plan.name}`} />
      </div>
    </article>
  );
});
export function Overview({
  query,
  view = 'overview',
  clear,
}: {
  query: string;
  view?: 'overview' | 'attention' | 'archive';
  clear(): void;
}) {
  const { snapshot, settings } = useLedger();
  const all = useMemo(
    () =>
      snapshot && settings
        ? snapshot.state.plans
            .filter((p) => archived(p, settings) === (view === 'archive'))
            .sort(
              (a, b) =>
                Number(a.status === 'Done') - Number(b.status === 'Done') ||
                b.mtime.localeCompare(a.mtime),
            )
        : [],
    [snapshot, settings, view],
  );
  const plans = all.filter(
    (p) =>
      (view !== 'attention' || (snapshot && needsAttention(p, snapshot))) &&
      planSearchText(p).includes(fold(query)),
  );
  const groups = new Map<
    string,
    { name: string; flat: boolean; workspaces: Map<string, DisplayPlan[]> }
  >();
  for (const plan of plans) {
    const id = plan.project;
    const group = groups.get(id) ?? {
      name: plan.projectName || plan.project || 'Workspace',
      flat: plan.source === 'tasks',
      workspaces: new Map(),
    };
    groups.set(id, group);
    const list = group.workspaces.get(plan.repo) ?? [];
    list.push(plan);
    group.workspaces.set(plan.repo, list);
  }
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
  return (
    <div className="overview">
      {view === 'archive' && (
        <p className="muted">Archived plans, kept for reference.</p>
      )}
      <div className="filter-notice" role="status">
        {view === 'attention' && <span>Needs attention · </span>}
        {plans.length} of {all.length} plans
        {query && (
          <>
            {' '}
            · Search: {query}{' '}
            <button className="link-button" onClick={clear}>
              Clear filters
            </button>
          </>
        )}
      </div>
      {plans.length ? (
        [...groups].map(([id, group]) => (
          <section className="project-group" key={id}>
            {!group.flat && <h2>{group.name}</h2>}
            {[...group.workspaces].map(([workspace, rows]) => (
              <section key={workspace} className="workspace-group">
                <h3>{workspace}</h3>
                <div
                  role="table"
                  aria-label={`${workspace} plans`}
                  className="ledger-table"
                >
                  <div className="plan-row table-head" role="row">
                    <span role="columnheader">Plan</span>
                    <span role="columnheader">Stage</span>
                    <span role="columnheader">Milestone</span>
                    <span role="columnheader">Progress</span>
                  </div>
                  {rows.map((p) => (
                    <PlanRow
                      key={planKey(p)}
                      plan={p}
                      attention={view === 'attention'}
                    />
                  ))}
                </div>
              </section>
            ))}
          </section>
        ))
      ) : (
        <Empty
          title={
            query
              ? 'No matching work'
              : view === 'archive'
                ? 'No archived plans'
                : 'No active plan'
          }
        >
          <p>
            {view === 'archive'
              ? settings.autoArchiveDone
                ? 'Plans appear here when their status is Done.'
                : 'Archive a plan from its actions menu to keep it here.'
              : 'Plans appear here when an AI tool saves one to your Tasks folder.'}
          </p>
        </Empty>
      )}
    </div>
  );
}
