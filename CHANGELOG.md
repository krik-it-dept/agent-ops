# Changelog

Each release section becomes the GitHub release notes and the in-app update notes.
The release workflow takes the section whose heading starts with the pushed tag.

## v1.2.1 - Update all Skills and zoom with Ctrl

- **Update all.** When newer Skills are available, Settings → Skills shows
  "Update all" with the number of Skills to update, and updates them in one
  step. Skills you changed yourself are left alone, as before; review them
  one by one.
- **Zoom with Ctrl.** Ctrl + mouse wheel, Ctrl + `=` and Ctrl + `-` make the
  whole interface larger or smaller, and Ctrl + `0` goes back to the default.
  The size is the Text size setting, so it is kept the next time you open the
  app.
- **One line less on plan pages.** The workspace name above the plan title is
  gone; it is in the sidebar and in the title's tooltip.

## v1.2.0 - Mark a plan Done from the Board

- **Mark a plan Done from the Board.** Drag a card into the Done column and
  Agent Ops writes `Status: Done` into the plan file. Only the Status line
  changes; the rest of the file stays byte for byte. A toast offers Undo for
  2 minutes. The card menu (`⋯`) and the plan page also have Mark as Done,
  for the keyboard and screen readers. If the plan changed since you looked at
  it, or it has no Status line, nothing is written and the reason is shown.
  A copy of the original is kept in `backups\plan-edits` in the data folder
  (the newest 50), and the change shows in the plan's activity as "Marked Done
  in Agent Ops". This is the only plan content the app changes.
- **One-colour window top.** On Windows the app bar is now the title bar: the
  white strip is gone, the minimise, maximise and close buttons sit in the app
  bar in the app's light or dark colours, and the bar moves the window.
- **Showing the window keeps your page.** Clicking the tray icon or starting
  Agent Ops again only brings the window forward; it no longer jumps back to
  Summary. Links to a plan still open that plan.
- **Skill v5.** The task-plan skill notes that the owner may mark a plan Done
  from Agent Ops, which only changes its Status line.

## v1.1.1 - Smaller fixes

Fixes for Start with Windows and the work views, and Settings and Help move to
the sidebar.

- **Start with Windows shows as on.** Turning it on in Settings now keeps the
  switch on. Before, the app saved the setting but then read it back under the
  wrong name and showed it as off.
- **Settings and Help in the sidebar.** The Settings gear and the `?` shortcut
  help are now small buttons at the bottom left of the sidebar, next to
  Archive, instead of the top right of the window. The shortcut help is also in
  the Ctrl+K search for when the sidebar is hidden.
- **More keyboard shortcuts.** Ctrl+3 opens Board and Ctrl+4 opens Timeline,
  after Ctrl+1 for Summary and Ctrl+2 for List. Shortcuts and the Ctrl+K search
  keep your current search and agent filter, as the tabs do.
- **Clearer agent names.** A plan the coordinator carries out alone shows one
  agent instead of a chain. Several executors are separated with commas, and
  more than two show as "Multi" with the full list on hover and for screen
  readers. The chain no longer wraps after the arrow in Timeline.
- **Agent workload.** Rows read "1 plan · 3 tasks", show a bar for the share of
  plans, mark the agent you are filtering by, and are disabled when an agent
  has no plans.
- **Board and chart columns.** A plan with a stage the app does not recognise
  but with blocked steps now appears under Waiting instead of To do.
- **Smoother large lists.** The List and Timeline no longer redraw every row
  each time a report arrives.
- **Safer reading of reports.** Agent names, reports and executors that are
  missing or malformed no longer break a plan; unusable report entries are
  skipped.

## v1.1.0 - Work views and agent tracking

The card-style work views from the beta are back, and every AI tool can report
the work it does on a plan.

- **Summary, List, Board and Timeline.** Summary opens with four tiles (active,
  done, updated in the last 7 days, needs attention), cards for current work
  with the agent chain and progress, a status chart, step progress, agent
  workload and recent activity. List shows each step with its plan, agent,
  status, latest result and update time, grouped by plan. Board sorts plans into
  To do, In progress, Review & test, Waiting and Done; Timeline shows plans by
  day. An agent filter in the top bar works across the views, and the plan page
  shows the coordinator, the executing agents and each step's latest result.
