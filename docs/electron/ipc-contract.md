# Typed IPC contract

Baseline: `38c840b`. This replaces the complete HTTP surface and its single SSE stream;
it does not keep an HTTP compatibility server. [Architecture](architecture.md) defines trust,
module ownership and persistence; [parity matrix](parity-matrix.md) provides source anchors.
Channel identifiers use `domain:action`. Storage/DTO field names retain baseline English names;
UI labels use Workspace / Skills / Tasks.

Current implementation uses these 37 public requests plus private `app:renderer-ready`:
Empty request and `{ ready: true }` success, normal sender/payload/Result validation, and no
public bridge method. Preload invokes it after activation listeners attach; main releases
queued activations only after the reader is ready too. Go source references below are historical
design provenance; matching the beta is no longer an acceptance criterion.

The real main registry and preload now use `src/shared/contracts` and the Result/Empty
contract below. The provisional scaffold adapter and its old channel aliases have been removed.
No HTTP compatibility server or second public API is retained.

## Transport and errors

Each request below is an `ipcMain.handle`/`ipcRenderer.invoke` pair. All responses are
`Promise<Result<ResponseType>>`; tables give the inner success type. Empty requests are exactly
`{}`, not `undefined`/null. Payloads are JSON-compatible DTOs, never Buffer/Date/Error or native
objects. ISO dates serialize as strings; byte revisions are lowercase SHA-256. Request schemas
reject unknown keys, prototype-bearing/non-plain values, unsafe numbers and malformed enums.
Schemas validate on the main side before effects and on the outgoing side before crossing IPC.

```ts
type ISOTime = string;
type PlanKey = string; // project/repo/name, or unambiguous legacy repo/name for lookup
type ProjectId = string; // /^[a-z0-9][a-z0-9-]{0,39}$/; configured id cannot be "tasks"
type TargetId = string; // same pattern; look up in config, never derive a path from input id
type Revision = string; // /^[a-f0-9]{64}$/
type Empty = Record<string, never>;
type ErrorCode =
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
interface AppError {
  code: ErrorCode;
  message: string; // plain owner-facing sentence, not a stack/child output
  retryable: boolean;
  correlationId?: string; // local log lookup, no paths or secret
}
type Result<T> = { ok: true; value: T } | { ok: false; error: AppError };
```

Every channel can return INVALID_REQUEST (400 equivalent), FORBIDDEN (403) or INTERNAL (500).
NOT_FOUND replaces 404; READ_ONLY, BUSY, INSIDE_WORKSPACE, REVISION_CHANGED and CONFLICT replace
distinct 409 causes; TIMEOUT replaces 408; UNAVAILABLE replaces 503; REFRESH_FAILED replaces 502;
IO_ERROR covers persistence/native failures. Do not return raw HTTP codes/bodies to React.
Malformed/foreign callers cannot trigger dialogs or log unbounded payloads. Renderer displays
`message` and uses `code`, never message parsing, to choose a confirmation or retry.

All invokes validate sender webContents **and top-level frame and exact trusted UI URL**.
Normal mutation requests are limited to the baseline 8 KiB of UTF-8 JSON, move-legacy to 1 MiB,
update apply/skip to 1 KiB. Validate before any path access. IDs follow their pattern; request
plan keys are bounded to 1024 UTF-8 bytes and resolved from current main state. Filesystem
paths are bounded Windows paths, must contain no NUL, and undergo service-specific checks.
Move key arrays must also fit their total limit; duplicates are processed once. Response sizes
are bounded by collector/store/diff limits rather than a small generic request cap.

Only the following method-specific bridge is exposed conceptually (no generic channel access):
`agentOps.state.get/refresh/onChanged`, `settings.get/set`, `workspaces.add/edit/remove`,
`tasks.moveLegacy/moveAll`, `skills.list/add/edit/removeTarget/diff/install/update/replace/keep/
removeSkill/instructionsOn/instructionsOff`, `plans.archive/recycle`, `shell.pick/cancelPick/
openFolder/openExternal`, `updates.get/check/apply/skip/onChanged`,
`diagnostics.get/copy/dismissCrash`, `app.getInfo/getInstance/open/onActivate`.
Every event method returns an idempotent unsubscribe function and forwards only validated data.

