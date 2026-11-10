# In-app updates

Agent Ops checks the latest stable release of the public repository `krik-it-dept/agent-ops` shortly after startup and every six hours. A new release appears as a non-modal card at the bottom right and as **Update available** in the status bar; nothing opens a dialog by itself. The card offers **Update and restart**, **Skip this version** and **Dismiss** (remembered per version until a newer one ships). **Settings > About** shows the installed version, release notes, **Check for updates**, **Open logs folder** and **Copy diagnostics**. Only an explicit Update and restart request installs software. F5 remains the task-progress check.

## Channel

From v0.2.1 the app needs no GitHub CLI and no credentials:

- Discovery: an anonymous `GET https://api.github.com/repos/krik-it-dept/agent-ops/releases/latest` ([latest-release API](https://docs.github.com/en/rest/releases/releases#get-the-latest-release)) with an ETag, so repeated checks are cheap against the 60-requests-per-hour anonymous limit. Drafts and prereleases are never returned by this endpoint and are rejected anyway.
- Download: `https://github.com/krik-it-dept/agent-ops/releases/download/<tag>/<asset>` over HTTPS through the environment proxy. The URL is built from fixed parts and the validated tag; a response never supplies it. Redirects are followed only to HTTPS GitHub hosts (`github.com`, `*.githubusercontent.com`).
- Offline, rate-limited (with the reset time), missing-release and unexpected-response cases each show a specific message. Response bodies are never shown.

Releases up to v0.2.0 still use `gh` for their last update, to v0.2.1. The repository is public, so any signed-in `gh` works.

`--update-feed http://127.0.0.1:<port>` replaces both GitHub endpoints with one loopback test server. Only the literal origin `http://127.0.0.1:<port>` is accepted (not `localhost`, which the hosts file can redirect, nor `::1`). The flag stays in release builds because the N-1 to N test runs release binaries. It exists for isolated update tests and does not widen the trust boundary: a local user can already replace the installed files.

## Package manifest

Each release has three assets:

| Asset | Content |
| --- | --- |
| `agent-ops-windows-amd64.zip` | The runtime files |
| `agent-ops-windows-amd64.zip.sha256` | `<sha256>  agent-ops-windows-amd64.zip` |
| `agent-ops-windows-amd64.manifest.json` | `{format, version, files:[{path, sha256, size}], remove:[...]}` |

The updater validates the package against the manifest plus fixed rules, not against a file list compiled into the running version (`internal/pkgmanifest`):

- Paths are relative with forward slashes; no absolute or drive paths, `.`/`..` segments, backslashes, colons (alternate data streams), spaces, control characters, Windows device names or trailing dots; at most 8 levels and 160 characters.
- Allowed extensions: `.exe .dll .mjs .js .cjs .ps1 .md .txt .json .ico .png`. `remove` entries cannot be `.json`, because user registries in the runtime folder are JSON; an update never deletes data.
- At most 256 files, 128 MB per file and in total; `agent-ops.exe` is required; no duplicates (case-insensitive) and no file that is also a folder of another.
- The ZIP must hold exactly the manifest's files with their exact sizes and SHA-256 digests, plus parent folder entries and an optional `manifest.json` byte-identical to the asset. Every entry is checked before anything is written, and each file is hashed again during extraction.
- The manifest's `version` must equal the release tag, and the downloaded `agent-ops.exe --version` must report it.

Files in `remove` are backed up with the replaced files, deleted after the new files are written (with folders the deletion emptied), and restored by a rollback.

Format 1 readers ignore unknown JSON fields. A change that older updaters must understand to stay safe needs a new `format` and a new asset name, published next to the format 1 manifest while older installs exist.

### Why the manifest is a separate asset (the v0.2.0 bridge)

The v0.2.0 updater rejects any ZIP entry outside its compiled list and any missing one. To let v0.2.0 installs update in the app, the v0.2.1 ZIP held exactly the v0.2.0 file set, and the manifest is published as its own asset, which v0.2.0 ignores.

From v0.3.0 the file set changes (the run reporting modules are removed through `remove`, the task-plan skill is embedded in the executable), so only v0.2.1 or later can install it in the app. A v0.2.0 install that never took v0.2.1 fails safely ("Incomplete update package") and keeps running; install the release package by hand once. The retired `task-sync.mjs` and `task-report.mjs` stay in the package as small stubs, so older sessions and hooks that call them keep working.

### Compatibility rules for later releases

- The staged helper is always the new version. It must accept every handoff version an installed release can write: 1 (v0.2.0) and 2 (v0.2.1+, hashes of the manifest files plus `remove`).
- The relaunch reuses the previous version's arguments. A new version must keep accepting every flag an older release passes (`--background --addr --script --data-dir --profile-dir --repos-dir --state-file --slots-file --no-update-check --update-feed`).
- The helper's health check reads `/api/updates` (`current`, `processId`) and `/api/state` (`appVersion`, `error`, `state.plans`). Later versions must keep these fields.
- From v0.3.0 the helper runs no script from the package. It runs the one-time migration from earlier releases in process (see below). A move of the install folder (M6) is done by the new version's own helper.
- The relaunch of an earlier release names its data folder `%LOCALAPPDATA%\krik-workboard`; the new version maps that folder to `%LOCALAPPDATA%\AgentOps`, so the helper writes the result there.

## Integrity

Trust model (owner decision, 2026-11-10): the manifest is not signed; update safety rests on HTTPS to fixed GitHub URLs and on the security of the `krik-it-dept` GitHub account and its release workflow, so whoever controls that account can ship an update every install accepts.

SHA-256 detects corruption and a mismatch with the GitHub release, and the GitHub asset digest and size are checked when supplied. It does not replace code signing (not used, by owner decision) or protect against a compromised release maintainer. The existing local-user trust boundary still applies. Release notes are rendered as escaped text. HTTP requests to the app cannot supply a download URL, install directory or executable.

## Replacement and recovery

1. Download and validate into a new private directory under `<data-dir>/updates/` while the old app keeps running. Older staging folders are pruned; the newest three are kept, each holding the backup of its update.
2. Start the verified staged executable as a separate helper. It rechecks every staged file against the handoff and confirms the exact parent process image before signaling readiness.
3. Stop accepting status writes, finish an in-flight collector/status operation and exit the old process.
4. Back up the files to replace or remove, any existing legacy executable alias, and the AI client files the migration may change (skills, instruction files, every Claude `settings.json` of the profile including Orca's). Atomically replace runtime files and delete the `remove` files.
5. Once per data folder (until `migration.json` exists), run the client part of the migration from earlier releases: copy `config.json` into the new data folder, remove the retired reporting hooks and unedited instruction blocks, replace unedited old skills and carry the old integration record into `config.json`. Every change is backed up into `<data-dir>\backups\migration-<time>` and written atomically. See [INSTALL.md](../INSTALL.md#moving-from-earlier-releases-v02x-and-older).
6. Restart with the same loopback address (when one was set explicitly), data folder and profile, keeping the session so an open window keeps working. Find the new app through its `session.json` (it may have fallen back to another port), then verify the new version, exact new PID and successful state collection with the session secret.
7. Only then delete the old run history (backed up first) and record `migration.json`. The update result names the files that were kept because the owner changed them, and how many owner-written lines still mention the old name (listed in Settings > Integrations).
8. If installation, the client migration or startup fails, restore the saved install-folder files (including removed ones) and restart the previous app. AI client files are not in that backup set: the migration records each file it changed with the hash of its content before and after, and the rollback puts a file back only while it still holds exactly what the migration wrote. A file that changed since (Claude Code, Orca or the owner wrote it) is left as it is and listed in the update result and log, and a client file is deleted only when the migration created it. A later update that does not migrate never touches client files. An incomplete recovery is reported honestly with the backup location retained.

Later updates never write AI client files: a newer embedded task-plan skill only shows as **Update available** in Settings > Integrations, where the owner installs it.

Task Markdown, activity, browser profile, navigation preferences and owner data are not replacement targets. There is no recursive cleanup of live runtime or task directories; pruning touches only `<data-dir>/updates/update-<digits>` folders that are real directories.

Recovery failures remain visible after restart instead of being overwritten by a startup check. The open UI notices a changed server version, saves its view state and reloads itself.

## Logs and diagnostics

- `<data-dir>\logs\agent-ops.log`, rotated at 1 MB with five files kept: start, plan refresh failures and recovery, update steps, notification failures and crashes.
- `<data-dir>\logs\update.log`: the update helper's steps, including rollback. It is the new version's data folder (`%LOCALAPPDATA%\AgentOps` also when the update starts from v0.2.x), which Settings > General > Open logs folder shows.
- `<data-dir>\migration.json`: the one-time migration's latest result and up to five earlier ones. A run with errors is not done: the next update, installer run or app start retries it (15 minutes after the first attempt, doubling up to a day), and Settings > Integrations > Review by hand lists the errors and the next retry. Problems only the owner can fix (a linked file, settings that are not valid JSON or UTF-8) are listed there instead of keeping the migration open.
- Background work and HTTP handlers recover panics, log the stack and write `<data-dir>\crash.json`; long-lived loops restart with a growing delay. Fatal Go runtime output goes to `logs\fatal.log`; on the next start it is archived as `fatal-<time>.log` and becomes a crash marker. A crash marker shows a non-modal notice with **Open logs** and **Dismiss**.
- **Copy diagnostics** copies versions, Windows build, Go and Node.js versions, a settings summary (counts and switches), a fixed category for a refresh failure (`timeout`, `collector failed`, `state folder`, `state invalid`, `project unreadable (n)`), the update phase with an error flag, and the last crash's version, kind, time and count. It never includes error text, crash messages, plan content, project names or paths. Nothing is sent anywhere.
- The log records refresh failures by category and length, not their text. Update and crash entries can contain folder paths on this computer, so the UI says not to post logs publicly.

## Release flow

1. Bump `VERSION` and add a `## vX.Y.Z` section to `CHANGELOG.md` in a PR; merge it to `main`.
2. Tag the merge commit and push the tag: `git tag vX.Y.Z origin/main && git push origin vX.Y.Z`.
3. `.github/workflows/release.yml` checks that the tag equals `VERSION` and is on `main`, runs tests, vet, the vulnerability scan, the build, the package smoke and the N-1 to N update test in a `build` job with a read-only token that is not persisted, then a separate `publish` job, the only one with `contents: write` and running no repository code, re-checks the ZIP checksum and creates a **draft** release with the three assets and the changelog section as notes.
4. Review the draft on GitHub and click **Publish release**. Installed apps see it within six hours, or at once with **Check for updates**.

A build of any commit that is not tagged with `VERSION` reports `vX.Y.Z-dev.<commit>`; the updater never offers updates to it and never installs it.

## Validation

- Go unit tests cover the path rules and manifest validation, version ordering, anonymous checks with ETag reuse, rate-limit/offline/missing/unexpected responses, redirect host rules, the loopback feed rule, release asset requirements, ZIP-versus-manifest mismatches (traversal, unknown, duplicate, symlink, size, digest, embedded manifest), the full download-verify-handoff path against a local HTTP feed, tamper detection, the v0.2.0 handoff format, install with removals and rollback, staging pruning, exact-process health, logging, crash markers and diagnostics redaction.
- `node scripts/smoke.mjs` validates the package and its manifest without contacting GitHub.
- `node scripts/update-e2e.mjs [--from vX.Y.Z]` builds the previous release from its tag and the current source as N, N+1 and N+2, then, fully isolated (temp runtime, profile, data, port and task folder; no GitHub): installs the previous release, whose installer writes its reporting hooks, blocks and skills into the temp profile (plus an Orca Claude profile copy); updates it to N with its own updater and N's real manifest (removing the retired modules), checking that the migration removed hooks and blocks, replaced the unedited skill, kept the owner-edited one as "modified locally" and deleted the run history with backups; then N to N+1 over the HTTP feed with a manifest that adds and removes files (the migration does not run again), and N+1 to N+2 whose plan collector fails (a fixture build linked with `-X main.testFault=collector`), which must roll back to N+1 without bringing a hook back and without overwriting a client file edited during the failed start. By default it runs that scenario from the newest earlier release and a second one from the bridge release v0.2.1 with `LOCALAPPDATA` redirected into the temp profile for both apps (no `--data-dir`): v0.2.1 first takes a broken N whose start fails, and the rollback must restore v0.2.1, the hooks, the blocks and the replaced skill and remove the config.json copy; then v0.2.1 takes N, whose data folder moves from the old default to the Agent Ops folder with config.json copied and the update log there. `--from` runs only the first scenario. CI and the release workflow run it. It needs the release tags (`git fetch --tags`).
