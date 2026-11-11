# Electron migration architecture

Current status: the application is integrated; see [integration notes](integration.md).
The Go app was a beta and its quirks are not acceptance criteria. Existing fixtures are frozen
regression tests; compatibility and safe replacement of installed beta data remain required.
The source inventory and proposed work below describe the original migration design, with the
implementation and explicit owner decisions in the integration notes taking precedence.

Contract baseline: `38c840b4a201bd348d898cd2d6d02fdd67a51c2b` (`electron/main`, 2026-11-10).
This is an implementation contract, not a claim that the Electron app is implemented.
Use [IPC contract](ipc-contract.md), [parity matrix](parity-matrix.md) and
[work packages](work-packages.md) together. Source code and tests at that commit win over
historical statements in README, INSTALL, CHANGELOG and release-readiness.

Scaffold reference: `a737966` on `electron/main`, reviewed after the baseline inventory.
Keep its `electron.vite.config.ts`, `src/main/index.ts`, `data-dir.ts`, `ipc.ts`, `window.ts`,
`src/main/modules/<name>/`, preload/renderer/shared layout and Playwright `electron-tests/`.
The scaffold is not yet parity: its theme-only store tolerates invalid config and preserves
unknown keys, closes the app with its last window, and uses a file URL and provisional IPC names.
Extend those through the packages below; do not mistake that temporary behavior for a change to
the Go compatibility contract. Its `AGENT_OPS_DATA_DIR` absolute override and `.dev-data` default
are retained; add baseline launch compatibility with explicit flags taking precedence.

## Fixed scope

Windows x64; Electron main/preload/renderer; React, TypeScript and Vite; no Go runtime,
Edge dependency or local HTTP server. The app remains a reader of Markdown plans.
It records file-derived activity and reads the runs agents report through the report command
(`--report`, owner decision 2026-11-11); it never assigns work or records acceptance results.
Owner actions may archive in configuration, recycle a confirmed plan, or move plans to Tasks
with backups and a report. The business hierarchy and problem/impact migration remain separate.

Keep `%LOCALAPPDATA%\AgentOps` and config version 1. Preserve English storage keys including
`projects`, `repo` and `integrations`; visible app copy uses Workspace / Skills / Tasks.
Do not expose repository, Git or worktree terminology in app-authored copy. Owner-written
plan text and explicit source-path details remain verbatim data.

Distribution is an unsigned electron-builder NSIS per-user installer. Existing Go users run
that installer once; subsequent Electron updates use electron-updater and public GitHub Releases.
Do not try to deliver Electron through the Go ZIP updater.

## Processes and module boundaries

Main owns all file access, native operations, preferences, migrations, watching, stores,
notifications and release traffic. Renderer has no Node, filesystem, subprocess or updater access.
Preload exposes a frozen, method-specific API through `contextBridge`; it does not export
`ipcRenderer`, Electron objects or a generic `invoke(channel, payload)` function.
Shared code contains JSON DTOs, schemas and pure helpers only; it imports no Electron/Node APIs.

