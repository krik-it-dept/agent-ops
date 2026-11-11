import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type {
  SettingsPatch,
  SettingsProject,
  PlanMove,
} from '../../shared/contracts';
import { BridgeFailure } from '../client';
import { fold } from '../model';
import { useLedger } from '../store';
import { Skills } from './Skills';
import { useAction, usePicker } from './hooks';
import { UpdatePanel } from '../components/Updates';
import { Empty } from '../components/ui';

export const settingSections = [
  ['general', 'General'],
  ['projects', 'Workspace'],
  ['integrations', 'Skills'],
  ['tasks', 'Tasks'],
  ['about', 'About'],
] as const;
export function Preferences({ setup = false }: { setup?: boolean }) {
  const { settings, client, setSettings } = useLedger();
  const action = useAction();
  const navigate = useNavigate();
  if (!settings) return <p role="status">Loading settings…</p>;
  const locked = action.busy || !!settings.readOnly;
  const change = (patch: SettingsPatch) => {
    void action.run(async () => {
      setSettings(await client.settings.set(patch));
      action.setNotice('Saved');
    });
  };
  return (
    <div>
      {action.error && <p role="alert">{action.error}</p>}
      {action.notice && <p role="status">{action.notice}</p>}
      <section className="settings-card">
        <h3>App</h3>
        <label className="setting-row">
          <span>
            <strong>Start with Windows</strong>
            <small>
              Open Agent Ops in the tray when you sign in.
              {!settings.startupManaged &&
                ' Available in the installed app only.'}
            </small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.startWithWindows}
            disabled={locked || !settings.startupManaged}
            onChange={(e) => change({ startWithWindows: e.target.checked })}
          />
        </label>
        <label className="setting-row">
          <span>
            <strong>Desktop notifications</strong>
            <small>Notify when a plan becomes blocked or waits for you.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.notifications}
            disabled={locked}
            onChange={(e) => change({ notifications: e.target.checked })}
          />
        </label>
        <label className="setting-row" htmlFor="theme">
          <span>
            <strong>Theme</strong>
            <small>Follow Windows, or always use light or dark.</small>
          </span>
          <select
            id="theme"
            aria-label="Theme"
            value={settings.theme}
            disabled={locked}
            onChange={(e) =>
              change({ theme: e.target.value as 'system' | 'light' | 'dark' })
            }
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        {!setup && (
          <label className="setting-row">
            <span>
              <strong>Single-key shortcuts</strong>
              <small>
                Keys that work without Ctrl while you are not typing. / Search ·
                , Settings · R Refresh · ? Shortcuts
              </small>
            </span>
            <input
              type="checkbox"
              role="switch"
              checked={settings.shortcuts}
              disabled={locked}
              onChange={(e) => change({ shortcuts: e.target.checked })}
            />
          </label>
        )}
      </section>
      {!setup && (
        <>
          <section className="settings-card">
            <h3>Plans</h3>
            <label className="setting-row">
              <span>
                <strong>Automatically archive Done plans</strong>
                <small>
                  Keep completed plans in Archive. Plans return when their
                  status is reopened. Files stay in place.
                </small>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.autoArchiveDone}
                disabled={locked}
                onChange={(e) => change({ autoArchiveDone: e.target.checked })}
              />
            </label>
          </section>
          <section className="settings-card">
            <h3>Maintenance</h3>
            <div className="setting-row">
              <span>
                <strong>Data folder</strong>
                <small>Where Agent Ops keeps its settings and cache.</small>
                <code className="path">{settings.dataDir}</code>
              </span>
              <button
                onClick={() => {
                  void action.run(async () => {
                    await client.shell.openFolder({ target: 'data' });
                  });
                }}
              >
                Open
              </button>
            </div>
            <div className="setting-row">
              <span>
                <strong>Run setup again</strong>
                <small>Show the first-run setup.</small>
              </span>
              <button onClick={() => navigate('/setup')}>
                Run setup again
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}
export function Workspaces({
  setup = false,
  projectId,
  filter = '',
}: {
  setup?: boolean;
  projectId?: string | undefined;
  filter?: string;
}) {
  const { settings, client, setSettings, reload } = useLedger();
  const action = useAction();
  const picker = usePicker();
  const [adding, setAdding] = useState(setup);
  const [pasting, setPasting] = useState(false);
  const [path, setPath] = useState('');
  const [remove, setRemove] = useState('');
  const [edit, setEdit] = useState('');
  const [name, setName] = useState('');
  if (!settings) return <p role="status">Loading Workspace…</p>;
  const locked =
    action.busy || !!settings.readOnly || !!settings.projectsOverridden;
  async function add(value: string) {
    await action.run(async () => {
      const result = await client.workspaces.add({ path: value.trim() });
      setSettings(result.settings);
      setPath('');
      setPasting(false);
      if (!setup) setAdding(false);
      action.setNotice(
        `Workspace added · ${result.repos.reduce((n, r) => n + r.planCount, 0)} plans found.`,
      );
      await reload();
    });
  }
  async function choose() {
    await action.run(async () => {
      try {
        const value = await picker.pick('workspace');
        if (value) {
          const result = await client.workspaces.add({ path: value });
          setSettings(result.settings);
          action.setNotice('Workspace added');
          await reload();
        }
      } catch (failure) {
        setPasting(true);
        throw failure;
      }
    });
  }
  async function removeWorkspace(project: SettingsProject) {
    if (remove !== project.id) {
      setRemove(project.id);
      return;
    }
    await action.run(async () => {
      setSettings(await client.workspaces.remove({ id: project.id }));
      setRemove('');
      await reload();
    });
  }
  return (
    <section>
      <p>
        The folders where your work lives. Your plans are kept together in the
        Tasks folder. Older plans inside a workspace can be moved from Settings
        &gt; Tasks.
      </p>
      {settings.projectsOverridden && (
        <p role="status">{settings.projectsOverridden}</p>
      )}
      {action.error && (
        <p role={action.error.includes('already added') ? 'status' : 'alert'}>
          {action.error}
        </p>
      )}
      {action.notice && <p role="status">{action.notice}</p>}
      {picker.controls}
      {!adding && (
        <button
          className="primary"
          disabled={locked}
          onClick={() => setAdding(true)}
        >
          Add workspace
        </button>
      )}
      {adding && (
        <div className="settings-card">
          <button
            disabled={locked}
            onClick={() => {
              void choose();
            }}
          >
            {action.busy ? 'Waiting for the folder picker…' : 'Choose folder…'}
          </button>
          <p>
            <button
              className="link-button"
              disabled={locked}
              onClick={() => setPasting(true)}
            >
              Paste a path instead
            </button>
          </p>
          {pasting && (
            <form
              className="row"
              onSubmit={(e) => {
                e.preventDefault();
                void add(path);
              }}
            >
              <label className="grow">
                Folder path
                <input
                  required
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape') {
                      e.stopPropagation();
                      setPasting(false);
                      setPath('');
                    }
                  }}
                />
              </label>
              <button disabled={locked}>Add</button>
            </form>
          )}
        </div>
      )}
      {settings.projects.length ? (
        <ul className="card-list">
          {settings.projects
            .filter(
              (project) =>
                (!projectId || project.id === projectId) &&
                (!filter ||
                  fold(
                    project.name +
                      ' ' +
                      project.path +
                      ' ' +
                      project.repos.map((r) => r.name).join(' '),
                  ).includes(fold(filter))),
            )
            .map((project) => (
              <li key={project.id} className="settings-card">
                <div className="row">
                  <h3>{project.name}</h3>
                  <label>
                    <input
                      type="checkbox"
                      role="switch"
                      checked={project.enabled}
                      disabled={locked}
                      onChange={(e) => {
                        void action.run(async () => {
                          setSettings(
                            await client.workspaces.edit({
                              id: project.id,
                              enabled: e.target.checked,
                            }),
                          );
                          await reload();
                        });
                      }}
                    />
                    Include in ledger
                  </label>
                  {!project.enabled && <span className="pill">Hidden</span>}
                  {!project.exists && <span className="pill">Missing</span>}
                </div>
                <code className="path">{project.path}</code>
                <p className="muted">
                  {project.exists
                    ? `Workspace · ${project.repos.reduce((n, r) => n + r.planCount, 0)} plans`
                    : project.error || 'Folder not found.'}
                </p>
                <ul className="workspace-inventory">
                  {project.repos.map((r) => (
                    <li key={r.path}>
                      {r.name}
                      <small>
                        {r.hasTasks ? `${r.planCount} plans` : 'No older plans'}
                      </small>
                    </li>
                  ))}
                </ul>
                <div className="actions">
                  <button
                    disabled={action.busy || !project.exists}
                    onClick={() => {
                      void action.run(async () => {
                        await client.shell.openFolder({
                          target: 'project',
                          id: project.id,
                        });
                      });
                    }}
                  >
                    Open folder
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => {
                      setEdit(project.id);
                      setName(project.name);
                    }}
                  >
                    Rename
                  </button>
                  <button
                    disabled={locked}
                    onClick={() => {
                      void removeWorkspace(project);
                    }}
                  >
                    {remove === project.id ? 'Click again to remove' : 'Remove'}
                  </button>
                </div>
                {remove === project.id && (
                  <p className="muted">
                    Plan files are not changed. Agent Ops stops reading this
                    folder.
                  </p>
                )}
                {edit === project.id && (
                  <form
                    className="row"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void action.run(async () => {
                        setSettings(
                          await client.workspaces.edit({
                            id: project.id,
                            name: name.trim(),
                          }),
                        );
                        setEdit('');
                      });
                    }}
                  >
                    <label>
                      Workspace name
                      <input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                      />
                    </label>
                    <button disabled={locked}>Save</button>
                    <button type="button" onClick={() => setEdit('')}>
                      Cancel
                    </button>
                  </form>
                )}
              </li>
            ))}
        </ul>
      ) : (
        <Empty title="No workspace folders added yet">
          <p>Add a workspace to start.</p>
        </Empty>
      )}
    </section>
  );
}
export function Tasks({
  onPending,
}: {
  onPending?: (pending: boolean) => void;
} = {}) {
  const { settings, snapshot, client, setSettings, reload } = useLedger();
  const action = useAction();
  const picker = usePicker();
  const [path, setPath] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [move, setMove] = useState(true);
  const [allow, setAllow] = useState(false);
  /** A folder inside the chosen one, offered when the chosen folder holds a workspace. */
  const [inner, setInner] = useState('');
  const [results, setResults] = useState<PlanMove[]>([]);
  const [backup, setBackup] = useState('');
  useEffect(() => {
    onPending?.(!!draft);
  }, [draft, onPending]);
  if (!settings) return <p role="status">Loading Tasks…</p>;
  const locked = action.busy || !!settings.readOnly;
  function review(value: string) {
    setPath(value);
    setDraft(value.trim());
    setMove(true);
    setAllow(false);
    setInner('');
    // Results of an earlier move belong to the previous choice.
    setResults([]);
    setBackup('');
    action.setError(value.trim() ? '' : 'Enter a full Tasks folder path.');
  }
  async function change() {
    await action.run(async () => {
      try {
        const result = await client.settings.set({
          tasksDir: draft,
          moveExisting: move,
          allowInsideWorkspace: allow,
        });
        setSettings(result);
        setResults(result.results || []);
        setBackup(result.backup || '');
        setDraft('');
        setPath(null);
        if (result.moveError) action.setError(result.moveError);
        await reload();
      } catch (failure) {
        if (failure instanceof BridgeFailure) {
          if (failure.detail.code === 'INSIDE_WORKSPACE') setAllow(true);
          if (failure.detail.code === 'CONTAINS_WORKSPACE')
            setInner(draft.replace(/[\\/]+$/, '') + '\\Tasks');
        }
        await reload();
        throw failure;
      }
    });
  }
  async function movePlans(previous = false) {
    await action.run(async () => {
      const result = previous
        ? await client.tasks.moveAll({ from: settings!.previousTasksDir })
        : await client.tasks.moveLegacy({});
      setSettings(result.settings);
      setResults(result.results);
      setBackup(result.backup);
      await reload();
    });
  }
  return (
    <section>
      <p>
        One folder for every plan. Every AI tool writes its plans to this shared
        Tasks folder. Agent Ops reads them here.
      </p>
      <div className="settings-card">
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            review(path ?? (settings.tasksDir || settings.tasksDirSuggested));
          }}
        >
          <label className="grow">
            Tasks folder
            <input
              value={path ?? (settings.tasksDir || settings.tasksDirSuggested)}
              disabled={locked}
              onChange={(e) => setPath(e.target.value)}
            />
          </label>
          <button disabled={locked}>Use folder</button>
        </form>
        <div className="actions">
          <button
            disabled={locked}
            onClick={() => {
              void action.run(async () => {
                const value = await picker.pick('tasks');
                if (value) review(value);
              });
            }}
          >
            Choose folder…
          </button>
          <button
            disabled={locked || !settings.tasksDir}
            onClick={() => {
              void action.run(async () => {
                await client.shell.openFolder({ target: 'tasks' });
              });
            }}
          >
            Open folder
          </button>
        </div>
        <p className="muted">
          Suggested default: <code>{settings.tasksDirSuggested}</code>
        </p>
        <p className="muted">
          Skills keep working when you change this folder. Your AI tools find it
          automatically.
        </p>
        {picker.controls}
        {draft && (
          <section
            className="callout"
            role="group"
            aria-label="Confirm Tasks folder"
          >
            <h3>Use this Tasks folder?</h3>
            <code className="path">{draft}</code>
            <label className="choice-card">
              <input
                type="checkbox"
                checked={move}
                onChange={(e) => setMove(e.target.checked)}
                disabled={locked}
              />
              Move my existing plans to the new folder
            </label>
            {allow && (
              <p>
                This folder is inside a workspace. Choose “Use it anyway” only
                if you want plans there.
              </p>
            )}
            {inner && (
              <p>
                A new folder inside it keeps your plans apart from your
                workspaces:{' '}
                <button
                  className="primary"
                  disabled={locked}
                  onClick={() => review(inner)}
                >
                  Use {inner}
                </button>
              </p>
            )}
            <div className="actions">
              <button
                disabled={locked}
                onClick={() => {
                  setDraft('');
                  setAllow(false);
                  setInner('');
                  action.setError('');
                }}
              >
                Cancel
              </button>
              <button
                className="primary"
                disabled={locked}
                onClick={() => {
                  void change();
                }}
              >
                {allow ? 'Use it anyway' : 'Change Tasks folder'}
              </button>
            </div>
          </section>
        )}
        <p>
          {snapshot?.state.plans.filter((p) => p.source === 'tasks').length ||
            0}{' '}
          plans in Tasks. {settings.legacyPlanCount} older plans still inside
          workspaces.
        </p>
        {settings.legacyPlanCount > 0 && (
          <button
            disabled={locked}
            onClick={() => {
              void movePlans();
            }}
          >
            Move them here
          </button>
        )}
        {settings.previousTasksDir && settings.previousPlanCount > 0 && (
          <div className="settings-card">
            <p>
              {settings.previousPlanCount} plans still in the previous Tasks
              folder
            </p>
            <code className="path">{settings.previousTasksDir}</code>
            <button
              disabled={locked}
              onClick={() => {
                void movePlans(true);
              }}
            >
              Move them to the new folder
            </button>
          </div>
        )}
        {action.busy && <p role="status">Saving Tasks folder changes…</p>}
        {action.error && <p role="alert">{action.error}</p>}
        {results.length > 0 && (
          <section aria-label="Plan move results">
            <h3>Plan move results</h3>
            <p>
              {results.filter((r) => r.ok).length} moved ·{' '}
              {results.filter((r) => !r.ok).length} not moved
            </p>
            {backup && <code className="path">Backup: {backup}</code>}
            <ul>
              {results.map((row, i) => (
                <li className="entry" key={row.key + i}>
                  <code className="path">{row.from}</code>
                  <p>{row.ok ? 'Moved' : row.error || 'Not moved'}</p>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </section>
  );
}
function About() {
  const { settings, client } = useLedger();
  const action = useAction();
  return (
    <section>
      <h3>Agent Ops {settings?.version}</h3>
      <p>A local work ledger for your plans.</p>
      <UpdatePanel inline />
      <section className="settings-card">
        <h3>Troubleshooting</h3>
        <p className="muted">
          Diagnostics hold only versions, counts and on/off settings: never plan
          content, workspace names or paths. Logs stay on this computer.
        </p>
        <div className="actions">
          <button
            disabled={action.busy}
            onClick={() => {
              void action.run(async () => {
                await client.shell.openFolder({ target: 'logs' });
              });
            }}
          >
            Open logs folder
          </button>
          <button
            disabled={action.busy}
            onClick={() => {
              void action.run(async () => {
                await client.diagnostics.copy({});
                action.setNotice(
                  'Diagnostics copied. Paste them into your report.',
                );
              });
            }}
          >
            Copy diagnostics
          </button>
        </div>
        {action.error && <p role="alert">{action.error}</p>}
        {action.notice && <p role="status">{action.notice}</p>}
      </section>
    </section>
  );
}
export function SettingsPage({ returnTo = '/' }: { returnTo?: string }) {
  const location = useLocation();
  let section = 'general';
  try {
    section = decodeURIComponent(location.pathname.split('/')[2] || 'general');
  } catch {
    /* Keep a readable Settings page for malformed routes. */
  }
  const { settings, error, reload } = useLedger();
  const [query, setQuery] = useState('');
  const navigate = useNavigate();
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        document.getElementById('settings-search')?.focus();
      }
      if (event.key === 'Escape') {
        // Escape in a field or open dialog belongs to that control; leaving
        // Settings here would throw away a draft the owner is typing.
        const target = event.target;
        if (
          event.defaultPrevented ||
          document.querySelector('dialog[open]') ||
          (target instanceof HTMLElement &&
            target.id !== 'settings-search' &&
            (target.isContentEditable ||
              (['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName) &&
                !['checkbox', 'radio'].includes(
                  (target as HTMLInputElement).type,
                ))))
        )
          return;
        event.preventDefault();
        if (query) setQuery('');
        else navigate(returnTo);
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [query, navigate, returnTo]);
  const matches = settingSections.filter(([id, title]) =>
    fold(
      id +
        ' ' +
        title +
        ' ' +
        (
          {
            general:
              'appearance theme dark light notifications startup shortcuts automatic archive data folder setup',
            projects: 'workspace folders add hidden',
            integrations: 'AI tools skills reminder install path',
            tasks: 'folder move shared plans',
            about: 'version updates logs diagnostics',
          } as const
        )[id],
    ).includes(fold(query)),
  );
  const body = (id: string) =>
    id === 'projects' || id.startsWith('project:') ? (
      <Workspaces
        projectId={id.startsWith('project:') ? id.slice(8) : undefined}
      />
    ) : id === 'integrations' ? (
      <Skills />
    ) : id === 'tasks' ? (
      <Tasks />
    ) : id === 'about' ? (
      <About />
    ) : (
      <Preferences />
    );
  return (
    <section className="settings-shell">
      <aside className="settings-sidebar">
        <div className="row">
          <Link to={returnTo}>← Back</Link>
          <h1>Settings</h1>
        </div>
        <label className="sr-only" htmlFor="settings-search">
          Search settings
        </label>
        <input
          id="settings-search"
          type="search"
          placeholder="Search settings"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <nav aria-label="Settings sections">
          {settingSections.map(([id, title]) => (
            <Link
              key={id}
              to={`/settings/${id}`}
              aria-current={section === id ? 'page' : undefined}
              onClick={() => setQuery('')}
            >
              {title}
            </Link>
          ))}
        </nav>
        {settings?.projects.map((p) => (
          <Link
            className="workspace-shortcut"
            key={p.id}
            to={`/settings/${encodeURIComponent('project:' + p.id)}`}
            onClick={() => setQuery('')}
          >
            {p.name}
          </Link>
        ))}
      </aside>
      <main className="settings-content">
        {!settings ? (
          <Empty
            title={error ? 'Settings could not be loaded' : 'Loading settings…'}
          >
            {error && (
              <>
                <p role="alert">{error}</p>
                <button
                  onClick={() => {
                    void reload();
                  }}
                >
                  Try again
                </button>
              </>
            )}
          </Empty>
        ) : (
          <>
            {settings.readOnly && (
              <p className="callout warning" role="alert">
                {settings.readOnly}
              </p>
            )}
            {settings.warning && <p role="status">{settings.warning}</p>}
            {query ? (
              <>
                <h2>Search results</h2>
                {matches.length ? (
                  matches.map(([id, title]) => (
                    <section key={id}>
                      <h2>{title}</h2>
                      {body(id)}
                    </section>
                  ))
                ) : settings.projects.some((p) =>
                    fold(
                      p.name +
                        ' ' +
                        p.path +
                        ' ' +
                        p.repos.map((r) => r.name).join(' '),
                    ).includes(fold(query)),
                  ) ? (
                  <Workspaces filter={query} />
                ) : (
                  <Empty title="No matching settings" />
                )}
              </>
            ) : (
              <>
                <p className="breadcrumb">
                  Settings /{' '}
                  {settingSections.find(([id]) => id === section)?.[1] ||
                    'General'}
                </p>
                <h2>
                  {settingSections.find(([id]) => id === section)?.[1] ||
                    'General'}
                </h2>
                {body(section)}
              </>
            )}
          </>
        )}
      </main>
    </section>
  );
}
