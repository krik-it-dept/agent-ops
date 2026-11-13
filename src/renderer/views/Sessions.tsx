import { useCallback, useEffect, useMemo, useState } from 'react';
import type { SessionSummary, SessionsResponse } from '../../shared/contracts';
import { AgentBadge } from '../components/Agents';
import { whenLabel } from '../model';
import { useLedger } from '../store';

const STATE_LABEL: Record<SessionSummary['state'], string> = {
  active: 'Working',
  waiting: 'Waiting for you',
  idle: 'Idle',
  quiet: 'Quiet',
  ended: 'Ended',
  note: 'Handoff note',
};
const TODO_MARK = { completed: '✓', in_progress: '▸', pending: '○' } as const;
/** Sessions that ended or went quiet are folded away after this many per workspace. */
const SHOWN_PER_WORKSPACE = 8;

function SessionCard({
  session,
  now,
}: {
  session: SessionSummary;
  now: string;
}) {
  const open = session.todos.filter((t) => t.state !== 'completed').length;
  return (
    <article
      className={`work-card session-card session-${session.state}`}
      data-session={session.id}
    >
      <div className="card-heading">
        <AgentBadge name={session.agent} />
        <span className={`pill session-state session-state-${session.state}`}>
          {STATE_LABEL[session.state]}
        </span>
        <small className="muted session-when">
          {whenLabel(session.lastAt, now)}
        </small>
      </div>
      <div className="card-place">
        <span title={session.cwd}>{session.cwd}</span>
        {session.compactions > 0 && (
          <span>
            {session.compactions} compaction
            {session.compactions === 1 ? '' : 's'}
          </span>
        )}
      </div>
      {session.waiting && <p className="session-waiting">{session.waiting}</p>}
      {session.lastPrompt && (
        <p className="card-next" title="Your latest request">
          {session.lastPrompt}
        </p>
      )}
      {session.todos.length > 0 && (
        <details className="session-todos" open={open > 0}>
          <summary>
            Todo list · {open} open of {session.todos.length}
          </summary>
          <ul>
            {session.todos.map((t, i) => (
              <li key={i} className={`todo-${t.state}`}>
                <span aria-hidden="true">{TODO_MARK[t.state]}</span> {t.text}
              </li>
            ))}
          </ul>
        </details>
      )}
      {session.notes.map((n) => (
        <details className="session-note" key={n.at}>
          <summary>
            Handoff {n.auto ? '(saved automatically)' : `by ${n.agent}`} ·{' '}
            {whenLabel(n.at, now)}
          </summary>
          <pre>{n.text}</pre>
        </details>
      ))}
    </article>
  );
}

export function Sessions({ query }: { query: string }) {
  const { client } = useLedger();
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState('');
  const [showAll, setShowAll] = useState(false);
  const load = useCallback(() => {
    client.sessions
      .list({})
      .then((value) => {
        setData(value);
        setError('');
      })
      .catch((e: unknown) =>
        setError(
          e instanceof Error ? e.message : 'Sessions could not be read.',
        ),
      );
  }, [client]);
  useEffect(() => {
    load();
    const off = client.state.onChanged(load);
    const timer = setInterval(load, 15_000);
    return () => {
      off();
      clearInterval(timer);
    };
  }, [client, load]);
  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const map = new Map<string, SessionSummary[]>();
    for (const s of data?.sessions ?? []) {
      if (
        q &&
        ![
          s.workspace,
          s.cwd,
          s.agent,
          s.lastPrompt,
          ...s.todos.map((t) => t.text),
        ]
          .join('\n')
          .toLowerCase()
          .includes(q)
      )
        continue;
      const list = map.get(s.workspace) ?? [];
      list.push(s);
      map.set(s.workspace, list);
    }
    return [...map.entries()];
  }, [data, query]);
  const now = data?.readAt ?? new Date().toISOString();
  const waiting = (data?.sessions ?? []).filter(
    (s) => s.state === 'waiting',
  ).length;
  return (
    <section className="sessions-view" aria-labelledby="sessions-title">
      <div className="sessions-head">
        <h2 id="sessions-title">Sessions</h2>
        <p className="muted">
          What AI sessions recorded about themselves: who works where, their
          todo lists and the handoff notes they leave before a clear. Agent Ops
          only reads these records.
          {waiting > 0 && (
            <strong>
              {' '}
              {waiting} session{waiting === 1 ? ' is' : 's are'} waiting for
              you.
            </strong>
          )}
        </p>
      </div>
      {error && (
        <p className="session-error" role="alert">
          {error}
        </p>
      )}
      {data && groups.length === 0 && (
        <div className="empty">
          <h2>No sessions yet</h2>
          <p>
            Claude Code sessions appear here once Agent Ops' hooks are on
            (Settings › Sessions). Other AI tools appear when they write a
            handoff with the report command.
          </p>
        </div>
      )}
      {groups.map(([workspace, sessions]) => {
        const live = sessions.filter(
          (s) => !['ended', 'quiet'].includes(s.state),
        );
        const rest = sessions.filter((s) => !live.includes(s));
        const shown = showAll
          ? sessions
          : [
              ...live,
              ...rest.slice(0, Math.max(0, SHOWN_PER_WORKSPACE - live.length)),
            ];
        return (
          <section className="session-group" key={workspace}>
            <h3>
              {workspace} <small className="muted">{sessions.length}</small>
            </h3>
            <div className="plan-card-grid">
              {shown.map((s) => (
                <SessionCard key={s.id} session={s} now={now} />
              ))}
            </div>
            {shown.length < sessions.length && (
              <button
                type="button"
                className="link-button"
                onClick={() => setShowAll(true)}
              >
                Show {sessions.length - shown.length} older sessions
              </button>
            )}
          </section>
        );
      })}
    </section>
  );
}
