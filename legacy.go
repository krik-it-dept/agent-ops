package main

// Names from releases before v0.3.0, when the product was called Workboard. They
// are used only to migrate an existing installation (data folder, registry
// entries, install folder, client integrations) and to read relaunch arguments
// of an older release. Nothing new is ever written under these names. This file,
// migrate.go and their tests are the only Go sources allowed to contain them
// (see TestOldProductNameOnlyInMigrationCode).

const (
	// %LOCALAPPDATA%\krik-workboard: the data folder up to v0.2.x.
	legacyDataDirName = "krik-workboard"
	// The install folder up to v0.2.x, relative to the user profile. The install
	// folder itself moves in a later release; until then it stays in use.
	legacyRuntimeRel = `.claude\tools\workboard`
	// An executable alias that very early installs kept next to agent-ops.exe.
	legacyAliasExe = "krik-workboard.exe"
	// HKCU\Software\Classes\krik-workboard: the URL protocol up to v0.2.x.
	legacyProtocol = "krik-workboard"
	// The Run key value name up to v0.2.x.
	legacyRunValue = "KRIK Workboard"

	// Managed instruction block markers written by the reporting installer.
	legacyBlockStart = "<!-- workboard-task-reporting:start -->"
	legacyBlockEnd   = "<!-- workboard-task-reporting:end -->"
	// The command of a Claude hook the reporting installer wrote contains both.
	legacyHookScript = "task-sync.mjs"
	legacyHookFlag   = "--claude-hook"
	// The reporting installer's record of what it wrote, in <profile>\.agents.
	legacyIntegrationsFile = "workboard-integrations.json"
	// Run history written by task-report.mjs next to the generated state file.
	legacyExecutionsDir = "workboard-executions"
	// The skill template placeholder for the install folder.
	legacySkillPlaceholder = "{{WORKBOARD_DIR}}"
	// The old product name, searched (case-insensitively) in owner-authored text.
	legacyProductName = "workboard"
)

// Run history registries that the collector read from the install folder.
var legacyRegistryFiles = []string{"historical-executions.json", "agent-attributions.json"}

// sha256 (LF line endings, unrendered) of every task-plan SKILL.md template the
// reporting installer shipped. A copy that still matches one of them, after its
// install-folder path is put back as the placeholder, was never edited.
var legacySkillTemplates = map[string]bool{
	"36ceb5048cc5a8b9605c4850d905cf4a66f44c464bf3753de3e9e8d53f47b5de": true,
	"4cad5a07f6c9362b0413cc6efd52c5e6445b13f46ac7c580084cb2d16b29db4d": true,
}

// legacyBlockText returns the two variants of the managed instruction block the
// reporting installer wrote for one client ("Codex", "Anti" or "Claude"); skill is
// the shared skill path it named, with forward slashes.
func legacyBlockText(client, skill string) []string {
	block := legacyBlockStart + "\n## Shared Workboard task reporting\n\n" +
		"This client identity is " + client + ". Direct work uses `Agent: " + client + "` and `Executor: " + client + "`. A delegated CLI worker preserves the parent Agent and reports its own actual execution with `task-report.mjs --role executor`. Workboard is an execution log; clients self-report start, progress and results without owner assignment in the app. For substantial work or progress updates, read `" + skill + "` before implementation.\n" +
		"Write the shared plan under `.tasks/` in the repository main checkout, including reporter identity, and publish per-task execution evidence through the shared skill. Update it at real stage/milestone changes, blocks, handoffs and before the final response, then use the `task-sync.mjs` command defined by the protocol. Private chat checklists and brain artifacts alone do not update Workboard.\n" +
		"Use only observed progress; preserve work owned by other sessions and respect repository restrictions. Do not create plans for trivial work. Never claim a refresh succeeded if the command failed.\n" + legacyBlockEnd
	managed := block[:len(block)-len(legacyBlockEnd)] + "When WORKBOARD_HOST_REPORTING=1, the host runner already records this CLI execution. Do not duplicate its lifecycle reports or widen the worker sandbox for reporting.\n" + legacyBlockEnd
	return []string{block, managed}
}
