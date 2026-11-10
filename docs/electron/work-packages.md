# Electron implementation work packages

Current owner decision: the Go beta is retired, and matching it is not an acceptance criterion.
This inventory is historical design provenance; frozen fixtures remain regression inputs and
safe preservation/replacement of beta installations is still required. Current wiring is in integration.md.

Baseline `38c840b`; [architecture](architecture.md), [IPC contract](ipc-contract.md) and
[parity matrix](parity-matrix.md) are the shared contract. This document assigns future
implementation work; the contract task itself changes only `docs/electron/`.
There are seven packages. No package may edit another owner's files while running in parallel.
Ask that owner for an interface change and integrate it through that owner. Never revert another
worker's changes or alter private runtime plans/profiles. Merge tested commits through the
coordinator; do not push or deploy as an incidental implementation action.

The separate scaffold worker delivered the WP1 starting point on `electron/main` at `a737966`.
Preserve its entry files and `src/main/modules/<name>/` layout. This contract was aligned to that
reference without changing source files in the contract branch. WP1 below includes remaining
foundation work, not a request to recreate the scaffold. Use `npm ci`, `npm run typecheck`,
`npm test`, `npm run lint`, `npm run build` and `npm run smoke` from that scaffold; build before smoke.
See `docs/development-electron.md` at the scaffold commit for the actual toolchain instructions.

## Dependency order and ownership

```text
WP1 scaffold + shared schemas + runtime/io/interfaces
  |
  +--> WP2 collector + ledger -----+
  +--> WP3 settings + Tasks -------+
  +--> WP4 Skills + migration -----+--> integrated services + native gates
  +--> WP5 desktop ----------------+
  +--> WP6 React renderer ---------+
  +--> WP7 updater + packaging ----+--> bootstrap + Electron update + release gates
```

WP2–WP7 can start in parallel after WP1 freezes interfaces and provides typed fake services.
Cross-package imports use those interfaces; packages do not import the main singleton or each
other's IPC registrations. The integrator owns the composition root and registers services supplied by the
other owners. Integration commits are applied serially by the file owner, not by concurrent
edits of index.ts or package.json.

The coordinator's active assignments below supersede the original proposed ownership split.
The historical package acceptance sections remain the behavior checklist, not permission to edit
another active owner's files.