## Shared overview and state DTOs

```ts
type StepStatus = 'todo' | 'doing' | 'done' | 'partial' | 'blocked';
interface Step {
  status: StepStatus;
  text: string;
  line: number;
  milestone: string;
  index: number;
  executors?: string[]; // canonical names from a trailing <!-- Executors: A, B --> comment; absent when none
}
type RunEvent = 'start' | 'progress' | 'done' | 'blocked' | 'stopped';
interface AgentRun {
  runId: string; // lowercase UUID printed by the start report
  agent: string; // canonical (Claude, Codex, Gemini, Antigravity, Cursor, Copilot) or the reported plain name
  coordinator: string; // '' when not reported
  role: 'coordinator' | 'executor';
  event: RunEvent; // the latest event
  active: boolean; // latest event start/progress within the last 12 hours, as of collection
  startedAt: ISOTime;
  updatedAt: ISOTime;
  step: { line: number; text: string; milestone: string } | null; // mapped onto the plan as it is now
  result: string; // latest non-empty result or blocking reason
}
interface Decision {
  key: string;
  when: string;
  text: string;
}
interface Question {
  key: string;
  when: string;
  ask: string;
  answer: string;
  open: boolean;
}
interface Milestone {
  id: string;
  title: string;
  state: StepStatus | '';
  summary: string;
  progress: { done: number; total: number };
  steps: Step[];
}
interface Plan {
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
  agent?: string; // canonical name from the Agent: header; absent when none
  runs?: AgentRun[]; // reported runs, newest first, at most 50; absent when none
}
interface ProjectResult {
  id: string;
  name: string;
  path: string;
  kind: 'repo' | 'folder' | 'tasks';
  status: 'ok' | 'missing' | 'error';
  message: string;
  repos: number;
  plans: number;
}
interface Repo {
  project: string;
  name: string;
  root: string;
  gh: string;
  plans: number;
  worktrees: { path: string; branch: string }[];
}
interface PlanDiagnostic {
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
interface Overview {
  generatedAt: ISOTime;
  projects: ProjectResult[];
  repos: Repo[];
  plans: Plan[];
  diagnostics: PlanDiagnostic[];
}
// Baseline initial/no-source envelopes can omit repos/diagnostics/generatedAt.
// Tolerate these only on retained old input; new collector output is Overview.
type OverviewSnapshot =
  | Overview
  | {
      plans: [];
      generatedAt?: ISOTime;
      projects?: ProjectResult[];
      repos?: [];
      diagnostics?: [];
    };
type ActivityKind =
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
  | 'run-started' // actor: the agent; text: the step or 'Cả plan'; extra: the result
  | 'run-finished' // done or stopped
  | 'run-blocked';
interface Activity {
  ts: ISOTime;
  project?: string;
  repo: string;
  plan: string;
  kind: ActivityKind;
  text: string;
  extra?: string;
  actor: string;
}
interface ProjectSummary {
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
interface CrashNotice {
  time: ISOTime;
  kind: string;
  version: string;
  count: number;
}
interface StateResponse {
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
```

Normal collector arrays are always arrays and normal overview strings are always present, even
when empty. Retained old snapshots may lack newly added fields; normalize them without inventing
progress. `Activity.actor` is preserved file-owner/display context, never inferred agent attribution;
for the run kinds it is the agent that reported the run.

