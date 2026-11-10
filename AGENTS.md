# Agent Ops development

This repository is the Agent Ops Windows desktop application: a read-only work ledger of the plans in each repository's `.tasks/`. Read README.md, INSTALL.md and docs/release-readiness.md before release work.

- Keep the app a reader: it records no runs, attributes no agents and never writes plans. Orchestration belongs to Orca.
- User task sources, session logs and installed profiles are private runtime data. Never commit them or rewrite another session's plan as part of app development.
- Keep the service loopback-only. Preserve Host/Origin/CSRF validation (`X-Agent-Ops` header) and the hashed-script CSP.
- The task-plan skill has one canonical source, skills/task-plan/SKILL.md, embedded in the executable and installed only from Settings > Integrations. AI client files are written only on the owner's action or by the one-time migration, always with a backup, an atomic replace and a hash or marker guard. Tests use temporary profiles only.
- The old product names appear only in legacy.go, migrate.go and their tests; TestOldProductNameOnlyInMigrationCode enforces it.
- Validate with scripts/test.ps1 -VulnerabilityScan. Build/package with scripts/build.ps1 and verify native icons. Run release/install smoke checks in isolated directories and ports.
- Source development belongs in this repository. The installed runtime is a deployment target; preserve its data and publish tested runtime files together.
- Talk to the owner in concise Vietnamese; code comments and repository documentation are English.

The business-task hierarchy and richer problem/impact brief remain a separately reviewed migration. Presentation changes must not silently infer new acceptance states or move legacy evidence.
