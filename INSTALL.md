# Install Agent Ops

Requires Windows x64 and Microsoft Edge. Node.js is not required (releases up to v0.3.x needed it for the plan collector). No model/API account is needed for the dashboard or F5.

1. Download **agent-ops.exe** and **agent-ops.exe.sha256** from the public [releases](https://github.com/krik-it-dept/agent-ops/releases). No GitHub account or token is needed. Verify `(Get-FileHash .\agent-ops.exe -Algorithm SHA256).Hash.ToLower()` against the first field of `agent-ops.exe.sha256`.
2. Open the executable. It is unsigned by design: if SmartScreen shows **Windows protected your PC**, select **More info > Run anyway** after checking the download and checksum.
3. Accept the native **Install Agent Ops?** prompt. It installs into **%LOCALAPPDATA%\Programs\AgentOps** for this user, without administrator access, adds **Agent Ops** to the Start menu (AppUserModelID `KrikIT.AgentOps`), and registers **Agent Ops** in Windows Apps & features. Choose whether to start with Windows; this starts off for a new install. It then launches the installed app.
4. Alternatively run `.\agent-ops.exe --install`; add `--install-startup` to enable login startup. Repeating installation preserves settings, the data folder and an existing startup preference. Running `--install` from the installed executable uses a temporary helper so Windows can replace its locked executable. Later changes to startup are available in Settings and the tray menu.

The executable carries all runtime files listed by its generated package manifest, with sizes and SHA-256 hashes checked before copying. It installs no skill; choose skills in **Settings > Integrations**. If replacement or startup health fails, runtime files, shortcut and owned registry values are restored; recovery files are retained at the temporary transaction path printed in the error. A housekeeping failure after health succeeds keeps the healthy replacement and reports the error.

A release first started from the earlier runtime `%USERPROFILE%\.claude\tools\workboard` moves once to the new location, including a default login start. You can also run the newly downloaded EXE with `--install` to migrate. Setup stops only processes whose exact executable path belongs to the old or new runtime, installs the manifest's files, repoints startup, protocol and AUMID, then verifies the replacement's PID, version and state. Only after health succeeds is the whole old directory renamed with a `.backup-<timestamp>` suffix beside its previous location. Unknown files stay in that recovery copy. The old directory is then recreated with only the `task-sync.mjs` and `task-report.mjs` stubs, because sessions and instruction files of earlier releases call them by that path; a later install leaves such a stub-only directory alone. App data remains in `%LOCALAPPDATA%\AgentOps`; the in-app updater follows the installed executable's new location. Development builds and launches with explicit test configuration do not automatically offer installation.

The ZIP and its checksum remain available for isolated or scripted copies. Extract it, verify its SHA-256, and use `scripts/install.ps1 -RuntimeDir <absolute-isolated-path> -ProfileDir <temporary-profile> -NoLaunch`. Browser-downloaded scripts may need `Unblock-File` and a one-time `powershell -NoProfile -ExecutionPolicy Bypass -File ...` invocation. Use the executable installer for the normal per-user installation and Windows registrations.

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

Settings are stored in `<data-dir>/config.json`; the plan collector runs inside the app and reads the same settings. A corrupt `config.json` is renamed to `config.json.corrupt-<time>` and reported, never silently replaced.

Precedence for each value is flag, then environment variable, then `config.json`, then the default:

| Flag | Environment | Default |
| --- | --- | --- |
| `--repos-dir` | `AGENT_OPS_REPOS_DIR` | Projects from `config.json`. When set, this folder replaces them for the run and Settings shows projects read-only |
| `--state-file` | `AGENT_OPS_STATE_FILE` | `stateFile` in `config.json`; otherwise `<data-dir>/state/tong-hop-chung.json` |
| `--addr` | `AGENT_OPS_ADDR` | `127.0.0.1:7790`, or 7791 to 7799 or any free loopback port when another user or program holds it. An address you set is used as it is, without a fallback. |
| `--data-dir` | — | `%LOCALAPPDATA%/AgentOps` (the folder of earlier releases is mapped to it) |
| `--profile-dir` | — | Current user profile; where Settings > Integrations looks for folders to suggest |
| `--no-update-check` | — | Off; disable automatic checks, retain manual checks |

`--slots-file` and `--script` (with `AGENT_OPS_SCRIPT`, the Node collector of releases up to v0.3.x) are still accepted from earlier releases' restart arguments and ignored.

Use `--background` to start only the tray. Start with Windows is a preference in Settings and the tray menu; it registers a plain `--background` launch under the Run value `Agent Ops`, and the rest of the configuration comes from `config.json`.

Notifications appear as **Agent Ops** with the app icon. The installed instance (default port and data folder) registers the AppUserModelID `KrikIT.AgentOps` at `HKCU\Software\Classes\AppUserModelId\KrikIT.AgentOps` (`DisplayName`, `IconUri`) on each start and extracts the icon to `%LOCALAPPDATA%\AgentOps\icons\agent-ops-toast.png`; development, test and smoke instances never write it and their notifications show as Windows PowerShell. Clicking a notification opens the plan through the `agent-ops:` protocol. The installed instance also removes the URL protocol and Run value of earlier releases.

F5/Refresh rereads the plan files. Failures retain the last good state and show the reason. It does not run an AI model.

In **Settings > General > Plans**, **Automatically archive Done plans** keeps plans whose explicit status is Done in the app's **Archive** collection. It starts off. Enabling it hides those plans from the main workspace; turning it off shows them there again. A plan whose status is reopened in its file returns to the workspace automatically. Archive is a read-only view: the app never moves or edits a plan file. Archive remains searchable and can open plan details and the full plan.

## Rollback

Quit Agent Ops. Copy the previous runtime files from the printed `backups/<timestamp>` directory back into the runtime directory. AI client files changed by the migration or by Settings > Integrations are backed up under `%LOCALAPPDATA%\AgentOps\backups`. Keep the task sources and the data folder; they are not code rollback targets. Relaunch the previous binary and verify `/api/state` and one F5 check.

The desktop service is loopback-only, with Host/Origin/Fetch-Metadata checks, protected POST actions, script-hash CSP and frame protection, and every request must carry this app session's secret (an HttpOnly cookie in the app window; `session.json` in the data folder for local tools). After the first update to this release, close a window that was already open and open Agent Ops again from the tray: it was opened before sessions existed. It is not a public multi-user server and must not be exposed through a reverse proxy or port forwarding.

## Uninstall

Open Windows **Apps & features > Agent Ops > Uninstall**, or run `"%LOCALAPPDATA%\Programs\AgentOps\agent-ops.exe" --uninstall` (in PowerShell: `& "$env:LOCALAPPDATA\Programs\AgentOps\agent-ops.exe" --uninstall`). The native dialog defaults to **Keep settings, backups and browser data**. Cancel leaves the installation alone. Uncheck that box only to delete `%LOCALAPPDATA%\AgentOps` as well.

**Remove managed AI skills and reminder lines** is unchecked by default. Checking it uses the same guarded **Remove skill** and **reminder off** actions as Settings > Integrations, including backups and recorded hash/marker checks. Locally modified files stop uninstall and remain for manual review. With the box unchecked, AI client files are untouched, even when deleting app data.

Uninstall stops the installed app, removes its Start menu shortcut, Run value, protocol class, AUMID and uninstall registration, then schedules removal of the install directory after the uninstall process exits. Other Run values, projects, source plans and the retained legacy runtime backup are left alone. Deferred deletion refuses redirected paths and retries file locks briefly; a remaining directory can be removed after closing processes that still hold it. Isolated ZIP copies have no Windows uninstall registration: stop their isolated process and remove only their own runtime directory.