Agent fields come from the plan file (`Agent:`, `<!-- Executors: ... -->`) and from run reports the
agents write with `agent-ops.exe --report` (`<data folder>/runs/<runId>.jsonl`, one JSON object per
line, append-only). Runs match a plan by its `file`, case-insensitively, so a moved plan does not take
its runs along. `executors` and the Executors comment never change step text, plan keys or activity.
Unreadable run lines are skipped and listed as an `unreadable` plan diagnostic; a run file that names
no readable plan is one diagnostic without a plan. A report changes `runs` without changing the plan's
`revision`, so a renderer that reuses plans by revision must also compare `runs`. The app never assigns
work and never derives a step's status from runs.
Plan `status` and milestone `state` are recorded/derived under baseline parser rules; completion
does not replace an explicit stage. The renderer never uses `file`, `root` or Git metadata as a
native command authority. `generation` is transport metadata, not written into legacy overview files.

## Settings, config and Tasks DTOs

```ts
type Theme = 'system' | 'light' | 'dark';
interface Project {
  id: ProjectId;
  path: string;
  name: string;
  kind: 'repo' | 'folder';
  enabled: boolean;
  addedAt: ISOTime;
}
interface RepoInfo {
  name: string;
  path: string;
  hasTasks: boolean;
  planCount: number;
}
interface SettingsProject extends Project {
  exists: boolean;
  error?: string;
  repos: RepoInfo[];
}
interface Settings {
  setupRequired: boolean;
  setupComplete: boolean;
  notifications: boolean;
  theme: Theme;
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
interface SettingsPatch {
  notifications?: boolean;
  setupComplete?: boolean;
  startWithWindows?: boolean;
  theme?: Theme;
  shortcuts?: boolean;
  autoArchiveDone?: boolean;
  tasksDir?: string;
  allowInsideWorkspace?: boolean;
  moveExisting?: boolean;
}
interface PlanMove {
  key: PlanKey;
  from: string;
  to: string;
  ok: boolean;
  error?: string;
}
interface MoveReport {
  results: PlanMove[];
  moved: number;
  failed: number;
  backup: string;
}
type SettingsSetResponse = Settings &
  Partial<MoveReport> & { moveError?: string };
type MoveResponse = MoveReport & { settings: Settings };
interface WorkspaceAddResponse {
  project: Project;
  kind: 'repo' | 'folder';
  name: string;
  repos: RepoInfo[];
  settings: Settings;
}
```