| Active owner                                  | Exclusive source ownership                                                                                                                                                          | Integration boundary                                                                                                    |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Integrator, ops-C, electron/integration       | src/main/index.ts, src/main/ipc/**, src/main/modules/runtime/**, src/main/modules/ledger/**, docs/electron/**; minimal scaffold ipc.ts adapter replacement requested by coordinator | CoreServices/settings projection, typed request registry, ledger, worker collector and application composition          |
| Plans library, completed                      | src/main/modules/plans/**                                                                                                                                                           | collectOverview(config, {signal}) executed by the ledger's emitted worker entry                                         |
| Skills library, completed                     | src/main/modules/skills/**                                                                                                                                                          | SkillsService with canonical embedded skill, shared SettingsStore adapter and workspace provider                        |
| Settings owner, ops-B, electron/settings-core | src/main/lib/safe-io/**; src/main/modules/settings/**, workspaces/**, tasks/**, activity/**                                                                                         | CoreServices uses real version1 config, Tasks/pointers/moves, PlanActions and ActivityLog; no duplicated business rules |
| Windows owner, ops-E, electron/platform       | src/main/modules/platform/**, src/main/modules/logging/**                                                                                                                           | Inject environment/startup/trash/notification and window/tray/picker/shell/logging services                             |
| React owner, ops-D, electron/react-ui         | src/renderer/**, src/shared/contracts/**                                                                                                                                            | Canonical renderer-facing RequestMap/ResponseMap/EventMap; preload bridge migration must be coordinated with this owner |
| Delivery owner, ops-A, electron/packaging     | src/main/modules/updater/**, installer and release files                                                                                                                            | Updater handlers/events, restart barrier and installed-only bootstrap migration                                         |

Root dependency additions go through WP1; WP7 specifies builder/updater settings without racing
WP1's lockfile. A domain owner also owns co-located tests beneath its production directory
(including existing settings/store.test.ts); domain E2E uses electron-tests/ on the existing
Playwright configuration. Only WP1 changes shared
fixtures/harness after a request. Golden data is synthetic, frozen from the baseline and includes
provenance, never copied from the owner's Tasks or AI profiles. Only WP7 removes obsolete Go
build/CI/runtime source at the final retirement checkpoint; until then baseline sources remain
read-only differential inputs. Contract documents are frozen during the parallel wave; the
coordinator assigns a single owner for a contract amendment.

## WP1 — foundation and secure bridge

Build the main/preload/React/Vite skeleton with the process isolation and strict production CSP.
Set compatible data and separate Electron session paths before readiness. Development must use
a temporary/explicit sandbox data folder and fail before touching the owner's defaults.
Define every channel/request/result/event and strict runtime schemas from the IPC document,
service interfaces and typed fakes, capability gates and method-only preload surface.
Own cross-cutting atomic IO, byte guards and Windows file/path identity;
WP5 supplies native picker/environment/shell operations through the agreed adapters.

Acceptance:

- Typecheck/build/lint pass for all three processes; renderer bundle contains no Node import.
- Every declared request/event has a schema and fake; unknown fields/channels, foreign sender,
  subframe and untrusted URL fail before an effect; unsubscribe removes listeners.
- Packaged policy has no eval/inline script, remote content, HTTP listener or development HMR
  origin; navigation/window creation and permissions fail closed.
- IO tests prove old file remains on failure, temp cleanup, bounded lock retry, link/identity
  checks and compare-before-replace. Recycling performs the final realpath/hash/fixed-drive check;
  the controller accepted the final-millisecond race documented in the parity matrix, without a
  native spanning lock. Real Recycle Bin/restore checks still use disposable files.
- Harness redirects all profile/data/session/environment effects and detects attempted access
  outside fixture roots. Frozen baseline fixtures include source commit and deterministic clocks.

## WP2 — collector, refresh and ledger stores

Port the exact Go parser/overview contract, Tasks-first collection/deduplication, metadata-only
worktrees, stable Windows IDs/paths and read-only Git handling. Port diff, seeding, stale detection,
store bounds, warning generation and last-good behavior. Add Tasks watching to the known baseline
watcher gap with event coalescing plus full reconciliation. Keep main responsive and prevent
timed-out collectors overlapping accepted file actions.

Acceptance:

- Differential suite covers all overview fields, legacy/current markers, fences, aliases, UTF-8,
  duplicate steps, status priority, timestamps, large/missing/locked files and Tasks dedupe.
- Diffs/seed/stale/rename/move and all persisted stores match controlled Go results; event map
  iteration order is compared semantically only where baseline order is unspecified.
- Refresh failure keeps overview/time/history, current warning state and retry behavior; empty
  sources are healthy; no source bytes or directories are changed by collection.
- Watch tests cover Tasks-only edit, workspace creation/rename/delete, legacy edit, missing root,
  dropped event and disconnected drive; queued invalidation cannot lose a newer generation.
- IPC state:refresh/get and state:changed work with real preload/renderer in an isolated E2E.

## WP3 — compatible settings and safe plan actions

Implement all config/nested keys, load-vs-action validation, corrupt/newer/read-only behavior,
workspace summaries and CRUD. Implement Tasks selection and pointers using an injected
environment writer, previous-folder state, optional moves and per-file report. Implement
archive overrides and revision-checked recycle using WP1 handle protection/WP5 trash adapter.
Keep actual plan bytes read-only except explicit move/removal; never accept an arbitrary source
path from a renderer. Preserve partial success of a saved Tasks folder when a move fails.

Acceptance:

- Config version1 roundtrips every key, optional/missing defaults, old integrations input through
  WP4 conversion interface, newer version/read failure remains untouched; saves serialize.
- Workspace duplicate/overlap/root/name/disabled/override behavior matches baseline fixtures;
  settings projections and warning counts agree.
- Tasks validation covers UNC/device/drive/data/workspace overlap and junctions; inside-workspace
  requires explicit repeat confirmation. Pointers are unchanged when same and test env writer
  never touches real HKCU.
- Moves prove backup first, exclusive target/no overwrite, mtime, late-source change recovery,
  links outside root refused, unknown keys failed row and all counts/settings in partial reports.
- Archive true/false has zero source-byte effects. Delete requires confirm + current revision,
  validated key/file identity and successful trash-only adapter; missing/locked/changed/unsafe
  sources fail without unlink. W gate restores a disposable plan from the actual Recycle Bin.

## WP4 — Skills and remaining legacy migrations

Implement canonical embedded skill, detection suggestions, target CRUD/state/diff and all seven
file actions. Preserve guarded marker/hash/backups and owner text. Port the incomplete
pre-ledger migration, integration-object conversion, project-key upgrades, journal/backoff and
post-health run-data retirement; respect done journal and real-profile/installed boundaries.
Provide the same optional guarded cleanup for NSIS uninstall; no second file-edit implementation.

Acceptance:

- No install on detection, refresh or ordinary app update; setup selections start unchecked.
- Install/update/replace/keep/remove and reminder on/off cover every state, disabled cleanup,
  path changes, duplicate/link/inside-workspace cases and final-byte race.
- Diff is escaped and bounded; BOM/newline/outside text survives; failed backup/modified file
  does not get overwritten; removal from list leaves installed file unchanged.
- Old synthetic profile corpus migrates idempotently, keeps edited/linked files and manual
  checklist, preserves unrelated JSON order/hooks/text, seeds targets once and retries with
  exact journal bounds/backoff.
- Failed bootstrap rollback restores only still-owned hashes; post-health retirement is scoped
  and backed up. Real installed config/profiles are never used in tests. No business-plan source
  or acceptance state migration is introduced.

## WP5 — Windows desktop and lifecycle

Create app-owned window/tray, lifecycle/instance/protocol activation, icon theme choice,
notifications/AUMID, startup, Explorer/link/clipboard and picker/trash adapters. Build the
installed-only capability implementation and fake implementation for development/tests.
Coordinate native file-handle sharing with WP1 without editing WP1 files concurrently.

Acceptance:

- `requestSingleInstanceLock` focuses existing normal launch, keeps background quiet and queues
  cold/warm Unicode protocol activation. Closing window keeps tray; tray Quit exits cleanly.
- Tray menu/counts/system contrast, native icons, AUMID notification gating/click and startup
  off/preserved preference are verified with fakes and then disposable Windows smoke.
- `dialog.showOpenDialog` uses actual parent and remembered location, correct folder/file mode;
  Cancel and timeout close only its owned dialog and release lock after confirmed closure;
  Promise timeout is not accepted as native cancellation evidence.
- `shell.trashItem` rejects unsafe/non-recyclable/locked paths and has no permanent deletion
  fallback; verify actual trash restore under WP3/WP1 revision/handle protection.
- Production alone can register startup/protocol/environment; tests perform zero real registry
  writes. Open-folder/external-link bridge cannot pass arbitrary paths or protocols.

## WP6 — React UI parity

Port current ledger UX, not historical Board/Timeline layouts. Implement routes, navigation,
Overview/List/attention/archive/plan sections, exact source-row navigation, keyboard/command
palette, setup/Settings/Skills/Tasks flows and update/error/crash surfaces through the bridge.
Retain stable React keys/focus/scroll across refresh. Keep owner content safe and app copy plain.
Use system fonts as current source does; don't revive older CDN assets or hidden branch/agent UI.

Acceptance:

- Port behavior cases of web_test.mjs into component/Electron tests with the same source
  fixtures; all routes/Back/Forward/old fragments, encoded keys and malformed links covered.
- Actual Ctrl+1/2 behavior and help agree; single-key shortcuts obey preference/typing; keyboard
  focus, default-Cancel delete and command palette restoration pass.
- List filter drafts, groups/sort/full completion denominator, milestone collapse/loose steps,
  duplicate names, archived direct access, stars/recent/open tabs and refresh focus/caret/scroll
  match baseline. Stage never inferred from percent complete.
- Setup only installs checked Skills; Tasks confirmation defaults move-existing, reports failures
  per file and preserves chosen folder. Read-only/modified/timeout/error states are actionable.
- One bounded update surface, no focus stealing, redacted diagnostics copy and escaped plan/
  notes/diffs pass at 1600x1000, 900x800 and 600x800, both themes, reduced motion/forced colors.
- Bootstrap fresh UI profile is explicit; Electron-to-Electron update retains navigation without
  reading or changing Edge's profile files.

## WP7 — updater, diagnostics and delivery

Wrap electron-updater for the fixed public release provider; preserve check/skip/explicit apply
semantics, safe notes, normalized phases and mutation barrier. Add redacted local logs/crash
handling. Build unsigned NSIS per-user install/uninstall with the one-time Go replacement,
exact-process ownership, backup/health receipt and guarded optional Skills cleanup. Update release
docs and CI only when the application satisfies parity. No Go runtime ships in the package.

Acceptance:

- Update adapter tests prove stable selected-version guard, one operation, no automatic download
  or install on ordinary quit/next launch, including cached pending installers; pinned updater
  option behavior is verified rather than inferred from older API examples.
- Offline/rate-limit/bad checksum/incomplete metadata errors preserve running app/data, expose
  safe messages and retain recovery feedback. Public provider needs no credential; isolated
  test feed cannot be set through renderer IPC.
- Logs rotate/bound, crash notice dismisses, redacted copy contains no sentinel source text,
  paths/names or raw errors. No telemetry/crash-upload destination exists.
- Isolated VM installs over Go once, preserves all config/stores/pointers/unknown recovery data
  and startup choice, removes Go runtime, creates owned shortcut/protocol/AUMID/Apps entry and
  checks exact Electron process/version/initial state via private nonce receipt. Forced failure
  restores bootstrap files/registrations and guarded migration effects.
- Real Electron N-1 to N uses NSIS metadata/assets through an isolated feed, restarts to exact
  new version, preserves task hashes/Skills/client config/activity/preferences and exercises
  failed-update reinstall recovery. Go post-start automatic rollback is explicitly not claimed.
- Uninstall default keeps data, optional Skills cleanup honors hash conflicts before removing
  registrations, unrelated registry/apps survive, AGENT_OPS_TASKS removed, Tasks sources remain.
- Artifact contains only intended app/resources/notices, no Go/fixtures/private data; verify PE
  icon sizes/theme variants, version/changelog/tag, dependency audit, typecheck/unit/E2E and
  installer/update smoke. Build token read-only; release job only drafts with write token.

## Integration and retirement checkpoints

After scaffold, freeze shared schemas and named service interfaces. Next integrate reader/settings/
Skills/native services into WP1's composition root and run isolated UI E2E. Then exercise Windows
picker cancellation, Recycle Bin/restore, activation/startup and bootstrap in a VM; retain the
explicitly accepted final-millisecond recycle limitation.
Finally verify Electron-to-Electron updates and recovery; only then remove Go source/build/runtime
references and transition CI. Keep immutable baseline fixtures/provenance outside shipped assets.

Each package reports owned files, commit(s), acceptance evidence and failures honestly. A typed
stub or mocked native effect is not functional completion. The existing baseline command is
`scripts/test.ps1 -VulnerabilityScan`; until retirement it must remain green. Use the scaffold's
typecheck/lint/test/build/smoke scripts and add differential/component/audit/package/native checks
through the relevant owner rather than introducing a parallel throwaway test stack. All
development and smoke data remains disposable.

No owner question is outstanding for these fixed decisions. Package versions, native adapter
selection and precise installer receipt mechanics are engineering choices to prove against this
contract. Failing a native gate requires an engineering fix or an explicitly reviewed contract
change; it does not permit silently dropping baseline protections.
