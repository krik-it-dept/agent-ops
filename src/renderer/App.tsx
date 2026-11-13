import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useNavigationType,
  useSearchParams,
} from 'react-router-dom';
import { LedgerProvider, useLedger, useLedgerStatus } from './store';
import {
  archived,
  findPlan,
  needsAttention,
  fold,
  planSearchText,
  planKey,
  timeLabel,
  type ListFilters,
} from './model';
import {
  defaultNavigation,
  loadPreference,
  migrateNavigation,
  normalizeNavigation,
  savePreference,
  visitPlan,
  type Navigation,
} from './preferences';
import { routePlan, viewRoute, VIEW_SHORTCUTS } from './routes';
import { Empty, planRoute, ToastHost } from './components/ui';
import { UpdatePanel, updating, useUpdateDock } from './components/Updates';
import { CommandSearch, ShortcutSheet } from './components/Commands';
import { Sidebar, sidebarPlans } from './components/Sidebar';
import { PlanTabs } from './components/PlanTabs';
import { Overview } from './views/Overview';
import { Sessions } from './views/Sessions';
import { WorkViews } from './views/WorkViews';
import { agentMatches, agentName, participation } from './agents';
import { TaskList, restoreListPreferences } from './views/TaskList';
import { PlanPage } from './views/PlanPage';
import { SettingsPage } from './settings/Settings';
import { Setup } from './settings/Setup';

