# Install Agent Ops

Requires Windows x64, Microsoft Edge and Node.js 24. No model/API account is needed for the dashboard or F5.

1. Quit the previous Workboard instance from its tray menu.
2. Extract the release ZIP to a temporary folder. Verify its SHA-256 against the adjacent checksum:
   `(Get-FileHash .\agent-ops-windows-amd64.zip -Algorithm SHA256).Hash.ToLower()` must equal the value in `agent-ops-windows-amd64.zip.sha256`.
3. A ZIP downloaded with a browser marks every extracted file as coming from the internet, and Windows' default PowerShell policy refuses unsigned scripts. In PowerShell, from the extracted package folder, clear the mark and run the installer with a one-time policy bypass (this changes no system setting):
   ```powershell
   Get-ChildItem -LiteralPath . -Recurse -File | Unblock-File
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```
   It installs to `~/.claude/tools/workboard` and updates only the managed reporting instructions for Codex, Anti and Claude. Existing instructions are preserved with backups. It clears the download mark on every file it installs, then starts the app.
4. The installer launches the app itself. Pass `-NoLaunch` to install without starting it, and start it later with `Start-Process "$env:USERPROFILE\.claude\tools\workboard\agent-ops.exe"`. If SmartScreen still shows "Windows protected your PC", choose **More info**, check that the file is the one you just installed, then **Run anyway**. The first launch opens the setup; existing Workboard data and Edge profile are reused. Turn on **Start with Windows** in Settings to start it at sign-in.

From v0.1.2 onward, the app offers later releases itself. It checks on startup and every six hours, or on demand from **Settings > About**; a new release appears as a card and as **Update available** in the status bar, and **Update and restart** verifies, backs up, installs and restarts in place. From v0.2.1 the app downloads public releases directly over HTTPS; it needs no GitHub CLI and no token. A v0.2.0 installation still uses a signed-in GitHub CLI for its one update to v0.2.1. See [in-app updates](docs/in-app-updates.md) for recovery and validation details. An installation older than the updater needs this bootstrap procedure once.

`-RuntimeDir <path>` and `-ProfileDir <path>` support alternate/isolated installations. `-SkipSkills` installs runtime files only. `-NoLaunch` installs without starting the app; use it with an isolated `-RuntimeDir` so the copy does not start against the default port and data folder. The installer validates all package entries first, backs up overwritten runtime files and does not delete task files, execution history or preferences. Quit the old process before replacing an existing executable. A failed step reports an error rather than claiming a successful installation.

## First run and settings

On first launch Agent Ops opens a short setup: add one or more project folders, then choose startup, notification and appearance preferences. **Set up later** skips it, even before a project is added; the board then shows **Add a project to start**. A project is either a Git repository or a folder whose direct subfolders are repositories. Agent Ops reads `.tasks/*.md` in each repository's main checkout. Change projects later in **Settings** (gear in the header, or **Settings…** in the tray menu).

Settings are stored in `<data-dir>/config.json` and shared with the reporting helpers (`task-sync.mjs`, `task-report.mjs`), which find it through `AGENT_OPS_CONFIG` or the default data folder, so agents need no path flags. An installation upgraded from a version without settings keeps its existing repositories folder, state file and slots file: they are written into `config.json` on the first start. A corrupt `config.json` is renamed to `config.json.corrupt-<time>` and reported, never silently replaced.

Precedence for each value is flag, then environment variable, then `config.json`, then the default. The app and the Node helpers (`tasks-overview.mjs`, `task-sync.mjs`, `task-report.mjs`) use this same order, so a `KRIK_*` variable set in an agent's shell overrides `config.json` for that helper exactly as it would for the app; leave these variables unset unless you mean to override the configured projects or state file everywhere. One upgrade exception: a `--repos-dir`, `--state-file` or `--slots-file` value equal to the first release's built-in path is treated as migration input, not as an override, because releases before settings passed those paths on every restart:

| Flag | Environment | Default |
| --- | --- | --- |
| `--repos-dir` | `KRIK_REPOS_DIR` | Projects from `config.json`. When set, this folder replaces them for the run and Settings shows projects read-only |
| `--slots-file` | `KRIK_SLOTS_FILE` | `slotsFile` in `config.json`; otherwise off |
| `--state-file` | `KRIK_STATE_FILE` | `stateFile` in `config.json`; otherwise `<data-dir>/state/tong-hop-chung.json` |
| `--script` | `KRIK_SCRIPT` | Collector beside the executable; legacy user-profile locations are fallback paths |
| `--addr` | `KRIK_ADDR` | `127.0.0.1:7790` |
| `--data-dir` | — | `%LOCALAPPDATA%/krik-workboard` |
| `--profile-dir` | — | Current user profile; managed reporting-instruction target |
| `--no-update-check` | — | Off; disable automatic checks, retain manual checks |

Use `--background` to start only the tray. Start with Windows is a preference in Settings and the tray menu; it always registers a plain `--background` launch, and the rest of the configuration comes from `config.json`; login starts the tray quietly. Persistence and the legacy protocol/run-key names remain compatible to avoid losing preferences or creating duplicate startup entries.

Notifications appear as **Agent Ops** with the app icon. The installed instance (default port and data folder) registers the AppUserModelID `KrikIT.AgentOps` at `HKCU\Software\Classes\AppUserModelId\KrikIT.AgentOps` (`DisplayName`, `IconUri`) on each start and extracts the icon to `%LOCALAPPDATA%\krik-workboard\icons\agent-ops-toast.png`; development, test and smoke instances never write it and their notifications show as Windows PowerShell. Clicking a notification opens the plan through the `krik-workboard:` protocol.

F5/Refresh rereads source files and execution reports. Failures retain the last good state and show the reason. It does not run an AI model or assign agents. An execution report describes an observed event; it is not proof of a currently running OS process.

In **Settings > General > Plans**, **Automatically archive Done plans** keeps plans whose explicit status is Done in the app's **Archive** collection. It starts off. Enabling it hides those plans from the main workspace; turning it off shows them there again. A plan whose status is reopened returns to the workspace automatically. Archiving preserves the original files, task markers and execution evidence. Archive remains searchable and can open plan details and the full plan.

Historical attribution registries are optional private runtime data and are not in the repository/release. Upgrades preserve existing registries. New installations show unreported identity until clients report actual execution.

## Rollback

Quit Agent Ops. Copy the previous runtime files from the printed `backups/<timestamp>` directory back into the runtime directory. Reporting-instruction backups are under `~/.agents/workboard-backups`. Keep the current task sources, execution directory and app-data directory; they are not code rollback targets. Relaunch the previous binary and verify `/api/state` and one F5 check.

The desktop service is loopback-only, with Host/Origin/Fetch-Metadata checks, protected POST actions, script-hash CSP and frame protection. It is not a public multi-user server and must not be exposed through a reverse proxy or port forwarding.

## Uninstall

Quit Agent Ops and turn off **Start with Windows** first. Then remove the runtime directory, and in PowerShell remove the registrations the app wrote: `Remove-Item -Recurse HKCU:\Software\Classes\AppUserModelId\KrikIT.AgentOps, HKCU:\Software\Classes\krik-workboard`. Delete `%LOCALAPPDATA%\krik-workboard` only if its settings, state and Edge profile are no longer wanted.
