// A board plan for activity tests.

import type { Plan, Step } from './diff';

/** plan returns a plan in sample/plan owned by Lan; steps are shared by the flat list and milestone M1. */
export function plan(over: Partial<Plan> = {}, ...steps: Step[]): Plan {
  return {
    revision: '',
    owner: 'Lan',
    repo: 'sample',
    name: 'plan',
    status: 'Implementing',
    mtime: new Date().toISOString(),
    decisions: [],
    questions: [],
    milestones: [
      {
        id: 'M1',
        title: 'Delivery',
        state: '',
        summary: '',
        steps: [...steps],
      },
    ],
    steps,
    ...over,
  };
}
