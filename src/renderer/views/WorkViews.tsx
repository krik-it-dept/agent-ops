import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  archived,
  fold,
  planKey,
  planSearchText,
  type DisplayPlan,
} from '../model';
import { agentMatches, participation } from '../agents';
import { useLedger } from '../store';
import { Empty, usePlanStatus } from '../components/ui';
import type { Navigation } from '../preferences';
import type { PlanState } from '../../shared/contracts';
import { Timeline } from './Timeline';
import { COLUMNS, columnOf, PLAN_DRAG_TYPE, PlanCard } from './Overview';

const COLUMN_STATES: PlanState[] = [
  'Planning',
  'Implementing',
  'Reviewing',
  'Waiting for owner',
  'Done',
];

export function WorkViews({
  view,
  query,
  agent,
  clear,
  navigation,
  setNavigation,
}: {
  view: 'board' | 'timeline';
  query: string;
  agent: string;
  clear(): void;
  navigation: Navigation;
  setNavigation(update: (nav: Navigation) => Navigation): void;
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
  // A drag carries the exact revision the owner saw. Pinning is private navigation only.
  const [dragging, setDragging] = useState('');
  const draggedPlan = useRef<DisplayPlan | null>(null);
  const [over, setOver] = useState<number | 'pinned' | null>(null);
  const [marking, setMarking] = useState(false);
  const changeStatus = usePlanStatus();
  const drag = useMemo(
    () => ({
      start: (plan: DisplayPlan) => {
        draggedPlan.current = plan;
        setDragging(planKey(plan));
      },
      end: () => {
        draggedPlan.current = null;
        setDragging('');
        setOver(null);
      },
    }),
    [],
  );
  const canDrag = !settings?.readOnly && !marking;
  const accepts = (event: DragEvent) =>
    canDrag &&
    draggedPlan.current !== null &&
    event.dataTransfer.types.includes(PLAN_DRAG_TYPE);
  const dropTarget = (target: number | 'pinned') => ({
    onDragEnter: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      setOver(target);
    },
    onDragOver: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
    },
    onDragLeave: (event: DragEvent) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null))
        setOver(null);
    },
    onDrop: (event: DragEvent) => {
      if (!accepts(event)) return;
      event.preventDefault();
      const key = event.dataTransfer.getData(PLAN_DRAG_TYPE) || dragging;
      const plan = draggedPlan.current;
      drag.end();
      if (!plan || planKey(plan) !== key) return;
      const pin = (pinned: boolean) =>
        setNavigation((nav) => ({
          ...nav,
          pinnedCards: pinned
            ? [...new Set([...nav.pinnedCards, key])].slice(-200)
            : nav.pinnedCards.filter((value) => value !== key),
        }));
      if (target === 'pinned') {
        pin(true);
        return;
      }
      if (columnOf(plan) === target) {
        pin(false);
        return;
      }
      setMarking(true);
      void changeStatus(plan, COLUMN_STATES[target]!)
        .then((changed) => {
          if (changed) pin(false);
        })
        .finally(() => setMarking(false));
    },
  });
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
        <>
          <section
            className={`board-pinned${dragging ? ' drop-target' : ''}${over === 'pinned' ? ' drop-over' : ''}`}
            aria-label="Pinned plans"
            {...dropTarget('pinned')}
          >
            <div className="board-pinned-heading">
              <h2>
                Pinned{' '}
                <small>
                  {
                    plans.filter((p) =>
                      navigation.pinnedCards.includes(planKey(p)),
                    ).length
                  }
                </small>
              </h2>
              <span className="muted">
                Drop here to pin without changing status
              </span>
            </div>
            <div className="board-pinned-cards">
              {plans
                .filter((p) => navigation.pinnedCards.includes(planKey(p)))
                .map((p) => (
                  <PlanCard
                    key={planKey(p)}
                    plan={p}
                    drag={canDrag ? drag : undefined}
                    pin={{
                      pinned: true,
                      toggle: () =>
                        setNavigation((nav) => ({
                          ...nav,
                          pinnedCards: nav.pinnedCards.filter(
                            (key) => key !== planKey(p),
                          ),
                        })),
                    }}
                  />
                ))}
            </div>
          </section>
          <div className="board-columns">
            {COLUMNS.map((title, i) => {
              const column = plans.filter(
                (p) =>
                  columnOf(p) === i &&
                  !navigation.pinnedCards.includes(planKey(p)),
              );
              const target =
                dragging !== '' &&
                draggedPlan.current !== null &&
                (columnOf(draggedPlan.current) !== i ||
                  navigation.pinnedCards.includes(dragging));
              return (
                <section
                  className={`board-column column-${i}${target ? ' drop-target' : ''}${target && over === i ? ' drop-over' : ''}`}
                  key={title}
                  aria-label={title}
                  aria-busy={marking ? true : undefined}
                  {...dropTarget(i)}
                >
                  <h2>
                    <i />
                    {title}
                    <small>{column.length}</small>
                  </h2>
                  {target && (
                    <p className="drop-hint">
                      {i === 4
                        ? 'Drop here to mark the plan Done'
                        : `Drop here to set ${COLUMN_STATES[i]}`}
                    </p>
                  )}
                  {column.slice(0, limit).map((p) => (
                    <PlanCard
                      key={planKey(p)}
                      plan={p}
                      drag={canDrag ? drag : undefined}
                      pin={{
                        pinned: false,
                        toggle: () =>
                          setNavigation((nav) => ({
                            ...nav,
                            pinnedCards: [
                              ...new Set([...nav.pinnedCards, planKey(p)]),
                            ].slice(-200),
                          })),
                      }}
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
        </>
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
