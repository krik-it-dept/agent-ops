# Release readiness

The application is Electron + TypeScript. The Go beta and its build/release pipelines are retired.
Matching its quirks is not an acceptance criterion. Safe replacement and retained beta data remain
required.

## Automated gates

Run npm ci, typecheck, lint, test, build, smoke, package and smoke:packaged. Tests use synthetic
plans, temporary data/AI profiles, OS fakes and frozen regression fixtures. They cover strict IPC/
CSP, reader refresh/watch/cancellation, shared settings, Skills hash/backup guards, plan actions,
platform adapters and updater failures.

Electron flows exercise real files through Workspace/Skills/Tasks setup, live changes, archive,
confirmed fake trash, guarded skill writes, preferences, initial protocol activation and a fake
update provider. Packaged smoke verifies real setup/ledger, Result IPC, resources/icons, disabled
samples/test hooks and read-only health. These checks never install the app on the developer's PC.

## Native release checks still required

- In a disposable Windows account/VM, install over a representative beta and verify retained
  settings/backups/plans, exact-path process stopping and interrupted-bootstrap recovery.
- Check actual picker/cancel/timeout, tray/notification branding, Recycle Bin restoration and
  locked-file behavior, startup/protocol/environment registration and uninstall.
- Check a published stable N-1 to N update, failure recovery and the restart notice.
- Inspect native icons, focus, light/dark surfaces and accessibility on Windows.

The installer is intentionally unsigned. Checksums detect corruption; release trust depends on
the release account. Automated fakes do not claim those native checks succeeded.

## Known limits

Recycling rechecks identity, real path, hash and fixed local drive immediately before
shell.trashItem. No native write lock spans that call: a file changed in the last milliseconds
may still be recycled, and remains recoverable from the Recycle Bin. The owner accepted this.

Headless --health-check validates config/resources without changing checked data. NSIS commit/
recovery is not yet gated on its receipt: recovery recognises completed extraction by file
presence. Adding a check only at customInstall would leave that retry path unsafe, so a shared
tested health transaction remains installer follow-up work.

Keep app data and plans during recovery. Use local logs and redacted diagnostics; never publish
private plans, AI profiles or session logs. The workflow creates a draft for owner review.
