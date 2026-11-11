import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import {
  archived,
  filterTasks,
  fold,
  planKey,
  progress,
  stepLabels,
  taskRows,
  type ListFilters,
  type TaskRow,
  placeLabel,
} from '../model';
import { useLedger } from '../store';
import { execution, stepAgentMatches } from '../agents';
import { StepAgents, StepResult } from '../components/Agents';
import { whenLabel } from '../model';
import {
  Empty,
  PlanLink,
  Progress,
  SourceLabel,
  Status,
  planRoute,
} from '../components/ui';
import {
  loadPreference,
  savePreference,
  type Navigation,
} from '../preferences';
import type { AgentOpsClient } from '../../shared/contracts';

const savedLists = new WeakMap<
  AgentOpsClient,
  { work: string; plans: string[] | null; sort: ListFilters['sort'] }
>();
export function restoreListPreferences(client: AgentOpsClient, value: unknown) {
  if (!value || typeof value !== 'object') return;
  const data = value as {
    work?: unknown;
    plans?: unknown;
    sort?: ListFilters['sort'];
  };
  savedLists.set(client, {
    work: typeof data.work === 'string' ? data.work : '',
    plans: Array.isArray(data.plans)
      ? data.plans.filter((p): p is string => typeof p === 'string')
      : null,
    sort:
      data.sort &&
      ['work', 'plan', 'status'].includes(data.sort.column) &&
      ['asc', 'desc'].includes(data.sort.direction)
        ? data.sort
        : null,
  });
}

