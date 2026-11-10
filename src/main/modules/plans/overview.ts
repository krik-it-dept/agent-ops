import {
  parseMarkdown,
  type ParsedPlan,
  type ParsedStep,
  type StepStatus,
} from './parse';

export interface Step {
  status: StepStatus;
  text: string;
  line: number;
  milestone: string;
  index: number;
}
export interface Milestone {
  id: string;
  title: string;
  state: StepStatus | '';
  summary: string;
  progress: { done: number; total: number };
  steps: Step[];
}
export interface Decision {
  key: string;
  when: string;
  text: string;
}
export interface Question {
  key: string;
  when: string;
  ask: string;
  answer: string;
  open: boolean;
}
export type Tone =
  'doing' | 'review' | 'test' | 'pending' | 'bad' | 'ok' | 'idle';
export interface Plan {
  project: string;
  projectName: string;
  repo: string;
  root: string;
  gh: string;
  name: string;
  source: 'tasks' | 'legacy';
  workspace: string;
  file: string;
  owner: string;
  goal: string;
  spec: string;
  next: string;
  status: string;
  tone: Tone;
  step: number;
  mtime: string;
  revision: string;
  decisions: Decision[];
  questions: Question[];
  milestones: Milestone[];
  steps: Step[];
}
export interface ProjectResult {
  id: string;
  name: string;
  path: string;
  kind: 'repo' | 'folder' | 'tasks';
  status: 'ok' | 'missing';
  message: string;
  repos: number;
  plans: number;
}
export interface Repo {
  project: string;
  name: string;
  root: string;
  gh: string;
  plans: number;
  /** Retained for schema compatibility; this reader does not expose worktree information. */
  worktrees: { path: string; branch: string }[];
}
export type DiagnosticKind =
  | 'unreadable'
  | 'too-large'
  | 'invalid-utf8'
  | 'unclosed-fence'
  | 'folder-unreadable'
  | 'duplicate';
export interface Diagnostic {
  project: string;
  repo: string;
  plan: string;
  file: string;
  kind: DiagnosticKind;
  message: string;
}
export interface Overview {
  generatedAt: string;
  projects: ProjectResult[];
  repos: Repo[];
  plans: Plan[];
  diagnostics: Diagnostic[];
}
export interface PlanMeta {
  project?: string;
  projectName?: string;
  repo?: string;
  root?: string;
  gh?: string;
  name?: string;
  source?: 'tasks' | 'legacy';
  workspace?: string;
  file?: string;
  mtime?: Date | string;
}

const stages: [string, Tone, number][] = [
  ['Planning', 'doing', 0],
  ['Implementing', 'doing', 1],
  ['Reviewing', 'review', 2],
  ['Fixing review', 'review', 2],
  ['Testing', 'test', 3],
  ['Waiting for CI', 'test', 4],
  ['Dry run', 'test', 5],
  ['Waiting for owner', 'pending', -1],
  ['Shipping', 'doing', 5],
  ['Blocked', 'bad', -1],
  ['Done', 'ok', 6],
];

export function statusOf(
  p: ParsedPlan,
): Pick<Plan, 'status' | 'tone' | 'step'> {
  const label = p.label;
  const stage = stages.find(
    ([name]) => label && label.toLowerCase().startsWith(name.toLowerCase()),
  );
  if (stage) return { status: label, tone: stage[1], step: stage[2] };
  if (!label) {
    if (p.steps.some((s) => s.status === 'blocked'))
      return { status: 'Blocked', tone: 'bad', step: -1 };
    if (p.steps.length && p.steps.every((s) => s.status === 'done'))
      return { status: 'Done', tone: 'ok', step: 6 };
    if (p.steps.some((s) => s.status === 'doing'))
      return { status: 'In progress', tone: 'doing', step: -1 };
    if (p.steps.some((s) => s.status === 'partial'))
      return { status: 'Partly done', tone: 'pending', step: -1 };
    return { status: 'Not started', tone: 'idle', step: -1 };
  }
  const tones: [RegExp, Tone][] = [
    [/chặn|block|lỗi|fail/, 'bad'],
    [/xong|done|merged|shipped/, 'ok'],
    [/review/, 'review'],
    [/wait|chờ|dở|owner|partial/, 'pending'],
    [/test|\bci\b|build|dry/, 'test'],
  ];
  return {
    status: label,
    tone: tones.find(([re]) => re.test(label.toLowerCase()))?.[1] ?? 'doing',
    step: -1,
  };
}

export function stamped(text: string): {
  key: string;
  when: string;
  text: string;
} {
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?\s*:\s*/.exec(
    text,
  );
  if (!m) return { key: '', when: '', text };
  const hour = m[4]?.padStart(2, '0');
  return {
    key: `${m[1]}${m[2]}${m[3]}${hour ? hour + m[5]! : '9999'}`,
    when: `${m[3]}/${m[2]}${hour ? ` ${hour}:${m[5]}` : ''}`,
    text: text.slice(m[0].length),
  };
}

export function buildPlan(p: ParsedPlan, meta: PlanMeta = {}): Plan {
  const where = new Map<ParsedStep, { milestone: string; index: number }>();
  for (const m of p.milestones)
    m.steps.forEach((s, index) => where.set(s, { milestone: m.id, index }));
  const step = (s: ParsedStep, index: number): Step => ({
    ...s,
    milestone: '',
    index,
    ...where.get(s),
  });
  return {
    project: meta.project ?? '',
    projectName: meta.projectName ?? '',
    repo: meta.repo ?? '',
    root: meta.root ?? '',
    gh: meta.gh ?? '',
    name: meta.name ?? '',
    source: meta.source ?? 'legacy',
    workspace: meta.workspace ?? meta.repo ?? '',
    file: meta.file ?? '',
    owner: p.owner,
    goal: p.goal,
    spec: p.spec,
    next: p.next,
    ...statusOf(p),
    mtime:
      typeof meta.mtime === 'string'
        ? meta.mtime
        : (meta.mtime ?? new Date(0)).toISOString(),
    revision: p.revision,
    decisions: p.decisions.map(stamped),
    questions: p.questions.map((q) => {
      const d = stamped(q.ask);
      return {
        key: d.key,
        when: d.when,
        ask: d.text,
        answer: q.open ? '' : q.answer,
        open: q.open,
      };
    }),
    milestones: p.milestones.map((m) => ({
      id: m.id,
      title: m.title,
      state: m.state,
      summary: m.summary,
      progress: {
        done: m.steps.filter((s) => s.status === 'done').length,
        total: m.steps.length,
      },
      steps: m.steps.map(step),
    })),
    steps: p.steps.map(step),
  };
}

/** Parse a plan into its public overview shape. Byte input preserves revision and UTF-8 semantics. */
export function parsePlan(
  text: string | Uint8Array,
  meta: PlanMeta = {},
): Plan {
  return buildPlan(parseMarkdown(text), meta);
}

export function buildOverview(
  data: Omit<Overview, 'generatedAt'>,
  now = new Date(),
): Overview {
  return {
    generatedAt: now.toISOString(),
    ...data,
    plans: [...data.plans].sort(
      (a, b) => Date.parse(b.mtime) - Date.parse(a.mtime),
    ),
  };
}
