import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from 'react-router-dom';
import {
  activityFor,
  dayLabel,
  findPlan,
  fold,
  looseSteps,
  milestoneOpen,
  milestoneProgress,
  milestoneState,
  planKey,
  progress,
  reason,
  stage,
  stepLabels,
  timeLabel,
  whenLabel,
  workflow,
} from '../model';
import { useLedger } from '../store';
import { AgentChain, StepAgents, StepResult } from '../components/Agents';
import { execution } from '../agents';
import {
  Empty,
  Glyph,
  PlanActions,
  Progress,
  RichText,
  SourceLabel,
  Status,
  Warning,
  planRoute,
} from '../components/ui';
import type { Navigation } from '../preferences';
import type { Plan, Step } from '../../shared/contracts';

export function ActivityFeed({
  plan,
  query = '',
  plans,
  limit = Infinity,
}: {
  plan?: Plan;
  plans?: Plan[];
  limit?: number;
  query?: string;
}) {
  const { snapshot } = useLedger();
  if (!snapshot) return null;
  let last = '';
  const keys = plans ? new Set(plans.map(planKey)) : null;
  const items = activityFor(snapshot, plan)
    .filter(
      (e) =>
        (!keys ||
          (e.project
            ? keys.has([e.project, e.repo, e.plan].join('/'))
            : snapshot.state.plans.filter(
                (p) => p.repo === e.repo && p.name === e.plan,
              ).length === 1 &&
              plans!.some((p) => p.repo === e.repo && p.name === e.plan))) &&
        fold(e.text + ' ' + e.plan + ' ' + e.extra).includes(fold(query)),
    )
    .slice(0, limit);
  return items.length ? (
    <div className="activity-feed">
      {items.map((e, i) => {
        const day = dayLabel(e.ts, snapshot.now);
        const heading = day !== last;
        last = day;
        const showActor =
          !plan || ![plan.name, plan.repo, 'agent'].includes(e.actor);
        return (
          <div key={`${e.ts}:${e.project}:${e.repo}:${e.plan}:${e.kind}:${i}`}>
            {heading && <h3>{day}</h3>}
            <article className="activity-item">
              <header>
                {showActor && <strong>{e.actor}</strong>}
                {!plan && <span>{e.plan}</span>}
                <time dateTime={e.ts}>{timeLabel(e.ts)}</time>
              </header>
              <small>
                {(
                  {
                    new: 'Opened the plan',
                    closed: 'Closed the plan',
                    moved: 'Moved the plan file',
                    status: 'Stage changed',
                    done: 'Done',
                    doing: 'Started',
                    decision: 'Decision',
                    question: 'Question',
                    answer: 'Answered',
                    milestone: 'Milestone done',
                    blocked: 'Blocked',
                    waiting: 'Waiting for you',
                    stale: 'Stale',
                    partial: 'Partly done',
                    'run-started': 'Agent started',
                    'run-finished': 'Agent finished',
                    'run-blocked': 'Agent blocked',
                  } as Record<string, string>
                )[e.kind] || 'Agent activity'}
              </small>
              <p>{e.text}</p>
              {e.extra && <p className="muted">{e.extra}</p>}
            </article>
          </div>
        );
      })}
    </div>
  ) : (
    <Empty title="No activity yet" />
  );
}
export function PlanPage({
  navigation,
  setNavigation,
  query,
}: {
  navigation: Navigation;
  setNavigation(update: (nav: Navigation) => Navigation): void;
  query: string;
}) {
  const { key = '', section = 'summary' } = useParams();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const { snapshot, report, announce, client } = useLedger();
  const plan = snapshot ? findPlan(snapshot.state.plans, key) : undefined;
  const panel = useRef<HTMLElement>(null);
  // The title row sits in the app's top bar, beside search and Refresh.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  useEffect(() => setSlot(document.getElementById('page-title')), []);
  // Goal and Next take at most a third of the window; the rest is one click away.
  const summary = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [clipped, setClipped] = useState(false);
  useEffect(() => {
    const box = summary.current;
    if (!box) return;
    const measure = () =>
      setClipped(
        [...box.querySelectorAll<HTMLElement>(':scope > div')].some(
          (column) => column.scrollHeight > column.clientHeight + 1,
        ),
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(box);
    for (const column of box.querySelectorAll(':scope > div'))
      observer.observe(column);
    return () => observer.disconnect();
  }, [plan?.revision, expanded]);
  const line = Number((search.get('step') || '').replace(/^L/, ''));
  const linkedRevision = search.get('revision');
  const linkedIndex = search.get('index');
  const focused =
    plan && (!linkedRevision || linkedRevision === plan.revision)
      ? plan.steps.find(
          (s, index) =>
            s.line > 0 &&
            s.line === line &&
            (linkedIndex === null || Number(linkedIndex) === index) &&
            (!search.has('text') || search.get('text') === s.text) &&
            (!search.has('milestone') ||
              search.get('milestone') === s.milestone),
        )
      : undefined;
  useEffect(() => {
    if (focused && panel.current) {
      const row = panel.current.querySelector<HTMLElement>(
        `[data-source-line="${focused.line}"]`,
      );
      row?.scrollIntoView({ block: 'center' });
      row?.focus({ preventScroll: true });
    }
  }, [plan && planKey(plan), focused?.line]);
  if (!plan)
    return (
      <Empty title="Plan unavailable">
        <p>This plan is no longer in the ledger.</p>
        <Link to="/">Summary</Link>
      </Empty>
    );
  const openQuestions = plan.questions.filter((q) => q.open);
  const tab = ['summary', 'decisions', 'questions', 'activity'].includes(
    section,
  )
    ? section
    : 'summary';
  const tabs = [
    ['summary', 'Milestones'],
    ['decisions', `Decisions ${plan.decisions.length}`],
    ['questions', `Questions ${openQuestions.length}`],
    ['activity', 'Activity'],
  ];
  const starred = navigation.starred.includes(planKey(plan));
  const matchesStep = (s: Step) =>
    fold(
      [
        s.text,
        ...execution(plan, s).agents,
        execution(plan, s).latest?.result || '',
      ].join(' '),
    ).includes(fold(query));
  function steps(list: Step[]) {
    return [...list]
      .map((s, i) => ({ s, i }))
      .sort(
        (a, b) =>
          (workflow[a.s.status] ?? 99) - (workflow[b.s.status] ?? 99) ||
          a.i - b.i,
      )
      .filter(({ s }) => matchesStep(s))
      .map(({ s, i }) => (
        <div
          key={`${s.line}:${i}`}
          className={`step-row${focused === s ? ' task-focused' : ''}`}
          data-source-line={s.line}
          tabIndex={focused === s ? -1 : undefined}
          aria-current={focused === s ? 'step' : undefined}
        >
          <span className={`step-box step-${s.status}`} aria-hidden="true">
            {
              { done: '✓', doing: '◐', todo: '○', blocked: '×', partial: '!' }[
                s.status
              ]
            }
          </span>
          <div className="step-content">
            <div className="step-heading">
              <p>
                <RichText text={s.text} plan={plan} />
              </p>
              <StepAgents plan={plan!} step={s} />
            </div>
            {execution(plan!, s).latest?.result && (
              <small className="step-result">
                <StepResult plan={plan!} step={s} />
              </small>
            )}
          </div>
          <small>{stepLabels[s.status] || 'Unknown'}</small>
        </div>
      ));
  }
  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        `agent-ops:open?plan=${encodeURIComponent(planKey(plan!))}`,
      );
      announce('Plan link copied');
    } catch {
      report(new Error('Copying is not available here.'));
    }
  }
  const titleRow = (
    <header className="plan-header">
      <div className="row">
        <Link to="/">← Summary</Link>
        {/* The workspace is in the sidebar; it is kept as the title's tooltip. */}
        <h1 title={placeLabel(plan)}>{plan.name}</h1>
        <button
          aria-pressed={starred}
          aria-label={`${starred ? 'Unstar' : 'Star'} ${plan.name}`}
          onClick={() =>
            setNavigation((nav) => ({
              ...nav,
              starred: starred
                ? nav.starred.filter((k) => k !== planKey(plan))
                : [...nav.starred, planKey(plan)],
            }))
          }
        >
          {starred ? '★' : '☆'}
        </button>
        <Status value={plan.status} />
        <SourceLabel plan={plan} />
        <PlanActions plan={plan} afterDelete={() => navigate('/')}>
          <button
            onClick={() => {
              void client.shell
                .openFolder({ target: 'plan', key: planKey(plan) })
                .catch(report);
            }}
          >
            Open plan folder
          </button>
          <button
            onClick={() => {
              void copyLink();
            }}
          >
            Copy link
          </button>
          <div className="plan-action-info">
            {whenLabel(plan.mtime, snapshot!.now) && (
              <small>Updated {whenLabel(plan.mtime, snapshot!.now)} · </small>
            )}
            <code>{plan.file || plan.spec || plan.name + '.md'}</code>
          </div>
        </PlanActions>
        <AgentChain plan={plan} labels />
      </div>
    </header>
  );
  return (
    <section className="plan-page" ref={panel} data-plan-key={planKey(plan)}>
      {slot ? createPortal(titleRow, slot) : titleRow}
      <div
        className={`plan-summary${expanded ? ' expanded' : clipped ? ' clipped' : ''}`}
        ref={summary}
      >
        <div className="plan-summary-main">
          <Progress {...progress(plan.steps)} label="Plan progress" />
          {plan.goal && (
            <div className="goal">
              <strong>Goal</strong>
              <p>
                <RichText text={plan.goal} plan={plan} />
              </p>
            </div>
          )}
        </div>
        <div className="plan-summary-side">
          {(stage(plan.status) === 'Blocked' ||
            /^waiting for owner/i.test(plan.status)) && (
            <div className="callout warning">
              <strong>{stage(plan.status)}</strong>
              <p>
                <RichText
                  text={reason(plan.status) || 'No reason recorded'}
                  plan={plan}
                />
              </p>
            </div>
          )}
          {openQuestions.length > 0 && (
            <div className="callout">
              <strong>Open questions ({openQuestions.length})</strong>
              <p>{openQuestions[0]!.ask}</p>
              <Link to={planRoute(planKey(plan), 'questions')}>
                View all questions
              </Link>
            </div>
          )}
          {plan.next && (
            <div className="callout">
              <strong>Next</strong>
              <p>
                <RichText text={plan.next} plan={plan} />
              </p>
            </div>
          )}
          <Warning plan={plan} />
        </div>
        {(clipped || expanded) && (
          <button
            className="summary-toggle"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? 'Show less' : 'Show full summary'}
          </button>
        )}
        {linkedRevision && linkedRevision !== plan.revision && (
          <p role="status">
            This task changed. Refresh the list and open it again.
          </p>
        )}
      </div>
      <nav
        className="plan-tabs"
        role="tablist"
        aria-label="Plan sections"
        onKeyDown={(e) => {
          if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key))
            return;
          e.preventDefault();
          const buttons = [
            ...e.currentTarget.querySelectorAll<HTMLButtonElement>('button'),
          ];
          const index = buttons.indexOf(e.target as HTMLButtonElement);
          buttons[
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : (index + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) %
                  buttons.length
          ]?.click();
          buttons[
            e.key === 'Home'
              ? 0
              : e.key === 'End'
                ? buttons.length - 1
                : (index + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) %
                  buttons.length
          ]?.focus();
        }}
      >
        {tabs.map(([id, label]) => (
          <button
            key={id}
            role="tab"
            id={`plan-tab-${id}`}
            aria-selected={tab === id}
            aria-controls="plan-panel"
            tabIndex={tab === id ? 0 : -1}
            onClick={() =>
              navigate(
                planRoute(planKey(plan), id) +
                  (search.size ? '?' + search.toString() : ''),
              )
            }
          >
            {label}
          </button>
        ))}
      </nav>
      <section
        id="plan-panel"
        role="tabpanel"
        aria-labelledby={`plan-tab-${tab}`}
      >
        {tab === 'summary' && (
          <>
            {plan.milestones
              .filter(
                (m) =>
                  !query ||
                  fold(
                    m.title +
                      ' ' +
                      m.summary +
                      ' ' +
                      m.steps.map((s) => s.text).join(' '),
                  ).includes(fold(query)) ||
                  m.steps.some(matchesStep),
              )
              .map((m, i) => {
                const token = `${planKey(plan)}|${m.id}|${i}`;
                const open =
                  query || m.steps.includes(focused!)
                    ? true
                    : (navigation.disclosures[token] ?? milestoneOpen(m));
                return (
                  <details
                    key={`${m.id}:${i}`}
                    className="milestone"
                    open={open}
                    onToggle={(e) => {
                      if (query || m.steps.includes(focused!)) return;
                      const isOpen = e.currentTarget.open;
                      if (isOpen !== open)
                        setNavigation((nav) => ({
                          ...nav,
                          disclosures: { ...nav.disclosures, [token]: isOpen },
                        }));
                    }}
                  >
                    <summary>
                      <Glyph
                        value={
                          {
                            done: 'Done',
                            doing: 'Implementing',
                            blocked: 'Blocked',
                            partial: 'Waiting for owner',
                            todo: 'Planning',
                          }[milestoneState(m)]
                        }
                      />
                      <code>{m.id}</code>
                      <strong>{m.title}</strong>
                      <Progress
                        {...milestoneProgress(m)}
                        label={`Milestone progress for ${m.id}`}
                      />
                    </summary>
                    {m.summary && (
                      <p className="milestone-summary">
                        <RichText text={m.summary} plan={plan} />
                      </p>
                    )}
                    {steps(m.steps)}
                  </details>
                );
              })}
            {looseSteps(plan).length > 0 && (
              <section className="loose">
                <h2>{plan.milestones.length ? 'Other steps' : 'Steps'}</h2>
                {steps(looseSteps(plan))}
              </section>
            )}
            {!plan.milestones.length && !plan.steps.length && (
              <Empty title="No milestones or steps recorded" />
            )}
          </>
        )}
        {tab === 'decisions' &&
          (plan.decisions.length ? (
            plan.decisions
              .filter((d) => fold(d.text).includes(fold(query)))
              .map((d, i) => (
                <article className="entry" key={d.key + i}>
                  <time>{d.when}</time>
                  <p>
                    <RichText text={d.text} plan={plan} />
                  </p>
                </article>
              ))
          ) : (
            <Empty title="No decisions recorded" />
          ))}
        {tab === 'questions' &&
          (plan.questions.length ? (
            plan.questions
              .filter((q) => fold(q.ask + ' ' + q.answer).includes(fold(query)))
              .map((q, i) => (
                <article className="entry" key={q.key + i}>
                  <time>{q.when}</time>
                  <div>
                    <p>
                      <RichText text={q.ask} plan={plan} />
                    </p>
                    {q.open ? (
                      <span className="pill">Open</span>
                    ) : (
                      <p className="muted">
                        <RichText text={q.answer} plan={plan} />
                      </p>
                    )}
                  </div>
                </article>
              ))
          ) : (
            <Empty title="No questions recorded" />
          ))}
        {tab === 'activity' && <ActivityFeed plan={plan} query={query} />}
      </section>
    </section>
  );
}