| Module                                              | Responsibility and collaborators                                                                                                                                                                                                       |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/index.ts`                                 | Composition root; resolve explicit launch settings before readiness; wire service interfaces; orderly shutdown.                                                                                                                        |
| `src/main/data-dir.ts`, `src/main/modules/runtime/` | Paths, injected profile, runtime mode, flags/env precedence, installed-instance capabilities. Set Electron userData explicitly to compatible data folder; keep scaffold sessionData in its `chromium` child before creating a session. |
| `src/main/ipc.ts`, `src/main/ipc/`                  | Extend existing createHandler with channel allowlist, sender/frame checks, input/output validation, error envelopes and event fan-out. No domain rules here.                                                                           |
| `src/main/lib/safe-io/`                             | Atomic writes, bounded reads/tails, retries, hashes, path/file identity, same-volume temporary files, guarded client writes. Windows adapter owns handle sharing and reparse-point checks; no Go helper.                               |
| `src/main/modules/plans/`                           | Parser, collector, read-only Git metadata, overview conversion, stable keys and diagnostics. Never writes plan content.                                                                                                                |
| `src/main/modules/ledger/`                          | Refresh serialization, immutable state generation, watcher, activity diff/seed/stale rules, snapshots and bounded stores. Calls plans; emits invalidation after publication.                                                           |
| `src/main/modules/settings/`                        | Config v1 load/validate/save; workspace inventory and CRUD; settings projection. Uses io and injected desktop capabilities.                                                                                                            |
| `src/main/modules/tasks/`                           | Tasks-folder validation, pointers, move lock, backups, exclusive destination creation, report. Calls settings and ledger interfaces.                                                                                                   |
| `src/main/modules/tasks/`                           | Archive choices; main-resolved plan identity, revision/handle checks and recycling through desktop adapter.                                                                                                                            |
| `src/main/modules/skills/`                          | Suggested folders, install/update/diff/keep/replace/remove, optional reminder blocks and recorded hashes. Only user actions change clients, except legacy migration.                                                                   |
| `src/main/modules/migration/`                       | Isolated legacy names/templates; config adoption, old integration-map conversion, project key upgrade, retired-run cleanup and retry journal. No business-plan rewrite.                                                                |
| `src/main/window.ts`, `src/main/modules/platform/`  | Extend scaffold BrowserWindow; Tray/Menu, picker, notifications/AUMID, startup, protocol, instance activation, Explorer, external links and Windows adapters.                                                                          |
| `src/main/modules/updater/`                         | electron-updater adapter, selected-version checks, schedule, skip preferences, normalized update DTOs and restart barrier.                                                                                                             |
| `src/main/modules/logging/`                         | Local rotating logs, crash marker, redacted diagnostics; injected clipboard. No remote telemetry.                                                                                                                                      |
| `src/preload/`                                      | Typed method wrappers, payload-only event subscriptions with unsubscribe; minimal sandbox-compatible bundle.                                                                                                                           |
| `src/renderer/`                                     | React routes, Overview/List/plan pages, sidebar/tabs, Settings/setup, local navigation preferences, focus, update dock and safe text rendering.                                                                                        |
| `src/shared/`                                       | Keep scaffold `ipc.ts`/`validators.ts`; add `overview.ts`, `config.ts`, `errors.ts`, optional `schemas/` split; exact DTOs defined in IPC contract.                                                                                    |

Domain modules take interfaces for filesystem, clock, Git runner, installed capabilities and native
effects. They must not import the composition root or call another module's IPC handler. A service
registry/event sink supplied at startup avoids circular imports (for example settings asks a
`refresh()` interface rather than importing ledger's singleton).

## Startup and refresh flow

1. Resolve `--data-dir`, `--profile-dir`, temporary sessionData and runtime mode. Configure paths
   before Electron readiness and acquire `app.requestSingleInstanceLock()`. Use distinct temporary
   userData for independent tests. A second normal launch restores/focuses the existing window;
   a background launch stays quiet. Validate activation and queue it until the renderer is ready.
2. Initialize local logging. Read migration journal and retry an unfinished legacy migration only
   within scope/backoff. Adopt legacy config only if the compatible destination has no config.
   Read config, retained overview and stores; repair neither unreadable nor newer-version config.
   Synchronize Tasks pointers through injected installed-only environment capability.
3. Initialize tray, desktop services and release adapter. A normal launch opens the app window;
   `--background` starts the tray. Closing the window leaves the reader running; tray Quit and
   update shutdown are explicit exit paths. Renderer recreation refetches main-owned state.
4. Initial refresh, F5, tray Refresh, workspace/Tasks changes and watcher invalidations use one
   refresh queue. Coalesce simultaneous manual requests. A collector has a 30-second deadline;
   an earlier timed-out read must finish or be cancelled before another collector starts.
   Offload CPU-heavy collection/diff to a Node worker thread if needed; it receives validated
   options, never renderer code. Main keeps native/IPC handling responsive.
5. Enumerate Tasks first, then enabled legacy main-checkout `.tasks` sources; parse bounded
   regular files and gather read-only Git links/worktree metadata. Tasks wins a case-insensitive
   workspace/name duplicate. Worktree metadata is retained in transport but never rendered;
   the baseline does **not** collect linked worktrees' separate `.tasks` plans.
6. Validate overview, derive diffs against the compatible snapshot, seed returned workspaces
   quietly and record stale state. Missing folders and per-plan diagnostics are warnings.
   Collector/deadline/invalid-state failures retain the last good overview, timestamps and view.
7. Atomically save `overview.json`, snapshot/stale/seen stores and optional explicit overview
   export; append a batch of activity, compact if necessary. Failed optional store/export writes
   are logged and surfaced appropriately, not converted into successful plan changes.
8. Publish the coherent in-memory generation, update tray and notify eligible fresh events.
   Send `state:changed {generation}`; renderer calls `state:get`. Subscribe before initial fetch,
   discard older generations and refetch after renderer recreation. A 30-second state fallback
   keeps clock/stale presentation current. No network reconnect or session cookie is involved.

## Watching and concurrent actions

Baseline `main.go:397` polls enabled legacy files' path/size/mtime every two seconds; it misses
Tasks-folder changes. Electron deliberately closes this coverage gap: watch the Tasks root,
workspace children, legacy roots and their current `.tasks` children, including absent folders'
nearest existing parents. Coalesce event bursts and re-enumerate after rename/create/delete.
Keep a two-second signature reconciliation over **both** source sets because Windows watches
can miss events, drop handles or lose removable drives. Config changes rebuild watch subscriptions.
Run stale checks on the same cadence; retry failed reads at ten-second intervals when either
Tasks or an enabled workspace exists. Record this extension in the parity tests.

Config commits serialize read/modify/write. A Tasks move has one nonblocking operation lock;
concurrent moves return BUSY. Skills changes use a separate lock plus byte/hash checks immediately
before replacement. Recycling shares the refresh/plan-action lock and verifies the actual file,
not renderer-supplied `file` or `root`. Update restart rejects new mutations, waits for accepted
file actions and flushes stores before calling the updater's explicit install operation.
Do not hold a global config lock while waiting on disk, a dialog or a download.

## Security boundary

Follow Electron's [security guidance](https://www.electronjs.org/docs/latest/tutorial/security).
Create BrowserWindow with `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
`webSecurity: true`, no remote module, no webviews and no production DevTools access by default.
The preload bundle uses only the sandbox-supported bridge/IPC subset.