| Channel             | Request TypeScript type                               | Success response           | Additional errors and semantics                                                                                                                                                                                                                | Baseline HTTP/source                                   |
| ------------------- | ----------------------------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `state:get`         | `Empty`                                               | `StateResponse`            | Always returns retained data plus `error`/warnings; no collector run.                                                                                                                                                                          | GET `/api/state`, `main.go:1282`                       |
| `state:refresh`     | `Empty`                                               | `{ refreshedAt: ISOTime }` | UNAVAILABLE while restarting; REFRESH_FAILED on collector failure, with retained state still available. Concurrent UI refreshes share a request.                                                                                               | POST `/api/refresh`, `refresh.go:8`                    |
| `settings:get`      | `Empty`                                               | `Settings`                 | Derived availability, counts, override/read-only information.                                                                                                                                                                                  | GET `/api/settings`, `settings.go:511`                 |
| `settings:set`      | `SettingsPatch`                                       | `SettingsSetResponse`      | READ_ONLY, IO_ERROR, UNAVAILABLE; CONFLICT if startup unmanaged; INSIDE_WORKSPACE requires explicit resubmission with `allowInsideWorkspace: true`; CONTAINS_WORKSPACE when the folder holds a workspace; BUSY for a move.                                                                           | PUT `/api/settings`, `settings.go:520`, `tasks.go:579` |
| `workspaces:add`    | `{ path: string }`                                    | `WorkspaceAddResponse`     | INVALID_REQUEST for missing/unreadable/overlapping folder, READ_ONLY for override/newer config, IO_ERROR, UNAVAILABLE. Stable ID generated in main.                                                                                            | POST `/api/projects`, `settings.go:604`                |
| `workspaces:edit`   | `{ id: ProjectId; name?: string; enabled?: boolean }` | `Settings`                 | NOT_FOUND, READ_ONLY, IO_ERROR, UNAVAILABLE; name trimmed, 1–120 UTF-8 bytes and no controls.                                                                                                                                                  | PATCH `/api/projects/<id>`, `settings.go:657`          |
| `workspaces:remove` | `{ id: ProjectId }`                                   | `Settings`                 | NOT_FOUND, READ_ONLY, IO_ERROR, UNAVAILABLE; removes configuration only, not any source folder.                                                                                                                                                | DELETE `/api/projects/<id>`, `settings.go:657`         |
| `tasks:move-legacy` | `{ keys?: PlanKey[] }`                                | `MoveResponse`             | BUSY, READ_ONLY, UNAVAILABLE; CONFLICT if no Tasks folder/cannot create it; IO_ERROR if backup cannot start. Unknown keys and file failures are **successful reports** with failed rows. Missing keys selects all; `[]` selects none.          | POST `/api/tasks/move-legacy`, `tasks.go:416`          |
| `tasks:move-all`    | `{ from: string }`                                    | `MoveResponse`             | INVALID_REQUEST unless `from` is previousTasksDir; BUSY, READ_ONLY, UNAVAILABLE, CONFLICT on overlap/unreadable old folder, IO_ERROR for backup. File failures stay in report.                                                                 | POST `/api/tasks/move-all`, `tasks.go:479`             |
| `plans:archive`     | `{ key: PlanKey; archived: boolean }`                 | `Settings`                 | NOT_FOUND, READ_ONLY, IO_ERROR, UNAVAILABLE; archive true/false is an explicit config override.                                                                                                                                                | POST `/api/plan-actions/archive`, `plan_actions.go:26` |
| `plans:recycle`     | `{ key: PlanKey; revision: Revision; confirm: true }` | `{ recycled: true }`       | NOT_FOUND for missing plan/file, REVISION_CHANGED for changed bytes/identity, CONFLICT for locked/redirected/unsafe/non-recyclable file, UNAVAILABLE during restart. Main resolves from configuration and accepted plan; never accepts a path. | POST `/api/plan-actions/recycle`, `plan_actions.go:26` |
| `plans:mark-done` | `{ key: PlanKey; revision: Revision }` | `MarkDoneResponse` | READ_ONLY, BUSY, UNAVAILABLE; NOT_FOUND for a missing plan/file; REVISION_CHANGED ("This plan changed. Look again before marking it Done.") when the board revision or the file bytes differ, also when re-checked just before the rename; CONFLICT for no top `Status:` line, a locked/redirected/unsafe file; IO_ERROR when the backup cannot be saved. Already Done: `changed: false`, `undo: null`, no write. Main resolves from configuration and the accepted plan; never accepts a path. | none (owner decision 2026-11-11) |
| `plans:undo-mark-done` | `{ key: PlanKey; token: string }` | `UndoMarkDoneResponse` | READ_ONLY, BUSY, UNAVAILABLE; CONFLICT when the token is unknown, used, for another plan or older than 2 minutes; REVISION_CHANGED when the file no longer holds exactly what Mark as Done wrote. Restores the original bytes only. | none (owner decision 2026-11-11) |

`settings:set` is not a distributed transaction: baseline applies Tasks and optional move before
other fields. A valid new Tasks folder remains saved if its move cannot begin (`moveError`) or
some files fail. The baseline can also have committed Tasks before rejecting another field;
callers should send Tasks changes separately from ordinary preferences/startup, then refetch
after any error. A pointer-sync failure leaves saved config intact and is logged; startup will
retry. Do not promise that a saved folder guarantees all environment consumers have refreshed.

Move service reads once, backs up bytes before effects, creates destination exclusively, retains
mtime and checks source again before removal. A changed/failed source stays in place and the new
copy is removed; the backup stays. No overwrite, source-path injection, links outside the root,
or arbitrary `from` folder is allowed. Choosing a new folder without move stops reading the old
folder. Clear previousTasksDir only when it has no remaining plans.

