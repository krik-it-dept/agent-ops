package main

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// The migration only ever runs against temporary profiles here: userHomeDir
// still names the real home, so APPDATA, LOCALAPPDATA and CLAUDE_CONFIG_DIR are
// derived from the temporary profile instead.

func mput(t *testing.T, file, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(content), 0o600); err != nil {
		t.Fatal(err)
	}
}

func mread(t *testing.T, file string) string {
	t.Helper()
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func legacyHooks(runtime string) string {
	cmd := `node \"` + runtime + `/task-sync.mjs\" --claude-hook`
	return `"hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "` + cmd + `", "timeout": 5}]}],
    "PreToolUse": [{"matcher": "Write|Edit", "hooks": [{"type": "command", "command": "` + cmd + `", "timeout": 5}]}],
    "PostToolUse": [
      {"matcher": "Write|Edit|Bash", "hooks": [{"type": "command", "command": "` + cmd + `", "timeout": 5}]},
      {"matcher": "Bash", "hooks": [{"type": "command", "command": "echo owner && date", "timeout": 3}]}
    ]
  }`
}

type migrationFixture struct {
	profile, runtime, data, legacyData, states string
	opts                                       migrationOptions
	skillShared, skillClaude, ownerSkill       string
	orca                                       []string
}

func newMigrationFixture(t *testing.T) migrationFixture {
	t.Helper()
	root := isolated(t)
	f := migrationFixture{profile: filepath.Join(root, "profile"), runtime: filepath.Join(root, "runtime"), states: filepath.Join(root, "profile", "states")}
	f.data = filepath.Join(f.profile, "AppData", "Local", "AgentOps")
	f.legacyData = filepath.Join(f.profile, "AppData", "Local", legacyDataDirName)
	runtimeSlash := filepath.ToSlash(f.runtime)
	shared := filepath.ToSlash(filepath.Join(f.profile, ".agents", "skills", "task-plan", "SKILL.md"))
	// Claude settings: owner keys and hook around the reporting hooks.
	mput(t, filepath.Join(f.profile, ".claude", "settings.json"), "{\n  \"model\": \"opus\",\n  \"permissions\": {\"allow\": [\"Bash(git status)\"]},\n  "+legacyHooks(runtimeSlash)+",\n  \"env\": {\"A\": \"<&>\"}\n}\n")
	for _, id := range []string{"p1", "p2"} {
		file := filepath.Join(f.profile, "AppData", "Roaming", "orca", "claude-profiles", id, "home", "settings.json")
		mput(t, file, "\ufeff{\r\n  \"theme\": \"dark\",\r\n  "+strings.ReplaceAll(legacyHooks(runtimeSlash), "\n", "\r\n")+"\r\n}\r\n")
		f.orca = append(f.orca, file)
	}
	blocks := func(client string) []string { return legacyBlockText(client, shared) }
	mput(t, filepath.Join(f.profile, ".claude", "CLAUDE.md"), "# Owner rules\nTasks-overview feeds the Workboard page.\n\n"+blocks("Claude")[1]+"\n")
	mput(t, filepath.Join(f.profile, ".codex", "AGENTS.md"), "# Codex\n\n"+strings.Replace(blocks("Codex")[0], "Use only observed progress", "Owner edit: use only observed progress", 1)+"\n")
	mput(t, filepath.Join(f.profile, ".gemini", "GEMINI.md"), "\n"+blocks("Anti")[1]+"\n")
	// Skills: an unedited legacy template and an owner-edited one.
	template := strings.ReplaceAll(mread(t, filepath.Join("testdata", "legacy-task-plan-skill.md")), legacySkillPlaceholder, runtimeSlash)
	f.skillShared = filepath.Join(f.profile, ".agents", "skills", "task-plan", "SKILL.md")
	f.skillClaude = filepath.Join(f.profile, ".claude", "skills", "task-plan", "SKILL.md")
	f.ownerSkill = template + "\n## Workspace root (owner)\n- Keep this section; it mentions Workboard.\n"
	mput(t, f.skillShared, template)
	mput(t, f.skillClaude, f.ownerSkill)
	mput(t, filepath.Join(f.profile, ".agents", legacyIntegrationsFile), `{"version":1,"parts":{".claude/settings.json#hooks":"aa",".codex/AGENTS.md#block":"bb",".agents/skills/task-plan/SKILL.md#file":"cc"}}`)
	// The previous data folder with settings (including retired slots) and history.
	repos := filepath.Join(root, "repos")
	os.MkdirAll(filepath.Join(repos, "web", ".git"), 0o700)
	mput(t, filepath.Join(f.legacyData, "config.json"), `{"version":1,"setupComplete":true,"notifications":true,"shortcuts":true,"slotsFile":"C:\\slots.json","stateFile":`+jsonString(filepath.Join(f.states, "tong-hop-chung.json"))+`,"projects":[{"id":"`+projectIDFor(repos)+`","path":`+jsonString(repos)+`,"name":"repos","kind":"folder","enabled":true,"addedAt":"2026-01-01T00:00:00Z"}]}`)
	mput(t, filepath.Join(f.legacyData, "activity.jsonl"), `{"kind":"execution-report","plan":"p"}`+"\n")
	mput(t, filepath.Join(f.legacyData, "snapshot.json"), `{}`)
	mput(t, filepath.Join(f.legacyData, "state", legacyExecutionsDir, "run.json"), `{"event":"start"}`)
	mput(t, filepath.Join(f.legacyData, "logs", "agent-ops.log"), "keep the logs")
	mput(t, filepath.Join(f.states, legacyExecutionsDir, "run.json"), `{"event":"done"}`)
	mput(t, filepath.Join(f.states, "tong-hop-chung.json"), `{"plans":[]}`)
	for _, name := range legacyRegistryFiles {
		mput(t, filepath.Join(f.runtime, name), `{"private":true}`)
	}
	f.opts = migrationOptions{Profile: f.profile, DataDir: f.data, LegacyDataDir: f.legacyData, RuntimeDir: f.runtime, Now: time.Date(2026, 11, 10, 18, 0, 0, 0, time.UTC)}
	return f
}

func jsonString(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestMigrationRemovesReportingAndKeepsOwnerText(t *testing.T) {
	f := newMigrationFixture(t)
	before := map[string]string{}
	for _, file := range append([]string{filepath.Join(f.profile, ".claude", "settings.json"), filepath.Join(f.profile, ".claude", "CLAUDE.md"), filepath.Join(f.profile, ".gemini", "GEMINI.md"), f.skillShared}, f.orca...) {
		before[file] = mread(t, file)
	}
	r, err := runMigration(f.opts)
	if err != nil || len(r.Errors) != 0 {
		t.Fatal(err, r.Errors)
	}
	// Hooks: only the reporting hooks are gone; owner keys, order and hook stay.
	settings := mread(t, filepath.Join(f.profile, ".claude", "settings.json"))
	if strings.Contains(settings, "task-sync") || !strings.Contains(settings, `"command": "echo owner && date"`) || strings.Contains(settings, "SessionStart") || strings.Contains(settings, "PreToolUse") {
		t.Fatal(settings)
	}
	if !(strings.Index(settings, `"model"`) < strings.Index(settings, `"permissions"`) && strings.Index(settings, `"permissions"`) < strings.Index(settings, `"hooks"`) && strings.Index(settings, `"hooks"`) < strings.Index(settings, `"env"`)) || !strings.Contains(settings, `"A": "<&>"`) {
		t.Fatal("key order or text changed", settings)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(settings), &parsed); err != nil {
		t.Fatal(err)
	}
	for _, file := range f.orca {
		b := mread(t, file)
		if strings.Contains(b, "task-sync") || !strings.HasPrefix(b, "\ufeff{\r\n") || !strings.Contains(b, "echo owner && date") || strings.Contains(b, "SessionStart") || !strings.Contains(b, "\"theme\": \"dark\"") || strings.Count(b, "\n") != strings.Count(b, "\r\n") {
			t.Fatalf("Orca profile %s: %q", file, b)
		}
	}
	if len(r.HooksRemoved) != 3 {
		t.Fatal("hooks removed from", r.HooksRemoved)
	}
	// Blocks: the unedited ones are removed, owner text outside is untouched.
	if got := mread(t, filepath.Join(f.profile, ".claude", "CLAUDE.md")); got != "# Owner rules\nTasks-overview feeds the Workboard page.\n" {
		t.Fatalf("%q", got)
	}
	if exists(filepath.Join(f.profile, ".gemini", "GEMINI.md")) {
		t.Fatal("a file that held only the block was kept")
	}
	if codex := mread(t, filepath.Join(f.profile, ".codex", "AGENTS.md")); !strings.Contains(codex, legacyBlockStart) || !strings.Contains(codex, "Owner edit") {
		t.Fatal("an edited block was removed", codex)
	}
	// Skills: the unedited template is replaced, the owner's copy is kept.
	if got := mread(t, f.skillShared); got != string(embeddedSkill) {
		t.Fatal("unedited legacy skill not replaced")
	}
	if got := mread(t, f.skillClaude); got != f.ownerSkill {
		t.Fatal("owner-edited skill changed")
	}
	if !strings.Contains(strings.Join(r.Kept, ";"), f.skillClaude+" (modified locally)") || !strings.Contains(strings.Join(r.Kept, ";"), filepath.Join(f.profile, ".codex", "AGENTS.md")+" (modified locally)") {
		t.Fatal(r.Kept)
	}
	// Checklist: owner lines that still mention the old name, never block lines.
	found := map[string]bool{}
	for _, item := range r.Checklist {
		found[filepath.Base(item.File)] = true
		if strings.Contains(item.Text, "Shared Workboard task reporting") {
			t.Fatal("a managed line is in the checklist", item)
		}
	}
	if !found["CLAUDE.md"] || !found["SKILL.md"] || !found["AGENTS.md"] {
		t.Fatalf("%+v", r.Checklist)
	}
	// Settings copied once, slots dropped, old record carried, skill recorded.
	cfg, err := readAppConfig(configFilePath(f.data))
	if err != nil || len(cfg.Projects) != 1 || cfg.StateFile != filepath.Join(f.states, "tong-hop-chung.json") || !r.ConfigCopied {
		t.Fatal(err, cfg)
	}
	if raw := mread(t, configFilePath(f.data)); strings.Contains(raw, "slotsFile") {
		t.Fatal("slots carried over", raw)
	}
	// The folder list is seeded from the skill folders found, not from fixed
	// clients: Orca profiles and ~/.gemini have no skill, so they stay suggestions.
	if len(cfg.Integrations) != 2 {
		t.Fatalf("%+v", cfg.Integrations)
	}
	byDir := map[string]IntegrationTarget{}
	for _, it := range cfg.Integrations {
		byDir[strings.ToLower(it.SkillDir)] = it
		if it.Source != "detected" || !it.Enabled || it.InstructionBlock {
			t.Fatalf("%+v", it)
		}
	}
	shared, claude := byDir[strings.ToLower(filepath.Dir(filepath.Dir(f.skillShared)))], byDir[strings.ToLower(filepath.Dir(filepath.Dir(f.skillClaude)))]
	if shared.Version != embeddedSkillVersion || shared.SHA256 != sha256Hex([]byte(lfText(embeddedSkill))) || shared.LegacySHA256 != "cc" || shared.InstructionFile != filepath.Join(f.profile, ".codex", "AGENTS.md") {
		t.Fatalf("%+v", shared)
	}
	if claude.SHA256 != "" || claude.Label != "Claude Code" || skillState(claude).State != "modified" || skillState(shared).State != "installed" {
		t.Fatalf("%+v %+v", claude, skillState(claude))
	}
	if exists(filepath.Join(f.profile, ".agents", legacyIntegrationsFile)) {
		t.Fatal("old integration record not deleted")
	}
	// History deleted, everything else of the old data folder kept.
	for _, gone := range []string{filepath.Join(f.legacyData, "activity.jsonl"), filepath.Join(f.legacyData, "snapshot.json"), filepath.Join(f.legacyData, "state"), filepath.Join(f.states, legacyExecutionsDir), filepath.Join(f.runtime, legacyRegistryFiles[0]), filepath.Join(f.runtime, legacyRegistryFiles[1])} {
		if exists(gone) {
			t.Fatal("not deleted:", gone)
		}
	}
	for _, kept := range []string{filepath.Join(f.legacyData, "config.json"), filepath.Join(f.legacyData, "logs", "agent-ops.log"), filepath.Join(f.states, "tong-hop-chung.json")} {
		if !exists(kept) {
			t.Fatal("deleted:", kept)
		}
	}
	// Every changed or deleted file is in the backup.
	for file, content := range before {
		rel, _ := filepath.Rel(f.profile, file)
		if got := mread(t, filepath.Join(r.Backup, "profile", rel)); got != content {
			t.Fatal("backup differs for", file)
		}
	}
	if b := mread(t, filepath.Join(r.Backup, "data", strings.ReplaceAll(filepath.Join(f.states, legacyExecutionsDir, "run.json"), ":", ""))); b != `{"event":"done"}` {
		t.Fatal("history backup", b)
	}
	if !migrationDone(f.data) || readMigrationResult(f.data) == nil {
		t.Fatal("migration not recorded")
	}
	summary := migrationSummary(r)
	if !strings.Contains(summary, "Your changes were kept") || !strings.Contains(summary, f.skillClaude+" (modified locally)") || !strings.Contains(summary, "Backup: ") {
		t.Fatal(summary)
	}

	// A second run changes nothing.
	snapshot := map[string]string{}
	filepath.Walk(f.profile, func(path string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && !strings.Contains(path, filepath.Join("AgentOps", "backups")) && !strings.HasSuffix(path, migrationFile) {
			snapshot[path] = mread(t, path)
		}
		return nil
	})
	f.opts.Now = f.opts.Now.Add(time.Hour)
	again, err := runMigration(f.opts)
	if err != nil || len(again.HooksRemoved)+len(again.BlocksRemoved)+len(again.SkillsReplaced)+len(again.Deleted) != 0 || again.ConfigCopied || len(again.Errors) != 0 {
		t.Fatalf("second run: %v %+v", err, again)
	}
	for path, content := range snapshot {
		if got, err := os.ReadFile(path); err != nil || string(got) != content {
			t.Fatal("second run changed", path)
		}
	}
}

func TestMigrationStripsRunHistoryFromASharedDataFolder(t *testing.T) {
	root := isolated(t)
	data := filepath.Join(root, "data")
	mput(t, filepath.Join(data, "activity.jsonl"), `{"kind":"execution-report","plan":"p"}`+"\n"+`{"kind":"done","plan":"p","text":"Step","agent":"Codex","executors":["Codex"]}`+"\n"+`{"kind":"assignment","plan":"p"}`+"\n")
	mput(t, filepath.Join(data, "snapshot.json"), `{"r/p":{"name":"p","agent":"Codex","executionReports":[],"slot":null,"steps":[{"text":"a","executors":["Codex"],"execution":{"state":"doing"}}],"milestones":[{"steps":[{"text":"a","sourceStatus":"done"}]}]}}`)
	mput(t, filepath.Join(data, "state", legacyExecutionsDir, "x.json"), "{}")
	r := &migrationResult{}
	retireLegacyData(migrationOptions{Profile: filepath.Join(root, "profile"), DataDir: data, Now: time.Now()}, r)
	if len(r.Errors) != 0 || exists(filepath.Join(data, "state", legacyExecutionsDir)) {
		t.Fatal(r.Errors)
	}
	activity := mread(t, filepath.Join(data, "activity.jsonl"))
	if strings.Contains(activity, "execution-report") || strings.Contains(activity, "assignment") || strings.Contains(activity, "Codex") || !strings.Contains(activity, `"text":"Step"`) {
		t.Fatal(activity)
	}
	snapshot := mread(t, filepath.Join(data, "snapshot.json"))
	for _, key := range []string{"agent", "executionReports", "slot", "executors", "execution", "sourceStatus"} {
		if strings.Contains(snapshot, `"`+key+`"`) {
			t.Fatal(key, snapshot)
		}
	}
	if !strings.Contains(snapshot, `"name":"p"`) {
		t.Fatal(snapshot)
	}
}

// A copied config.json can name a real state folder; an isolated profile's
// migration must never delete anything outside its own folders.
func TestIsolatedMigrationDeletesNothingOutsideItsFolders(t *testing.T) {
	root := isolated(t)
	outside := filepath.Join(root, "real-states")
	mput(t, filepath.Join(outside, legacyExecutionsDir, "run.json"), "{}")
	profile := filepath.Join(root, "profile")
	data := filepath.Join(profile, "AppData", "Local", "AgentOps")
	cfg := defaultAppConfig()
	cfg.StateFile = filepath.Join(outside, "tong-hop-chung.json")
	if err := writeAppConfig(configFilePath(data), cfg); err != nil {
		t.Fatal(err)
	}
	mput(t, filepath.Join(data, "state", legacyExecutionsDir, "run.json"), "{}")
	r, err := runMigration(migrationOptions{Profile: profile, DataDir: data, Now: time.Now()})
	if err != nil {
		t.Fatal(err)
	}
	if !exists(filepath.Join(outside, legacyExecutionsDir, "run.json")) {
		t.Fatal("deleted run history outside the isolated profile")
	}
	if exists(filepath.Join(data, "state", legacyExecutionsDir)) {
		t.Fatal("run history inside the data folder was kept")
	}
	if !strings.Contains(strings.Join(r.Kept, ";"), "outside this instance's own folders") {
		t.Fatal(r.Kept)
	}
}

func TestHelperMovesOnlyTheDefaultDataFolder(t *testing.T) {
	t.Setenv("LOCALAPPDATA", `C:\Users\me\AppData\Local`)
	if app, legacy := helperDataDirs(`C:\Users\me\AppData\Local\` + legacyDataDirName); app != `C:\Users\me\AppData\Local\AgentOps` || legacy == "" {
		t.Fatal(app, legacy)
	}
	if app, legacy := helperDataDirs(`D:\isolated\data`); app != `D:\isolated\data` || legacy != "" {
		t.Fatal(app, legacy)
	}
}

func TestClientPathsOutsideAProfileAreUsedOnlyForTheRealHome(t *testing.T) {
	profile := filepath.Join(isolated(t), "profile")
	t.Setenv("CLAUDE_CONFIG_DIR", `C:\real\claude`)
	t.Setenv("APPDATA", `C:\real\roaming`)
	if homes := claudeHomes(profile); len(homes) != 1 || homes[0] != filepath.Join(profile, ".claude") {
		t.Fatal(homes)
	}
	if profileRoamingAppData(profile) != filepath.Join(profile, "AppData", "Roaming") || profileLocalAppData(profile) != filepath.Join(profile, "AppData", "Local") {
		t.Fatal("isolated profile reached the real application data")
	}
	old := userHomeDir
	t.Cleanup(func() { userHomeDir = old })
	userHomeDir = func() (string, error) { return profile, nil }
	if homes := claudeHomes(profile); len(homes) != 2 || homes[1] != `C:\real\claude` {
		t.Fatal(homes)
	}
}

func TestSettingsEditKeepsFormatAndOnlyRemovesMatchingHooks(t *testing.T) {
	original := []byte("{\n  \"hooks\": {\n    \"Stop\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"node C:/x/task-sync.mjs --claude-hook\"\n          },\n          {\n            \"type\": \"command\",\n            \"command\": \"notify \\u00e9t\\u00e9\"\n          }\n        ]\n      }\n    ],\n    \"Empty\": []\n  },\n  \"n\": 1.50\n}\n")
	out, n, err := settingsWithoutHooks(original, "task-sync.mjs")
	if err != nil || n != 1 {
		t.Fatal(err, n)
	}
	want := "{\n  \"hooks\": {\n    \"Stop\": [\n      {\n        \"hooks\": [\n          {\n            \"type\": \"command\",\n            \"command\": \"notify été\"\n          }\n        ]\n      }\n    ],\n    \"Empty\": []\n  },\n  \"n\": 1.50\n}\n"
	if string(out) != want {
		t.Fatalf("%s", out)
	}
	same, n, err := settingsWithoutHooks([]byte(`{"a":1}`), "task-sync.mjs")
	if err != nil || n != 0 || string(same) != `{"a":1}` {
		t.Fatal("an unrelated file was rewritten")
	}
	if _, _, err := settingsWithoutHooks([]byte(`{"a":`), "x"); err == nil {
		t.Fatal("invalid JSON accepted")
	}
}

func TestRemoveBlockLeavesTextOutsideTheMarkers(t *testing.T) {
	block := "<!-- s -->\nx\n<!-- e -->"
	for _, tc := range []struct{ in, want string }{
		{"owner\n\n" + block + "\n", "owner\n"},
		{"owner\r\n\r\n" + block + "\r\n", "owner\r\n"},
		{"top\n" + block + "\nbottom\n", "top\nbottom\n"},
		{block + "\n", ""},
		{"a\n\n" + block + "\n\nb\n", "a\n\n\nb\n"},
	} {
		a, b, found, ok := findBlock(tc.in, "<!-- s -->", "<!-- e -->")
		if !found || !ok {
			t.Fatal(tc.in)
		}
		if got := removeBlock(tc.in, a, b); got != tc.want {
			t.Fatalf("%q -> %q, want %q", tc.in, got, tc.want)
		}
	}
	if _, _, found, ok := findBlock("x <!-- s --> y", "<!-- s -->", "<!-- e -->"); !found || ok {
		t.Fatal("an incomplete block must be reported")
	}
}

func TestLegacyTemplatesAreRecognisedOnlyWhenUnedited(t *testing.T) {
	template := mread(t, filepath.Join("testdata", "legacy-task-plan-skill.md"))
	if !legacySkillTemplates[sha256Hex([]byte(lfText([]byte(template))))] {
		t.Fatal("the test fixture is not a shipped template")
	}
	rendered := strings.ReplaceAll(template, legacySkillPlaceholder, "C:/Users/Some One/.claude/tools/x")
	if !unmodifiedLegacySkill([]byte(strings.ReplaceAll(rendered, "\n", "\r\n")), "") {
		t.Fatal("a rendered template with CRLF was not recognised")
	}
	if unmodifiedLegacySkill([]byte(rendered+"\nowner\n"), "") || unmodifiedLegacySkill(embeddedSkill, "") {
		t.Fatal("an edited or new skill was taken for a template")
	}
	block := legacyBlockText("Codex", "C:/p/.agents/skills/task-plan/SKILL.md")[0]
	if !knownLegacyBlock(block, "Codex", "") || knownLegacyBlock(block, "Claude", "") || knownLegacyBlock(strings.Replace(block, "trivial", "small", 1), "Codex", "") {
		t.Fatal("block recognition")
	}
	if !knownLegacyBlock(block+" ", "Codex", sha256Hex([]byte(block+" "))) {
		t.Fatal("a recorded hash must be trusted")
	}
}

func TestEmbeddedSkillIsStaticAndVersioned(t *testing.T) {
	text := string(embeddedSkill)
	if embeddedSkillVersion != 2 || skillVersionOf(embeddedSkill) != 2 {
		t.Fatal("agent-ops-skill version", embeddedSkillVersion)
	}
	for _, retired := range []string{"{{", "task-sync", "task-report", "--run-cli", "slots", legacyProductName, "Workboard"} {
		if strings.Contains(text, retired) {
			t.Fatal("static skill mentions", retired)
		}
	}
	for _, needed := range []string{"git rev-parse --path-format=absolute --git-common-dir", "Next:", "Status:", "Goal:", "## Decisions", "## Questions", "Summary:", "Waiting for owner", "## migrate", "## close", "Orca"} {
		if !strings.Contains(text, needed) {
			t.Fatal("static skill lacks", needed)
		}
	}
	if !bytes.HasPrefix(embeddedSkill, []byte("---\nname: task-plan\n")) {
		t.Fatal("front matter")
	}
}

// Only the hook shape the reporting installer wrote is removed; an owner hook
// that runs task-sync.mjs another way stays.
func TestMigrationRemovesOnlyTheInstallerHookShape(t *testing.T) {
	original := []byte(`{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"node C:/rt/task-sync.mjs --claude-hook"},{"type":"command","command":"node C:/owner/task-sync.mjs status --plan x"}]}]}}`)
	out, n, err := settingsWithoutHooks(original, legacyHookScript, legacyHookFlag)
	if err != nil || n != 1 {
		t.Fatal(err, n)
	}
	if !strings.Contains(string(out), "task-sync.mjs status --plan x") || strings.Contains(string(out), "--claude-hook") {
		t.Fatalf("%s", out)
	}
	if _, n, _ := settingsWithoutHooks(original); n != 0 {
		t.Fatal("no marker must match nothing")
	}
}

// A failed start rolls back only the files the migration changed and that still
// hold what it wrote. Edits made since (Claude Code, Orca, the owner) survive, a
// file recreated since is not deleted, and the config.json copy is removed.
func TestClientRollbackRestoresOnlyUnchangedMigrationWrites(t *testing.T) {
	f := newMigrationFixture(t)
	activity := filepath.Join(f.data, "activity.jsonl")
	mput(t, activity, `{"kind":"execution-report","plan":"p"}`+"\n"+`{"kind":"done","plan":"p"}`+"\n")
	ledger := filepath.Join(f.profile, ".agents", legacyIntegrationsFile)
	gemini := filepath.Join(f.profile, ".gemini", "GEMINI.md")
	restored := []string{filepath.Join(f.profile, ".claude", "settings.json"), filepath.Join(f.profile, ".claude", "CLAUDE.md"), f.skillShared, ledger, activity, f.orca[1]}
	before := map[string]string{}
	for _, file := range append(restored, f.orca[0], gemini) {
		before[file] = mread(t, file)
	}
	r, err := migrateClients(f.opts)
	if err != nil || len(r.Errors) != 0 {
		t.Fatal(err, r.Errors)
	}
	if !exists(configFilePath(f.data)) || exists(gemini) || exists(ledger) || len(r.Writes) < 8 {
		t.Fatal("fixture did not migrate as expected", len(r.Writes))
	}
	claudeEdit := strings.Replace(mread(t, f.orca[0]), `"theme"`, `"model": "sonnet",`+"\r\n  "+`"theme"`, 1)
	mput(t, f.orca[0], claudeEdit)
	mput(t, gemini, "# Written after the migration\n")
	problems := rollbackClients(r)
	for _, file := range restored {
		if mread(t, file) != before[file] {
			t.Fatal("not restored:", file)
		}
	}
	if mread(t, f.orca[0]) != claudeEdit || mread(t, gemini) != "# Written after the migration\n" {
		t.Fatal("a file changed after the migration was overwritten")
	}
	if exists(configFilePath(f.data)) {
		t.Fatal("the config.json copy this run created was kept, so a retry would not copy newer settings")
	}
	joined := strings.Join(problems, "\n")
	if len(problems) != 2 || !strings.Contains(joined, f.orca[0]) || !strings.Contains(joined, gemini) {
		t.Fatal(problems)
	}
	if again := rollbackClients(r); len(again) != 0 {
		t.Fatal("a second rollback did something", again)
	}
}

// asRealHome makes the fixture profile stand in for this user's real home, with
// APPDATA and LOCALAPPDATA inside it, so the real home rules apply to temp files.
func asRealHome(t *testing.T, f migrationFixture) {
	t.Helper()
	old := userHomeDir
	t.Cleanup(func() { userHomeDir = old })
	userHomeDir = func() (string, error) { return f.profile, nil }
	t.Setenv("LOCALAPPDATA", filepath.Join(f.profile, "AppData", "Local"))
	t.Setenv("APPDATA", filepath.Join(f.profile, "AppData", "Roaming"))
	t.Setenv("CLAUDE_CONFIG_DIR", "")
}

// An isolated -RuntimeDir or --data-dir used with the default (real) profile must
// delete nothing outside its own folders and edit no AI client file, even when
// the data folder is the default one; only the installed instance migrates.
func TestIsolatedInstanceWithTheRealProfileDeletesNothingOutsideItsFolders(t *testing.T) {
	legacyItems := func(f migrationFixture) []string {
		return []string{filepath.Join(f.legacyData, "activity.jsonl"), filepath.Join(f.legacyData, "snapshot.json"), filepath.Join(f.legacyData, "state", legacyExecutionsDir, "run.json"), filepath.Join(f.states, legacyExecutionsDir, "run.json"), filepath.Join(f.profile, ".agents", legacyIntegrationsFile)}
	}
	untouched := func(t *testing.T, f migrationFixture, r *migrationResult) {
		t.Helper()
		for _, item := range legacyItems(f) {
			if !exists(item) {
				t.Fatal("deleted outside the instance's folders:", item)
			}
		}
		for _, file := range append([]string{filepath.Join(f.profile, ".claude", "settings.json")}, f.orca...) {
			if !strings.Contains(mread(t, file), "task-sync.mjs") {
				t.Fatal("edited a client file of the real home:", file)
			}
		}
		if len(r.HooksRemoved)+len(r.BlocksRemoved)+len(r.SkillsReplaced) != 0 || !strings.Contains(strings.Join(r.Kept, ";"), "not the installed Agent Ops") {
			t.Fatal(r)
		}
	}
	t.Run("isolated runtime, default data folder", func(t *testing.T) {
		f := newMigrationFixture(t)
		asRealHome(t, f)
		if !samePath(f.data, defaultDataDir()) {
			t.Fatal("fixture data folder is not the default", f.data)
		}
		mput(t, filepath.Join(f.data, "activity.jsonl"), `{"kind":"execution-report","plan":"p"}`+"\n")
		r, err := runMigration(f.opts)
		if err != nil {
			t.Fatal(err)
		}
		untouched(t, f, r)
		if !strings.Contains(mread(t, filepath.Join(f.data, "activity.jsonl")), "execution-report") {
			t.Fatal("stripped the default data folder from an isolated runtime")
		}
		for _, name := range legacyRegistryFiles {
			if exists(filepath.Join(f.runtime, name)) {
				t.Fatal("kept run history in the isolated runtime's own folder:", name)
			}
		}
	})
	t.Run("installed runtime, isolated data folder", func(t *testing.T) {
		f := newMigrationFixture(t)
		asRealHome(t, f)
		installed := filepath.Join(f.profile, legacyRuntimeRel)
		for _, name := range legacyRegistryFiles {
			mput(t, filepath.Join(installed, name), `{"private":true}`)
		}
		own := filepath.Join(filepath.Dir(f.profile), "isolated-data")
		mput(t, filepath.Join(own, "state", legacyExecutionsDir, "run.json"), "{}")
		opts := f.opts
		opts.RuntimeDir, opts.DataDir, opts.LegacyDataDir = installed, own, ""
		r, err := runMigration(opts)
		if err != nil {
			t.Fatal(err)
		}
		untouched(t, f, r)
		for _, name := range legacyRegistryFiles {
			if !exists(filepath.Join(installed, name)) {
				t.Fatal("deleted the installed instance's registry:", name)
			}
		}
		if exists(filepath.Join(own, "state", legacyExecutionsDir)) {
			t.Fatal("kept run history in the isolated data folder")
		}
	})
	t.Run("installed instance", func(t *testing.T) {
		f := newMigrationFixture(t)
		asRealHome(t, f)
		installed := filepath.Join(f.profile, legacyRuntimeRel)
		for _, name := range legacyRegistryFiles {
			mput(t, filepath.Join(installed, name), `{"private":true}`)
		}
		opts := f.opts
		opts.RuntimeDir = installed
		r, err := runMigration(opts)
		if err != nil || len(r.Errors) != 0 {
			t.Fatal(err, r.Errors)
		}
		for _, item := range append(legacyItems(f), filepath.Join(installed, legacyRegistryFiles[0])) {
			if exists(item) {
				t.Fatal("the installed instance kept legacy run history:", item)
			}
		}
		if strings.Contains(mread(t, filepath.Join(f.profile, ".claude", "settings.json")), "task-sync.mjs") {
			t.Fatal("the installed instance left the hooks")
		}
	})
}

// A migration with errors is not done: it keeps its result in the new data
// folder, is retried only after its backoff, and a later run keeps the earlier
// results and the backup path of the last run that changed something.
func TestMigrationWithErrorsIsRetriedWithBackoffAndKeepsEarlierResults(t *testing.T) {
	f := newMigrationFixture(t)
	t0 := f.opts.Now
	mput(t, configFilePath(f.data), "{") // unreadable settings: the old record cannot be carried over yet
	r, err := runMigration(f.opts)
	if err != nil || len(r.Errors) == 0 {
		t.Fatal("expected a recorded problem", err, r.Errors)
	}
	saved := readMigrationResult(f.data)
	if saved == nil || saved.Done || migrationDone(f.data) || saved.Attempts != 1 || saved.NextRetryAt != t0.Add(15*time.Minute).UTC().Format(time.RFC3339) {
		t.Fatal("a migration with errors was recorded as done", saved)
	}
	if !exists(filepath.Join(f.profile, ".agents", legacyIntegrationsFile)) {
		t.Fatal("the old record was deleted although settings could not be saved")
	}
	early := f.opts
	early.Now = t0.Add(5 * time.Minute)
	if _, ran, _ := retryMigration(early); ran {
		t.Fatal("retried before the backoff passed")
	}
	if err := writeAppConfig(configFilePath(f.data), defaultAppConfig()); err != nil {
		t.Fatal(err)
	}
	later := f.opts
	later.Now = t0.Add(16 * time.Minute)
	r, ran, err := retryMigration(later)
	if !ran || err != nil || !r.Done || r.Attempts != 2 || len(r.Errors) != 0 || !migrationDone(f.data) {
		t.Fatal("the retry did not finish the migration", ran, err, r)
	}
	if exists(filepath.Join(f.profile, ".agents", legacyIntegrationsFile)) || len(r.Previous) != 1 || r.Previous[0].Backup != saved.Backup || r.Previous[0].Done {
		t.Fatal("retry result or history wrong", r.Previous)
	}
	again := f.opts
	again.Now = t0.Add(time.Hour)
	if _, ran, _ := retryMigration(again); ran {
		t.Fatal("a finished migration ran again on start")
	}
	// A re-run of the installer that changes nothing keeps the history and the backup path.
	last, err := runMigration(again)
	if err != nil || !last.Done || last.Backup != r.Backup || len(last.Previous) != 2 || last.Attempts != 3 {
		t.Fatal("an empty re-run lost the earlier backup or history", err, last.Backup, r.Backup, len(last.Previous))
	}
	if migrationBackoff(1) != 15*time.Minute || migrationBackoff(2) != 30*time.Minute || migrationBackoff(20) != 24*time.Hour {
		t.Fatal("backoff", migrationBackoff(1), migrationBackoff(2), migrationBackoff(20))
	}
}

// Problems only the owner can solve are listed for review, not kept as errors
// that would hold the migration open forever.
func TestOwnerActionItemsDoNotKeepTheMigrationOpen(t *testing.T) {
	f := newMigrationFixture(t)
	mput(t, f.orca[0], "{ not json")
	mput(t, f.orca[1], "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"type\":\"command\",\"command\":\"node C:/x/task-sync.mjs --claude-hook \xff\"}]}]}}")
	r, err := runMigration(f.opts)
	if err != nil || len(r.Errors) != 0 || !r.Done {
		t.Fatal(err, r.Errors)
	}
	kept := strings.Join(r.Kept, "\n")
	if strings.Count(kept, "(not valid JSON)") != 2 || mread(t, f.orca[0]) != "{ not json" || !strings.Contains(mread(t, f.orca[1]), "\xff") {
		t.Fatal("invalid settings were edited or not listed", kept)
	}
}

// Edge inputs: a client file changed at the last moment is not written and keeps
// the migration open for a retry; a linked file is left alone and listed;
// invalid JSON or UTF-8 is never rewritten.
func TestMigrationEdgeInputs(t *testing.T) {
	t.Run("file changed during the migration", func(t *testing.T) {
		f := newMigrationFixture(t)
		settings := filepath.Join(f.profile, ".claude", "settings.json")
		old := beforeClientReplace
		t.Cleanup(func() { beforeClientReplace = old })
		concurrent := ""
		beforeClientReplace = func(file string) {
			if file == settings && concurrent == "" {
				concurrent = mread(t, file) + " "
				mput(t, file, concurrent)
			}
		}
		r, err := runMigration(f.opts)
		if err != nil || len(r.Errors) != 1 || !strings.Contains(r.Errors[0], errClientFileChanged.Error()) {
			t.Fatal(err, r.Errors)
		}
		if mread(t, settings) != concurrent {
			t.Fatal("a concurrent edit was overwritten")
		}
		if migrationDone(f.data) {
			t.Fatal("a migration with a skipped file was recorded as done")
		}
		for _, w := range r.Writes {
			if samePath(w.File, settings) {
				t.Fatal("an unwritten file was recorded as written")
			}
		}
	})
	t.Run("linked settings file", func(t *testing.T) {
		f := newMigrationFixture(t)
		settings := filepath.Join(f.profile, ".claude", "settings.json")
		target := filepath.Join(filepath.Dir(f.profile), "elsewhere-settings.json")
		mput(t, target, mread(t, settings))
		if err := os.Remove(settings); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, settings); err != nil {
			// Without the symlink privilege, a junction (no privilege needed) at the
			// file's name exercises the same "the file itself is a link" rule.
			dir := filepath.Join(filepath.Dir(f.profile), "elsewhere-dir")
			if err := os.MkdirAll(dir, 0o700); err != nil {
				t.Fatal(err)
			}
			if out, err := exec.Command("cmd", "/c", "mklink", "/J", settings, dir).CombinedOutput(); err != nil {
				t.Skip("no symbolic link or junction available:", err, string(out))
			}
			t.Cleanup(func() { os.Remove(settings) })
		}
		before := mread(t, target)
		r, err := runMigration(f.opts)
		if err != nil || len(r.Errors) != 0 || !r.Done {
			t.Fatal(err, r.Errors)
		}
		if mread(t, target) != before || !strings.Contains(strings.Join(r.Kept, "\n"), settings+" (a link") {
			t.Fatal("a linked file was edited or not listed", r.Kept)
		}
	})
	t.Run("invalid JSON and UTF-8", func(t *testing.T) {
		for name, content := range map[string]string{
			"truncated":  `{"hooks":`,
			"trailing":   `{"a":1} {"b":2}`,
			"bad utf-8":  "{\"hooks\":{\"Stop\":[{\"hooks\":[{\"command\":\"node C:/x/task-sync.mjs --claude-hook\"}]}]},\"note\":\"caf\xe9\"}",
			"not object": `[1,2]`,
		} {
			out, n, err := settingsWithoutHooks([]byte(content), legacyHookScript, legacyHookFlag)
			if name == "not object" {
				if err != nil || n != 0 || string(out) != content {
					t.Fatal(name, err, n)
				}
				continue
			}
			if err == nil {
				t.Fatal(name, "accepted", string(out))
			}
		}
	})
}

// The list is seeded once: a folder the owner removed is not added back by a
// later installer run or retry, which only refreshes the hashes of listed folders.
func TestMigrationSeedsTheFolderListOnlyOnce(t *testing.T) {
	f := newMigrationFixture(t)
	if r, err := runMigration(f.opts); err != nil || len(r.Errors) != 0 {
		t.Fatal(err, r.Errors)
	}
	cfg, err := readAppConfig(configFilePath(f.data))
	if err != nil || len(cfg.Integrations) != 2 || !cfg.IntegrationsSeeded {
		t.Fatal(err, cfg.Integrations, cfg.IntegrationsSeeded)
	}
	sharedDir := filepath.Dir(filepath.Dir(f.skillShared))
	kept := []IntegrationTarget{}
	for _, it := range cfg.Integrations {
		if !samePath(it.SkillDir, sharedDir) {
			kept = append(kept, it)
		}
	}
	cfg.Integrations = kept // the owner's Remove from list
	if err := writeAppConfig(configFilePath(f.data), cfg); err != nil {
		t.Fatal(err)
	}
	// The kept folder now holds an unedited embedded copy; a later run records it.
	mput(t, f.skillClaude, string(embeddedSkill))
	f.opts.Now = f.opts.Now.Add(time.Hour)
	if r, err := runMigration(f.opts); err != nil || len(r.Errors) != 0 {
		t.Fatal(err, r.Errors)
	}
	cfg, err = readAppConfig(configFilePath(f.data))
	if err != nil || len(cfg.Integrations) != 1 || samePath(cfg.Integrations[0].SkillDir, sharedDir) {
		t.Fatal("a removed folder was added back", err, cfg.Integrations)
	}
	if cfg.Integrations[0].SHA256 != sha256Hex([]byte(lfText(embeddedSkill))) {
		t.Fatalf("hashes of a listed folder were not refreshed: %+v", cfg.Integrations[0])
	}
}

// A config.json saved by the owner before any seeding (the list edited in
// Settings) also counts as seeded.
func TestOwnerListChangeMarksTheListSeeded(t *testing.T) {
	profile := integrationsFixture(t)
	dir := filepath.Join(profile, "a", "skills")
	os.MkdirAll(filepath.Dir(dir), 0o700)
	if id, w := addTarget(t, map[string]any{"skillDir": dir}); id == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	cfg, err := readAppConfig(configFilePath(dataDir))
	if err != nil || !cfg.IntegrationsSeeded {
		t.Fatal(err, cfg.IntegrationsSeeded)
	}
}
