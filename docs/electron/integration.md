# Electron integration

The React interface, main services and sandboxed preload now use one contract in
`src/shared/contracts`: RequestMap, ResponseMap, EventMap and Result. The application has
37 public service requests plus the private `app:renderer-ready` preload handshake.
The old direct-success/scaffold handler adapter is removed. No local HTTP server runs.

The Go beta is retired by owner decision. Matching its implementation is not an acceptance
criterion; committed fixtures remain frozen regression inputs. Safe replacement of an installed
beta and preservation of its data remain required.

## Composition

- `src/main/index.ts` owns startup, native services, window lifecycle, IPC and installation scope.
- `src/main/ipc/requests.ts` validates every RequestMap payload, including unknown fields and
  byte limits. The registry checks the owning top frame/document, validates ResponseMap results
  through the same parser as preload and maps service failures to typed Result errors.
- `src/main/ipc/events.ts` validates EventMap publications. Native activation becomes exactly
  `{ plan, route }`. Preload announces readiness after activation listeners attach, so initial
  protocol links wait for both reader completion and the React listener. Reloads retain queued
  activations. The readiness request is private and exposes no general invoke method.
- `src/preload/transport.ts` preserves typed service errors. Only a missing handler becomes
  UNAVAILABLE; rejected invokes and malformed replies become INTERNAL with a correlation id.
  Main writes those preload transport failures to local rotating logs.
- `modules/ledger` runs the collector in a cancellable worker, coalesces refreshes, reconciles
  native watches, retains the last good overview, persists the cache and calls injected activity.
  No sources means no collector or watch/retry timer. Plan moves pause collection.
- `modules/runtime/core.ts` composes one SettingsStore, Workspaces, Tasks, plan actions and
  the Skills config adapter. There is no second config writer. Unreadable/newer settings do not
  clear Tasks pointers or write startup settings. Legacy integration maps are backed up and
  converted before exposing Skills; canonical skill bytes are embedded from the single source.
- `modules/runtime/platform.ts` binds picker scopes, known folder choices, fixed HTTPS targets,
  diagnostics, clipboard, startup, notifications, environment and crash notices. Open plan folder
  uses `shell:open-folder { target: 'plan', key }`; main resolves the key and source configuration,
  never a renderer-supplied path. There is no arbitrary file/executable opener.
- Platform code owns the real tray, close-to-hide behavior, instance activation, native picker,
  safe shell calls and logs. Registration/notifications/environment are restricted to the verified
  installed defaults. Isolated runs use temporary profiles and no registry theme query.
- Updater get/check/apply/skip and state events use the real updater module. Installer handoff
  freezes and drains accepted mutations and suspends background persistence. Both the explicit
  `afterInstallFailed` callback and an error event reopen the barrier. Picker cancellation remains
  available during the drain.

## Beta replacement, uninstall and health

In the verified installed scope, an Electron coordination lock is acquired in the private
Chromium subfolder, then `runLegacyMove` stops only verified old runtime executables and performs
its journalled move. Only after that does the remaining legacy-session guard run, before compatible
config/activity/cache writers and UI startup. Ordinary development/override launches never run
that registry/process migration. The process helper uses the packaged installer-helper resource.
The read-only config store is loaded only after a successful cutover.

`--cleanup-skills` is a no-window installed-only command. It uses recorded targets, backup and
hash guards, removes managed reminders before the skill, and returns nonzero on a conflict.
The uninstaller asks explicitly, stops the app first and leaves modified Skills in place.

`--health-check` is headless and read-only: it validates an existing config (or empty-install
settings), renderer/assets, preload, reader chunk and icons. It creates no stores, migration,
logger, window, session lock, registry entry or user environment value. Within a bounded check it
prints one JSON line `{ kind: 'agent-ops-health', ok, version, config?, resources?, message? }`
and exits 0/1. Tests cover valid/invalid/newer settings and unchanged files, including a real
packaged process. An invalid startup data path also produces a failure receipt.
Electron's own headless startup uses a separate temporary framework profile; it never creates
its default profile inside the data being checked. The packaged smoke creates its fake Windows
profile roots before starting Electron and compares file bytes and directory names around health.

NSIS health gating is deferred: its recovery helper currently commits a recovered extraction
from file presence, so adding a check only to customInstall would leave the recovery path able
to commit failed health. Making commit/recovery share a tested health transaction is a separate
installer change; the existing recoverable beta backup/journal remains in place. No real installer
or uninstaller is run by the integration checks.

Accepted limitation: the final realpath/SHA-256/fixed-local-drive check runs directly before
shell.trashItem, with no native spanning write lock. A file changed in the last milliseconds may
still be recycled; recoverable from the Recycle Bin. Success explicitly names the Recycle Bin.

## Samples and tests

`AGENT_OPS_UI_FIXTURES=1` permits the sample bridge only in unpackaged development/tests.
Main reports that capability through app:get-info; a hash or stored preference alone cannot enable
it. Packaged builds ignore the flag. The visible Sample workspace badge identifies sample data.

`electron-tests/backend.ts` is an external, separately bundled main test entry, never a packaged
entry or a production IPC handler. It loads the normal composition root with fake native effects
and a fake update provider. Injection requires an explicit E2E flag, an override below the temporary
directory and an unpackaged app. Packaged launches reject the hooks. Every public request still
passes through the real sender/payload/result registry; test doubles are not registered as channels.

Real-file Electron checks cover Workspace picker/setup, optional Skills installation, Tasks folder
confirmation and per-file move report, live watch refresh, archive/unarchive, confirmed fake trash
with intact bytes, source-folder opening, persisted settings, guarded Skills update/replace and
backups, update failure/retry/progress/restart, failed-install barrier recovery, protocol activation,
sample isolation and read-only health. Other UI cases use the explicitly enabled in-memory sample.

Run npm ci, typecheck, lint, test, build, smoke, package and smoke:packaged. Native interactive
picker/Recycle Bin restoration, an actual NSIS install/uninstall and live published-release update
remain disposable-Windows checks; test doubles do not claim those operations succeeded.

Before retiring Go: npm ci, typecheck, lint, 526 tests in 50 files, build, 27 Electron tests,
NSIS packaging and packaged smoke passed. The packaged smoke checks the real setup/ledger,
Result bridge, sample-mode denial and a successful read-only health process. Final checks are
repeated after the retirement commit.
