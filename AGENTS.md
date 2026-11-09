# Agent Ops development

This repository is the Windows desktop Workboard application and shared reporting protocol. Read README.md, INSTALL.md and docs/release-readiness.md before release work.

- Keep the UI an execution/progress monitor. Agent identity is read-only and clients report observed execution. Do not assign agents by guessing from text or the last file writer.
- User task sources, historical registries, session logs and installed profiles are private runtime data. Never commit them or rewrite another session's plan as part of app development.
- Keep the service loopback-only. Preserve Host/Origin/CSRF validation, hashed-script CSP, revision checks and Windows file locking.
- Shared client workflow has one canonical source: skills/task-plan/SKILL.md. The installer renders the runtime path and preserves existing global instructions with backups. Test all three client identities and delegated execution.
- Validate with scripts/test.ps1 -VulnerabilityScan. Build/package with scripts/build.ps1 and verify native icons. Run release/install smoke checks in isolated directories and ports.
- Source development belongs in this repository. The installed runtime is a deployment target; preserve its data and publish tested runtime files together.
- Talk to the owner in concise Vietnamese; code comments and repository documentation are English.

The business-task hierarchy and richer problem/impact brief remain a separately reviewed migration. Presentation changes must not silently infer new acceptance states or move legacy evidence.