Mark as Done is the one plan edit (owner decision 2026-11-11). Main finds the top Status line as the
reader does (the first `Status:` header line before the first level-2 to level-4 heading, outside fenced
code; `Trạng thái:` only without one) and replaces its value with `Done` on the raw bytes, so the BOM,
line endings, spacing and every other byte stay. Before writing it copies the original to
`<dataDir>\backups\plan-edits\<UTC time>-<id>\<workspace>\<plan>.md` and keeps the newest 50 such
folders; the write is atomic. It records one `status` activity entry, "Marked Done in Agent Ops", with
actor `Agent Ops`, and refreshes the ledger before replying. Undo tokens live in memory only.

```ts
interface MarkedPlan {
  key: PlanKey;
  status: string; // the Status value now in the file
  revision: Revision;
}
interface MarkDoneResponse {
  plan: MarkedPlan;
  changed: boolean; // false when already Done; nothing written
  undo: { token: string; expiresAt: ISOTime } | null; // token: 32 hex characters, valid 2 minutes
}
interface UndoMarkDoneResponse {
  plan: MarkedPlan;
}
```

## Skills/integrations DTOs and channels

```ts
interface IntegrationTarget {
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
interface AppConfig {
  version: 1;
  setupComplete: boolean;
  projects: Project[];
  tasksDir?: string;
  previousTasksDir?: string;
  notifications: boolean;
  theme?: Theme | '';
  shortcuts: boolean;
  autoArchiveDone: boolean;
  planArchive?: Record<PlanKey, boolean>;
  pickerDirectory?: string;
  integrations?: IntegrationTarget[];
  integrationsSeeded?: boolean;
}
type SkillState =
  | 'missing-folder'
  | 'not-installed'
  | 'installed'
  | 'update-available'
  | 'modified';
type InstructionState =
  'none' | 'missing-folder' | 'off' | 'on' | 'outdated' | 'modified';
interface TargetStatus {
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
interface IntegrationSuggestion {
  client: 'claude' | 'codex' | 'gemini' | 'orca';
  label: string;
  skillDir: string;
  instructionFile?: string;
}
interface ClientWrite {
  file: string;
  backup?: string;
  before?: string;
  after?: string;
}
interface MigrationResult {
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
interface SkillsResponse {
  skillVersion: number;
  targets: TargetStatus[];
  suggestions: IntegrationSuggestion[];
  migration: MigrationResult | null;
  readOnly: string;
  added?: TargetId;
}
interface TargetInput {
  skillDir?: string;
  instructionFile?: string;
  label?: string;
  enabled?: boolean;
}
interface SkillDiff {
  path: string;
  identical: boolean;
  lines: { op: ' ' | '-' | '+'; text: string }[];
}
```

Target-list removal and skill-file removal are different actions. The target list can be edited
without installing a file. Disabled targets still allow remove-skill and instructions-off.

