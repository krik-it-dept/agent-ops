import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  activityFor,
  dayKey,
  placeLabel,
  planKey,
  whenLabel,
  type DisplayPlan,
} from '../model';
import { participation } from '../agents';
import { useLedger } from '../store';
import { AgentChain } from '../components/Agents';
import { PlanLink, Status, planRoute } from '../components/ui';

/** Calendar marks are recorded events and file edits, never inferred durations. */
export function Timeline({ plans }: { plans: DisplayPlan[] }) {
  const { snapshot } = useLedger();
  const current = snapshot?.now || new Date().toISOString();
  const today = dayKey(current);
  const [offset, setOffset] = useState(0);
  const month = new Date(`${dayKey(current).slice(0, 7)}-15T12:00:00+07:00`);
  month.setUTCMonth(month.getUTCMonth() + offset);
  const monthKey = month.toISOString().slice(0, 7);
  const label = month.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: 'Asia/Ho_Chi_Minh',
  });
  const count = new Date(
    Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 0),
  ).getUTCDate();
  const days = Array.from(
    { length: count },
    (_, i) => `${monthKey}-${String(i + 1).padStart(2, '0')}`,
  );
  const events = useMemo(
    () =>
      new Map(
        plans.map((plan) => {
          const entries = snapshot
            ? activityFor(snapshot, plan).map((e) => ({
                ts: e.ts,
                actor: e.actor,
                text: e.text,
              }))
            : [];
          const grouped = new Map<string, string[]>();
          for (const entry of entries) {
            if (!Number.isFinite(Date.parse(entry.ts))) continue;
            const day = dayKey(entry.ts);
            grouped.set(day, [
              ...(grouped.get(day) || []),
              `${entry.actor}: ${entry.text}`,
            ]);
          }
          return [planKey(plan), grouped] as const;
        }),
      ),
    [plans, snapshot],
  );
  const editedDays = useMemo(
    () =>
      new Map(
        plans.map((plan) => [
          planKey(plan),
          Number.isFinite(Date.parse(plan.mtime)) ? dayKey(plan.mtime) : '',
        ]),
      ),
    [plans],
  );
  const dayClass = (day: string) =>
    `timeline-day${[0, 6].includes(new Date(day + 'T12:00:00+07:00').getUTCDay()) ? ' weekend' : ''}${day === today ? ' today' : ''}`;
  return (
    <>
      <div className="timeline-toolbar">
        <div>
          <strong>{label}</strong>
          <small className="muted">
            Recorded activity by day · Vietnam time
          </small>
        </div>
        <div className="row">
          <button
            aria-label="Previous month"
            disabled={offset <= -1200}
            onClick={() => setOffset(offset - 1)}
          >
            ←
          </button>
          <button onClick={() => setOffset(0)}>Today</button>
          <button
            aria-label="Next month"
            disabled={offset >= 1200}
            onClick={() => setOffset(offset + 1)}
          >
            →
          </button>
        </div>
      </div>
      <p className="timeline-legend muted">
        <span className="legend-event" />
        Recorded event <span className="timeline-edit" />
        Latest plan edit
      </p>
      <div
        className="timeline-scroll"
        tabIndex={0}
        role="region"
        aria-label="Daily plan activity"
      >
        <table className="timeline-table">
          <caption className="sr-only">
            Daily recorded plan activity for {label}, newest plans first
          </caption>
          <thead>
            <tr>
              <th scope="col" className="timeline-work">
                Work
              </th>
              <th scope="col" className="timeline-status">
                Status
              </th>
              <th scope="col" className="timeline-agent">
                Coordinator → executors
              </th>
              {days.map((day) => (
                <th scope="col" className={dayClass(day)} key={day} title={day}>
                  {day.slice(8)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {plans.map((plan) => (
              <tr key={planKey(plan)}>
                <td className="timeline-work">
                  <PlanLink plan={plan} />
                  <small className="muted">{placeLabel(plan)}</small>
                  <time
                    className="muted"
                    dateTime={participation(plan).updated}
                  >
                    Updated {whenLabel(participation(plan).updated, current)}
                  </time>
                </td>
                <td className="timeline-status">
                  <Status value={plan.status} />
                </td>
                <td className="timeline-agent">
                  <AgentChain plan={plan} />
                </td>
                {days.map((day) => {
                  const recorded = events.get(planKey(plan))?.get(day) || [];
                  const edited = editedDays.get(planKey(plan)) === day;
                  return (
                    <td key={day} className={dayClass(day)}>
                      {recorded.length ? (
                        <Link
                          className="timeline-event"
                          to={planRoute(planKey(plan), 'activity')}
                          title={recorded.join('\n')}
                          aria-label={`${plan.name} · ${day} · ${recorded.length} recorded events`}
                        >
                          {recorded.length}
                        </Link>
                      ) : edited ? (
                        <span
                          className="timeline-edit"
                          role="img"
                          aria-label={`${plan.name} · last edited ${day}`}
                          title="Latest plan edit"
                        />
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