| Go protection                                         | Electron replacement                                                                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Loopback bind and Host/Origin/Sec-Fetch validation    | No listener. Packaged UI loads from an allowlisted `app://agent-ops/` application protocol with a fixed asset map and no arbitrary filesystem resolution. No privileged bypass-CSP scheme.                                                                                |
| Session secret, cookie, `/open` token, `session.json` | OS process boundary plus owned webContents/top-level frame identity. No secret or launch token is exposed or required. Retained old session.json is ignored, never trusted for Electron activation.                                                                       |
| `X-Agent-Ops` CSRF header and allowed methods         | Every invoke checks the registered BrowserWindow webContents, non-destroyed sender, `event.senderFrame === event.sender.mainFrame`, and exact trusted scheme/host/path. Subframes, foreign/obsolete windows and unknown channels are denied before validation or effects. |
| HTTP body decoder and limits                          | Strict runtime schemas in main for every request; reject unknown keys, invalid enums, null-for-optional fields, over-limit strings/arrays and non-JSON values. Validate returned DTOs too. Preload does not pass Electron event objects to React.                         |
| Hashed inline script CSP                              | Vite emits bundled external scripts; strict `script-src 'self'` is the replacement, without inline/eval. Hash any unavoidable inline bootstrap explicitly at build time. No unsafe-inline script exception.                                                               |
| Frame denial/referrer/MIME headers                    | Set CSP and no-referrer/nosniff headers on the custom protocol responses; `frame-src 'none'`, `frame-ancestors 'none'`, deny webview attachment and window creation.                                                                                                      |

Production CSP: `default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self';
img-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none';
frame-src 'none'; frame-ancestors 'none'; form-action 'none'`. Extract CSS and use classes
rather than inline style attributes. Bundle all needed assets; current ledger uses system fonts,
so do not silently restore the historical CDN/font loading. Development may allow a fixed
Vite origin/HMR websocket in an explicitly separate, non-packaged policy; never ship that policy.

Block `will-navigate`, redirects and `setWindowOpenHandler` by default. Hash-route changes are
internal navigation. Open a main-constructed GitHub PR/release URL only on a user gesture through
the specific bridge action; reject file/javascript/data/other protocols, credentials and arbitrary
URLs. Deny permissions and permission checks by default, including media/geolocation/USB;
notifications are created in main. No remote content or Markdown HTML can obtain bridge access.
Render plan/diagnostic/diff/release text as text; never execute embedded commands or inject HTML.

