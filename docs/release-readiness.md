# Release readiness: Agent Ops

Audit date: 2026-11-09. Target: a private, trusted-local Windows x64 desktop tool, not a public multi-user service.

## Findings resolved

- Refresh now requires a same-origin protected POST; an unrelated web page cannot trigger the collector.
- All HTTP routes reject unexpected Host, Origin and cross-site browser metadata, including state reads and SSE. Loopback binding alone was insufficient against DNS rebinding.
- Responses include script-hash CSP, frame denial, MIME-sniffing protection and no-referrer policy. Inline script hashing normalizes browser line endings.
- The collector and reporting helpers now live in one source/package tree. Runtime discovery supports the executable's directory and legacy profile locations.
- Skill installation renders the actual runtime path, quotes paths containing spaces, validates managed blocks before writing and preserves other instructions with backups.
- Release files use an explicit allowlist. Private task sources, logs, historical registries and browser/app state are excluded from Git and packages.
- The source has Windows CI, reproducible validation/build commands, checksum output, install instructions and rollback guidance.
- Native executable resources are generated from the approved artwork and verified at 16, 24, 32, 48 and 256 pixels.

## Gate evidence

| Area | Evidence / disposition |
| --- | --- |
| Security | Automated request-boundary/CSRF tests; HTTP smoke rejects rebinding Host and foreign Origin; source-path/revision/Windows-lock tests; actual page CSP hash verified |
| Build | Windows Go build, module verification and vet; dependency versions locked in go.mod/go.sum; no frontend build dependencies |
| Tests | 120 JavaScript tests plus Go package tests pass; source code syntax checks pass |
| Dependencies | govulncheck v1.9.0 reports no known vulnerabilities reachable in the Go application; no npm runtime packages |
| Configuration | Isolated install at a path with spaces, isolated profile/task roots/port/data, repeated installation and portable collector discovery pass |
| Observability | Failed refresh retains last good state and exposes failure; actual timestamps and evidence remain distinct from process liveness |
| Data integrity | Revision conflicts, exclusive file access, agent read-only API and preserved unrelated plan bytes are tested; refresh smoke leaves fixture task source unchanged |
| Deployment | ZIP allowlist, checksum, native icon verification and actual extracted-package install/HTTP/SSE/F5 smoke pass; CI runs the same pipeline |
| Skill security | Canonical task-plan scan reports zero critical/high/info findings; identity/delegation, malformed instructions, idempotency and all three clients have tests |
| UI | DOM tests cover navigation, filters, grouping, workload counts, quick view, semantic colors and progressive disclosure. A read-only real-data HTML check also verified open tasks remain visible, completed tasks collapse, and IDs are unique. This is not a visual screenshot sign-off. |

Cloud database, cloud login, public TLS, payment and cloud-infrastructure scanner checks are not applicable. The app has no model/API dependency. Host/Origin checks protect against unrelated browser sites, not hostile software already running as the same user. Task prose is data, not authority to execute commands.

### Static scanner triage

The generic ship-gate scanner is a web/cloud heuristic, not an automatic approval for this desktop stack. Its initial clean-source summary was DO_NOT_SHIP because unanswered cloud/manual checks count as failures. Raw local reports are private audit artifacts and are not packaged. Each material flag was reviewed:

| Check | Disposition |
| --- | --- |
| SEC-02/03/10, DB-01/02/04/11, DEPLOY-01/02 | No cloud authentication/session/database/production server exists; local-boundary protection and runtime backups are assessed separately above |
| SEC-07 | False auth-route detection from words such as registerProtocol and login in tray code/comments; there is no login endpoint. Refreshes serialize through a mutex and the collector has a timeout. |
| SEC-14 | False positives on local variables named key in path/argument parsing; no credentials were present in the flagged lines |
| CODE-03 | Optional browser-preference fallbacks are now explicitly documented; they do not swallow task-write or collector failures |
| DEPLOY-10, OBS-01/03/05 | CLI receipts intentionally use stdout/JSON and errors use stderr; local persisted event records and visible refresh failures replace a cloud logging/uptime service. External telemetry is not installed. |
| DEPLOY-05/06 | Rollback instructions and extracted-package isolated smoke are present and exercised |
| SEC-05/06/13 | Scanner cannot recognize the Go/embedded-JS handlers; request validation, constrained source writes and escaped rendering are covered by actual code tests |

