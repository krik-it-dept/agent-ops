# Install Agent Ops

Requires Windows x64, Microsoft Edge and Node.js 24. No model/API account is needed for the dashboard or F5.

1. Quit a running Agent Ops from its tray menu.
2. Extract the release ZIP to a temporary folder. Verify its SHA-256 against the adjacent checksum:
   `(Get-FileHash .\agent-ops-windows-amd64.zip -Algorithm SHA256).Hash.ToLower()` must equal the value in `agent-ops-windows-amd64.zip.sha256`.
3. A ZIP downloaded with a browser marks every extracted file as coming from the internet, and Windows' default PowerShell policy refuses unsigned scripts. In PowerShell, from the extracted package folder, clear the mark and run the installer with a one-time policy bypass (this changes no system setting):
   ```powershell
   Get-ChildItem -LiteralPath . -Recurse -File | Unblock-File
   powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install.ps1
   ```
   It installs into the install folder of earlier releases, `%USERPROFILE%\.claude\tools\workboard` (a later release moves it to `%LOCALAPPDATA%\Programs\AgentOps`), clears the download mark on every file it installs, runs the one-time migration from earlier releases (below) and starts the app. It installs no skill: choose that in the app.
4. Pass `-NoLaunch` to install without starting the app, and start it later with `Start-Process "$env:USERPROFILE\.claude\tools\workboard\agent-ops.exe"`. If SmartScreen still shows "Windows protected your PC", choose **More info**, check that the file is the one you just installed, then **Run anyway**. The first launch opens the setup. Turn on **Start with Windows** in Settings to start it at sign-in.

The app offers later releases itself. It checks on startup and every six hours, or on demand from **Settings > About**; a new release appears as a card and as **Update available** in the status bar, and **Update and restart** verifies, backs up, installs and restarts in place. It downloads public releases over HTTPS and needs no GitHub CLI or token. An installation older than v0.2.1 cannot install v0.3.0 or later in the app: install this package with the steps above once. See [in-app updates](docs/in-app-updates.md).

`-RuntimeDir <path>` and `-ProfileDir <path>` support alternate or isolated installations; with an isolated profile, the migration uses that profile's own `AppData` folders. Only the installed instance (the default install folder and data folder of the real home) edits the real AI client files or deletes legacy run history. An isolated `-RuntimeDir` without an explicit `-ProfileDir` skips the migration, and the app itself keeps any non-default runtime or data folder to its own folders. `-SkipMigration` copies the runtime files only. `-NoLaunch` installs without starting the app; use it with an isolated `-RuntimeDir` so the copy does not start against the default port and data folder. The installer validates all package entries first, backs up overwritten and retired runtime files, and never deletes task files. A failed step reports an error rather than claiming a successful installation.

## Moving from earlier releases (v0.2.x and older)

Earlier releases recorded agent runs and installed reporting hooks and instruction blocks into the AI clients. v0.3.0 is a read-only ledger, and the first update (or install) migrates once, backing up every file it changes or deletes into `%LOCALAPPDATA%\AgentOps\backups\migration-<time>`:

- `config.json` (projects and preferences) is copied from `%LOCALAPPDATA%\krik-workboard` into the new data folder `%LOCALAPPDATA%\AgentOps`. Nothing else is carried over: activity starts fresh, and preferences kept in the app's browser profile (stars, recent plans, collapsed groups, view settings) start fresh once, because that profile lives in the data folder.
- Claude hooks that run `task-sync.mjs --claude-hook` (the shape the earlier installer wrote) are removed from `~\.claude\settings.json`, from `CLAUDE_CONFIG_DIR` and from every Orca Claude profile (`%APPDATA%\orca\claude-profiles\*\home\settings.json`). Other hooks and settings stay as they were.
- The managed reporting blocks (between their start and end markers) are removed from `~\.claude\CLAUDE.md`, `~\.codex\AGENTS.md` and `~\.gemini\GEMINI.md`. Text outside the markers is never edited (only the blank line that separated a block appended at the end of a file goes with it); a block you edited is kept and listed.
- A `task-plan` SKILL.md still identical to a skill an earlier installer wrote is replaced with the new skill; an edited copy is kept and shown as **Modified locally** in Settings > Integrations.
- The run history is deleted after the new version is running: execution reports (`workboard-executions` next to the state file), the history registries in the install folder, and the old data folder's activity, snapshots and generated state. The old integration record `~\.agents\workboard-integrations.json` is carried into the folder list in `config.json` (seeded once from the skill folders the first migration finds; later installer runs never add back a folder you removed) and deleted.
- Lines you wrote that still mention the old product name are listed in **Settings > Integrations** as a checklist to edit by hand.