| Channel                   | Request TypeScript type              | Success response                | Additional errors                                                                                                                              | Baseline HTTP/source                                                  |
| ------------------------- | ------------------------------------ | ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| `skills:list`             | `Empty`                              | `SkillsResponse`                | No installs/detection writes.                                                                                                                  | GET `/api/integrations`, `integrations.go:851`                        |
| `skills:add`              | `TargetInput & { skillDir: string }` | `SkillsResponse` (with `added`) | INVALID_REQUEST for path/label/duplicate; READ_ONLY, IO_ERROR, UNAVAILABLE.                                                                    | POST `/api/integrations`, `integrations.go:665`                       |
| `skills:edit`             | `TargetInput & { id: TargetId }`     | `SkillsResponse`                | NOT_FOUND, INVALID_REQUEST, CONFLICT while changing instructionFile with reminder on; READ_ONLY, IO_ERROR, UNAVAILABLE.                        | PATCH `/api/integrations/<id>`, `integrations.go:708`                 |
| `skills:remove-target`    | `{ id: TargetId }`                   | `SkillsResponse`                | NOT_FOUND, CONFLICT if reminder on; READ_ONLY, IO_ERROR, UNAVAILABLE. Leaves files.                                                            | DELETE `/api/integrations/<id>`, `integrations.go:756`                |
| `skills:diff`             | `{ id: TargetId }`                   | `SkillDiff`                     | NOT_FOUND, CONFLICT if unreadable/linked. Escaped line diff of on-disk skill vs bundled canonical skill.                                       | GET `/api/integrations/<id>/diff`, `integrations.go:917`              |
| `skills:install`          | `{ id: TargetId }`                   | `SkillsResponse`                | NOT_FOUND, READ_ONLY, CONFLICT, IO_ERROR, UNAVAILABLE.                                                                                         | POST `/api/integrations/<id>/install`, `integrations.go:351`          |
| `skills:update`           | `{ id: TargetId }`                   | `SkillsResponse`                | Same as install; requires managed/unmodified bytes.                                                                                            | POST `/api/integrations/<id>/update`, `integrations.go:351`           |
| `skills:replace`          | `{ id: TargetId }`                   | `SkillsResponse`                | Same errors; explicit replacement accepts locally modified content but still rechecks bytes, backs up and rejects linked/in-workspace targets. | POST `/api/integrations/<id>/replace`, `integrations.go:351`          |
| `skills:keep`             | `{ id: TargetId }`                   | `SkillsResponse`                | Same errors; only a readable locally modified skill can be kept; records its hash without changing it.                                         | POST `/api/integrations/<id>/keep`, `integrations.go:351`             |
| `skills:remove-skill`     | `{ id: TargetId }`                   | `SkillsResponse`                | Same errors; modified files are refused, only managed file and now-empty task-plan directory removed.                                          | POST `/api/integrations/<id>/remove`, `integrations.go:351`           |
| `skills:instructions-on`  | `{ id: TargetId }`                   | `SkillsResponse`                | Same errors; no selected instruction file, missing parent, malformed/modified marker block conflict.                                           | POST `/api/integrations/<id>/instructions-on`, `integrations.go:442`  |
| `skills:instructions-off` | `{ id: TargetId }`                   | `SkillsResponse`                | Same errors; preserves outside text and refuses changed managed block.                                                                         | POST `/api/integrations/<id>/instructions-off`, `integrations.go:442` |

Main checks real paths and file identity (including junctioned parents). Skills live outside all
workspaces; instruction files are plain `.md` files, not links, with existing writable parents,
not shared by two targets. Labels are trimmed, 1–80 Unicode code points, no controls. Changing
skillDir retains hashes and leaves the old copy on disk. A reminder must be off before changing
instructionFile/removing the target. LF-normalized content determines skill/block hashes;
raw bytes determine final optimistic concurrency. Every client overwrite/removal backs up first,
re-reads just before atomic replace/delete, and preserves unrelated text/BOM/line endings where
applicable. A config-save failure after a file effect is reported; do not silently claim rollback.

## Desktop and diagnostics

```ts
type PickPurpose = 'workspace' | 'skills' | 'tasks' | 'instruction-file';
interface PickRequest {
  requestId: string;
  purpose: PickPurpose;
}
type PickResponse =
  { path: string; cancelled?: never } | { cancelled: true; path?: never };
type OpenFolderRequest =
  | { target: 'data' | 'logs' | 'tasks' }
  | { target: 'project'; id: ProjectId }
  | { target: 'plan'; key: PlanKey };
type OpenExternalRequest =
  | { target: 'release'; version: string }
  | { target: 'pull-request'; key: PlanKey; number: number };
```

