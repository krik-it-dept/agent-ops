import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { archived, planKey, progress, stage, type DisplayPlan } from '../model';
import type { Navigation } from '../preferences';
import { useLedger } from '../store';
import { Glyph, SourceLabel, planRoute } from './ui';

export function sidebarPlans(plans: DisplayPlan[], nav: Navigation) {
  return nav.collection === 'starred'
    ? plans.filter((p) => nav.starred.includes(planKey(p)))
    : nav.collection === 'recent'
      ? nav.recent
          .map((r) => plans.find((p) => planKey(p) === r.key))
          .filter((p): p is DisplayPlan => !!p)
      : plans;
}
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
  const { snapshot, settings } = useLedger();
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
      aria-label="Plans navigation"
      hidden={navigation.collapsed}
    >
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
        {[...groups].map(([id, group]) => {
          const workspaces = [...group.workspaces].map(([workspace, rows]) =>
            folder(
              id + '/' + workspace,
              workspace,
              rows.map((p) => (
                <div
                  className={`sidebar-plan${planKey(p) === current ? ' current' : ''}`}
                  key={planKey(p)}
                >
                  <Link
                    data-tree-control
                    className="sidebar-plan-link"
                    to={planRoute(planKey(p))}
                    aria-current={planKey(p) === current ? 'page' : undefined}
                  >
                    <span>
                      <Glyph value={p.status} />
                      {p.name}
                      {p.diagnostics.length > 0 && (
                        <span role="img" aria-label="Plan warning">
                          !
                        </span>
                      )}
                    </span>
                    <small>
                      {progress(p.steps).done}/{p.steps.length} steps ·{' '}
                      {stage(p.status)}
                    </small>
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
              )),
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
