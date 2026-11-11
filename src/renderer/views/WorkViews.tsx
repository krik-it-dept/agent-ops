import { useMemo, useState } from 'react';
import { archived, fold, planKey, planSearchText } from '../model';
import { agentMatches, participation } from '../agents';
import { useLedger } from '../store';
import { Empty } from '../components/ui';
import { Timeline } from './Timeline';
import { COLUMNS, columnOf, PlanCard } from './Overview';

export function WorkViews({
  view,
  query,
  agent,
}: {
  view: 'board' | 'timeline';
  query: string;
  agent: string;
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
  if (!snapshot) return null;
  return (
    <div className={`work-${view}`}>
      <p className="filter-notice">{plans.length} plans</p>
      {!plans.length ? (
        <Empty title="No matching work" />
      ) : view === 'board' ? (
        <div className="board-columns">
          {COLUMNS.map((title, i) => {
            const column = plans.filter((p) => columnOf(p) === i);
            return (
              <section
                className={`board-column column-${i}`}
                key={title}
                aria-label={title}
              >
                <h2>
                  <i />
                  {title}
                  <small>{column.length}</small>
                </h2>
                {column.slice(0, limit).map((p) => (
                  <PlanCard key={planKey(p)} plan={p} />
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
          <Timeline plans={plans.slice(0, limit)} />
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
