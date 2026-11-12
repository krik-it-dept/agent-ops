export type ISOTime = string;
export type PlanKey = string; // project/repo/name, or unambiguous legacy repo/name for lookup
export const PLAN_STATES = [
  'Planning',
  'Implementing',
  'Reviewing',
  'Fixing review',
  'Testing',
  'Waiting for CI',
  'Waiting for owner',
  'Shipping',
  'Blocked',
  'Done',
] as const;
export type PlanState = (typeof PLAN_STATES)[number];
export type ProjectId = string; // /^[a-z0-9][a-z0-9-]{0,39}$/; configured id cannot be "tasks"
export type TargetId = string; // same pattern; look up in config, never derive a path from input id
export type Revision = string; // /^[a-f0-9]{64}$/
export type Empty = Record<string, never>;
export type ErrorCode =
  | 'INVALID_REQUEST'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'READ_ONLY'
  | 'BUSY'
  | 'INSIDE_WORKSPACE'
  | 'CONTAINS_WORKSPACE'
  | 'REVISION_CHANGED'
  | 'UNAVAILABLE'
  | 'TIMEOUT'
  | 'IO_ERROR'
  | 'REFRESH_FAILED'
  | 'INTERNAL';
export interface AppError {
  code: ErrorCode;
  message: string; // plain owner-facing sentence, not a stack/child output
  retryable: boolean;
  correlationId?: string; // local log lookup, no paths or secret
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };

export type StepStatus =
  'todo' | 'doing' | 'done' | 'partial' | 'blocked' | 'waiting';
export interface Step {
  status: StepStatus;
  text: string;
  line: number;
  milestone: string;
  index: number;
  /** Agents named in the step's `<!-- Executors: A, B -->` comment (also `Executor:`); canonical names. */
  executors?: string[];
}
/** The lifecycle event an agent reported for one run of work. */
export type RunEvent = 'start' | 'progress' | 'done' | 'blocked' | 'stopped';
/**
 * AgentRun is one run of work an agent reported for a plan (through the report
 * command), summarised by its latest event. Agents record runs; the app only
 * reads them and never assigns work.
 */
export interface AgentRun {
  runId: string;
  /** Canonical agent name (Claude, Codex, Gemini, Antigravity, Cursor, Copilot) or the reported name. */
  agent: string;
  /** The coordinating agent, '' when not reported. */
  coordinator: string;
  role: 'coordinator' | 'executor';
  /** The latest event of the run. */
  event: RunEvent;
  /** Latest event is start or progress and is recent enough to count as working now. */
  active: boolean;
  startedAt: ISOTime;
  updatedAt: ISOTime;
  /** The checklist step the run worked on, when reported. */
  step: { line: number; text: string; milestone: string } | null;
  /** The latest reported result or blocking reason, plain text. */
  result: string;
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
export interface Milestone {
  id: string;
  title: string;
  state: StepStatus | '';
  summary: string;
  progress: { done: number; total: number };
  steps: Step[];
}
export interface Plan {
  project: string;
  projectName: string;
  repo: string;
  root: string;
  gh: string;
  name: string;
  owner: string;
  goal: string;
  spec: string;
  next: string;
  status: string;
  tone: 'doing' | 'review' | 'test' | 'pending' | 'bad' | 'ok' | 'idle';
  step: number;
  mtime: ISOTime;
  revision: Revision;
  decisions: Decision[];
  questions: Question[];
  milestones: Milestone[];
  steps: Step[];
  source: 'tasks' | 'legacy';
  workspace: string;
  file: string;
  /** The coordinating agent from the plan's `Agent:` line, '' when absent. */
  agent?: string;
  /** Reported runs for this plan, newest first. */
  runs?: AgentRun[];
}
export interface ProjectResult {
  id: string;
  name: string;
  path: string;
  kind: 'repo' | 'folder' | 'tasks';
  status: 'ok' | 'missing' | 'error';
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
  worktrees: { path: string; branch: string }[];
}
export interface PlanDiagnostic {
  project: string;
  repo: string;
  plan: string;
  file: string;
  kind:
    | 'unreadable'
    | 'too-large'
    | 'invalid-utf8'
    | 'unclosed-fence'
    | 'folder-unreadable'
    | 'duplicate';
  message: string;
}
export interface Overview {
  generatedAt: ISOTime;
  projects: ProjectResult[];
  repos: Repo[];
  plans: Plan[];
  diagnostics: PlanDiagnostic[];
}
// Baseline initial/no-source envelopes can omit repos/diagnostics/generatedAt.
// Tolerate these only on retained old input; new collector output is Overview.
export type OverviewSnapshot =
  | Overview
  | {
      plans: [];
      generatedAt?: ISOTime;
      projects?: ProjectResult[];
      repos?: [];
      diagnostics?: [];
    };
export type ActivityKind =
  | 'new'
  | 'closed'
  | 'moved'
  | 'status'
  | 'done'
  | 'doing'
  | 'blocked'
  | 'partial'
  | 'decision'
  | 'question'
  | 'answer'
  | 'milestone'
  | 'waiting'
  | 'stale'
  /** An agent reported a run start (text: the step, extra: the result so far, actor: the agent). */
  | 'run-started'
  /** An agent reported a run done or stopped (extra: its result). */
  | 'run-finished'
  /** An agent reported a run blocked (extra: what blocks it). */
  | 'run-blocked';
export interface Activity {
  ts: ISOTime;
  project?: string;
  repo: string;
  plan: string;
  kind: ActivityKind;
  text: string;
  extra?: string;
  actor: string;
}
export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  kind: 'repo' | 'folder';
  enabled: boolean;
  status: 'ok' | 'missing' | 'error' | 'disabled' | 'pending';
  message?: string;
  repos: number;
  plans: number;
}
export interface CrashNotice {
  time: ISOTime;
  kind: string;
  version: string;
  count: number;
}
export interface StateResponse {
  generation: number; // new monotonically increasing in-process publication id
  appVersion: string;
  state: OverviewSnapshot;
  activity: Activity[];
  now: ISOTime;
  error: string;
  stale: Record<PlanKey, boolean>;
  setupRequired: boolean;
  projects: ProjectSummary[];
  warnings: string[];
  crash: CrashNotice | null;
  planArchive: Record<PlanKey, boolean> | null;
}

