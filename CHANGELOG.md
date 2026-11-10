# Changelog

Each release section becomes the GitHub release notes and the in-app update notes.
The release workflow takes the section whose heading starts with the pushed tag.

## v0.3.0 - A read-only work ledger

Agent Ops now only reads plans. Orchestration (worktrees, workers, hand-offs)
belongs to Orca. The previous release is v0.2.2; v0.2.1 and v0.2.2 update to this
release in the app. An older installation cannot, and is reinstalled once from
the package.

- Keeps the v0.2.2 desktop workspace, command search, Geist font and the
  optional Done archive. Archive is a read-only view filter: it never edits or
  moves a plan file.
- Run reporting is retired: no run history, no executor or agent attribution,
  no worktree slots, and no status changes from the app. `task-sync.mjs` and
  `task-report.mjs` stay as stubs that exit 0, so older sessions and hooks keep
  working; `task-report.mjs --run-cli ... -- <CLI> <arguments>` runs the CLI
  unchanged.
- The update migrates once, with backups of every file it changes or deletes:
  it removes the Claude reporting hooks (also from Orca's Claude profiles) and
  the managed reporting instruction blocks, replaces task-plan skills that were
  never edited, keeps edited ones as **Modified locally**, deletes the old run
  history and lists text you wrote that still uses the old name. Text outside
  the managed markers is never edited.
- The task-plan skill is static (plan format and location, Orca mapping) and
  built into the app. **Settings > Integrations** detects Claude Code, Codex
  and Antigravity / Gemini, installs or updates the skill when you choose, shows
  a diff of local changes with **Keep mine** and **Replace**, removes it, and
  can add an optional one-line reminder to each client's instruction file.
  First-run setup offers the same as an optional step. Updates never write AI
  client files; a newer skill shows as **Update available**.
- Renamed to Agent Ops everywhere: data folder `%LOCALAPPDATA%\AgentOps`
  (settings are copied once from the old folder), the `agent-ops:` protocol,
  the **Agent Ops** startup entry (the old protocol and startup entry are
  removed), `AGENT_OPS_*` variables and the `X-Agent-Ops` request header.
  The app's Edge profile lives in the new data folder, so preferences kept in
  the browser (stars, recent plans, collapsed groups, view settings) start
  fresh once; plans and settings are unaffected.
- The plan list, board, history and summary no longer show agents, executors,
  run evidence or slots.

## v0.2.2 - Desktop workspace and Archive

- Quieter light and dark surfaces, bundled Geist typography and readable task rows.
- A project tree, persistent plan tabs and a resizable details pane keep plans
  beside the workspace on wide windows. Narrow windows use a focused dialog.
- Ctrl+K searches plans and commands, including Vietnamese without accents.
  Shortcut hints expose view switching, sidebar navigation and Settings search.
- Summary puts current work and recorded next actions first, with direct plan
  previews and the existing status and execution evidence.
- Settings > General > Plans adds automatic archiving, off by default. Plans
  explicitly marked Done enter Archive and return when their status is reopened.
  Original files, task markers and execution evidence stay in place.
- Fixed a false error in plan previews caused by reading hidden banner buttons.

## v0.2.1 - Release and update foundation

This is the bridge release: install it before any release that adds, renames or
removes program files. A v0.2.0 installation updates to it in the app as usual.

- Updates no longer need GitHub CLI. The app checks the public release with an
  anonymous GitHub request and downloads over HTTPS. Offline, rate-limited and
  missing-release cases show a specific message.
- Each release publishes a package manifest (files, sizes, SHA-256 digests and files
  to remove). The updater checks the package against it and fixed path rules
  instead of a file list built into each version, so later releases can change the
  file set. Removed files are backed up and restored if the update fails.
- Logs: `<data-dir>\logs\agent-ops.log` (rotated at 1 MB, five files kept) records
  start, plan refresh failures, update steps and errors. The update helper writes
  `update.log`.
- Crash recovery: background work and requests recover from internal errors, log
  them and show a notice with **Open logs**. A crash that ends the app is reported
  on the next start.
- **Settings > About** adds **Open logs folder** and **Copy diagnostics** (versions,
  Windows build, counts, switches and fixed failure categories; never plan
  content, project names or paths). Logs stay local and can contain folder paths.
- Old update staging folders are pruned; the newest three are kept.
- Builds of an untagged commit report `vX.Y.Z-dev.<commit>` and are never offered
  updates. Releases are built by the release workflow from a version tag.

## v0.2.0 - First-run setup and project folders (2026-11-10)

- First-run setup chooses project folders with the native folder picker; no
  hard-coded paths remain. Settings has General, Projects and About.
- Shared `config.json` for the app and the reporting helpers, with a one-time
  migration of the previous fixed folders.
- Orca-style interface: one board grouped by project, repository and plan, system
  font, light and dark app icons, one **Update and restart** button with **Skip this
  version**.
- Windows notifications appear as Agent Ops with its own icon. Fixed a command
  injection path through notification content.
- Updates keep a skill, hook or instruction block that the owner edited, and report
  it as modified locally.

## v0.1.4 (2026-11-10)

- Delegated CLI workers are recorded by the host runner outside the worker sandbox;
  plans without agent metadata no longer break attribution.

## v0.1.3 (2026-11-10)

- A failed update's recovery message stays visible after restart instead of being
  replaced by the next automatic check.

## v0.1.2 (2026-11-10)

- In-app updates: verified download, backup, replacement, health check, rollback
  and automatic reload of the open window.

## v0.1.1 (2026-11-10)

- Plan sections share one alignment; grouped lists keep whole-plan progress.

## v0.1.0 (2026-11-09)

- First release: local dashboard of `.tasks` plans with live refresh, activity,
  notifications, and the shared task-plan reporting workflow for Claude, Codex and
  Gemini clients.