function Shell() {
  const {
    client,
    snapshot,
    settings,
    update,
    fixture,
    loading,
    error,
    dismissActionError,
    refresh,
    report,
    announce,
    setSettings,
  } = useLedger();
  const { actionError, notice, refreshing } = useLedgerStatus();
  // Ctrl + mouse wheel and Ctrl + = / - / 0 step through the Text size setting,
  // so the size is kept like the one chosen in Settings.
  const textSize = settings?.textSize;
  const readOnly = !!settings?.readOnly;
  useEffect(() => {
    if (!textSize || readOnly) return;
    const sizes = ['small', 'default', 'large', 'larger'] as const;
    let last = 0;
    type Size = (typeof sizes)[number];
    // The size on screen, which runs ahead of the saved setting while a save is on its way.
    const shown = (): Size => {
      const value = document.documentElement.dataset.textSize as Size;
      return sizes.includes(value) ? value : textSize;
    };
    const step = (to: Size) => {
      if (to === shown()) return;
      document.documentElement.dataset.textSize = to;
      void client.settings
        .set({ textSize: to })
        .then(setSettings)
        .catch(report);
    };
    const by = (delta: number) => {
      const i = sizes.indexOf(shown());
      step(sizes[Math.max(0, Math.min(sizes.length - 1, i + delta))]!);
    };
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const now = Date.now();
      if (now - last < 200 || event.deltaY === 0) return;
      last = now;
      by(event.deltaY < 0 ? 1 : -1);
    };
    const onKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.altKey || event.metaKey) return;
      if (event.key === '=' || event.key === '+') by(1);
      else if (event.key === '-') by(-1);
      else if (event.key === '0') step('default');
      else return;
      event.preventDefault();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
    };
  }, [client, textSize, readOnly, setSettings, report]);
  const location = useLocation(),
    navigate = useNavigate(),
    navigationType = useNavigationType();
  const [search, setSearch] = useSearchParams();
  const searchRef = useRef(search);
  useLayoutEffect(() => {
    searchRef.current = search;
  }, [search]);
  const [navigation, setNavigation] = useState<Navigation>(() =>
    normalizeNavigation(loadPreference('wb-navigation', defaultNavigation())),
  );
  const [commands, setCommands] = useState(false),
    [help, setHelp] = useState(false),
    [errorDetails, setErrorDetails] = useState(false);
  const scroll = useRef<HTMLDivElement>(null),
    positions = useRef(new Map<string, { top: number; left: number }>()),
    previous = useRef(location),
    visited = useRef(''),
    setupOpened = useRef(false),
    queryRef = useRef<HTMLInputElement>(null);
  const ledgerRoute = useRef('/');
  const pendingUpdatePosition = useRef<{
    route: string;
    top: number;
    left: number;
  } | null>(null);
  const updateRestored = useRef(false);
  const activeKey = routePlan(location.pathname),
    isSettings = location.pathname.startsWith('/settings'),
    isSetup = location.pathname === '/setup',
    query = search.get('q') || '',
    dock = useUpdateDock();
  const plans = useMemo(
    () => snapshot?.state.plans || [],
    [snapshot?.state.plans],
  );
  const activePlans = useMemo(
    () => (settings ? plans.filter((p) => !archived(p, settings)) : []),
    [plans, settings],
  );
  // Links may name an agent in any case, or one no plan mentions any more.
  const agent =
    search.get('agent') === 'unreported'
      ? 'unreported'
      : agentName(search.get('agent') || '');
  const filterPlans =
    location.pathname === '/archive'
      ? plans.filter((p) => settings && archived(p, settings))
      : activePlans;
  const agentNames = [
    ...new Set([
      ...filterPlans.flatMap((p) => participation(p).agents),
      ...(agent && agent !== 'unreported' ? [agent] : []),
    ]),
  ].sort();
  function clearFilters() {
    const next = new URLSearchParams(searchRef.current);
    next.delete('q');
    next.delete('agent');
    next.delete('plan');
    searchRef.current = next;
    setSearch(next, { replace: true });
  }
  const current = activeKey ? findPlan(plans, activeKey) : undefined;
  const visiblePlans = sidebarPlans(activePlans, navigation);
  useLayoutEffect(() => {
    if (!isSettings && !isSetup)
      ledgerRoute.current = location.pathname + location.search;
  }, [location.pathname, location.search, isSettings, isSetup]);
  useEffect(() => {
    if (!isSettings && !isSetup)
      savePreference('wb-ui', {
        ...loadPreference('wb-ui', {}),
        route: location.pathname,
        layout: location.pathname === '/list' ? 'list' : 'summary',
      });
  }, [location.pathname, isSettings, isSetup]);
  useEffect(() => {
    if (update?.phase !== 'restarting') return;
    const list = loadPreference('wb-ui', {
      taskWork: '',
      taskPlans: null,
      taskSort: null,
    });
    savePreference('wb-update-view', {
      version: update.latest,
      route: location.pathname + location.search,
      top: scroll.current?.scrollTop || 0,
      left: scroll.current?.scrollLeft || 0,
      list: { work: list.taskWork, plans: list.taskPlans, sort: list.taskSort },
    });
  }, [update?.phase, update?.latest, location.pathname, location.search]);
  useEffect(() => {
    if (updateRestored.current || !snapshot) return;
    const saved = loadPreference('wb-update-view', {
      version: '',
      route: '',
      top: 0,
      left: 0,
      list: null,
    });
    if (
      saved.version !== snapshot.appVersion ||
      !saved.route.startsWith('/') ||
      saved.route.startsWith('//')
    )
      return;
    updateRestored.current = true;
    restoreListPreferences(client, saved.list);
    pendingUpdatePosition.current = saved;
    savePreference('wb-update-view', {});
    navigate(saved.route, { replace: true });
  }, [client, navigate, snapshot]);
  useEffect(() => savePreference('wb-navigation', navigation), [navigation]);
  useEffect(() => {
    if (plans.length)
      setNavigation((nav) => {
        const next = migrateNavigation(nav, plans);
        return JSON.stringify(nav) === JSON.stringify(next) ? nav : next;
      });
  }, [plans]);
  useEffect(() => {
    if (current && activeKey !== visited.current) {
      visited.current = activeKey!;
      setNavigation((nav) =>
        visitPlan(nav, planKey(current), new Date().toISOString()),
      );
    } else if (!activeKey) visited.current = '';
  }, [activeKey, !!current]);
  useEffect(() => {
    if (settings?.setupRequired && !setupOpened.current) {
      setupOpened.current = true;
      navigate('/setup', { replace: true });
    }
  }, [settings?.setupRequired, navigate]);
  useEffect(
    () =>
      client.app.onActivate((event) => {
        // A plain activation (tray click, a second launch) only shows the
        // window; it never moves the owner away from the page they are on.
        if (event.route === 'settings') navigate('/settings/general');
        else if (event.plan) navigate(planRoute(event.plan));
      }),
    [client, navigate],
  );
  useLayoutEffect(() => {
    const node = scroll.current;
    if (!node) return;
    if (previous.current.pathname !== location.pathname) {
      const pos =
        navigationType === 'POP' ? positions.current.get(location.key) : null;
      node.scrollTop = pos?.top || 0;
      node.scrollLeft = pos?.left || 0;
    }
    previous.current = location;
    const restore = pendingUpdatePosition.current;
    if (restore && location.pathname + location.search === restore.route) {
      node.scrollTop = Number.isFinite(restore.top) ? restore.top : 0;
      node.scrollLeft = Number.isFinite(restore.left) ? restore.left : 0;
      pendingUpdatePosition.current = null;
    }
    return () => {
      positions.current.set(location.key, {
        top: node.scrollTop,
        left: node.scrollLeft,
      });
    };
  }, [location.key]);
  function setQuery(value: string) {
    const next = new URLSearchParams(searchRef.current);
    if (value) next.set('q', value);
    else next.delete('q');
    searchRef.current = next;
    setSearch(next, { replace: true });
  }
  const status = (
    ['doing', 'todo', 'blocked', 'waiting', 'partial', 'done', 'all'].includes(
      search.get('status') || '',
    )
      ? search.get('status')
      : 'all'
  ) as ListFilters['status'];
  function setStatus(value: ListFilters['status']) {
    const next = new URLSearchParams(searchRef.current);
    next.set('status', value);
    next.set('group', navigation.group);
    searchRef.current = next;
    setSearch(next, { replace: true });
  }
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target,
        typing =
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) &&
              !['checkbox', 'radio'].includes(
                (target as HTMLInputElement).type,
              )));
      if (event.key === 'F5') {
        event.preventDefault();
        if (!event.repeat) void refresh();
        return;
      }
      if (document.querySelector('dialog[open]') || isSetup) return;
      if (
        event.ctrlKey &&
        event.key.toLowerCase() === 'f' &&
        (isSettings || window.location.hash.startsWith('#/settings'))
      ) {
        event.preventDefault();
        requestAnimationFrame(() =>
          document.getElementById('settings-search')?.focus(),
        );
        return;
      }
      if (
        event.ctrlKey &&
        !event.altKey &&
        event.key.toLowerCase() === 'k' &&
        !isSettings
      ) {
        event.preventDefault();
        if (!event.repeat) setCommands(true);
        return;
      }
      if (event.ctrlKey && !event.altKey && event.key.toLowerCase() === 'b') {
        event.preventDefault();
        setNavigation((nav) => ({ ...nav, collapsed: !nav.collapsed }));
        return;
      }
      if (event.ctrlKey && !event.altKey && /^[1-4]$/.test(event.key)) {
        event.preventDefault();
        navigate(
          viewRoute(VIEW_SHORTCUTS[Number(event.key) - 1]!, searchRef.current),
        );
        return;
      }
      if (event.ctrlKey && !event.altKey && event.key === ',') {
        event.preventDefault();
        navigate('/settings/general');
        return;
      }
      if (isSettings) {
        if (!typing && event.key === '/' && settings?.shortcuts) {
          event.preventDefault();
          document.getElementById('settings-search')?.focus();
        }
        return;
      }
      if (
        (event.altKey || (event.ctrlKey && event.shiftKey)) &&
        ['ArrowUp', 'ArrowDown'].includes(event.key) &&
        !typing
      ) {
        event.preventDefault();
        const i = visiblePlans.findIndex((p) => planKey(p) === activeKey),
          p =
            visiblePlans[
              (i + (event.key === 'ArrowDown' ? 1 : visiblePlans.length - 1)) %
                visiblePlans.length
            ];
        if (p) navigate(planRoute(planKey(p)));
        return;
      }
      if (event.key === 'Escape') {
        const menu = document.querySelector<HTMLDetailsElement>(
          'details.plan-actions[open]',
        );
        if (menu) {
          // Close the open actions menu before leaving the plan.
          event.preventDefault();
          menu.open = false;
          menu.querySelector('summary')?.focus();
          return;
        }
        if (query && target === queryRef.current) {
          event.preventDefault();
          setQuery('');
        } else if (activeKey && !typing) {
          event.preventDefault();
          navigate('/');
        }
        return;
      }
      if (
        !typing &&
        !event.ctrlKey &&
        !event.altKey &&
        !event.metaKey &&
        settings?.shortcuts
      ) {
        if (event.key === '/') {
          event.preventDefault();
          queryRef.current?.focus();
          queryRef.current?.select();
        } else if (event.key === ',') {
          event.preventDefault();
          navigate('/settings/general');
        } else if (event.key.toLowerCase() === 'r') {
          event.preventDefault();
          if (!event.repeat) void refresh();
        } else if (event.key === '?') {
          event.preventDefault();
          setHelp(true);
        }
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [
    refresh,
    navigate,
    activeKey,
    visiblePlans,
    isSettings,
    isSetup,
    settings?.shortcuts,
    query,
    navigation.openPlans,
    navigation.pinnedPlans,
  ]);
  function closeTab(key: string) {
    if (navigation.pinnedPlans.includes(key)) return;
    const index = navigation.openPlans.indexOf(key),
      tabs = navigation.openPlans.filter((k) => k !== key);
    setNavigation((nav) => ({ ...nav, openPlans: tabs }));
    if (activeKey === key)
      navigate(
        tabs[Math.max(0, index - 1)]
          ? planRoute(tabs[Math.max(0, index - 1)]!)
          : '/',
      );
  }
  const view =
    location.pathname === '/attention'
      ? 'attention'
      : location.pathname === '/archive'
        ? 'archive'
        : 'overview';
  const title = activeKey
    ? ''
    : view === 'attention'
      ? 'Needs attention'
      : view === 'archive'
        ? 'Archive'
        : location.pathname === '/list'
          ? 'List'
          : location.pathname === '/board'
            ? 'Board'
            : location.pathname === '/timeline'
              ? 'Timeline'
              : location.pathname === '/sessions'
                ? 'Sessions'
                : 'Summary';
  return (
    <div className="app">
      {/* First-run setup is modal: the app bar and status bar stay visible
          but cannot be used until setup is finished or skipped. */}
      <header className="appbar" inert={isSetup}>
        <button
          aria-label="Toggle plans sidebar"
          aria-expanded={!navigation.collapsed}
          onClick={() =>
            setNavigation((nav) => ({ ...nav, collapsed: !nav.collapsed }))
          }
        >
          ☰
        </button>
        <strong className="app-name">Agent Ops</strong>
        {fixture && <small className="fixture-badge">Sample workspace</small>}
        <button
          className="command-open"
          aria-label="Search plans and commands (Ctrl+K)"
          onClick={() => setCommands(true)}
        >
          <span>Search or jump to…</span>
          <kbd>Ctrl K</kbd>
        </button>
        <span className="save-state" role="status">
          {notice.includes('Recycle Bin') ? '' : notice}
        </span>
      </header>
      {actionError && (
        <section className="banner error-banner action-error" role="alert">
          <span>That didn’t work — {actionError}</span>
          <button onClick={dismissActionError}>Dismiss</button>
        </section>
      )}
      {isSetup ? (
        <Setup />
      ) : isSettings ? (
        <SettingsPage returnTo={ledgerRoute.current} />
      ) : (
        <div className="workspace">
          <Sidebar
            plans={activePlans}
            navigation={navigation}
            setNavigation={setNavigation}
            current={activeKey}
            openCommands={() => setCommands(true)}
            openHelp={() => setHelp(true)}
          />
          <main className="main">
            <nav className="workspace-strip" aria-label="Views">
              <Link
                to={`/?${search}`}
                aria-current={location.pathname === '/' ? 'page' : undefined}
              >
                Summary
              </Link>
              <Link
                to={`/list?${search}`}
                aria-current={
                  location.pathname === '/list' ? 'page' : undefined
                }
              >
                List
              </Link>
              {(['board', 'timeline'] as const).map((name) => (
                <Link
                  key={name}
                  to={`/${name}?${search}`}
                  aria-current={
                    location.pathname === `/${name}` ? 'page' : undefined
                  }
                >
                  {name === 'board' ? 'Board' : 'Timeline'}
                </Link>
              ))}
              <Link
                to={`/attention?${search}`}
                aria-current={view === 'attention' ? 'page' : undefined}
              >
                Needs attention
                {snapshot && (
                  <small>
                    {
                      activePlans.filter((p) => needsAttention(p, snapshot))
                        .length
                    }
                  </small>
                )}
              </Link>
              <Link
                to={`/archive?${search}`}
                aria-current={view === 'archive' ? 'page' : undefined}
              >
                Archive
              </Link>
              <Link
                to={`/sessions?${search}`}
                aria-current={
                  location.pathname === '/sessions' ? 'page' : undefined
                }
              >
                Sessions
              </Link>
              <PlanTabs
                plans={plans}
                navigation={navigation}
                setNavigation={setNavigation}
                current={activeKey}
                close={closeTab}
              />
            </nav>
            {notice.includes('Recycle Bin') && (
              <section className="banner result-banner" role="status">
                <span>{notice}</span>
                <button
                  aria-label="Dismiss result"
                  onClick={() => announce('')}
                >
                  Dismiss
                </button>
              </section>
            )}
            {error && (
              <section className="banner error-banner" role="alert">
                <div>
                  <strong>Couldn’t read plans — {error.split('\n')[0]}</strong>
                  <p>
                    {snapshot?.state.generatedAt
                      ? `Showing the last successful check from ${timeLabel(snapshot.state.generatedAt)}.`
                      : 'No successful check yet.'}
                  </p>
                  {errorDetails && <pre>{error}</pre>}
                </div>
                <button
                  aria-expanded={errorDetails}
                  onClick={() => setErrorDetails(!errorDetails)}
                >
                  {errorDetails ? 'Hide details' : 'Details'}
                </button>
                <button
                  disabled={refreshing}
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Retry
                </button>
              </section>
            )}
            {!!snapshot?.warnings.length && (
              <section className="banner warning-banner" role="status">
                <span>{snapshot.warnings.join(' ')}</span>
                <Link to="/settings/projects">Open settings</Link>
                <button
                  disabled={refreshing}
                  onClick={() => {
                    void refresh();
                  }}
                >
                  Retry
                </button>
              </section>
            )}
            {snapshot?.crash && (
              <section className="banner warning-banner" role="status">
                <strong>
                  {snapshot.crash.kind === 'fatal'
                    ? 'Agent Ops closed unexpectedly last time.'
                    : 'Agent Ops recovered from an internal error.'}
                </strong>
                <button
                  onClick={() => {
                    void client.shell
                      .openFolder({ target: 'logs' })
                      .catch(report);
                  }}
                >
                  Open logs
                </button>
                <button
                  onClick={() => {
                    void client.diagnostics.dismissCrash({}).catch(report);
                  }}
                >
                  Dismiss
                </button>
              </section>
            )}
            <header className="top">
              {title && (
                <div className="view-title">
                  <h1>{title}</h1>
                  {/* List counts tasks in its own notice; every other view counts plans here, once. */}
                  {location.pathname !== '/list' && (
                    <small className="muted">
                      {
                        filterPlans.filter(
                          (p) =>
                            agentMatches(p, agent) &&
                            planSearchText(p).includes(fold(query)) &&
                            (view !== 'attention' ||
                              (snapshot && needsAttention(p, snapshot))),
                        ).length
                      }{' '}
                      of {filterPlans.length} plans
                    </small>
                  )}
                </div>
              )}
              {/* A plan page places its title row here, level with search and Refresh. */}
              {activeKey && <div className="top-title" id="page-title" />}
              <label className="sr-only" htmlFor="work-search">
                {activeKey ? 'Search this plan' : 'Search work'}
              </label>
              <input
                ref={queryRef}
                id="work-search"
                type="search"
                aria-label={
                  activeKey
                    ? 'Search this plan'
                    : location.pathname === '/list'
                      ? 'Search tasks'
                      : 'Search work'
                }
                placeholder={
                  activeKey
                    ? 'Search this plan…'
                    : location.pathname === '/list'
                      ? 'Search tasks'
                      : 'Search work'
                }
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              {!activeKey && (
                <select
                  aria-label="Filter by agent"
                  value={agent}
                  onChange={(e) => {
                    const next = new URLSearchParams(searchRef.current);
                    if (e.target.value) next.set('agent', e.target.value);
                    else next.delete('agent');
                    searchRef.current = next;
                    setSearch(next);
                  }}
                >
                  <option value="">All agents ({filterPlans.length})</option>
                  {agentNames.map((name) => (
                    <option key={name} value={name}>
                      {name} (
                      {filterPlans.filter((p) => agentMatches(p, name)).length})
                    </option>
                  ))}
                  <option value="unreported">
                    Not reported (
                    {
                      filterPlans.filter((p) => agentMatches(p, 'unreported'))
                        .length
                    }
                    )
                  </option>
                </select>
              )}
              <button
                disabled={refreshing}
                onClick={() => {
                  void refresh();
                }}
              >
                {refreshing ? 'Checking…' : 'Refresh'}
                <kbd>F5</kbd>
              </button>
            </header>
            <div className="view" ref={scroll}>
              {loading ? (
                <Empty title="Loading plans…" />
              ) : !snapshot ? (
                <Empty title="Plans could not be loaded">
                  <p>Check the app status, then try again.</p>
                  <button
                    onClick={() => {
                      void refresh();
                    }}
                  >
                    Try again
                  </button>
                </Empty>
              ) : (
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Overview
                        query={query}
                        agent={agent}
                        clear={clearFilters}
                      />
                    }
                  />
                  <Route
                    path="/overview"
                    element={<Navigate to="/" replace />}
                  />
                  <Route path="/ledger" element={<Navigate to="/" replace />} />
                  <Route
                    path="/list"
                    element={
                      <TaskList
                        query={query}
                        agent={agent}
                        status={status}
                        setStatus={setStatus}
                        clearQuery={clearFilters}
                        navigation={navigation}
                        setNavigation={setNavigation}
                      />
                    }
                  />
                  <Route
                    path="/board"
                    element={
                      <WorkViews
                        view="board"
                        navigation={navigation}
                        setNavigation={setNavigation}
                        query={query}
                        agent={agent}
                        clear={clearFilters}
                      />
                    }
                  />
                  <Route
                    path="/timeline"
                    element={
                      <WorkViews
                        view="timeline"
                        navigation={navigation}
                        setNavigation={setNavigation}
                        query={query}
                        agent={agent}
                        clear={clearFilters}
                      />
                    }
                  />
                  <Route
                    path="/attention"
                    element={
                      <Overview
                        query={query}
                        view="attention"
                        agent={agent}
                        clear={clearFilters}
                      />
                    }
                  />
                  <Route
                    path="/archive"
                    element={
                      <Overview
                        query={query}
                        view="archive"
                        agent={agent}
                        clear={clearFilters}
                      />
                    }
                  />
                  <Route
                    path="/sessions"
                    element={<Sessions query={query} />}
                  />
                  <Route
                    path="/plan/:key/:section?"
                    element={
                      <PlanPage
                        query={query}
                        navigation={navigation}
                        setNavigation={setNavigation}
                      />
                    }
                  />
                  <Route
                    path="*"
                    element={
                      <Empty title="Page unavailable">
                        <Link to="/">Summary</Link>
                      </Empty>
                    }
                  />
                </Routes>
              )}
            </div>
          </main>
        </div>
      )}
      {dock.visible && !isSettings && !isSetup && (
        <div className="update-dock">
          <UpdatePanel minimize={dock.minimize} dismiss={dock.dismiss} />
        </div>
      )}
      <footer className="statusbar" aria-label="Status" inert={isSetup}>
        <span role="status">
          {updating(update?.phase)
            ? 'Updating…'
            : loading
              ? 'Connecting…'
              : error
                ? 'Couldn’t read plans'
                : 'Live'}
        </span>
        <span
          title={
            snapshot?.state.generatedAt || 'No successful progress check yet'
          }
        >
          {snapshot?.state.generatedAt &&
            `Updated ${timeLabel(snapshot.state.generatedAt)}`}
        </span>
        <span className="grow" />
        <span>
          {settings?.projects.filter((p) => p.enabled).length || 0} workspaces ·{' '}
          {plans.length} plans
        </span>
        {update &&
          (updating(update.phase) ||
            update.phase === 'error' ||
            (update.available && !update.skipped)) && (
            <button
              className="update-segment"
              onClick={() => {
                if (isSettings) navigate('/settings/about');
                else dock.show();
              }}
            >
              {updating(update.phase)
                ? `${update.phase === 'restarting' ? 'Restarting for' : 'Installing'} update…`
                : update.phase === 'error'
                  ? 'Update failed'
                  : 'Update available'}
            </button>
          )}
        <Link to="/settings/about">
          {update?.current || snapshot?.appVersion || 'About'}
        </Link>
      </footer>
      {commands && (
        <CommandSearch
          plans={[...activePlans].sort(
            (a, b) =>
              Number(navigation.starred.includes(planKey(b))) -
                Number(navigation.starred.includes(planKey(a))) ||
              b.mtime.localeCompare(a.mtime),
          )}
          close={() => setCommands(false)}
          viewRoute={(path) => viewRoute(path, searchRef.current)}
          showShortcuts={() => setHelp(true)}
          toggleSidebar={() =>
            setNavigation((nav) => ({ ...nav, collapsed: !nav.collapsed }))
          }
          refresh={() => {
            void refresh();
          }}
        />
      )}
      {help && <ShortcutSheet close={() => setHelp(false)} />}
      {!isSetup && <ToastHost />}
    </div>
  );
}
export function App() {
  return (
    <LedgerProvider>
      <HashRouter>
        <Shell />
      </HashRouter>
    </LedgerProvider>
  );
}