export type Theme = 'system' | 'light' | 'dark';
export type TextSize = 'small' | 'default' | 'large' | 'larger';
export interface Project {
  id: ProjectId;
  path: string;
  name: string;
  kind: 'repo' | 'folder';
  enabled: boolean;
  addedAt: ISOTime;
}
export interface RepoInfo {
  name: string;
  path: string;
  hasTasks: boolean;
  planCount: number;
}
export interface SettingsProject extends Project {
  exists: boolean;
  error?: string;
  repos: RepoInfo[];
}
export interface Settings {
  setupRequired: boolean;
  setupComplete: boolean;
  notifications: boolean;
  theme: Theme;
  textSize: TextSize;
  shortcuts: boolean;
  autoArchiveDone: boolean;
  planArchive: Record<PlanKey, boolean> | null;
  startWithWindows: boolean;
  startupManaged: boolean;
  dataDir: string;
  configFile: string;
  tasksDir: string;
  tasksDirSuggested: string;
  legacyPlanCount: number;
  previousTasksDir: string;
  previousPlanCount: number;
  projectsOverridden: string;
  warning: string;
  readOnly: string;
  version: string;
  projects: SettingsProject[];
}
export interface SettingsPatch {
  notifications?: boolean;
  setupComplete?: boolean;
  startWithWindows?: boolean;
  theme?: Theme;
  textSize?: TextSize;
  shortcuts?: boolean;
  autoArchiveDone?: boolean;
  tasksDir?: string;
  allowInsideWorkspace?: boolean;
  moveExisting?: boolean;
}
export interface PlanMove {
  key: PlanKey;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}
export interface MoveReport {
  results: PlanMove[];
  moved: number;
  failed: number;
  backup: string;
}
export type SettingsSetResponse = Settings &
  Partial<MoveReport> & { moveError?: string };
export type MoveResponse = MoveReport & { settings: Settings };
export interface WorkspaceAddResponse {
  project: Project;
  kind: 'repo' | 'folder';
  name: string;
  repos: RepoInfo[];
  settings: Settings;
}

