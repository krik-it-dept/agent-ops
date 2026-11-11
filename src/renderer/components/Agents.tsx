import { Fragment } from 'react';
import type { Plan, Step } from '../../shared/contracts';
import { agentName, execution, participation } from '../agents';
import claude from '../assets/icon-claude.svg';
import codex from '../assets/icon-codex.png';
import anti from '../assets/icon-anti.png';

const icons: Record<string, string> = {
  Claude: claude,
  Codex: codex,
  Antigravity: anti,
};
export function AgentBadge({ name }: { name: string }) {
  const canonical = agentName(name);
  return (
    <span className="agent-chip">
      {icons[canonical] ? (
        <img
          className={`agent-icon-${canonical.toLowerCase()}`}
          src={icons[canonical]}
          alt=""
        />
      ) : (
        <span className="agent-monogram" aria-hidden="true">
          {canonical.slice(0, 2)}
        </span>
      )}
      <span>{canonical}</span>
    </span>
  );
}
/** Beyond this many executors a chain shows one "Multi" badge. */
export const CHAIN_EXECUTORS = 2;
/** Names are separated by commas; more than `collapseAfter` become one "Multi" badge naming them all. */
export function AgentBadges({
  names,
  collapseAfter = Infinity,
}: {
  names: string[];
  collapseAfter?: number;
}) {
  if (!names.length) return null;
  if (names.length > collapseAfter)
    return (
      <span className="agent-badges">
        <span className="agent-chip agent-multi" title={names.join(', ')}>
          <span className="agent-monogram" aria-hidden="true">
            {names.length}
          </span>
          <span>Multi</span>
          <span className="sr-only">: {names.join(', ')}</span>
        </span>
      </span>
    );
  return (
    <span className="agent-badges">
      {names.map((name, i) => (
        <Fragment key={name}>
          {i > 0 && (
            <span className="agent-sep" aria-hidden="true">
              ,
            </span>
          )}
          <AgentBadge name={name} />
        </Fragment>
      ))}
    </span>
  );
}
export function AgentChain({
  plan,
  labels = false,
}: {
  plan: Plan;
  labels?: boolean;
}) {
  const { coordinator, executors } = participation(plan);
  if (!coordinator && !executors.length) return null;
  const label = [
    coordinator && `Coordinator: ${coordinator}`,
    executors.length && `Executed by: ${executors.join(', ')}`,
  ]
    .filter(Boolean)
    .join('; ');
  // The coordinator doing all the work is one agent, not a chain.
  if (coordinator && executors.length === 1 && executors[0] === coordinator)
    return (
      <div
        className="agent-chain"
        role="group"
        aria-label={label}
        title={label}
      >
        <span>
          {labels && <small>Coordinator and executor</small>}
          <AgentBadges names={[coordinator]} />
        </span>
      </div>
    );
  return (
    <div className="agent-chain" role="group" aria-label={label} title={label}>
      {coordinator && (
        <span>
          {labels && <small>Coordinator</small>}
          <AgentBadges names={[coordinator]} />
        </span>
      )}
      {coordinator && executors.length > 0 && (
        <span className="muted agent-arrow" aria-hidden="true">
          →
        </span>
      )}
      {executors.length > 0 && (
        <span>
          {labels && <small>Executed by</small>}
          <AgentBadges names={executors} collapseAfter={CHAIN_EXECUTORS} />
        </span>
      )}
    </div>
  );
}
export function StepAgents({ plan, step }: { plan: Plan; step: Step }) {
  const info = execution(plan, step);
  if (!info.agents.length && !info.active.length) return null;
  return (
    <div className="step-agents">
      <AgentBadges names={info.active.length ? info.active : info.agents} />
      {info.active.length > 0 && (
        <small className="working-now">Working now</small>
      )}
    </div>
  );
}
export function StepResult({ plan, step }: { plan: Plan; step: Step }) {
  const latest = execution(plan, step).latest;
  if (!latest?.result) return null;
  return (
    <span
      className={`latest-result${latest?.event === 'blocked' ? ' blocked-result' : ''}`}
    >
      {latest?.event === 'blocked' && <strong>Blocked · </strong>}
      {latest.result}
    </span>
  );
}
