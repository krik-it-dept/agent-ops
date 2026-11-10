# Agent Ops

A local Windows dashboard for a tech lead to follow work reported by Codex, Anti and Claude. It reads shared Markdown plans, collects execution evidence and presents current work in a quiet desktop interface inspired by Orca.

## What it shows

- Summary opens new workspaces with current work first, next actions, status, workload and recent changes. Existing view preferences are preserved.
- Local Geist typography, layered neutral light/dark surfaces, a distinct plans sidebar and quieter task rows.
- Search plans and commands with Ctrl+K; use Up/Down and Enter to open a result, Esc to close. Ctrl+1 through Ctrl+4 switch Summary/List/Board/Timeline; Ctrl+B toggles the sidebar. `/` filters the current view, F5 refreshes progress, Alt+Up/Down moves between plans, and Ctrl+, opens Settings. In Settings, Ctrl+F focuses search. Single-key shortcuts can be disabled in General.
- A task-level List with column filters, sorting and expandable plan groups. Each group keeps its plan stage and whole-plan completion visible when collapsed or expanded; the matching-task count is separate from completion. The initial filter focuses on work in progress.
- Board and day-by-day recorded progress history.
- A plan Summary with the recorded goal, next action, blockers and open decisions first. Completed work and detailed execution evidence are collapsed. Full-plan headings, tabs and content share the workspace gutter.
- Starred/recent plans, quick view and agent icons. Navigation preferences survive refresh.
- Separate coordinator and executor identities, including Claude delegating to Codex or Anti. Multiple contributors display as Multi; missing evidence stays unreported.
- In-app release checks, escaped release notes, skip/dismiss and a verified Update and restart action in a non-modal card. The app replaces its files, maintains reporting instructions and restarts with automatic UI reload; failures restore the previous version. See [in-app updates](docs/in-app-updates.md).

F5 and Refresh run the local Node collector. They do not call a model or consume AI tokens. Clients report observed work; the app does not assign agents. An in-progress report is not an OS-process heartbeat.

## Install

Download the Windows x64 ZIP and checksum from this private repository's releases. Follow [INSTALL.md](INSTALL.md) for installation, configuration and rollback. Node.js 24 and Microsoft Edge are required.

The default runtime stays at `~/.claude/tools/workboard` so existing launch links and private registries remain usable. The application and new executable are named Agent Ops. Legacy startup, URL protocol and persistence identifiers are retained.

## Develop and validate

Requires Windows x64, Node.js 24 and the Go version in `go.mod`.

```powershell
./scripts/test.ps1 -VulnerabilityScan
./scripts/build.ps1
```

Tests cover parsing, all three reporters, delegated execution, historical evidence, refresh failures, revision-safe status writes, local HTTP protection and UI behavior. Build regenerates native icons from the approved artwork, verifies all five embedded sizes and produces:

- `dist/agent-ops.exe`
- `dist/agent-ops-windows-amd64.zip`
- `dist/agent-ops-windows-amd64.zip.sha256`

Packaging uses an explicit file list and a fresh staging directory. Task sources, private attribution registries, execution history, browser profiles and session logs are excluded. CI runs the same checks on Windows and retains only the ZIP and checksum.

## Architecture

| Component | Responsibility |
| --- | --- |
| Go tray / loopback server | File watching, SSE, persisted change events, revision-safe status edits and opening Edge |
| `web/index.html` | Embedded vanilla-JS UI and local navigation preferences |
| `tasks-overview.mjs` | Collect main-checkout `.tasks/*.md`, optional slot metadata and execution evidence |
| `task-sync.mjs` | Validate reporter identity and publish shared source progress |
| `task-report.mjs` | Record immutable per-task events with the actual executor |
| `skills/task-plan/SKILL.md` | Canonical workflow shared by Codex, Anti and Claude |
| `integrations/install-task-reporting.mjs` | Render the runtime path and update managed client instructions with backups |

The collector is bundled beside the helpers; no external parent script is required. The canonical skill documents reporting commands and their required evidence.

The skill installer writes the shared and Claude slash skills, plus one managed block in each client's global instructions. It validates all managed blocks before writing, preserves unrelated instructions and backs up replacements. Repeated installation makes no duplicate edits.

Claude Code also receives small reporting hooks: session-start context, metadata validation for plan writes, and post-tool reminders. Existing hooks/settings are preserved. Delegated CLI commands run through `task-report.mjs --run-cli ... -- <CLI> <original args>` so the host records the actual worker outside its sandbox. CLI run completion does not mark a business task done. See the canonical skill for invocation details. Already-running Claude sessions need their hook/context reload before enforcing new rules.

```powershell
node integrations/install-task-reporting.mjs --runtime-dir C:/path/to/installed/runtime
```

Use `--home <isolated-profile>` for a separate profile. Point global skills at a deployed release runtime, not a development checkout.

## Data and trust

Markdown task files are the source of recorded progress. Identity comes from explicit metadata or verified execution evidence, never the last file writer or a model name guessed from prose. Reporting preserves coordinator/executor roles. Optional historical attribution is private and bound to source content. Missing evidence is never fabricated.

The collector also maintains generated per-repository indexes and a combined state file. Use isolated task roots for experimental runs. Failed refreshes keep the last good state and report failure.

The service binds only to loopback, checks Host/Origin/browser metadata, protects writes with a custom header, sends frame/security headers and uses a hash-based script CSP. Status writes require a matching revision, constrained path and exclusive Windows file handle. Same-user local programs and browser extensions remain inside the desktop trust boundary. Do not expose it as a public server.

Geist is bundled with its OFL license and a system fallback. No interface assets require a remote CDN. Artwork and third-party identity notices are in [NOTICE.md](NOTICE.md). See [release readiness](docs/release-readiness.md) for audit evidence and remaining manual checks.

## Scope retained for review

The proposed business-task parent/child migration and richer problem/impact/acceptance brief are separate, unapproved data changes. This release improves presentation without inventing missing business context, acceptance results or task ownership. Detailed logs remain evidence; they are not automatically promoted into business tasks.