export interface IntegrationTarget {
  id: TargetId;
  label: string;
  skillDir: string;
  instructionFile?: string;
  instructionBlock: boolean;
  enabled: boolean;
  source: 'detected' | 'custom';
  addedAt?: ISOTime;
  version?: number;
  sha256?: string;
  installedAt?: ISOTime;
  kept?: string;
  instructionSha256?: string;
  legacySha256?: string;
}
export interface AppConfig {
  version: 1;
  setupComplete: boolean;
  projects: Project[];
  tasksDir?: string;
  previousTasksDir?: string;
  notifications: boolean;
  theme?: Theme | '';
  textSize?: TextSize;
  shortcuts: boolean;
  autoArchiveDone: boolean;
  planArchive?: Record<PlanKey, boolean>;
  pickerDirectory?: string;
  integrations?: IntegrationTarget[];
  integrationsSeeded?: boolean;
}
export type SkillState =
  | 'missing-folder'
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'modified';
export type InstructionState =
  'none' | 'missing-folder' | 'off' | 'on' | 'outdated' | 'modified';
export interface TargetStatus {
  id: TargetId;
  label: string;
  skillDir: string;
  skillFile: string;
  enabled: boolean;
  source: 'detected' | 'custom';
  state: SkillState;
  installedVersion: number;
  kept: boolean;
  instructions: { path: string; state: InstructionState; line: string };
}
export interface IntegrationSuggestion {
  client: 'claude' | 'codex' | 'gemini' | 'orca';
  label: string;
  skillDir: string;
  instructionFile?: string;
}
export interface ClientWrite {
  file: string;
  backup?: string;
  before?: string;
  after?: string;
}
export interface MigrationResult {
  version: number;
  at: ISOTime;
  done: boolean;
  backup: string;
  attempts?: number;
  nextRetryAt?: ISOTime;
  configCopied?: boolean;
  hooksRemoved?: string[];
  blocksRemoved?: string[];
  skillsReplaced?: string[];
  kept?: string[];
  deleted?: string[];
  checklist?: { file: string; line: number; text: string }[];
  errors?: string[];
  writes?: ClientWrite[];
  previous?: MigrationResult[];
}
export interface SkillsResponse {
  skillVersion: number;
  targets: TargetStatus[];
  suggestions: IntegrationSuggestion[];
  migration: MigrationResult | null;
  readOnly: string;
  added?: TargetId;
}
export interface TargetInput {
  skillDir?: string;
  instructionFile?: string;
  label?: string;
  enabled?: boolean;
}
export interface SkillDiff {
  path: string;
  identical: boolean;
  lines: { op: ' ' | '-' | '+'; text: string }[];
}

export type PickPurpose = 'workspace' | 'skills' | 'tasks' | 'instruction-file';
export interface PickRequest {
  requestId: string;
  purpose: PickPurpose;
}
export type PickResponse =
  { path: string; cancelled?: never } | { cancelled: true; path?: never };
export type OpenFolderRequest =
  | { target: 'data' | 'logs' | 'tasks' }
  | { target: 'project'; id: ProjectId }
  | { target: 'plan'; key: PlanKey };
export type OpenExternalRequest =
  | { target: 'release'; version: string }
  | { target: 'pull-request'; key: PlanKey; number: number };

export type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'updated'
  | 'error';
export interface UpdateState {
  current: string;
  commit: string;
  processId: number;
  latest: string;
  notes: string;
  available: boolean;
  skipped: boolean;
  phase: UpdatePhase;
  error: string;
  message: string;
  checkedAt: ISOTime | '';
}

export interface EventMap {
  'state:changed': { generation: number };
  'settings:changed': Settings;
  'updates:changed': UpdateState;
  'app:activate': {
    plan: PlanKey | null;
    route: 'overview' | 'plan' | 'settings';
  };
}

/** The plan after Mark as Done or its Undo. */
export interface MarkedPlan {
  key: PlanKey;
  /** The Status value now in the file. */
  status: string;
  revision: Revision;
}
export interface MarkDoneResponse {
  plan: MarkedPlan;
  /** False when the plan was already Done and nothing was written. */
  changed: boolean;
  /** Present when the file was changed; valid for 2 minutes. */
  undo: { token: string; expiresAt: ISOTime } | null;
}
export interface UndoMarkDoneResponse {
  plan: MarkedPlan;
}
