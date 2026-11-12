import type { Step } from '../../shared/contracts';
import {
  needsAttention,
  stepLabels,
  type ListFilters,
  type DisplayPlan,
} from '../model';
import { useLedger } from '../store';

export const taskStatusOrder = [
  'done',
  'doing',
  'todo',
  'blocked',
  'waiting',
  'partial',
] as const;
const icons: Record<Step['status'], string> = {
  done: '✓',
  doing: '●',
  todo: '○',
  blocked: '⚠',
  waiting: '◷',
  partial: '◐',
};

/** Counts checklist statuses only; plan state and agent reports never change them. */
export function taskSummary(steps: readonly Step[]) {
  const counts = {
    done: 0,
    doing: 0,
    todo: 0,
    blocked: 0,
    waiting: 0,
    partial: 0,
  };
  for (const step of steps) {
    if (Object.hasOwn(counts, step.status)) counts[step.status]++;
  }
  return {
    counts,
    total: steps.length,
    done: counts.done,
    doneOrDoing: counts.done + counts.doing,
  };
}
type Summary = ReturnType<typeof taskSummary>;
const percent = (count: number, total: number) =>
  total ? Math.round((count * 100) / total) : 0;

/** The combined figure measures Done + In progress, never completion alone. */
export function TaskProgressTotal({ summary }: { summary: Summary }) {
  const value = percent(summary.doneOrDoing, summary.total);
  const label = `Done + In progress: ${summary.doneOrDoing} of ${summary.total} ${summary.total === 1 ? 'task' : 'tasks'} · ${value}%`;
  return (
    <span title={label} aria-label={label}>
      {summary.doneOrDoing} / {summary.total} · {value}%
    </span>
  );
}
const visibleStatuses = (
  { counts }: Summary,
  selected?: ListFilters['status'],
) =>
  taskStatusOrder.filter(
    (status) =>
      !['waiting', 'partial'].includes(status) ||
      counts[status] > 0 ||
      selected === status,
  );

export function TaskCounts({
  summary,
  compact = false,
  selected,
  onSelect,
}: {
  summary: Summary;
  compact?: boolean;
  selected?: ListFilters['status'];
  onSelect?(status: ListFilters['status']): void;
}) {
  return (
    <span
      className={`task-counts${compact ? ' compact' : ''}`}
      role="group"
      aria-label="Task statuses"
    >
      {visibleStatuses(summary, selected).map((status) => {
        const content = (
          <>
            <span className="task-status-icon" aria-hidden="true">
              {icons[status]}
            </span>
            <strong>{summary.counts[status]}</strong>
            {!compact && (
              <span className="task-count-label">{stepLabels[status]}</span>
            )}
          </>
        );
        const label = `${stepLabels[status]}: ${summary.counts[status]} ${summary.counts[status] === 1 ? 'task' : 'tasks'}`;
        return onSelect ? (
          <button
            key={status}
            className={`task-count task-tone-${status}`}
            aria-label={label}
            aria-pressed={selected === status}
            onClick={() => onSelect(selected === status ? 'all' : status)}
          >
            {content}
          </button>
        ) : (
          <span
            key={status}
            className={`task-count task-tone-${status}`}
            aria-label={label}
            title={label}
          >
            {content}
          </span>
        );
      })}
    </span>
  );
}

export function SegmentedProgress({
  summary,
  label,
  detail = false,
}: {
  summary: Summary;
  label: string;
  detail?: boolean;
}) {
  return (
    <span className={`task-progress${detail ? ' with-detail' : ''}`}>
      <span className="task-segments" role="group" aria-label={label}>
        {taskStatusOrder
          .filter((status) => summary.counts[status] > 0)
          .map((status) => {
            const count = summary.counts[status];
            const text = `${stepLabels[status]} — ${count} ${count === 1 ? 'task' : 'tasks'} · ${percent(count, summary.total)}%`;
            return (
              <span
                key={status}
                className={`task-segment task-tone-${status}`}
                style={{ flexGrow: count }}
                tabIndex={detail ? 0 : undefined}
                role="img"
                aria-label={text}
                title={detail ? undefined : text}
              >
                <span className="task-segment-tooltip" aria-hidden="true">
                  {text}
                </span>
              </span>
            );
          })}
      </span>
      {detail && (
        <span className="task-progress-detail">
          <TaskProgressTotal summary={summary} />
        </span>
      )}
    </span>
  );
}

export function TaskOverview({
  steps,
  selected,
  onSelect,
}: {
  steps: Step[];
  selected: ListFilters['status'];
  onSelect(status: ListFilters['status']): void;
}) {
  const summary = taskSummary(steps);
  return (
    <section className="task-overview" aria-label="Task overview">
      <div className="task-overview-counts">
        <button
          className="task-count task-total"
          aria-pressed={selected === 'all'}
          onClick={() => onSelect('all')}
        >
          <strong>{summary.total}</strong>
          <span>Tasks</span>
        </button>
        <TaskCounts summary={summary} selected={selected} onSelect={onSelect} />
      </div>
      <SegmentedProgress
        summary={summary}
        label="Task status distribution"
        detail
      />
    </section>
  );
}

export function PlanAttention({
  plan,
  blocked,
  compact = false,
}: {
  plan: DisplayPlan;
  blocked: number;
  compact?: boolean;
}) {
  const { snapshot } = useLedger();
  if (blocked)
    return (
      <span
        className="plan-attention"
        title={`${blocked} blocked tasks`}
        aria-label={`${blocked} blocked tasks`}
      >
        <span aria-hidden="true">⚠</span> {blocked}
        {!compact && ' blocked'}
      </span>
    );
  if (snapshot && needsAttention(plan, snapshot))
    return (
      <span
        className="plan-attention"
        title="Needs attention"
        aria-label="Needs attention"
      >
        <span aria-hidden="true">⚠</span>
        {!compact && ' Needs attention'}
      </span>
    );
  return null;
}