- **Agents report their work.** Agents record their own runs with the app's
  report command (`agent-ops.exe --report --agent <name> --plan-file <plan.md>
  --event start|progress|done|blocked|stopped`, with a step line, run ID and
  result). It works while the app runs, prints the run ID or `ok`, and never
  changes the plan. The app reads the reports with the plans: each plan lists
  its latest 50 runs, a run counts as working now for 12 hours after its last
  start or progress, and a report shows up within seconds. Finished runs older
  than 90 days are removed at start.
- **Agent fields in plans.** The `Agent:` line names the coordinating agent and
  a step's `<!-- Executors: A, B -->` comment the agents that worked on it;
  known names are spelled one way (Claude, Codex, Gemini, Antigravity, Cursor,
  Copilot) and the comment is hidden from the step text.
- **Activity** shows "Agent started", "Agent finished" and "Agent blocked", and
  a blocked report is notified.
- **The installed app** keeps `AGENT_OPS_REPORT` and `report-command.txt`
  pointing at its executable; uninstalling removes the variable.
- **Skills version 4** explains the new fields and execution reporting;
  installed Skills show an update.

## v1.0.1 - Easier plan pages and Tasks folder

Fixes from the first installs of v1.0.0.

- **Plan pages put milestones first.** The plan name, status and actions sit in
  the top bar beside search, and the Milestones / Decisions / Questions /
  Activity tabs stay in view while you scroll. Goal and Next sit side by side
  and take at most a third of the window; "Show full summary" opens the rest.
- **Settings.** On/off settings are switches, "Saved" disappears after a moment,
  and a new Text size setting makes the whole interface smaller or larger.
- **No extra "Tasks" level.** The sidebar and Overview list plans by workspace
  directly; labels show just the workspace name.
- **Clearer Tasks folder choice.** A folder that holds one of your workspaces is
  refused with a ready alternative, a new `Tasks` folder inside it, one click
  away. Results of an earlier move no longer stay on screen after you pick a
  new folder.
- **The MIT License** is now included.

## v1.0.0 - First public release

Agent Ops is a Windows desktop ledger for the Markdown plans your AI tools keep.
It reads plan files and shows their goals, next steps, milestones and progress;
it edits no plan content, records no runs and calls no AI model.

- **Setup in four steps.** Welcome, Workspace, Skills and Tasks. Skills are
  optional and installed only for the AI tools you tick.
- **A live ledger.** Overview, List, Needs attention and Archive, plan pages
  with stages, questions, decisions and recent changes. Saving a plan file
  updates the window within seconds; F5 rereads everything.
- **Two plan actions only.** Archive/Unarchive changes the app's list; Delete
  asks first and moves the file to the Windows Recycle Bin.
- **Skills kept safe.** Install, update, replace and remove the shared
  `task-plan` skill with backups; locally changed files are never overwritten
  without an explicit Replace.
- **One Tasks folder.** Plans live in `<Tasks folder>/<workspace>/<plan>.md`.
  Changing the folder can move existing plans, with backups, no overwrites and
  a report for every file.
- **Per-user install, in-app updates.** The installer needs no administrator
  rights. Later releases download, verify and install from inside the app.
- **Replaces the Go beta.** Run this installer once over a beta (v0.2.x to
  v0.4.0): settings and data in `%LOCALAPPDATA%\AgentOps` are kept and the beta
  is kept as a recoverable backup.

Known limitations:

- The installer and app are not code-signed. Windows SmartScreen may show
  **Windows protected your PC**; choose **More info > Run anyway**. Updates are
  trusted through HTTPS and this GitHub repository.
- Windows x64 only.
- Pull request links (`#123` in a plan) need Git on the PATH to find the
  repository; without Git everything else works.
- Delete rechecks the file just before moving it, but a change made in the
  last milliseconds may still be recycled; it stays recoverable from the
  Recycle Bin.
- Folders on network shares or removable drives can be read but their plans
  cannot be deleted from the app.

Earlier sections describe the retired Go beta.

## v0.4.0 - One file to install, no Node.js, a ledger by milestone

v0.3.0 updates to this release in the app. The update removes the Node
collector files; Node.js is no longer needed to run Agent Ops.

- **Install by opening one file.** Releases also publish `agent-ops.exe` with
  its checksum. Opening it offers **Install Agent Ops?** (or run
  `agent-ops.exe --install`): it installs for the current user into
  `%LOCALAPPDATA%\Programs\AgentOps` without administrator access, adds an
  **Agent Ops** Start menu shortcut and an Apps & features entry, optionally
  starts with Windows, and keeps your settings and data. A failed install
  restores the previous files, shortcut and registry values. The download is
  unsigned: SmartScreen may need **More info > Run anyway**.