No scanner failure was converted into a claim that an unavailable manual visual check passed.

## Release limits and follow-up

- Native Edge/Explorer visual inspection was unavailable in this automation session. Check small icon rendering, light/dark surfaces and keyboard focus on the owner's desktop after reopening. Native PE resources have been verified; Explorer may cache an old icon.
- The internal Windows binary is unsigned. From v0.1.2, release checks and user-confirmed in-app updates are available; older installations require one bootstrap installation.
- Font display uses the official Atlassian CDN and falls back to system fonts offline. Agent marks are bundled locally. No full upstream design-system files are redistributed.
- Old running client sessions must read the updated reporting instructions before they start reporting; installation cannot prove those sessions have loaded them.
- Business hierarchy migration and richer problem/impact/acceptance briefs remain unapproved drafts. No legacy task source or acceptance state was migrated for this release.

## Recheck and rollback

Run `./scripts/test.ps1 -VulnerabilityScan`, `./scripts/build.ps1`, then `node scripts/smoke.mjs` from a clean Windows checkout. The smoke uses only isolated temporary roots and stops only the process it created. The package contains no test task data.

Follow INSTALL.md to quit the old process, install and roll back from runtime/instruction backups. Do not roll back or delete live task sources, execution reports or user preferences as part of a code rollback.

## 2026-11-10: plan alignment and grouped progress

Full-plan headings, tabs and all content sections now share the workspace gutter instead of independently centered maximum widths. List group headers retain the explicit plan stage, whole-plan done/total and percentage in both expanded and collapsed states. Matching-task counts are separate and filters do not change the completion denominator. Header chevrons use centered SVGs.

The JavaScript suite now has 123 tests, including filtered/collapsed progress, same-named plans, stage/completion independence and refresh updates. Native visual inspection was attempted but Computer Use stopped because it could not confidently determine the Edge URL. No visual sign-off is claimed for this patch; automated DOM and extracted-package checks remain the verification path.

## 2026-11-10: in-app updater

The updater is scoped to the fixed private release repository. The GitHub credential stays in the existing CLI; the browser only sees version, notes and operation status. All actions retain local request protection. Downloads are checked against their checksum and GitHub digest/size; ZIP contents and paths are allowlisted. A separate verified helper waits for the exact old process, backs up runtime/instructions, installs and checks the replacement process/version/state. Recovery restores the previous files. In-flight task writes finish before the old process exits.

127 JavaScript tests and the expanded Go suite cover the update UI, reload restoration, request boundaries, version and ZIP validation, staging tamper detection, backup/rollback and exact-process health. Package smoke remains isolated and disables automatic GitHub checks. The optional real-release round trip and operational details are documented in docs/in-app-updates.md.

## 2026-11-10: v0.2.1 release and update foundation

The updater validates a package against a manifest release asset (files, sizes, SHA-256, removals) and fixed path rules instead of a compiled file list, so later releases can change the file set. The v0.2.1 ZIP keeps the exact v0.2.0 file set and the helper accepts the v0.2.0 handoff, so v0.2.0 installs update in the app. Release discovery and downloads are anonymous HTTPS against the public repository; no GitHub CLI or token. A tag push drafts the release after all checks and an isolated N-1 to N update test (previous tag built from source, then a manifest add/remove update and a forced rollback). Local logs (rotating, size-capped), panic recovery with a crash notice, fatal-output capture, Copy diagnostics without plan content or project paths, staging pruning and dev versions for untagged builds were added. The binary remains unsigned by owner decision; SHA-256 and the GitHub digest detect corruption, not a compromised maintainer. Details: docs/in-app-updates.md.

## 2026-11-10: delegated worker reporting

The missing don-backlog identities came from a legacy plan with no Agent header and direct sandboxed Codex CLI launches with no execution reports. Reviewed Claude/Codex session evidence identified Claude as coordinator and Codex in both worktrees; private attribution registries were updated without changing source plan bytes or status. Reviewed native evidence can opt into an unambiguous exact-task anchor across unrelated edits; renamed/duplicate tasks do not inherit it, and old records keep strict revision matching.

The host CLI runner now records the actual spawned client before/after execution without requiring writes from inside the worker sandbox. Its run-scoped terminal records preserve the source business-task status. Claude reporting hooks load the shared workflow and reject plan writes lacking an explicit coordinator; they never assign executors. The installer preserves unrelated Claude settings/hooks, and updater backups now also cover the settings file.
