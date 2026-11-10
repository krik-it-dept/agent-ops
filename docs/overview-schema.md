# Overview schema

The plan reader (`src/main/modules/plans`, run in a worker thread of the app's main process) reads the plans of
the Tasks folder (`<Tasks folder>\<workspace>\*.md`) and the legacy `.tasks/*.md` plans of every enabled
workspace, and produces one overview. The window receives it as `state` from the `state:get` request (see the
[IPC contract](electron/ipc-contract.md)); the app keeps the last one in `<data folder>\overview.json`, an
internal file replaced atomically.

The frozen fixtures in `tests/fixtures/plans` pin this contract.

All fields are always present. Strings are empty, not missing, when a plan has no value.

## Top level

| Field | Type | Meaning |
| --- | --- | --- |
| `generatedAt` | string | Time of the read, `YYYY-MM-DDTHH:MM:SS.mmmZ` (UTC). |
| `projects` | array of [Project](#project) | One entry per enabled project, in Settings order; first an entry for the Tasks folder when one is chosen. |
| `repos` | array of [Repo](#repo) | **New.** Every repository found, with its Git worktrees, plans or not. |
| `plans` | array of [Plan](#plan) | Every plan read, newest file change first. |
| `diagnostics` | array of [Diagnostic](#diagnostic) | **New.** Problems the collector worked around. Empty when all plans read cleanly. |

## Project

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Project ID from config.json (8 hex characters of the folder path's SHA-256 for a `--repos-dir` run). `tasks` for the Tasks folder; no configured project has this ID. |
| `name` | string | Display name; the path when the project has no name. |
| `path` | string | Project folder. |
| `kind` | string | `repo` (the folder is one repository), `folder` (each subfolder with `.git` or `.tasks` is one) or `tasks` (the Tasks folder; `name` is `Tasks`, `repos` counts its workspace folders). |
| `status` | string | `ok`, or `missing` when the folder cannot be opened (missing, offline drive, no permission, a file). A missing project or Tasks folder is a warning; the refresh still succeeds. |
| `message` | string | For `missing`: `Folder not found.` or `Folder cannot be opened (<code>).` with a code such as `ENOTDIR`, `EACCES`, `EBUSY`. |
| `repos` | number | Repositories found in the project. |
| `plans` | number | Plans read in the project. |

## Repo

| Field | Type | Meaning |
| --- | --- | --- |
| `project` | string | Project ID. |
| `name` | string | Folder name (for a repo project on a drive or share root, the drive letter or share name). |
| `root` | string | Repository folder, with forward slashes. |
| `gh` | string | `https://github.com/<owner>/<repo>` from the `origin` remote, or empty. |
| `plans` | number | Plans read in this repository. |
| `worktrees` | array of `{path, branch}` | From `git worktree list --porcelain`, main checkout first. `path` uses forward slashes; `branch` is the short branch name, empty for a detached HEAD. Bare and prunable entries are left out. Empty when the folder has no `.git`, or Git is missing, fails or takes longer than 5 seconds. |

Git runs read-only (`GIT_OPTIONAL_LOCKS=0`, no prompt), at most 8 repositories at a time; the link and worktrees are
cached for a minute per repository.

## Plan

| Field | Type | Meaning |
| --- | --- | --- |
| `project`, `projectName` | string | Project ID and display name; `tasks` and `Tasks` for a plan in the Tasks folder. |
| `repo`, `root`, `gh` | string | Repository name, folder (forward slashes) and GitHub link, as in [Repo](#repo). For a Tasks-folder plan `repo` is the workspace name, and `root` and `gh` are those of the one configured repository with that name (case-insensitive), empty when there is none or more than one. |
| `name` | string | File name without `.md`. `project/repo/name` identifies a plan: `tasks/<workspace>/<plan>` in the Tasks folder. |
| `source` | string | **New.** `tasks` (the Tasks folder) or `legacy` (a repository's `.tasks` folder). |
| `workspace` | string | **New.** The group a plan belongs to: the Tasks-folder workspace, or the repository name for a legacy plan. |
| `file` | string | **New.** The plan file, with forward slashes. |
| `owner`, `goal`, `spec`, `next` | string | Header fields `Owner:`, `Goal:`, `Spec:`, `Next:` (or the older `Tiếp theo:`). |
| `status` | string | The `Status:` header (or the older `Trạng thái:`). Without one: `Blocked`, `Done`, `In progress`, `Partly done` or `Not started`, derived from the steps. |
| `tone` | string | `doing`, `review`, `test`, `pending`, `bad`, `ok` or `idle`: from the stage the status starts with, else from keywords of a free-text status. |
| `step` | number | Position of the stage on the main path (0 Planning … 6 Done), `-1` when off the path. |
| `mtime` | string | File change time, like `generatedAt`. |
| `revision` | string | SHA-256 (hex) of the file bytes. |
| `decisions` | array of `{key, when, text}` | Items under `## Decisions`; an indented line continues the item above. |
| `questions` | array of `{key, when, ask, answer, open}` | Items under `## Questions`, written `<ask> \| Answer: <answer>`. `open` when the answer is empty or starts with `open`; `answer` is then empty. |
| `milestones` | array of [Milestone](#milestone) | `## M<n>: <title> [state]` sections (levels 2 to 4). |
| `steps` | array of [Step](#step) | Every step of the plan, in file order, inside milestones or not. |

`key` is `YYYYMMDDHHMM` from a leading `YYYY-MM-DD HH:MM:` stamp (`HHMM` is `9999` for a date without time, empty
without a stamp); `when` is `DD/MM HH:MM` or `DD/MM`. The stamp is removed from `text` and `ask`.

### Milestone

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | `M1`, `M2a` … in upper case. |
| `title` | string | Heading text. |
| `state` | string | `todo`, `doing`, `done`, `partial` or `blocked` from `[state]`, else empty. |
| `summary` | string | The `Summary:` line of the section. |
| `progress` | `{done, total}` | **New.** Steps of the milestone that are `done`, and all its steps. |
| `steps` | array of [Step](#step) | The milestone's steps. |

### Step

| Field | Type | Meaning |
| --- | --- | --- |
| `status` | string | `todo`, `doing`, `done`, `partial` or `blocked`. |
| `text` | string | Step text without a time estimate (`~2h`, `~30 phút`) or an old `<!-- Executor: … -->` comment. |
| `line` | number | 1-based line in the file. Identical step texts stay apart by line. |
| `milestone` | string | Milestone ID, empty for a step outside milestones. |
| `index` | number | Position inside the milestone, or inside `steps` for a step outside milestones. |

## Diagnostic

A problem with one plan, a repository's `.tasks` folder or a Tasks-folder workspace that the collector worked around. A diagnostic
never fails the refresh. `state:get` also lists the first five as `warnings`, so a plan left out of the board is never
silently missing.

| Field | Type | Meaning |
| --- | --- | --- |
| `project`, `repo` | string | Where the file is. |
| `plan` | string | Plan name; empty for a folder problem. |
| `file` | string | The file or folder, with forward slashes. |
| `kind` | string | See below. |
| `message` | string | A sentence for the owner. |

| `kind` | The plan is | Cause |
| --- | --- | --- |
| `unreadable` | left out | The file could not be read (locked past the retries, no permission, removed while reading). |
| `too-large` | left out | Over 8 MB. |
| `invalid-utf8` | shown | Not UTF-8; invalid bytes are shown as `�`. |
| `unclosed-fence` | shown | A code fence opens and never closes, so the lines after it are not read. |
| `folder-unreadable` | — | The repository's `.tasks` folder, or a workspace folder of the Tasks folder, could not be listed. |
| `duplicate` | left out | A legacy `.tasks` plan has the same workspace and name (case-insensitive) as a plan in the Tasks folder, which is shown instead. |

## Reading rules

- Lines are split on LF or CRLF; a UTF-8 byte order mark is ignored.
- Header fields are read only from the header block: the lines before the first section heading (`##` and
  deeper), outside code fences. A `# Title` line may stand above the header. The Node collector read them anywhere,
  including inside code fences.
- Nothing inside a code fence (```` ``` ```` or `~~~`, three or more) is read. A fence closes on a line of the same
  character, at least as long, with nothing after it. The Node collector also closed a fence on a line with an
  info string such as ```` ```js ````.
- A step is `[todo|doing|done|partial|blocked] text`, optionally after `-` or `*`, or an older line starting
  with ⬜ 🔄 ✅ ⚠ ❌. GitHub checkboxes (`- [x]`) are not steps.
- In the Tasks folder, a plan is a `.md` file directly inside a workspace folder. Files directly in the Tasks folder
  and folders whose name starts with `.` are not read.
- The collector writes nothing into a repository or the Tasks folder. A generated index file of releases up to
  v0.3.x that is still in a `.tasks` folder is skipped, never read as a plan.
