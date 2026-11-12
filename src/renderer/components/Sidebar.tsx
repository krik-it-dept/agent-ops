import { useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { archived, planKey, stage, type DisplayPlan } from '../model';
import { moveSidebarPlan, type Navigation } from '../preferences';
import { useLedger } from '../store';
import { SourceLabel, planRoute } from './ui';
import { PlanStatePicker } from './PlanControls';
import { PlanAttention, TaskProgressTotal, taskSummary } from './TaskProgress';
import { SidebarResize } from './SidebarResize';

export function sidebarPlans(plans: DisplayPlan[], nav: Navigation) {
  const selected =
    nav.collection === 'starred'
      ? plans.filter((p) => nav.starred.includes(planKey(p)))
      : nav.collection === 'recent'
        ? nav.recent
            .map((r) => plans.find((p) => planKey(p) === r.key))
            .filter((p): p is DisplayPlan => !!p)
        : plans;
  if (nav.collection === 'recent' || !nav.sidebarOrder.length) return selected;
  const rank = new Map(nav.sidebarOrder.map((key, index) => [key, index]));
  const folders = new Map<string, DisplayPlan[]>();
  for (const plan of selected) {
    const id = `${plan.project}/${plan.repo}`;
    const list = folders.get(id) ?? [];
    list.push(plan);
    folders.set(id, list);
  }
  return [...folders.values()].flatMap((list) =>
    list.sort(
      (a, b) =>
        (rank.get(planKey(a)) ?? Infinity) - (rank.get(planKey(b)) ?? Infinity),
    ),
  );
}
const SIDEBAR_DRAG = 'application/x-agent-ops-sidebar-plan';
export function Sidebar({
  plans,
  navigation,
  setNavigation,
  current,
  openCommands,
  openHelp,
}: {
  plans: DisplayPlan[];
  navigation: Navigation;
  setNavigation(update: (nav: Navigation) => Navigation): void;
  current: string | null;
  openCommands(): void;
  openHelp(): void;
}) {
  const { snapshot, settings, announce } = useLedger();
  const dragging = useRef<string | null>(null);
  const [draggedKey, setDraggedKey] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ key: string; after: boolean } | null>(
    null,
  );
  const reorderable = navigation.collection !== 'recent';
  function endDrag() {
    dragging.current = null;
    setDraggedKey(null);
    setDrop(null);
  }
  function sameFolder(source: string, target: DisplayPlan) {
    const from = plans.find((plan) => planKey(plan) === source);
    return (
      !!from && from.project === target.project && from.repo === target.repo
    );
  }
  function move(source: string, target: DisplayPlan, after: boolean) {
    if (!reorderable || !sameFolder(source, target)) return;
    const keys = plans
      .filter(
        (plan) => plan.project === target.project && plan.repo === target.repo,
      )
      .map(planKey);
    const updated = moveSidebarPlan(
      navigation,
      keys,
      source,
      planKey(target),
      after,
    );
    if (updated === navigation) return;
    setNavigation((nav) =>
      moveSidebarPlan(nav, keys, source, planKey(target), after),
    );
    announce('Plan order saved');
  }
  const visible = sidebarPlans(plans, navigation);
  const groups = new Map<
    string,
    { name: string; flat: boolean; workspaces: Map<string, DisplayPlan[]> }
  >();
  for (const p of visible) {
    const group = groups.get(p.project) ?? {
      name: p.projectName || p.project || 'Workspace',
      // Plans in the Tasks folder are listed by workspace, with no extra level.
      flat: p.source === 'tasks',
      workspaces: new Map(),
    };
    groups.set(p.project, group);
    const rows = group.workspaces.get(p.repo) ?? [];
    rows.push(p);
    group.workspaces.set(p.repo, rows);
  }
  function folder(id: string, label: string, body: ReactNode, count: number) {
    const closed = navigation.folders[id] === true;
    return (
      <section key={id} className="tree-folder">
        <button
          data-tree-control
          data-folder={id}
          aria-expanded={!closed}
          aria-controls={`folder-${encodeURIComponent(id)}`}
          onClick={() =>
            setNavigation((nav) => ({
              ...nav,
              folders: { ...nav.folders, [id]: !closed },
            }))
          }
        >
          <span aria-hidden="true">{closed ? '›' : '⌄'}</span>
          <strong>{label}</strong>
          <small>{count}</small>
        </button>
        <div id={`folder-${encodeURIComponent(id)}`} hidden={closed}>
          {body}
        </div>
      </section>
    );
  }
  return (
    <aside
      className="plan-sidebar"
      style={
        { '--sidebar-width': `${navigation.sidebarWidth}px` } as CSSProperties
      }
      aria-label="Plans navigation"
      hidden={navigation.collapsed}
    >
      <SidebarResize
        width={navigation.sidebarWidth}
        onChange={(sidebarWidth) =>
          setNavigation((nav) => ({ ...nav, sidebarWidth }))
        }
      />
      <button className="sidebar-find" onClick={openCommands}>
        Search plans <kbd>Ctrl K</kbd>
      </button>
      <header className="sidebar-head">
        <strong>Workspace</strong>
        <small>{plans.length} plans</small>
      </header>
      <div className="collections">
        {(['all', 'starred', 'recent'] as const).map((value) => (
          <button
            key={value}
            aria-pressed={navigation.collection === value}
            onClick={() =>
              setNavigation((nav) => ({ ...nav, collection: value }))
            }
          >
            {value === 'all'
              ? 'All'
              : value === 'starred'
                ? 'Starred'
                : 'Recent'}
          </button>
        ))}
      </div>
      <nav
        className="tree-nav"
        aria-label="Workspace plans"
        onKeyDown={(event) => {
          const element = event.target as HTMLElement;
          if (element.closest('select,input,textarea')) return;
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const rows = [
              ...event.currentTarget.querySelectorAll<HTMLElement>(
                '[data-tree-control]',
              ),
            ].filter((el) => !el.closest('[hidden]'));
            const i = rows.indexOf(element);
            rows[
              event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? rows.length - 1
                  : Math.max(
                      0,
                      Math.min(
                        rows.length - 1,
                        i + (event.key === 'ArrowDown' ? 1 : -1),
                      ),
                    )
            ]?.focus();
          }
          if (
            ['ArrowLeft', 'ArrowRight'].includes(event.key) &&
            element.dataset.folder
          ) {
            event.preventDefault();
            setNavigation((nav) => ({
              ...nav,
              folders: {
                ...nav.folders,
                [element.dataset.folder!]: event.key === 'ArrowLeft',
              },
            }));
          }
        }}
      >
        <span id="sidebar-reorder-help" className="sr-only">
          Drag a Plan card to reorder it in its workspace, or focus its link and
          press Alt + Up or Down. Recent stays ordered by last opened.
        </span>
        {[...groups].map(([id, group]) => {
          const workspaces = [...group.workspaces].map(([workspace, rows]) =>
            folder(
              id + '/' + workspace,
              workspace,
              rows.map((p, index) => {
                const summary = taskSummary(p.steps);
                const key = planKey(p);
                return (
                  <div
                    className={`sidebar-plan${key === current ? ' current' : ''}${draggedKey === key ? ' dragging' : ''}${drop?.key === key ? (drop.after ? ' drop-after' : ' drop-before') : ''}`}
                    key={key}
                    data-sidebar-plan={key}
                    draggable={reorderable}
                    onDragStart={(event) => {
                      if (
                        !reorderable ||
                        (event.target as HTMLElement).closest(
                          'select,button,summary',
                        )
                      ) {
                        event.preventDefault();
                        return;
                      }
                      dragging.current = key;
                      setDraggedKey(key);
                      event.dataTransfer.clearData();
                      event.dataTransfer.setData(SIDEBAR_DRAG, key);
                      event.dataTransfer.effectAllowed = 'move';
                      event.dataTransfer.setDragImage(
                        event.currentTarget,
                        24,
                        16,
                      );
                    }}
                    onDragEnd={endDrag}
                    onDragOver={(event) => {
                      const source = dragging.current;
                      if (
                        !source ||
                        source === key ||
                        !sameFolder(source, p) ||
                        !event.dataTransfer.types.includes(SIDEBAR_DRAG)
                      )
                        return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = 'move';
                      const rect = event.currentTarget.getBoundingClientRect();
                      const after = event.clientY >= rect.top + rect.height / 2;
                      setDrop((previous) =>
                        previous?.key === key && previous.after === after
                          ? previous
                          : { key, after },
                      );
                    }}
                    onDragLeave={(event) => {
                      if (
                        !event.currentTarget.contains(
                          event.relatedTarget as Node | null,
                        )
                      )
                        setDrop(null);
                    }}
                    onDrop={(event) => {
                      const source = dragging.current;
                      if (
                        !source ||
                        event.dataTransfer.getData(SIDEBAR_DRAG) !== source ||
                        !sameFolder(source, p)
                      )
                        return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      move(
                        source,
                        p,
                        event.clientY >= rect.top + rect.height / 2,
                      );
                      endDrag();
                    }}
                    onKeyDown={(event) => {
                      if (
                        !reorderable ||
                        !event.altKey ||
                        !['ArrowUp', 'ArrowDown'].includes(event.key) ||
                        !(event.target as HTMLElement).closest(
                          '.sidebar-plan-link',
                        )
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      const target =
                        rows[index + (event.key === 'ArrowDown' ? 1 : -1)];
                      if (target) move(key, target, event.key === 'ArrowDown');
                    }}
                  >
                    {reorderable && (
                      <span className="sidebar-drag-handle" aria-hidden="true">
                        <svg
                          width="10"
                          height="14"
                          viewBox="0 0 10 14"
                          fill="currentColor"
                        >
                          {[3, 7, 11].flatMap((y) =>
                            [3, 7].map((x) => (
                              <circle key={`${x}-${y}`} cx={x} cy={y} r="1" />
                            )),
                          )}
                        </svg>
                      </span>
                    )}
                    <span className="sidebar-state-control">
                      <PlanStatePicker plan={p} />
                    </span>
                    <Link
                      data-tree-control
                      className="sidebar-plan-link"
                      draggable={reorderable ? undefined : false}
                      aria-describedby={
                        reorderable ? 'sidebar-reorder-help' : undefined
                      }
                      to={planRoute(planKey(p))}
                      title={`Plan state: ${stage(p.status)}`}
                      aria-current={planKey(p) === current ? 'page' : undefined}
                    >
                      <span className="sidebar-plan-name">
                        <span
                          className="sidebar-state-spacer"
                          aria-hidden="true"
                        />
                        <span className="sidebar-plan-title">{p.name}</span>
                        {p.diagnostics.length > 0 && (
                          <span role="img" aria-label="Plan warning">
                            !
                          </span>
                        )}
                      </span>
                      <span className="sidebar-task-progress">
                        <span className="sidebar-task-meta">
                          <TaskProgressTotal summary={summary} />
                          <PlanAttention
                            plan={p}
                            blocked={summary.counts.blocked}
                            compact
                          />
                        </span>
                      </span>
                      <SourceLabel plan={p} />
                    </Link>
                    <button
                      className="star-toggle"
                      aria-pressed={navigation.starred.includes(planKey(p))}
                      aria-label={`${navigation.starred.includes(planKey(p)) ? 'Unstar' : 'Star'} ${p.name}`}
                      onClick={() =>
                        setNavigation((nav) => ({
                          ...nav,
                          starred: nav.starred.includes(planKey(p))
                            ? nav.starred.filter((k) => k !== planKey(p))
                            : [...nav.starred, planKey(p)],
                        }))
                      }
                    >
                      {navigation.starred.includes(planKey(p)) ? '★' : '☆'}
                    </button>
                  </div>
                );
              }),
              rows.length,
            ),
          );
          return group.flat
            ? workspaces
            : folder(
                'project:' + id,
                group.name,
                workspaces,
                [...group.workspaces.values()].flat().length,
              );
        })}
        {!visible.length && (
          <p className="sidebar-empty">
            {navigation.collection === 'starred'
              ? 'Star plans to keep them here'
              : navigation.collection === 'recent'
                ? 'Plans you open appear here'
                : 'No plans yet'}
          </p>
        )}
      </nav>
      <footer>
        <span className="sidebar-tools">
          <Link
            className="icon-button"
            aria-label="Settings"
            to="/settings/general"
          >
            ⚙
          </Link>
          <button
            className="icon-button"
            aria-label="Keyboard shortcuts"
            onClick={openHelp}
          >
            ?
          </button>
        </span>
        <Link className="sidebar-archive" to="/archive">
          Archive{' '}
          <small>
            {settings
              ? snapshot?.state.plans.filter((p) => archived(p, settings))
                  .length
              : 0}
          </small>
        </Link>
      </footer>
    </aside>
  );
}
