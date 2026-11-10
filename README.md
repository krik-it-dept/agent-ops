# Agent Ops

A local Windows work ledger for a tech lead. It reads the Markdown plans that Codex, Antigravity and Claude keep in each repository's `.tasks/` folder and shows goals, milestones, steps, decisions, questions and progress in a quiet desktop interface inspired by Orca. It only reads plans: it records no runs, assigns no agents and edits no plan. Orchestration (worktrees, workers, hand-offs) belongs to Orca.

## What it shows

- Summary opens new workspaces with current work first, next actions, status and recent changes. Existing view preferences are preserved.
- Local Geist typography, layered neutral light/dark surfaces, a distinct plans sidebar and quieter task rows.
- A project tree, workspace plan tabs and a resizable details pane. Wide windows keep details beside the work; narrow windows use a focused dialog. Project folders, open tabs and pane width are local navigation preferences.
- Optional automatic archiving in Settings > General > Plans. Plans whose file says Done move into the app's Archive collection and leave the main views; a reopened status returns the plan to the workspace. Archive is a read-only view filter: no file is moved or edited. It starts off.
- Search plans and commands with Ctrl+K; use Up/Down and Enter to open a result, Esc to close. Ctrl+1 through Ctrl+4 switch Summary/List/Board/Timeline; Ctrl+B toggles the sidebar. `/` filters the current view, F5 refreshes, Alt+Up/Down moves between plans, and Ctrl+, opens Settings. In Settings, Ctrl+F focuses search. Single-key shortcuts can be disabled in General.
- A task-level List with column filters, sorting and expandable plan groups. Each group keeps its plan stage and whole-plan completion visible when collapsed or expanded.
- Board and day-by-day history of plan changes.
- A plan Summary with the recorded goal, next action, blockers and open decisions first.
- Starred and recent plans and a quick view. Navigation preferences survive refresh.
- **Settings > Integrations**: a list of skills folders you choose (native folder picker, pasted path, or a suggestion found on this computer). Per folder: install the task-plan skill with a hash check, a diff of local changes, edit, turn off or remove, and an optional one-line reminder in an instruction file you name.
- In-app release checks, escaped release notes, skip/dismiss and a verified Update and restart action. See [in-app updates](docs/in-app-updates.md).

F5 and Refresh re-read the plan files with the collector built into the app. They do not call a model or consume AI tokens.

## Install

Download the Windows x64 ZIP and checksum from this repository's [releases](https://github.com/krik-it-dept/agent-ops/releases). Follow [INSTALL.md](INSTALL.md) for installation, configuration and rollback. Microsoft Edge is required; Node.js is not.

## Develop and validate

Requires Windows x64, the Go version in `go.mod`, and Node.js 24 for the test and release scripts.

```powershell
./scripts/test.ps1 -VulnerabilityScan
./scripts/build.ps1
node scripts/smoke.mjs
node scripts/update-e2e.mjs
```

Tests cover plan parsing, refresh failures, the read-only HTTP surface and its local request protection, settings, integrations, the one-time migration from earlier releases, the retired command stubs and UI behavior. Build regenerates native icons from the approved artwork, verifies all five embedded sizes and produces:

- `dist/agent-ops.exe`
- `dist/agent-ops-windows-amd64.zip`
- `dist/agent-ops-windows-amd64.zip.sha256`
- `dist/agent-ops-windows-amd64.manifest.json` (the package manifest the in-app updater verifies)

Packaging uses an explicit file list and a fresh staging directory. Task sources, browser profiles and session logs are excluded. A build of a commit not tagged with `VERSION` reports `vX.Y.Z-dev.<commit>`. CI runs the same checks plus the isolated N-1 to N update test. Releases are drafted by `.github/workflows/release.yml` from a pushed version tag; see [in-app updates](docs/in-app-updates.md#release-flow) and [CHANGELOG.md](CHANGELOG.md).

## Architecture

| Component | Responsibility |
| --- | --- |
| Go tray / loopback server | File watching, SSE, persisted change events, settings, integrations, updates and opening Edge |
| `web/index.html` | Embedded vanilla-JS UI and local navigation preferences |
| `internal/plans` | The plan collector, run in-process: reads main-checkout `.tasks/*.md` of the configured projects and the repositories' Git worktrees into one overview ([schema](docs/overview-schema.md)) |
| `internal/safeio` | Atomic file writes (temp file, flush, rename) with retries while Windows reports a file as in use |
| `skills/task-plan/SKILL.md` | The task-plan skill: plan format and location only. Embedded in the executable and installed from Settings > Integrations |
| `task-sync.mjs`, `task-report.mjs` | Retired commands kept as stubs so older sessions and hooks that still run them with Node keep working: they exit 0; `task-report.mjs --run-cli ... -- <CLI> <args>` runs the CLI unchanged. The app never runs them |

## Data and trust

Markdown plan files are the only source. The app reads them and never writes them, and it writes nothing into a repository (the generated `.tasks/tong-hop.md` index and the standalone HTML board of earlier releases are no longer produced). It runs `git remote get-url` and `git worktree list` read-only. A plan that cannot be read or parsed is listed under `diagnostics` and the other plans still show; a failed refresh keeps the last good state and reports the failure. State, settings and config files are replaced atomically.

The app writes AI client files only when you act in Settings > Integrations, and during the one-time migration from earlier releases. Each such write backs up the previous file, re-reads it just before an atomic replace, and changes only Agent Ops' own marked block or a whole skill file Agent Ops wrote; a file changed outside Agent Ops is reported as **Modified locally** and left alone unless you choose **Replace**.

The service binds only to loopback, checks Host/Origin/browser metadata, protects writes with a custom header, sends frame/security headers and uses a hash-based script CSP. Every request (except bundled icons and fonts) must also carry this app session's secret: the window Agent Ops opens gets it as an HttpOnly cookie through a single-use launch token, and other local clients read it from `session.json` in the data folder, which only your Windows user can read. Other Windows users on the same PC, and programs that cannot read your data folder, therefore cannot read your plans. The default port is 7790; when another user or program holds it, the app uses 7791 to 7799 or any free port and records it in `session.json`, and a second launch or a notification click reaches the running instance there. Same-user local programs and browser extensions remain inside the desktop trust boundary. Do not expose it as a public server.

Geist is bundled with its OFL license and a system fallback. No interface assets require a remote CDN. Artwork and third-party identity notices are in [NOTICE.md](NOTICE.md). See [release readiness](docs/release-readiness.md) for audit evidence and remaining manual checks.

## Scope retained for review

The proposed business-task parent/child migration and richer problem/impact/acceptance brief are separate, unapproved data changes. This release does not invent missing business context, acceptance results or task ownership.
