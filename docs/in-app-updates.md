# In-app updates

Agent Ops checks the latest stable release in the fixed private repository `krik-it-dept/agent-ops` shortly after startup and every six hours. Open **Updates** for the installed version, release notes and a manual check. New releases show **Update now**, **Skip this version** and **Cancel**. Only an explicit Update now request installs software. F5 remains the task-progress check.

## Authentication and integrity

The Windows host needs GitHub CLI signed in to an account with read access to this private repository. The app reuses that CLI's existing credential handling; it never sends a token to the browser, stores a new token or opens an unattended login prompt. Missing CLI/access/network failures appear in the dialog with a retry path. This uses the official [release download command](https://cli.github.com/manual/gh_release_download) and [latest-release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

The app accepts stable `vMAJOR.MINOR.PATCH` releases only, compares numeric components and never downgrades. Before installation it verifies the ZIP checksum, GitHub asset size and digest when supplied, exact archive contents, safe paths, expanded size and the downloaded executable's reported version. Release notes are rendered as escaped text. The release repository and asset names are fixed in code; HTTP requests cannot supply a download URL, install directory or executable.

SHA-256 detects corruption and mismatch with the trusted GitHub release. It does not replace code signing or protect against a compromised release maintainer. The existing local-user trust boundary still applies.

## Replacement and recovery

1. Download and validate into a new private directory under `<data-dir>/updates/` while the old app keeps running.
2. Start the verified staged executable as a separate helper. It rechecks every staged file and confirms the exact parent process image before signaling readiness.
3. Stop accepting status writes, finish an in-flight collector/status operation and exit the old process.
4. Back up the fixed runtime allowlist, any existing legacy executable alias, and managed reporting-instruction files. Atomically replace runtime files and run the idempotent skill installer against the configured profile. The installer records the sha256 of each part it writes (the two `task-plan/SKILL.md` copies, the Agent Ops hooks in `~/.claude/settings.json`, and each managed instruction block) in `~/.agents/workboard-integrations.json`. It replaces a part only while it still holds exactly what was last written, or, before any record exists, the text of an earlier release. A part you edited or removed is left alone, and the update result names it as "modified locally" or "removed locally".
5. Restart with the same resolved task roots, state file, slots, collector, loopback address, app-data directory and profile. Verify the new version, exact new PID and successful state collection.
6. If installation, instruction installation or startup fails, restore the saved files and restart the previous app. An incomplete recovery is reported honestly with the backup location retained.

Task Markdown, execution/historical registries, activity, browser profile, navigation preferences and owner data are not replacement targets. Backups and a small result receipt stay under the data directory. There is no recursive cleanup of live runtime or task directories.

Recovery failures remain visible after restart instead of being immediately overwritten by a startup check. A manual check acknowledges the message; the six-hour retry schedule remains available.

The open UI notices a changed server version, saves its current filters, plan/group/collapse state, scroll and quick view, then reloads itself. It restores that snapshot only for the expected new version. Ordinary startup still uses the usual default filters.

`--profile-dir` selects the profile whose managed instructions are maintained; default is the current user. `--no-update-check` disables automatic checks, while leaving explicit checks available. These flags support isolated validation and portable setups. Updating from a release older than the updater requires one initial bootstrap installation; subsequent releases use the in-app action.

## Validation

Unit tests cover version ordering, private-release errors, CSRF/read boundaries, ZIP traversal/unknown entries/symlinks/duplicates, checksum and version mismatch, staged-file tampering, runtime/profile rollback, exact-process health and write rejection during restart. UI tests cover notes escaping, skip/cancel/apply, duplicate submission, expected disconnect and view restoration.

`node scripts/smoke.mjs` validates the package without contacting GitHub. After publishing the version in VERSION, `node scripts/update-smoke.mjs` builds an isolated `v0.0.0` test instance of the updater, downloads the actual private release and exercises replacement/restart. This is a test fixture of the current updater, not a claim that historical releases already supported updates. Its profile, data, port and task roots are isolated from the live installation.