| Channel                     | Request TypeScript type | Success response                                          | Additional errors / constraints                                                                                                                               | Baseline HTTP/source                                                                                                |
| --------------------------- | ----------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `shell:pick`                | `PickRequest`           | `PickResponse`                                            | BUSY, TIMEOUT, IO_ERROR; requestId bounded ASCII token (1–64), scoped to sender; owner-window dialog, two-minute deadline, cancellation is successful result. | POST `/api/settings/pick-folder`, `settings.go:704`; baseline absent/empty purpose becomes workspace                |
| `shell:cancel-pick`         | `{ requestId: string }` | `{ cancelled: boolean }`                                  | May cancel only sender's active dialog; no-op false if already settled. Complete only after adapter confirms closure.                                         | New IPC equivalent of HTTP request abort, `shell_windows.go:146`                                                    |
| `shell:open-folder`         | `OpenFolderRequest`     | `{ opened: true }`                                        | NOT_FOUND for unknown/missing folder, IO_ERROR for Explorer; logs directory may be created first. No raw path accepted.                                       | POST `/api/settings/open-folder`, `settings.go:747`; this is also **Open logs folder**, no log-read endpoint exists |
| `shell:open-external`       | `OpenExternalRequest`   | `{ opened: true }`                                        | NOT_FOUND for unavailable plan/release; INVALID_REQUEST for invalid positive PR number/stable tag; main builds fixed HTTPS GitHub URL.                        | Existing PR and release-note anchors, `web/index.html:862,1610`; new bridge for external opening                    |
| `diagnostics:get`           | `Empty`                 | `{ text: string }`                                        | Redacted text, no paths/prose. Runtime versions become Electron/Chromium/Node, not Go.                                                                        | GET `/api/diagnostics`, `diagnostics.go:121`                                                                        |
| `diagnostics:copy`          | `Empty`                 | `{ copied: true }`                                        | IO_ERROR; main generates same redacted text and calls clipboard.writeText. Does not accept arbitrary text.                                                    | New bridge for renderer clipboard action, `web/index.html:1928`; test coverage in `web_test.mjs:733`                |
| `diagnostics:dismiss-crash` | `Empty`                 | `{ dismissed: true }`                                     | IO_ERROR removing marker; emits state invalidation.                                                                                                           | POST `/api/diagnostics/dismiss-crash`, `diagnostics.go:130`                                                         |
| `app:get-info`              | `Empty`                 | `{ version: string; dataDir: string; platform: 'win32'; sampleModeAllowed?: boolean }` | Scaffold application information; no file read requested by renderer.                                                                                         | New scaffold `app:getInfo` at `a737966:src/shared/ipc.ts`                                                           |
| `app:get-instance`          | `Empty`                 | `{ pid: number; version: string }`                        | Local renderer only; installer health uses a private receipt, never invokes renderer IPC remotely.                                                            | GET `/api/instance`, `instance.go:227`                                                                              |
| `app:open`                  | `{ plan?: PlanKey }`    | `{ pid: number }`                                         | Invalid/unknown plan retains unavailable-plan route; empty opens Overview. Does not accept URLs or executable arguments.                                      | POST `/api/instance/open`, `instance.go:234`                                                                        |

Picked paths are choices, not authorization to write: the destination service validates again.
Open-folder uses `shell.openPath` and must treat its nonempty result string as an error. External
open uses `shell.openExternal` in main only. Keep the scaffold's trusted-primary-click preload
listener: translate allowed PR/release anchors to the discriminated target request and validate
again in main; do not preserve its arbitrary `{url}` request or expose a generic URL opener.
`agent-ops:open?plan=<encoded key>` is an OS activation,
parsed by main's protocol/second-instance handler with one bounded plan parameter; no commands,
file path or arbitrary URL is executed. Notification clicks activate the existing window directly.

## Update DTOs and channels

```ts
type UpdatePhase =
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'restarting'
  | 'updated'
  | 'error';
interface UpdateState {
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
```

