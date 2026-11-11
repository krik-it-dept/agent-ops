import { useMemo, useState, type DragEvent } from 'react';
import { archived, fold, planKey, planSearchText } from '../model';
import { agentMatches, participation } from '../agents';
import { useLedger } from '../store';
import { Empty, isDone, useMarkDone } from '../components/ui';
import { Timeline } from './Timeline';
import { COLUMNS, columnOf, PLAN_DRAG_TYPE, PlanCard } from './Overview';

const DONE_COLUMN = COLUMNS.indexOf('Done');

export function WorkViews({
  view,
  query,
  agent,
  clear,
}: {
  view: 'board' | 'timeline';
  query: string;
  agent: string;
  clear(): void;
}) {
  const { snapshot, settings } = useLedger();
  const plans = useMemo(
    () =>
      snapshot && settings
        ? snapshot.state.plans
            .filter(
              (p) =>
                !archived(p, settings) &&
                agentMatches(p, agent) &&
                planSearchText(p).includes(fold(query)),
            )
            .sort(
              (a, b) =>
                Date.parse(participation(b).updated) -
                Date.parse(participation(a).updated),
            )
        : [],
    [snapshot, settings, agent, query],
  );
  const [page, setPage] = useState({ signature: '', limit: 100 });
  const signature = view + query + agent;
  const limit = page.signature === signature ? page.limit : 100;
  // A stable slice keeps Timeline's memoised activity from re-running on every render.
  const shown = useMemo(() => plans.slice(0, limit), [plans, limit]);
  // Cards are dragged to the Done column only; no other column is a target.
  const [dragging, setDragging] = useState('');
  const [over, setOver] = useState(false);
  const [marking, setMarking] = useState(false);
  const markDone = useMarkDone();
  const drag = useMemo(
    () => ({
      start: (key: string) => setDragging(key),
      end: () => {
        setDragging('');
        setOver(false);
      },
    }),
    [],
  );
  const canDrag = !settings?.readOnly && !marking;
  const accepts = (event: DragEvent) =>
    dragging !== '' && event.dataTransfer.types.includes(PLAN_DRAG_TYPE);
  const doneTarget = {
    onDragEnter: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      setOver(true);
    },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setOver(false);
    },
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      const key = event.dataTransfer.getData(PLAN_DRAG_TYPE) || dragging;
      drag.end();
      const plan = plans.find((p) => planKey(p) === key);
      if (!plan || isDone(plan)) return;
      setMarking(true);
      void markDone(plan).finally(() => setMarking(false));
    },
  };
  if (!snapshot) return null;
  return (
    <div className={`work-${view}`}>
      {(query || agent) && (
        <div className="filter-notice" role="status">
          Filtered{' '}
          <button className="link-button" onClick={clear}>
            Clear filters
          </button>
        </div>
      )}
      {!plans.length ? (
        <Empty title="No matching work" />
      ) : view === 'board' ? (
        <div className="board-columns">
          {COLUMNS.map((title, i) => {
            const column = plans.filter((p) => columnOf(p) === i);
            const target = i === DONE_COLUMN && dragging !== '';
            return (
              <section
                className={`board-column column-${i}${target ? ' drop-target' : ''}${target && over ? ' drop-over' : ''}`}
                key={title}
                aria-label={title}
                aria-busy={i === DONE_COLUMN && marking ? true : undefined}
                {...(i === DONE_COLUMN ? doneTarget : {})}
              >
                <h2>
                  <i />
                  {title}
                  <small>{column.length}</small>
                </h2>
                {target && (
                  <p className="drop-hint">Drop here to mark the plan Done</p>
                )}
                {column.slice(0, limit).map((p) => (
                  <PlanCard
                    key={planKey(p)}
                    plan={p}
                    drag={canDrag && !isDone(p) ? drag : undefined}
                  />
                ))}
                {column.length > limit && (
                  <button
                    onClick={() => setPage({ signature, limit: limit + 100 })}
                  >
                    Show more plans
                  </button>
                )}
                {!column.length && <p className="muted">No plans</p>}
              </section>
            );
          })}
        </div>
      ) : (
        <>
          <Timeline plans={shown} />
          {plans.length > limit && (
            <button onClick={() => setPage({ signature, limit: limit + 100 })}>
              Show more plans
            </button>
          )}
        </>
      )}
    </div>
  );
}
