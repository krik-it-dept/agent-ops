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
export function AgentBadges({ names }: { names: string[] }) {
  return names.length ? (
    <span className="agent-badges">
      {names.map((name) => (
        <AgentBadge key={name} name={name} />
      ))}
    </span>
  ) : (
    <span className="muted role-none">Not reported</span>
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
  return (
    <div
      className="agent-chain"
      aria-label={`Coordinator: ${coordinator || 'Not reported'}; Executed by: ${executors.join(', ') || 'Not reported'}`}
    >
      <span>
        {labels && <small>Coordinator</small>}
        <AgentBadges names={coordinator ? [coordinator] : []} />
      </span>
      <span className="muted" aria-hidden="true">
        →
      </span>
      <span>
        {labels && <small>Executed by</small>}
        <AgentBadges names={executors} />
      </span>
    </div>
  );
}
export function StepAgents({ plan, step }: { plan: Plan; step: Step }) {
  const info = execution(plan, step);
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
  return (
    <span
      className={`latest-result${latest?.event === 'blocked' ? ' blocked-result' : ''}`}
    >
      {latest?.event === 'blocked' && <strong>Blocked · </strong>}
      {latest?.result || 'Not reported'}
    </span>
  );
}