| Channel         | Request TypeScript type | Success response | Additional errors / behavior                                                                                                                         | Baseline HTTP/source                           |
| --------------- | ----------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `updates:get`   | `Empty`                 | `UpdateState`    | UNAVAILABLE if updater not initialized; ordinary availability/error state is a successful DTO.                                                       | GET `/api/updates`, `update.go:748`            |
| `updates:check` | `Empty`                 | `UpdateState`    | BUSY if an operation is active; UNAVAILABLE; starts async check, returns checking (202 equivalent).                                                  | POST `/api/updates/check`, `update.go:763`     |
| `updates:apply` | `{ version: string }`   | `UpdateState`    | BUSY, UNAVAILABLE, CONFLICT unless the currently offered newer stable version matches; starts download/verify/install/restart, returns accepted DTO. | POST `/api/updates/apply`, `update.go:408,763` |
| `updates:skip`  | `{ version: string }`   | `UpdateState`    | BUSY, CONFLICT unless current offered version matches, IO_ERROR saving update-preferences.json, UNAVAILABLE.                                         | POST `/api/updates/skip`, `update.go:388,763`  |

Stable versions use `vMAJOR.MINOR.PATCH` with no leading zeroes; normalize Electron semver to the
compatible display/tag form in the adapter. Development/prerelease versions never auto-offer a
stable upgrade by guessing. No feed/token/download URL is accepted over IPC. A test feed is
injected only at isolated launch. Updater events are normalized to the above phases; do not expose
downloaded executable paths, raw error objects or HTML release notes. Error/skip/dismiss/minimize
and explicit restart behavior follow architecture; automatic Go rollback is dropped.

## Main-to-renderer events and resynchronization

```ts
interface EventMap {
  'state:changed': { generation: number };
  'settings:changed': Settings;
  'updates:changed': UpdateState;
  'app:activate': {
    plan: PlanKey | null;
    route: 'overview' | 'plan' | 'settings';
  };
}
```

| Baseline stream/action                                                 | Target event and rule                                                                                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/events` unnamed `data: change` (`main.go:1271`)                      | `state:changed`; no plan data in invalidation. Main coalesces repeated changes; renderer calls state:get and accepts newest generation. Settings/refresh/crash changes trigger it.      |
| `/events` `retry: 3000`                                                | Dropped transport control. Electron renderer recovery subscribes again, then gets a complete state/settings/update snapshot.                                                            |
| `/events` comment `: ping` every 25 seconds                            | Dropped transport keepalive. No fake activity/notification event; renderer fallback reads state every 30 seconds.                                                                       |
| Update UI polls `/api/updates` (there is **no update SSE event**)      | `updates:changed` is a target extension; also call updates:get initially and after recreation. Event DTO equals get response.                                                           |
| Settings updates invalidate state in Go; scaffold has a settings event | Keep `settings:changed` with full Settings after a committed settings change; paired state invalidations still refetch state. Settings consumers subscribe before initial settings:get. |
| Instance open, toast/protocol and tray Settings activation             | `app:activate`, queued until trusted top frame finishes loading; renderer routes then focuses. The second-instance path calls the same main service directly.                           |

Activity kinds are persisted state entries, **not** independent IPC channels or baseline SSE event
names. Event subscriptions have no renderer-selected topic, arbitrary payload or generic IPC
event object. Main sends only to registered UI webContents and removes listeners on destruction.
Subscribe before fetching to avoid missed changes, serialize/refetch when an invalidation arrives
during a fetch, and always fetch a new snapshot after a main-process restart.

## HTTP paths with no IPC equivalent

`GET/HEAD /`, `/icons/*`, `/fonts/*` become packaged protocol assets (unknown assets fail closed).
`/open` is the retired one-time cookie exchange. `/events` is replaced as above. Method errors
and security failures are transport validation, not additional channels. Unknown `/api/*` routes
remain unavailable; specifically do not restore plan status writes, drag/drop updates, execution,
agent assignment or retired run endpoints. Uninstall is an NSIS owner action, not an app IPC
channel. It uses the same guarded Skills cleanup service when explicitly selected, retains data
by default and never removes Tasks plans.