// Plan and step objects are kept while the plan revision is unchanged, so a
// memoised row re-renders only when its own plan changed.
const TaskRowView = memo(function TaskRowView({
  plan,
  step,
  index,
  now,
}: TaskRow & { now: string }) {
  return (
    <tr>
      <td>
        <Link
          className="work-link"
          to={`${planRoute(planKey(plan))}?${new URLSearchParams({ step: `L${step.line}`, revision: plan.revision, index: String(index), text: step.text, milestone: step.milestone }).toString()}`}
        >
          {step.text}
        </Link>
      </td>
      <td>
        <PlanLink plan={plan} />
        <small className="muted">
          {[placeLabel(plan), step.milestone].filter(Boolean).join(' · ')}
        </small>
      </td>
      <td>
        <StepAgents plan={plan} step={step} />
      </td>
      <td>
        <span className={`pill step-${step.status}`}>
          {stepLabels[step.status]}
        </span>
      </td>
      <td>
        <StepResult plan={plan} step={step} />
      </td>
      <td>
        <time dateTime={execution(plan, step).latest?.updatedAt}>
          {execution(plan, step).latest
            ? whenLabel(execution(plan, step).latest!.updatedAt, now)
            : 'Not reported'}
        </time>
      </td>
    </tr>
  );
});
/** Rows rendered at first; more are added on request so large ledgers stay fast. */
export const LIST_PAGE = 200;
type Column = 'work' | 'plan' | 'status';
interface Draft {
  column: Column;
  work: string;
  status: ListFilters['status'];
  plans: string[] | null;
  query: string;
}
export function TaskList({
  agent = '',
  query,
  status,
  setStatus,
  clearQuery,
  navigation,
  setNavigation,
}: {
  query: string;
  agent?: string;
  status: ListFilters['status'];
  setStatus(status: ListFilters['status']): void;
  clearQuery(): void;
  navigation: Navigation;
  setNavigation(update: (nav: Navigation) => Navigation): void;
}) {
  const { snapshot, settings, client } = useLedger();
  const [search, setSearch] = useSearchParams();
  const [saved] = useState(() => {
    const old = loadPreference('wb-ui', {
      taskSort: null as ListFilters['sort'],
    }).taskSort;
    const valid =
      old &&
      ['work', 'plan', 'status'].includes(old.column) &&
      ['asc', 'desc'].includes(old.direction)
        ? old
        : null;
    return savedLists.get(client) || { work: '', plans: null, sort: valid };
  });
  const [work, setWork] = useState(saved.work);
  const [selected, setSelected] = useState<string[] | null>(saved.plans);
  const [sort, setSort] = useState<ListFilters['sort']>(saved.sort);
  useEffect(() => {
    savedLists.set(client, { work, plans: selected, sort });
    savePreference('wb-ui', {
      ...loadPreference('wb-ui', {}),
      taskSort: sort,
      taskWork: work,
      taskPlans: selected,
    });
  }, [client, work, selected, sort]);
  useEffect(() => {
    const group = search.get('group');
    if (group === 'plan' || group === 'none')
      setNavigation((nav) => (nav.group === group ? nav : { ...nav, group }));
  }, [search.get('group')]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const allPlans = useMemo(
    () =>
      snapshot && settings
        ? snapshot.state.plans.filter((p) => !archived(p, settings))
        : [],
    [snapshot, settings],
  );
  const allRows = useMemo(
    () =>
      taskRows(allPlans).filter((r) => stepAgentMatches(r.plan, r.step, agent)),
    [allPlans, agent],
  );
  const rows = filterTasks(allRows, {
    query,
    status,
    work,
    plans: selected,
    sort,
  });
  useEffect(() => {
    if (!draft) return;
    popup.current?.querySelector<HTMLElement>('input,select,button')?.focus();
    const onPointer = (event: PointerEvent) => {
      if (
        event.target instanceof Element &&
        !event.target.closest('.column-popup,.column-trigger')
      )
        setDraft(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [draft?.column]);
  function dismiss() {
    setDraft(null);
    trigger.current?.focus();
  }
  function apply() {
    if (!draft) return;
    setWork(draft.work.trim());
    setStatus(draft.status);
    setSelected(draft.plans);
    dismiss();
  }
  function clear() {
    clearQuery();
    setStatus('all');
    setWork('');
    setSelected(null);
  }
  function header(column: Column, title: string) {
    const active = draft?.column === column;
    return (
      <th
        scope="col"
        aria-sort={
          sort?.column === column
            ? sort.direction === 'asc'
              ? 'ascending'
              : 'descending'
            : 'none'
        }
      >
        <button
          className="column-trigger"
          aria-haspopup="dialog"
          aria-expanded={active}
          onClick={(event) => {
            trigger.current = event.currentTarget;
            setDraft(
              active
                ? null
                : { column, work, status, plans: selected, query: '' },
            );
          }}
        >
          {title}{' '}
          {sort?.column === column
            ? sort.direction === 'asc'
              ? '↑'
              : '↓'
            : '⌄'}
          {(column === 'status'
            ? status !== 'all'
            : column === 'work'
              ? !!work
              : selected !== null) && (
            <span className="filter-dot" aria-label="Filter active">
              ●
            </span>
          )}
        </button>
        {active && draft && (
          <div
            ref={popup}
            className="column-popup"
            role="dialog"
            aria-label={`${title} filter and sort`}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.stopPropagation();
                dismiss();
              }
              if (
                event.key === 'Enter' &&
                event.target instanceof HTMLInputElement &&
                event.target.type !== 'checkbox'
              )
                apply();
            }}
          >
            <div className="column-sort">
              <button
                onClick={() => {
                  setSort({ column, direction: 'asc' });
                  dismiss();
                }}
              >
                {column === 'status' ? 'Workflow order' : 'Sort A → Z'}
              </button>
              <button
                onClick={() => {
                  setSort({ column, direction: 'desc' });
                  dismiss();
                }}
              >
                {column === 'status' ? 'Reverse workflow' : 'Sort Z → A'}
              </button>
              <button
                onClick={() => {
                  setSort(null);
                  dismiss();
                }}
              >
                Default task order
              </button>
            </div>
            <strong>Filter {title}</strong>
            {column === 'work' ? (
              <input
                aria-label="Filter Work"
                value={draft.work}
                onChange={(e) => setDraft({ ...draft, work: e.target.value })}
              />
            ) : column === 'status' ? (
              <select
                aria-label="Filter Status"
                value={draft.status}
                onChange={(e) =>
                  setDraft({
                    ...draft,
                    status: e.target.value as ListFilters['status'],
                  })
                }
              >
                <option value="all">All statuses ({allRows.length})</option>
                {Object.entries(stepLabels).map(([key, label]) => (
                  <option key={key} value={key}>
                    {label} (
                    {allRows.filter((r) => r.step.status === key).length})
                  </option>
                ))}
              </select>
            ) : (
              <>
                <input
                  type="search"
                  aria-label="Find plans"
                  placeholder="Find plans"
                  value={draft.query}
                  onChange={(e) =>
                    setDraft({ ...draft, query: e.target.value })
                  }
                />
                <div className="row">
                  <button onClick={() => setDraft({ ...draft, plans: null })}>
                    Select all
                  </button>
                  <button onClick={() => setDraft({ ...draft, plans: [] })}>
                    Clear selection
                  </button>
                </div>
                <div className="plan-choices">
                  {allPlans
                    .filter((p) =>
                      fold(p.name + ' ' + p.repo).includes(fold(draft.query)),
                    )
                    .map((p) => (
                      <label key={planKey(p)}>
                        <input
                          type="checkbox"
                          checked={
                            draft.plans === null ||
                            draft.plans.includes(planKey(p))
                          }
                          onChange={(e) => {
                            const keys = draft.plans ?? allPlans.map(planKey);
                            setDraft({
                              ...draft,
                              plans: e.target.checked
                                ? [...keys, planKey(p)]
                                : keys.filter((k) => k !== planKey(p)),
                            });
                          }}
                        />
                        <span>
                          {p.name}
                          <small>{placeLabel(p)}</small>
                        </span>
                      </label>
                    ))}
                </div>
              </>
            )}
            <footer className="actions">
              <button
                onClick={() => {
                  if (column === 'work') setWork('');
                  if (column === 'plan') setSelected(null);
                  if (column === 'status') setStatus('all');
                  dismiss();
                }}
              >
                Clear filter
              </button>
              <button onClick={dismiss}>Cancel</button>
              <button className="primary" onClick={apply}>
                Apply
              </button>
            </footer>
          </div>
        )}
      </th>
    );
  }
  const row = (r: TaskRow) => (
    <TaskRowView
      key={`${planKey(r.plan)}:${r.step.line}:${r.index}`}
      plan={r.plan}
      step={r.step}
      index={r.index}
      now={snapshot?.now || ''}
    />
  );
  const groups = new Map<string, TaskRow[]>();
  for (const r of rows) {
    const key = planKey(r.plan);
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }
  let ordered = [...groups];
  const signature = JSON.stringify([
    agent,
    query,
    status,
    work,
    selected,
    sort,
    navigation.group,
  ]);
  const [page, setPage] = useState({ signature, limit: LIST_PAGE });
  const limit = page.signature === signature ? page.limit : LIST_PAGE;
  if (sort?.column === 'plan')
    ordered = ordered.sort((a, b) => {
      const compare = new Intl.Collator('vi', { numeric: true }).compare(
        a[1][0]!.plan.name,
        b[1][0]!.plan.name,
      );
      return sort.direction === 'desc' ? -compare : compare;
    });
  // Groups are shown until the page budget is used; a collapsed group costs
  // one row for its heading.
  let budget = limit;
  const shownGroups: [string, TaskRow[], TaskRow[]][] = [];
  for (const [key, list] of ordered) {
    if (budget <= 0) break;
    const closed = navigation.groups[key] === true;
    const visible = closed ? [] : list.slice(0, budget);
    budget -= closed ? 1 : visible.length;
    shownGroups.push([key, list, visible]);
  }
  const flat = rows.slice(0, limit);
  const available =
    navigation.group === 'none'
      ? rows.length
      : ordered.reduce(
          (n, [key, list]) =>
            n + (navigation.groups[key] === true ? 0 : list.length),
          0,
        );
  const shown =
    navigation.group === 'none'
      ? flat.length
      : shownGroups.reduce((n, [, , visible]) => n + visible.length, 0);
  const hasMore =
    navigation.group === 'none'
      ? rows.length > flat.length
      : shownGroups.length < ordered.length || shown < available;
  return (
    <>
      <div className="filter-notice" role="status">
        {rows.length} of {allRows.length} tasks
        {status !== 'all' && <> · Status: {stepLabels[status]}</>}
        {query && <> · Search: {query}</>}
        {work && <> · Work: {work}</>}
        {selected !== null && (
          <>
            {' '}
            · Plans:{' '}
            {selected.length
              ? selected
                  .map((k) => allPlans.find((p) => planKey(p) === k)?.name)
                  .join(', ')
              : 'None selected'}
          </>
        )}
        <button className="link-button" onClick={clear}>
          Clear filters
        </button>
      </div>
      <div className="list-toolbar">
        <label>
          Group by{' '}
          <select
            aria-label="Group by"
            value={navigation.group}
            onChange={(e) => {
              const next = new URLSearchParams(search);
              next.set('group', e.target.value);
              setSearch(next, { replace: true });
              setNavigation((nav) => ({
                ...nav,
                group: e.target.value as 'plan' | 'none',
              }));
            }}
          >
            <option value="plan">Plan</option>
            <option value="none">None</option>
          </select>
        </label>
        {navigation.group === 'plan' && (
          <>
            <button
              onClick={() =>
                setNavigation((nav) => ({
                  ...nav,
                  groups: {
                    ...nav.groups,
                    ...Object.fromEntries(ordered.map(([k]) => [k, false])),
                  },
                }))
              }
            >
              Expand all
            </button>
            <button
              onClick={() =>
                setNavigation((nav) => ({
                  ...nav,
                  groups: {
                    ...nav.groups,
                    ...Object.fromEntries(ordered.map(([k]) => [k, true])),
                  },
                }))
              }
            >
              Collapse all
            </button>
          </>
        )}
        <small className="muted">
          {sort && navigation.group === 'plan'
            ? 'Sorting within each plan'
            : 'Checklist tasks'}
        </small>
      </div>
      <div className="table-scroll">
        <table className="task-table">
          <thead>
            <tr>
              {header('work', 'Work')}
              {header('plan', 'Plan')}
              <th scope="col">Agent</th>
              {header('status', 'Status')}
              <th scope="col">Latest result</th>
              <th scope="col">Updated</th>
            </tr>
          </thead>
          {navigation.group === 'none' ? (
            <tbody>{flat.map(row)}</tbody>
          ) : (
            shownGroups.map(([key, list, visible]) => {
              const p = list[0]!.plan;
              const closed = navigation.groups[key] === true;
              return (
                <Fragment key={key}>
                  <tbody className="task-group">
                    {/* Plan group cells line up with the task columns, as in the beta List. */}
                    <tr>
                      <th colSpan={3} scope="rowgroup">
                        <div className="task-group-name">
                          <button
                            aria-expanded={!closed}
                            aria-controls={`group-${encodeURIComponent(key)}`}
                            onClick={() =>
                              setNavigation((nav) => ({
                                ...nav,
                                groups: { ...nav.groups, [key]: !closed },
                              }))
                            }
                          >
                            <span aria-hidden="true">{closed ? '›' : '⌄'}</span>
                            {p.name}
                          </button>
                          <small>
                            {placeLabel(p)} · {list.length} of {p.steps.length}{' '}
                            tasks matched
                          </small>
                          <SourceLabel plan={p} />
                        </div>
                      </th>
                      <td>
                        <Status value={p.status} />
                      </td>
                      <td>
                        <small>Plan progress</small>
                        <Progress
                          {...progress(p.steps)}
                          label={`Plan progress for ${p.name}`}
                        />
                      </td>
                      <td>
                        <PlanLink plan={p}>Open plan ↗</PlanLink>
                      </td>
                    </tr>
                  </tbody>
                  <tbody
                    id={`group-${encodeURIComponent(key)}`}
                    hidden={closed}
                  >
                    {visible.map(row)}
                  </tbody>
                </Fragment>
              );
            })
          )}
        </table>
      </div>
      {hasMore && (
        <div className="list-more">
          <p className="muted">
            Showing {shown} of {available} tasks
          </p>
          <button
            onClick={() => setPage({ signature, limit: limit + LIST_PAGE })}
          >
            Show {LIST_PAGE} more
          </button>
          <button onClick={() => setPage({ signature, limit: Infinity })}>
            Show all
          </button>
        </div>
      )}
      {!rows.length && (
        <Empty
          title={
            status === 'doing' && !query && !work
              ? 'No tasks in progress'
              : 'No matching tasks'
          }
        >
          <p>{allRows.length} checklist tasks are available.</p>
          <button onClick={clear}>Show all statuses</button>
        </Empty>
      )}
    </>
  );
}