## Native operation limits that must be proved

Use [dialog.showOpenDialog](https://www.electronjs.org/docs/latest/api/dialog) with the app
window as parent, remembered directory, `openDirectory` or `openFile` (Markdown) separately.
Its API has no AbortSignal for this dialog: a Promise timeout alone does not close the native
dialog. The Windows picker adapter must support baseline cancellation/120-second timeout by
closing only its owned dialog, reject late results and keep the picker lock until closure is
confirmed. Offer pasted paths after failure. Do not use `createDirectory` as a Windows-only
guarantee; validate/create the chosen Tasks folder in the Tasks service.

Use [shell.trashItem](https://www.electronjs.org/docs/latest/api/shell#shelltrashitempath)
only after fixed-drive/reparse-point/name/byte-revision/file-identity checks. The baseline held a
Windows read handle denying writes through the operation; Node's default open is not equivalent.
The controller explicitly accepted the remaining interval after runtime's final realpath/hash/
fixed-drive check: a file changed in the last milliseconds may still be recycled; recoverable
from the Recycle Bin. No native spanning guard is required. Fail closed if recycling is
unavailable; never fall back to unlink/rm, and name the Recycle Bin in success copy.
Real Recycle Bin restoration, long paths and locked-file cases are isolated Windows release gates.

Use `Tray`, `Menu`, `nativeImage`, `nativeTheme`, main `Notification` with
`app.setAppUserModelId('KrikIT.AgentOps')`, `app.setLoginItemSettings`,
`app.setAsDefaultProtocolClient` and `requestSingleInstanceLock`. Only the installed production
instance may register protocol/startup, write HKCU Tasks pointers or touch real client profiles.
Tests and development inject no-op/fake implementations; `app.isPackaged` alone is insufficient.

## Compatible storage and migration

Keep config DTOs, plan keys, overview fields, `snapshot.json`, `activity.jsonl`, `stale.json`,
`seen-projects.json`, `migration.json`, `update-preferences.json` and `tasks-dir.txt` compatible.
Keep backup locations discoverable. `startWithWindows` is an OS setting, not a new config key.
Treat `stateFile`/slots/run metadata as retired; explicit `--state-file` still means an extra
overview export, never the app's primary state. Preserve archive false overrides and disabled
Skills targets. A newer config remains untouched and settings become read-only.

The installer migration must stop only exact owned executable paths, preserve the entire Go
runtime in a recovery backup (including unknown files), keep data and existing startup choice,
replace only owned registrations/shortcut, and remove Go program files after verified Electron
startup. Do not run the old uninstaller with default options: it can remove shared registrations
or optionally clients/data. Roll back failed bootstrap files/registrations and guarded migration
writes; legacy run-history retirement occurs after a health receipt from the exact new process.
Use an installer-owned, nonce-bound file/pipe receipt in its temporary transaction directory,
not a new HTTP server or renderer IPC exposed to external clients.

Existing `migration.json.done` prevents re-running completed client migration. Retain incomplete
retry behavior and old integration-object conversion. Do not reinstall Skills during ordinary
Electron updates. Do not scrape or modify Edge profile databases: Electron starts its own UI
storage on the bootstrap install; config-backed settings and plan activity survive, old Edge
navigation storage stays untouched in its old folder. Future Electron upgrades preserve navigation.

## Updates and recovery

`src/main/updates` wraps electron-updater rather than Electron's built-in autoUpdater. Use fixed
public `krik-it-dept/agent-ops`, stable releases, anonymous HTTPS and packaged updater metadata.
Disable automatic download and install-on-quit/next-launch using the API supported by the pinned
updater version; test the effective behavior, including a cached pending installer. An explicit
`updates:apply {version}` starts download, verification and restart for the current selected newer
version only. A check occurs shortly after startup and every six hours; dev builds do not poll
public releases. Skip remains in compatible preferences; dismiss/minimize stays a UI preference.

Use the updater's NSIS/checksum mechanisms and generated release metadata. Go ZIP allowlists,
SHA-256 handoff manifests, staging helper readiness/port health and automatic Go file rollback are
dropped. NSIS/electron-updater does not establish the Go helper's automatic post-start rollback
contract: retain a bootstrap recovery backup, a visible failure record and a tested reinstall
recovery procedure. Do not label those as automatic rollback. Offline/rate-limit/corrupt-package
failures leave the current app running. Preserve data across install failures.
See upstream [auto-update documentation](https://www.electron.build/docs/features/auto-update/)
and [NSIS configuration](https://www.electron.build/nsis/); pin versions and release metadata
as one tested set, rather than copying options from another major version.

## Errors, logs and tests

IPC returns discriminated `Result<T>` values. Domain messages use plain app vocabulary and
stable codes; stacks/internal exception text remain in local logs. Unexpected handler failures
are caught, logged with a correlation id and returned as INTERNAL. Refresh errors keep last
good state; diagnostics list fixed categories, versions, counts and switches, never plan text,
paths, owner names, raw update failures or crash messages. Maintain 1 MiB logs plus four rotations,
bounded crash/fatal files and a dismissible crash marker. Capture main uncaught exceptions,
unhandled rejections and renderer/child-process exits; do not continue a potentially corrupted
main mutation after an uncaught exception. No crash upload or telemetry is enabled.

Unit tests cover pure parsing/diff/stale rules, schemas, config/path validation, safe IO faults,
move/report/hash races and injected native effects. Differential tests run immutable **Go baseline**
fixtures and TS implementations with controlled clock/mtime/Git responses. Include intentional
Go-vs-old-Node parsing differences, Tasks dedupe and all persisted DTOs. Normalize only declared
temporary roots/time/canonical ordering where the Go map is nondeterministic; do not normalize
away missing fields, revisions, counts, event kinds or warning behavior. Go/Node reference code
is a migration test input, excluded from the shipped app and final runtime dependency set.

Electron E2E launches the built main/preload/React app with a temporary data folder, temporary
profile, isolated session and fake OS adapters. Verify sender/iframe/navigation attacks, no open
HTTP listener, CSP, hostile plan text, F5/focus/scroll/routes, Tasks and Skills effects, instance
activation and shutdown. Separate packaged Windows smoke tests exercise real native picker,
Recycle Bin on disposable files, icons, tray/AUMID, NSIS bootstrap, Electron N-1 to N update and
reinstall recovery inside a disposable Windows user/VM. No native visual success may be claimed
from mocked tests.

Development must fail fast before opening the default real data folder. Never use live Tasks,
real AI client config, HKCU, the installed executable or its Edge profile for tests. Redirect
LOCALAPPDATA/APPDATA/USERPROFILE and explicitly inject profile/data/env/registry/native boundaries;
assert resolved deletion/move/backup paths stay inside the fixture. Never publish or commit private
plans, logs, installed profiles or test screenshots containing them. Build/package checks must
exclude fixture data and baseline tools, verify native icons at 16/24/32/48/256, audit dependencies
and preserve the release draft/manual publishing boundary. The existing baseline validation is
`scripts/test.ps1 -VulnerabilityScan`; replacement CI must cover the equivalent TS/Electron gates.

## Current integration plug-in points

At settings-core merge dad0208, the integrator wires collectOverview through the separately
emitted collector.worker chunk, SkillsService through the shared version1 SettingsStore,
CoreServices for the full Settings DTO/Tasks/workspaces/plan actions, and ActivityLog with legacy
key/file upgrades before the first refresh. The platform and updater branches now plug into
RuntimeOptions through runtime/platform.ts and runtime/updates.ts; native services own OS effects,
while runtime owns trusted source/path/revision validation and installation-scope gates.
Unimplemented IPC features fail closed as UNAVAILABLE; development never registers OS integrations.
FileOverviewCache uses the shared src/main/lib/safe-io implementation.
Ledger invalidation has one trailing read, source moves/recycling pause collection, shutdown
terminates the worker and drains accepted actions, and an unconfigured app starts no watcher timer.
Installer handoff freezes IPC mutations, drains accepted writes and suspends ledger persistence;
an update error reopens both. Picker cancellation remains available while draining.

The scaffold adapter is removed. Main and preload share RequestMap/ResponseMap/EventMap from
src/shared/contracts, with strict runtime payload/result parsing and Result-shaped errors.
The private renderer-ready handshake prevents protocol activation before listeners attach.