`task-sync.mjs` and `task-report.mjs` remain as stubs, so a session or hook that still calls them keeps working: they do nothing and exit 0; `task-report.mjs --run-cli ... -- <CLI> <arguments>` runs the CLI unchanged.

## First run and settings

On first launch Agent Ops opens a short setup: add one or more project folders, optionally connect AI clients (check the skills folders found on this computer to install the task-plan skill there; nothing is checked for you), then choose startup, notification and appearance preferences. **Set up later** skips it, even before a project is added; the board then shows **Add a project to start**. A project is either a Git repository or a folder whose direct subfolders are repositories. Agent Ops reads `.tasks/*.md` in each repository's main checkout. Change projects and integrations later in **Settings** (gear in the header, or **Settings…** in the tray menu).

Settings are stored in `<data-dir>/config.json`, which the collector also reads (through `AGENT_OPS_CONFIG` or the default data folder). A corrupt `config.json` is renamed to `config.json.corrupt-<time>` and reported, never silently replaced.

Precedence for each value is flag, then environment variable, then `config.json`, then the default. The app and the collector use the same order:

| Flag | Environment | Default |
| --- | --- | --- |
| `--repos-dir` | `AGENT_OPS_REPOS_DIR` | Projects from `config.json`. When set, this folder replaces them for the run and Settings shows projects read-only |
| `--state-file` | `AGENT_OPS_STATE_FILE` | `stateFile` in `config.json`; otherwise `<data-dir>/state/tong-hop-chung.json` |
| `--script` | `AGENT_OPS_SCRIPT` | Collector beside the executable |
| `--addr` | `AGENT_OPS_ADDR` | `127.0.0.1:7790` |
| `--data-dir` | — | `%LOCALAPPDATA%/AgentOps` (the folder of earlier releases is mapped to it) |
| `--profile-dir` | — | Current user profile; where Settings > Integrations looks for folders to suggest |
| `--no-update-check` | — | Off; disable automatic checks, retain manual checks |

`--slots-file` is still accepted from earlier releases' restart arguments and ignored.

Use `--background` to start only the tray. Start with Windows is a preference in Settings and the tray menu; it registers a plain `--background` launch under the Run value `Agent Ops`, and the rest of the configuration comes from `config.json`.

Notifications appear as **Agent Ops** with the app icon. The installed instance (default port and data folder) registers the AppUserModelID `KrikIT.AgentOps` at `HKCU\Software\Classes\AppUserModelId\KrikIT.AgentOps` (`DisplayName`, `IconUri`) on each start and extracts the icon to `%LOCALAPPDATA%\AgentOps\icons\agent-ops-toast.png`; development, test and smoke instances never write it and their notifications show as Windows PowerShell. Clicking a notification opens the plan through the `agent-ops:` protocol. The installed instance also removes the URL protocol and Run value of earlier releases.

F5/Refresh rereads the plan files. Failures retain the last good state and show the reason. It does not run an AI model.

In **Settings > General > Plans**, **Automatically archive Done plans** keeps plans whose explicit status is Done in the app's **Archive** collection. It starts off. Enabling it hides those plans from the main workspace; turning it off shows them there again. A plan whose status is reopened in its file returns to the workspace automatically. Archive is a read-only view: the app never moves or edits a plan file. Archive remains searchable and can open plan details and the full plan.

## Rollback

Quit Agent Ops. Copy the previous runtime files from the printed `backups/<timestamp>` directory back into the runtime directory. AI client files changed by the migration or by Settings > Integrations are backed up under `%LOCALAPPDATA%\AgentOps\backups`. Keep the task sources and the data folder; they are not code rollback targets. Relaunch the previous binary and verify `/api/state` and one F5 check.

The desktop service is loopback-only, with Host/Origin/Fetch-Metadata checks, protected POST actions, script-hash CSP and frame protection. It is not a public multi-user server and must not be exposed through a reverse proxy or port forwarding.

## Uninstall

Quit Agent Ops and turn off **Start with Windows** first. Remove the task-plan skill and reminder lines you installed in **Settings > Integrations**. Then remove the runtime directory, and in PowerShell remove the registrations the app wrote: `Remove-Item -Recurse HKCU:\Software\Classes\AppUserModelId\KrikIT.AgentOps, HKCU:\Software\Classes\agent-ops`. Delete `%LOCALAPPDATA%\AgentOps` only if its settings, backups and Edge profile are no longer wanted; `%LOCALAPPDATA%\krik-workboard` holds only leftovers of earlier releases (logs, update staging) after the migration.
