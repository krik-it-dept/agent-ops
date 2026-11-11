# Agent Ops

A Windows desktop ledger for your plans. Agent Ops reads Markdown files and shows their goals,
next steps, milestones and progress. Refresh reads files; it does not call an AI model.

- **Workspace** is where your work lives.
- **Skills** give your AI tools a shared plan format.
- **Tasks** is the folder where those tools keep plans, grouped by workspace.

Use Overview, List, Needs attention and Archive to find work. Search with Ctrl+K, refresh with
F5 and open Settings with Ctrl+,. Plan pages show recorded stages, questions, decisions and recent
changes. Light/dark appearance, private stars, recent plans and open tabs survive launches.

Agent Ops edits no plan content and never assigns work. Archive/Unarchive changes app settings.
Delete asks for confirmation and moves the file to the Windows Recycle Bin. Closing the window
hides it in the notification area; choose Quit there to exit.

## Install

Download `agent-ops-setup-<version>.exe` from [Releases](https://github.com/krik-it-dept/agent-ops/releases)
and run it for your Windows account. The installer is unsigned, so Windows may ask for an extra
confirmation. Edge and Node.js are not required to run it. See [INSTALL.md](INSTALL.md).

An existing Go beta needs this installer once. Settings and backups remain in
`%LOCALAPPDATA%/AgentOps`; plan files stay in their chosen folders. Later releases update from
inside the app after you choose Update and restart.

## First run

Setup walks through Welcome, Workspace, Skills and Tasks. Skills are optional and installed only
when chosen. Settings > Tasks can move older workspace plans into the chosen folder, with backups,
no overwrites and a report for every file. The app keeps `AGENT_OPS_TASKS` and `tasks-dir.txt`
current so AI tools find that folder without a fixed path in the skill.

## Agents and their work

A plan's `Agent:` line names the agent coordinating it, and a step can end with
`<!-- Executors: Codex -->` to name the agents that worked on it. Agents also report their own runs
with the installed app in command mode, for example
`agent-ops.exe --report --agent Codex --plan-file <plan.md> --step-line 42 --event start`, which
prints a run ID to continue with `--event progress`, `done`, `blocked` or `stopped` and a `--result`.
Reports go to `%LOCALAPPDATA%/AgentOps/runs` while the app runs; the window shows who is working now
and each run's latest result. The app keeps `AGENT_OPS_REPORT` and `report-command.txt` pointing at
the command, and the task-plan skill tells agents how to use it. Reports never change plan files.

## Development

Use Windows x64 and Node.js 24 (see `.nvmrc`). Go is not needed.

```powershell
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run smoke
npm run package
npm run smoke:packaged
```

`npm run dev` opens the app with `.dev-data`. Tests use temporary data and AI profiles.
Never point development at installed data. `AGENT_OPS_DATA_DIR` selects an explicit local folder.

Packaging writes an unsigned per-user NSIS installer, block map and update metadata under
`dist/electron`; it installs and publishes nothing. Untagged packages are development versions
and do not check for updates. The release workflow creates a draft for review.

The app uses Electron main/preload/renderer processes, React, TypeScript and Vite. Files and
native actions stay in main; the sandboxed interface uses typed IPC. No local HTTP server runs.
See [development](docs/development-electron.md), [architecture](docs/electron/architecture.md),
[IPC](docs/electron/ipc-contract.md), [integration](docs/electron/integration.md) and
[install/update](docs/install-and-update.md).

## License

Agent Ops is released under the [MIT License](LICENSE).