- **Uninstall** from Apps & features or `agent-ops.exe --uninstall`: removes
  the app, shortcut, startup entry, protocol and uninstall entry, keeps the
  data folder unless you untick it, and removes AI client skills only when you
  tick that box (through the same guarded removal as Settings > Integrations).
- **The earlier install moves once.** The first plain start (sign-in or the
  shortcut) of this release from `%USERPROFILE%\.claude\tools\workboard`
  moves it to the new folder after the new copy is running and healthy. The old
  folder is kept beside it with a `.backup-<time>` suffix, and `task-sync.mjs` and
  `task-report.mjs` stay at the old path for older sessions that still call
  them there.
- **No Node.js.** The plan collector is built into the app. The update removes
  `tasks-overview.mjs`, `plan-reader.mjs` and the Node migration shim;
  `task-sync.mjs` and `task-report.mjs` stay as stubs for older sessions that
  still run them with Node. Nothing is written into your repositories any more
  (no `.tasks/tong-hop.md`).
- **One bad plan no longer breaks the board.** A plan that cannot be read or
  parsed shows a small warning on its row and page (left-out plans are listed
  in the warning banner), and every other plan still shows. Header lines and
  steps inside code blocks are ignored.
- **Ledger by milestone.** A plan page shows its goal, status, Next and
  progress, Blocked and Waiting callouts first, then collapsible milestones
  with their summary and done/total. The sidebar and lists group plans by
  project and repository, with each repository's Git worktrees and branches.
  Every view and plan has its own address, so Back, Forward and copied links
  work. A refresh redraws only plans that changed and keeps focus, the search
  caret, scroll position and open sections.
- **Safer files.** State, settings and config files are replaced atomically
  and survive files held by an editor or antivirus; the activity log is kept to
  a bounded size.
- **Private to your Windows account.** Every request needs this session's
  secret, so other Windows users on the same PC cannot read your board. When
  port 7790 is taken by another user or program, Agent Ops uses another port,
  and a second launch or a notification click still opens the running app.
  After this update, close a window that was already open and open Agent Ops
  again from the tray.

## v0.3.0 - A read-only work ledger

Agent Ops now only reads plans. Orchestration (worktrees, workers, hand-offs)
belongs to Orca. The previous release is v0.2.3; v0.2.1 to v0.2.3 update to this
release in the app. An older installation cannot, and is reinstalled once from
the package.

- Keeps the v0.2.2 and v0.2.3 desktop workspace, command search, Geist font
  and the optional Done archive. Archive is a read-only view filter: it never edits or
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
  built into the app. **Settings > Integrations** is a list of skills folders
  you choose: add one with the folder picker or a pasted path, or from the
  folders found on this computer (Claude Code, Codex, Antigravity / Gemini and
  Orca profiles are only suggested, never added on their own). Per folder you
  can install or update the skill, view a diff of local changes with **Keep
  mine** and **Replace**, remove the skill, edit the path, turn the folder off
  or take it off the list, and add an optional one-line reminder to its
  instruction file. First-run setup lists the same suggestions, unchecked.
  The migration seeds the list from the skill folders it finds. Updates never
  write AI client files; a newer skill shows as **Update available**.
- Renamed to Agent Ops everywhere: data folder `%LOCALAPPDATA%\AgentOps`
  (settings are copied once from the old folder), the `agent-ops:` protocol,
  the **Agent Ops** startup entry (the old protocol and startup entry are
  removed), `AGENT_OPS_*` variables and the `X-Agent-Ops` request header.
  The app's Edge profile lives in the new data folder, so preferences kept in
  the browser (stars, recent plans, collapsed groups, view settings) start
  fresh once; plans and settings are unaffected.
- The plan list, board, history and summary no longer show agents, executors,
  run evidence or slots.

## v0.2.3 - Sidebar header spacing

- Move the sidebar toggle to the left edge of the header and remove the fixed
  logo/title block that left a 244-pixel gap when the sidebar was hidden.
- Keep the toggle in the same position with the sidebar open or closed, including
  narrow windows. Existing navigation preferences and Ctrl+B remain available.

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
