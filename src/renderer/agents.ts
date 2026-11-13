import type { AgentRun, Plan, Step } from '../shared/contracts';

const names = ['Claude', 'Codex', 'Gemini', 'Antigravity', 'Cursor', 'Copilot'];
export function agentName(value: string) {
  const name = value.trim();
  return names.find((n) => n.toLowerCase() === name.toLowerCase()) || name;
}
const unique = (values: string[]) => [
  ...new Set(values.map(agentName).filter(Boolean)),
];
const textKey = (text: string) =>
  text.normalize('NFC').trim().replace(/\s+/g, ' ');
export interface Execution {
  agents: string[];
  active: string[];
  latest: AgentRun | undefined;
}
interface Participation {
  coordinator: string;
  executors: string[];
  agents: string[];
  steps: Map<Step, Execution>;
  updated: string;
}
const cache = new WeakMap<Plan, Participation>();
/** Derive read-only participation once per retained plan object. Never infer task state from a run. */
export function participation(plan: Plan): Participation {
  const cached = cache.get(plan);
  if (cached) return cached;
  const runs = [...(plan.runs || [])].sort(
    (a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt),
  );
  const latestCoordinator = runs.find(
    (r) => r.coordinator || r.role === 'coordinator',
  );
  const coordinator = agentName(
    agentName(plan.agent || '') ||
      latestCoordinator?.coordinator ||
      (latestCoordinator?.role === 'coordinator'
        ? latestCoordinator.agent
        : '') ||
      '',
  );
  const byStep = new Map<Step, AgentRun[]>();
  for (const run of runs) {
    if (!run.step) continue;
    const reported = run.step;
    // A reused line must not attach an old report to unrelated work.
    const step = plan.steps.find(
      (s) =>
        s.line === reported.line &&
        textKey(s.text) === textKey(reported.text) &&
        s.milestone === reported.milestone,
    );
    if (step) byStep.set(step, [...(byStep.get(step) || []), run]);
  }
  const steps = new Map(
    plan.steps.map((step): [Step, Execution] => {
      const reports = byStep.get(step) || [];
      return [
        step,
        {
          agents: unique([
            ...(step.executors || []),
            ...reports.map((r) => r.agent),
          ]),
          active: unique(reports.filter((r) => r.active).map((r) => r.agent)),
          latest: reports[0],
        },
      ];
    }),
  );
  const executors = unique([
    ...runs.filter((r) => r.role === 'executor').map((r) => r.agent),
    ...plan.steps.flatMap((s) => s.executors || []),
  ]);
  const result = {
    coordinator,
    executors,
    agents: unique([coordinator, ...executors, ...runs.map((r) => r.agent)]),
    steps,
    updated:
      [plan.mtime, ...runs.map((r) => r.updatedAt)]
        .sort((a, b) => Date.parse(a) - Date.parse(b))
        .at(-1) || plan.mtime,
  };
  cache.set(plan, result);
  return result;
}
export function execution(plan: Plan, step: Step): Execution {
  return (
    participation(plan).steps.get(step) || {
      agents: [],
      active: [],
      latest: undefined,
    }
  );
}
export function agentMatches(plan: Plan, agent: string) {
  const agents = participation(plan).agents;
  return (
    !agent || (agent === 'unreported' ? !agents.length : agents.includes(agent))
  );
}
export function stepAgentMatches(plan: Plan, step: Step, agent: string) {
  if (!agent) return true;
  const agents = execution(plan, step).agents;
  return agent === 'unreported' ? !agents.length : agents.includes(agent);
}
export function agentWorkload(plans: Plan[], agent: string) {
  const tasks = plans.flatMap((p) =>
    p.steps.map((s) => ({ ...execution(p, s), status: s.status })),
  );
  const mine = tasks.filter((s) => s.agents.includes(agent));
  return {
    plans: plans.filter((p) => agentMatches(p, agent)).length,
    tasks: mine.length,
    /** Of the agent's tasks, those whose checklist step is done. */
    done: mine.filter((s) => s.status === 'done').length,
    coordinating: plans.filter((p) => participation(p).coordinator === agent)
      .length,
    active: tasks.filter((s) => s.active.includes(agent)).length,
  };
}
