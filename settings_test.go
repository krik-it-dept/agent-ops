package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// settingsFixture runs the real collector against config.json in an isolated
// data folder, with no --repos-dir override.
func settingsFixture(t *testing.T) string {
	t.Helper()
	dir := isolated(t)
	old := struct {
		repos, state, script, data string
		cfg                        AppConfig
		warning, readOnly          string
		prevPlans                  map[string]Plan
		ev                         []Event
		raw                        []byte
		errText                    string
		stale                      map[string]time.Time
		last                       map[string]bool
		states                     []ProjectState
		reader                     func() bool
		writer                     func(bool)
		managed                    func() bool
		picker                     func(context.Context, string) (string, error)
		opener                     func(string) error
		legacy                     legacyPaths
		allowLegacy                func() bool
		seen                       map[string]bool
	}{reposDir, stateFile, scriptFile, dataDir, appCfg, configWarning, configReadOnly, prev, events, rawState, refreshError, staleSeen, lastProjects, projectStates, startupReader, startupWriter, startupManaged, pickFolder, openFolder, legacyDefaults, legacyMigrationAllowed, seenProjects}
	t.Cleanup(func() {
		seenProjects = old.seen
		reposDir, stateFile, scriptFile, dataDir = old.repos, old.state, old.script, old.data
		appCfg, configWarning, configReadOnly = old.cfg, old.warning, old.readOnly
		prev, events, rawState, refreshError, staleSeen = old.prevPlans, old.ev, old.raw, old.errText, old.stale
		lastProjects, projectStates = old.last, old.states
		startupReader, startupWriter, startupManaged, pickFolder, openFolder = old.reader, old.writer, old.managed, old.picker, old.opener
		legacyDefaults, legacyMigrationAllowed = old.legacy, old.allowLegacy
	})
	legacyDefaults = legacyPaths{repos: filepath.Join(dir, "no-legacy-repos"), state: filepath.Join(dir, "legacy-state.json")}
	reposDir, stateFile = "", ""
	dataDir = filepath.Join(dir, "data")
	os.MkdirAll(dataDir, 0o700)
	scriptFile, _ = filepath.Abs("tasks-overview.mjs")
	appCfg, configWarning, configReadOnly = defaultAppConfig(), "", ""
	prev, events, rawState, refreshError, staleSeen, lastProjects, projectStates = nil, nil, nil, "", map[string]time.Time{}, nil, nil
	seenProjects = nil
	startupState := false
	startupReader = func() bool { return startupState }
	startupWriter = func(on bool) { startupState = on }
	startupManaged = func() bool { return true }
	pickFolder = func(context.Context, string) (string, error) { return "", nil }
	openFolder = func(string) error { return nil }
	initSettings()
	return dir
}

func writePlan(t *testing.T, file, owner string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(file), 0o700)
	if err := os.WriteFile(file, []byte("Owner: "+owner+"\nStatus: Implementing\nGoal: Ship\n\n## M1: Build\n- [doing] Step\n"), 0o600); err != nil {
		t.Fatal(err)
	}
}

func call(t *testing.T, handler http.HandlerFunc, method, path string, body any) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	var reader *bytes.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		reader = bytes.NewReader(b)
	} else {
		reader = bytes.NewReader(nil)
	}
	r := httptest.NewRequest(method, "http://"+addr+path, reader)
	r.Header.Set("X-Agent-Ops", "1")
	if body != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	handler(w, r)
	var out map[string]any
	_ = json.Unmarshal(w.Body.Bytes(), &out)
	return w, out
}

func TestInitSettingsPrecedenceFlagEnvConfigDefault(t *testing.T) {
	dir := settingsFixture(t)
	oldArgs, oldFlags := os.Args, flag.CommandLine
	t.Cleanup(func() { os.Args, flag.CommandLine = oldArgs, oldFlags })
	cfg := defaultAppConfig()
	cfg.SetupComplete = true
	cfg.StateFile = filepath.Join(dir, "config-state.json")
	writeAppConfig(configFilePath(dataDir), cfg)
	parse := func(args ...string) {
		flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
		os.Args = append([]string{"test", "--data-dir", dataDir}, args...)
		config()
		initSettings()
	}
	t.Setenv("AGENT_OPS_STATE_FILE", "")
	t.Setenv("AGENT_OPS_REPOS_DIR", "")
	parse()
	if stateFile != cfg.StateFile || reposDir != "" || explicitState {
		t.Fatal("config not applied", stateFile)
	}
	t.Setenv("AGENT_OPS_STATE_FILE", filepath.Join(dir, "env-state.json"))
	parse()
	if stateFile != filepath.Join(dir, "env-state.json") || !explicitState {
		t.Fatal("environment must beat config", stateFile)
	}
	parse("--state-file", filepath.Join(dir, "flag-state.json"))
	if stateFile != filepath.Join(dir, "flag-state.json") {
		t.Fatal("flag must beat environment", stateFile)
	}
	t.Setenv("AGENT_OPS_STATE_FILE", "")
	os.Remove(configFilePath(dataDir))
	parse()
	if stateFile != filepath.Join(dataDir, "state", "tong-hop-chung.json") {
		t.Fatal("default state must live under the data folder", stateFile)
	}
	if !setupRequired() {
		t.Fatal("a fresh profile without a legacy folder must require setup")
	}
	t.Setenv("AGENT_OPS_REPOS_DIR", dir)
	parse()
	if reposDir != dir || setupRequired() || len(effectiveProjects()) != 1 || effectiveProjects()[0].ID != projectIDFor(dir) {
		t.Fatal("repos override not applied")
	}
}

func TestSameRepoNameInTwoProjectsAndMissingProjectWarning(t *testing.T) {
	dir := settingsFixture(t)
	work, oss := filepath.Join(dir, "work"), filepath.Join(dir, "oss")
	writePlan(t, filepath.Join(work, "web", ".tasks", "plan.md"), "Codex")
	os.MkdirAll(filepath.Join(work, "web", ".git"), 0o700)
	writePlan(t, filepath.Join(oss, "web", ".tasks", "plan.md"), "Claude")
	os.MkdirAll(filepath.Join(oss, "web", ".git"), 0o700)
	now := time.Now()
	appCfg.SetupComplete = true
	appCfg.Projects = []Project{
		{ID: "work", Path: work, Name: "Work", Kind: "folder", Enabled: true, AddedAt: now},
		{ID: "oss", Path: filepath.Join(oss, "web"), Name: "OSS", Kind: "repo", Enabled: true, AddedAt: now},
		{ID: "gone", Path: filepath.Join(dir, "unplugged"), Name: "Gone", Kind: "folder", Enabled: true, AddedAt: now},
	}
	writeAppConfig(configFilePath(dataDir), appCfg)
	initSettings()
	refresh(true)
	if refreshError != "" {
		t.Fatal(refreshError)
	}
	if prev["work/web/plan"].Owner != "Codex" || prev["oss/web/plan"].Owner != "Claude" || len(prev) != 2 {
		t.Fatal("same-named repositories collided", len(prev))
	}
	w := httptest.NewRecorder()
	handleState(w, httptest.NewRequest("GET", "http://"+addr+"/api/state", nil))
	var state struct {
		Error         string           `json:"error"`
		SetupRequired bool             `json:"setupRequired"`
		Projects      []ProjectSummary `json:"projects"`
		Warnings      []string         `json:"warnings"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &state); err != nil {
		t.Fatal(err, w.Body)
	}
	if state.Error != "" || state.SetupRequired || len(state.Projects) != 3 || state.Projects[2].Status != "missing" || len(state.Warnings) != 1 || !strings.Contains(state.Warnings[0], "Gone") {
		t.Fatalf("%+v", state)
	}
}

func TestNoProjectsNeverRunsNodeAndStaysHealthy(t *testing.T) {
	settingsFixture(t)
	scriptFile = filepath.Join(dataDir, "missing-collector.mjs")
	refresh(true)
	if refreshError != "" || !strings.Contains(string(rawState), `"plans":[]`) {
		t.Fatal("empty configuration must not fail", refreshError)
	}
	if !setupRequired() {
		t.Fatal("setup must be required")
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/state" {
			handleState(w, r)
			return
		}
		_ = json.NewEncoder(w).Encode(updateState{Current: appVersion, ProcessID: 7})
	}))
	defer server.Close()
	if !updateHealth(server.URL, appVersion, 7, 2*time.Second) {
		t.Fatal("an update must not roll back because no project is configured")
	}
	appCfg.Projects = []Project{{ID: "gone", Path: filepath.Join(dataDir, "missing"), Name: "Gone", Kind: "folder", Enabled: true}}
	scriptFile, _ = filepath.Abs("tasks-overview.mjs")
	writeAppConfig(configFilePath(dataDir), appCfg)
	refresh(true)
	if refreshError != "" || !updateHealth(server.URL, appVersion, 7, 2*time.Second) {
		t.Fatal("a missing project folder must be a warning, not an unhealthy update", refreshError)
	}
}

func TestLegacyKeysAreMappedOnLoad(t *testing.T) {
	dir := settingsFixture(t)
	repos := filepath.Join(dir, "repos")
	os.MkdirAll(filepath.Join(repos, "sample", ".git"), 0o700)
	os.MkdirAll(filepath.Join(dir, "other", "sample"), 0o700)
	appCfg.Projects = []Project{{ID: "main", Path: repos, Name: "repos", Kind: "folder", Enabled: true}}
	old := fixture()
	snapshot, _ := json.Marshal(map[string]Plan{"sample/plan": old, "unknown/plan": {Repo: "unknown", Name: "plan"}})
	os.WriteFile(filepath.Join(dataDir, "snapshot.json"), snapshot, 0o600)
	line, _ := json.Marshal(Event{TS: time.Now(), Repo: "sample", Plan: "plan", Kind: "decision", Text: "Keep history"})
	os.WriteFile(filepath.Join(dataDir, "activity.jsonl"), append(line, '\n'), 0o600)
	stale, _ := json.Marshal(map[string]time.Time{"sample/plan": time.Now()})
	os.WriteFile(filepath.Join(dataDir, "stale.json"), stale, 0o600)
	prev, events = nil, nil
	loadPersisted()
	if _, ok := prev["main/sample/plan"]; !ok || prev["main/sample/plan"].Project != "main" {
		t.Fatal("snapshot key not mapped", prev)
	}
	if _, ok := prev["unknown/plan"]; !ok {
		t.Fatal("unmatched legacy entries must be kept")
	}
	if len(events) != 1 || events[0].Project != "main" || eventKey(events[0]) != "main/sample/plan" {
		t.Fatal("activity not mapped", events)
	}
	if _, ok := staleSeen["main/sample/plan"]; !ok {
		t.Fatal("stale key not mapped")
	}
	// Ambiguous: two projects contain a "sample" folder.
	appCfg.Projects = append(appCfg.Projects, Project{ID: "other", Path: filepath.Join(dir, "other"), Name: "other", Kind: "folder", Enabled: true})
	if legacyProjectFor("sample", appCfg.Projects) != "" {
		t.Fatal("ambiguous legacy key must not be guessed")
	}
}

func TestSettingsAPIAddToggleRemoveAndSetup(t *testing.T) {
	dir := settingsFixture(t)
	repo := filepath.Join(dir, "alpha")
	writePlan(t, filepath.Join(repo, ".tasks", "plan.md"), "Codex")
	os.MkdirAll(filepath.Join(repo, ".git"), 0o700)
	w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": repo})
	if w.Code != 200 || out["kind"] != "repo" || out["name"] != "alpha" {
		t.Fatal(w.Code, out)
	}
	repos := out["repos"].([]any)
	if len(repos) != 1 || repos[0].(map[string]any)["planCount"].(float64) != 1 {
		t.Fatal("repos preview", repos)
	}
	id := out["project"].(map[string]any)["id"].(string)
	if len(prev) != 1 {
		t.Fatal("adding a project must refresh", len(prev))
	}
	if events := kinds(events); events["new"] != 0 {
		t.Fatal("adding a project must not announce its plans as new", events)
	}
	if w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": repo}); w.Code != 400 || !strings.Contains(out["error"].(string), "already added") {
		t.Fatal("duplicate accepted", w.Code, out)
	}
	if w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": filepath.Join(dir, "nope")}); w.Code != 400 || !strings.Contains(out["error"].(string), "does not exist") {
		t.Fatal(w.Code, out)
	}
	if w, _ := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"setupComplete": true, "notifications": false, "startWithWindows": true}); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	saved, err := readAppConfig(configFilePath(dataDir))
	if err != nil || !saved.SetupComplete || saved.Notifications || len(saved.Projects) != 1 || !startupReader() {
		t.Fatal("settings not saved", saved, err)
	}
	if w, _ := call(t, handleProject, "PATCH", "/api/projects/"+id, map[string]any{"enabled": false, "name": "Alpha app"}); w.Code != 200 || len(prev) != 0 {
		t.Fatal("disable did not refresh", w.Code, len(prev))
	}
	if events := kinds(events); events["closed"] != 0 {
		t.Fatal("disabling a project must not close its plans in the feed", events)
	}
	if saved, _ := readAppConfig(configFilePath(dataDir)); saved.Projects[0].Enabled || saved.Projects[0].Name != "Alpha app" {
		t.Fatal("patch not saved")
	}
	if w, _ := call(t, handleProject, "PATCH", "/api/projects/"+id, map[string]any{"name": " "}); w.Code != 400 {
		t.Fatal("empty name accepted")
	}
	if w, _ := call(t, handleProject, "DELETE", "/api/projects/"+id, nil); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	if saved, _ := readAppConfig(configFilePath(dataDir)); len(saved.Projects) != 0 {
		t.Fatal("delete not saved")
	}
	if w, _ := call(t, handleProject, "DELETE", "/api/projects/"+id, nil); w.Code != 404 {
		t.Fatal("deleting twice", w.Code)
	}
	// GET is a read; the payload names the data folder and the version.
	w = httptest.NewRecorder()
	handleSettings(w, httptest.NewRequest("GET", "http://"+addr+"/api/settings", nil))
	var payload settingsPayload
	json.Unmarshal(w.Body.Bytes(), &payload)
	if payload.DataDir != dataDir || payload.Version != appVersion || payload.SetupRequired {
		t.Fatalf("%+v", payload)
	}
}

func TestSettingsWritesRequireLocalHeaderAndOverrideIsReadOnly(t *testing.T) {
	dir := settingsFixture(t)
	for _, h := range []http.HandlerFunc{handleSettings, handleProjects, handlePickFolder, handleOpenFolder} {
		r := httptest.NewRequest("POST", "http://"+addr+"/x", strings.NewReader(`{}`))
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		h(w, r)
		if w.Code != 403 && w.Code != 405 {
			t.Fatal("write without X-Agent-Ops accepted", w.Code)
		}
		r = httptest.NewRequest("POST", "http://"+addr+"/x", strings.NewReader(`{}`))
		r.Header.Set("X-Agent-Ops", "1")
		r.Header.Set("Origin", "https://attacker.example")
		w = httptest.NewRecorder()
		h(w, r)
		if w.Code != 403 && w.Code != 405 {
			t.Fatal("cross-site write accepted", w.Code)
		}
	}
	startupManaged = func() bool { return false }
	if w, _ := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"startWithWindows": true}); w.Code != 409 || startupReader() {
		t.Fatal("a dev instance must not rewrite the Run key", w.Code)
	}
	reposDir = dir
	if w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": dir}); w.Code != 409 || !strings.Contains(out["error"].(string), "--repos-dir") {
		t.Fatal("override must be read-only", w.Code, out)
	}
}

func TestPickFolderReturnsPathOrCancelledAndOpensOnlyKnownFolders(t *testing.T) {
	settingsFixture(t)
	if w, out := call(t, handlePickFolder, "POST", "/api/settings/pick-folder", nil); w.Code != 200 || out["cancelled"] != true {
		t.Fatal(w.Code, out)
	}
	pickFolder = func(context.Context, string) (string, error) { return `C:\Projects\web`, nil }
	if w, out := call(t, handlePickFolder, "POST", "/api/settings/pick-folder", nil); w.Code != 200 || out["path"] != `C:\Projects\web` {
		t.Fatal(w.Code, out)
	}
	asked := []string{}
	pickFolder = func(_ context.Context, purpose string) (string, error) {
		asked = append(asked, purpose)
		return `C:\Tools\skills`, nil
	}
	for _, purpose := range []string{"skills", "instruction-file"} {
		if w, out := call(t, handlePickFolder, "POST", "/api/settings/pick-folder", map[string]string{"purpose": purpose}); w.Code != 200 || out["path"] != `C:\Tools\skills` {
			t.Fatal(purpose, w.Code, out)
		}
	}
	if w, _ := call(t, handlePickFolder, "POST", "/api/settings/pick-folder", map[string]string{"purpose": "anything"}); w.Code != 400 || strings.Join(asked, ",") != "skills,instruction-file" {
		t.Fatal("unknown dialog purpose", w.Code, asked)
	}
	if w, _ := call(t, handlePickFolder, "GET", "/api/settings/pick-folder", nil); w.Code != 405 {
		t.Fatal("GET opened a dialog")
	}
	opened := ""
	openFolder = func(path string) error { opened = path; return nil }
	if w, _ := call(t, handleOpenFolder, "POST", "/api/settings/open-folder", map[string]string{"target": "data"}); w.Code != 200 || opened != dataDir {
		t.Fatal(w.Code, opened)
	}
	if w, _ := call(t, handleOpenFolder, "POST", "/api/settings/open-folder", map[string]string{"target": "project", "id": "none"}); w.Code != 404 {
		t.Fatal("unknown project opened", w.Code)
	}
}

func TestLegacyFolderMigratesOnlyIntoTheInstalledDataFolder(t *testing.T) {
	dir := settingsFixture(t)
	legacy := filepath.Join(dir, "legacy repos")
	os.MkdirAll(filepath.Join(legacy, "sample", ".git"), 0o700)
	legacyDefaults = legacyPaths{repos: legacy, state: filepath.Join(dir, "legacy-state.json")}
	os.Remove(configFilePath(dataDir))
	stateFile = ""
	initSettings()
	if !setupRequired() || len(effectiveProjects()) != 0 || exists(configFilePath(dataDir)) {
		t.Fatal("an isolated data folder adopted the legacy folder")
	}
	legacyMigrationAllowed = func() bool { return true }
	stateFile = ""
	initSettings()
	if setupRequired() || len(effectiveProjects()) != 1 || effectiveProjects()[0].Path != legacy || stateFile != legacyDefaults.state {
		t.Fatal("the installed data folder must migrate the legacy folder and keep its state file", stateFile)
	}
}

// An in-app update from v0.1.4 relaunches the new version with v0.1.4's own
// arguments, which always named the built-in legacy paths. They must migrate, not
// lock the project list as a --repos-dir override, and must not be passed on again.
func TestV014RelaunchArgumentsAreNotOverrides(t *testing.T) {
	dir := settingsFixture(t)
	oldArgs, oldFlags, oldAddr, oldProfile, oldBackground := os.Args, flag.CommandLine, addr, profileDir, background
	t.Cleanup(func() {
		os.Args, flag.CommandLine, addr, profileDir, background = oldArgs, oldFlags, oldAddr, oldProfile, oldBackground
		legacyLaunch = legacyPaths{}
		explicitRepos, explicitState = false, false
	})
	t.Setenv("AGENT_OPS_STATE_FILE", "")
	t.Setenv("AGENT_OPS_REPOS_DIR", "")
	legacy := filepath.Join(dir, "legacy repos")
	mkRepo(t, filepath.Join(legacy, "sample"), "plan")
	// Spelled with a different case and a trailing separator, as Windows allows.
	legacyDefaults = legacyPaths{repos: legacy, state: filepath.Join(dir, "legacy-state.json")}
	legacyMigrationAllowed = func() bool { return true }
	os.Remove(configFilePath(dataDir))
	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = []string{"agent-ops.exe", "--background", "--addr", addr, "--repos-dir", strings.ToUpper(legacy) + `\`,
		"--slots-file", filepath.Join(dir, "legacy-slots.json"), "--state-file", legacyDefaults.state, "--script", scriptFile,
		"--data-dir", dataDir, "--profile-dir", dir}
	config()
	initSettings()
	if reposDir != "" || setupRequired() || currentSettings().ProjectsOverridden != "" {
		t.Fatal("v0.1.4 launch arguments were treated as a --repos-dir override", reposDir)
	}
	if p := effectiveProjects(); len(p) != 1 || !strings.EqualFold(p[0].Path, legacy) {
		t.Fatal("the legacy folder was not migrated", p)
	}
	if stateFile != legacyDefaults.state {
		t.Fatal("migration must keep the legacy state file", stateFile)
	}
	other := mkRepo(t, filepath.Join(dir, "other"), "plan")
	if w, out := call(t, handleProjects, http.MethodPost, "/api/projects", map[string]string{"path": other}); w.Code != http.StatusOK {
		t.Fatal("projects must be editable after the update", w.Code, out)
	}
	args := strings.Join(launchArgs(), " ")
	for _, flagName := range []string{"--repos-dir", "--state-file", "--slots-file"} {
		if strings.Contains(args, flagName) {
			t.Fatal("legacy values are passed on to the next update", args)
		}
	}
}

// Disabling and re-enabling a project (or its drive dropping and returning) must
// not seed its history into the activity log again or repeat stale notices.
func TestReenabledProjectDoesNotReseedHistory(t *testing.T) {
	dir := settingsFixture(t)
	plan := "Agent: Codex\nStatus: Implementing\nGoal: Ship\n\n## Decisions\n- 2026-01-02 10:00: Keep it small\n\n## M1: Build [done]\nSummary: Built\n- [done] Step\n"
	alpha, beta := mkRepo(t, filepath.Join(dir, "alpha")), mkRepo(t, filepath.Join(dir, "beta"))
	for _, repo := range []string{alpha, beta} {
		os.MkdirAll(filepath.Join(repo, ".tasks"), 0o700)
		os.WriteFile(filepath.Join(repo, ".tasks", "plan.md"), []byte(plan), 0o600)
		old := time.Now().Add(-3 * staleAfter)
		os.Chtimes(filepath.Join(repo, ".tasks", "plan.md"), old, old)
	}
	if w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": alpha}); w.Code != 200 {
		t.Fatal(w.Code, out)
	}
	w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": beta})
	if w.Code != 200 {
		t.Fatal(w.Code, out)
	}
	id := out["project"].(map[string]any)["id"].(string)
	lines := func() int {
		b, _ := os.ReadFile(filepath.Join(dataDir, "activity.jsonl"))
		return strings.Count(string(b), "\n")
	}
	if kinds(events)["decision"] != 2 || kinds(events)["stale"] != 2 {
		t.Fatal("a newly added project seeds its history once", kinds(events))
	}
	count, logged := len(events), lines()
	for i := 0; i < 2; i++ {
		for _, enabled := range []bool{false, true} {
			if w, _ := call(t, handleProject, "PATCH", "/api/projects/"+id, map[string]any{"enabled": enabled}); w.Code != 200 {
				t.Fatal(w.Code, w.Body)
			}
		}
	}
	refresh(false)
	if len(events) != count || lines() != logged {
		t.Fatal("re-enabling a project duplicated its history", count, len(events), kinds(events))
	}
	// After a restart the returning project is still known.
	prev, events, lastProjects, seenProjects = nil, nil, nil, nil
	loadPersisted()
	call(t, handleProject, "PATCH", "/api/projects/"+id, map[string]any{"enabled": false})
	call(t, handleProject, "PATCH", "/api/projects/"+id, map[string]any{"enabled": true})
	if lines() != logged {
		t.Fatal("history was seeded again after a restart", lines(), logged)
	}
}

// The Go app and the collector must resolve projects and the state file in the
// same order: flag > AGENT_OPS_* environment > config.json > default.
func TestGoAndNodeResolveSettingsInTheSameOrder(t *testing.T) {
	dir := settingsFixture(t)
	oldArgs, oldFlags := os.Args, flag.CommandLine
	t.Cleanup(func() {
		os.Args, flag.CommandLine = oldArgs, oldFlags
		explicitRepos, explicitState = false, false
	})
	configured := mkRepo(t, filepath.Join(dir, "configured"), "plan")
	envRepos := mkRepo(t, filepath.Join(dir, "env-repos", "app"), "plan")
	cfg := defaultAppConfig()
	cfg.SetupComplete = true
	cfg.StateFile = filepath.Join(dir, "config-state.json")
	cfg.Projects = []Project{
		{ID: projectIDFor(configured), Path: configured, Name: "configured", Kind: "repo", Enabled: true},
		{ID: "off", Path: filepath.Join(dir, "off"), Name: "off", Kind: "folder", Enabled: false},
	}
	if err := writeAppConfig(configFilePath(dataDir), cfg); err != nil {
		t.Fatal(err)
	}
	reader, _ := filepath.Abs("plan-reader.mjs")
	script := `const {resolveSettings}=await import(process.argv[1]);` +
		`const s=resolveSettings(JSON.parse(process.argv[2]));` +
		`process.stdout.write(JSON.stringify({projects:s.projects.map(p=>p.id),state:s.stateFile}))`
	type resolved struct {
		Projects []string `json:"projects"`
		State    string   `json:"state"`
	}
	cases := []struct {
		name  string
		env   map[string]string
		flags map[string]string
	}{
		{"config", nil, nil},
		{"environment beats config", map[string]string{"AGENT_OPS_REPOS_DIR": filepath.Dir(envRepos), "AGENT_OPS_STATE_FILE": filepath.Join(dir, "env-state.json")}, nil},
		{"environment for one value", map[string]string{"AGENT_OPS_STATE_FILE": filepath.Join(dir, "env-state.json")}, nil},
		{"flag beats environment", map[string]string{"AGENT_OPS_STATE_FILE": filepath.Join(dir, "env-state.json"), "AGENT_OPS_REPOS_DIR": filepath.Dir(envRepos)},
			map[string]string{"state-file": filepath.Join(dir, "flag-state.json"), "repos-dir": configured}},
	}
	for _, c := range cases {
		for _, name := range []string{"AGENT_OPS_REPOS_DIR", "AGENT_OPS_STATE_FILE"} {
			t.Setenv(name, c.env[name])
		}
		args := []string{"test", "--data-dir", dataDir}
		for k, v := range c.flags {
			args = append(args, "--"+k, v)
		}
		flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
		os.Args = args
		config()
		initSettings()
		goSide := resolved{State: stateFile}
		for _, p := range effectiveProjects() {
			goSide.Projects = append(goSide.Projects, p.ID)
		}
		options, _ := json.Marshal(c.flags)
		if c.flags == nil {
			options = []byte("{}")
		}
		cmd := exec.Command("node", "--input-type=module", "-e", script, "file:///"+filepath.ToSlash(reader), string(options))
		cmd.Env = append(os.Environ(), "AGENT_OPS_CONFIG="+configFilePath(dataDir))
		out, err := cmd.Output()
		if err != nil {
			t.Fatal(c.name, err)
		}
		var nodeSide resolved
		if err := json.Unmarshal(out, &nodeSide); err != nil {
			t.Fatal(c.name, err, string(out))
		}
		if strings.Join(goSide.Projects, ",") != strings.Join(nodeSide.Projects, ",") || !strings.EqualFold(goSide.State, nodeSide.State) {
			t.Fatalf("%s: Go %+v, Node %+v", c.name, goSide, nodeSide)
		}
	}
}

func TestSettingsPutIsRejectedWhileRestartingForAnUpdate(t *testing.T) {
	settingsFixture(t)
	updateRestarting.Store(true)
	t.Cleanup(func() { updateRestarting.Store(false) })
	if w, _ := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"notifications": false}); w.Code != http.StatusServiceUnavailable {
		t.Fatal("settings were written during an update restart", w.Code)
	}
	if !appCfg.Notifications {
		t.Fatal("the in-memory setting changed during an update restart")
	}
}

// An upgrade from v0.1.4 keeps its history: the first refresh after loading an old
// snapshot announces nothing new or closed, and activity lines are rewritten with
// their project once, so a later same-named folder cannot detach them.
func TestV014HistoryIsUpgradedOnceAndRefreshIsQuiet(t *testing.T) {
	dir := settingsFixture(t)
	repos := filepath.Join(dir, "repos")
	writePlan(t, filepath.Join(repos, "sample", ".tasks", "plan.md"), "Codex")
	os.MkdirAll(filepath.Join(repos, "sample", ".git"), 0o700)
	appCfg.SetupComplete = true
	appCfg.Projects = []Project{{ID: "main", Path: repos, Name: "repos", Kind: "folder", Enabled: true}}
	writeAppConfig(configFilePath(dataDir), appCfg)
	refresh(true)
	if refreshError != "" || len(prev) != 1 {
		t.Fatal(refreshError, len(prev))
	}
	// Rewrite the snapshot and activity in the v0.1.4 format (no project).
	legacy := map[string]Plan{}
	for _, p := range prev {
		p.Project, p.ProjectName, p.Root = "", "", ""
		legacy[p.Repo+"/"+p.Name] = p
	}
	snapshot, _ := json.Marshal(legacy)
	os.WriteFile(filepath.Join(dataDir, "snapshot.json"), snapshot, 0o600)
	line, _ := json.Marshal(Event{TS: time.Now(), Repo: "sample", Plan: "plan", Kind: "decision", Text: "Keep history"})
	original := append(append([]byte("not json\n"), line...), '\n')
	os.WriteFile(filepath.Join(dataDir, "activity.jsonl"), original, 0o600)
	os.Remove(filepath.Join(dataDir, "seen-projects.json"))
	prev, events, lastProjects, seenProjects = nil, nil, nil, nil
	loadPersisted()
	refresh(false)
	if k := kinds(events); k["new"] != 0 || k["closed"] != 0 || k["decision"] != 1 {
		t.Fatal("the first refresh after the upgrade changed the feed", k)
	}
	b, _ := os.ReadFile(filepath.Join(dataDir, "activity.jsonl"))
	if !strings.Contains(string(b), `"project":"main"`) || !strings.HasPrefix(string(b), "not json\n") {
		t.Fatal("activity lines were not upgraded in place", string(b))
	}
	if saved, _ := os.ReadFile(filepath.Join(dataDir, "activity.jsonl.pre-projects")); string(saved) != string(original) {
		t.Fatal("the original activity file was not kept")
	}
	// A second project with a same-named folder no longer detaches the history.
	other := filepath.Join(dir, "other")
	os.MkdirAll(filepath.Join(other, "sample", ".git"), 0o700)
	appCfg.Projects = append(appCfg.Projects, Project{ID: "other", Path: other, Name: "other", Kind: "folder", Enabled: true})
	prev, events = nil, nil
	loadPersisted()
	if len(events) != 1 || events[0].Project != "main" {
		t.Fatal("history detached after adding a same-named folder", events)
	}
}

// The real picker pipeline (PowerShell output decoded by Go) keeps a Vietnamese
// folder name; only the dialog itself is replaced by a constant chooser.
func TestFolderPickerDecodesNonASCIIPaths(t *testing.T) {
	want := `D:\Dự án\Tiếng Việt – ổn định`
	t.Setenv("AGENT_OPS_PICK_TEST", want)
	got, err := runFolderPicker(context.Background(), `$selected=[Environment]::GetEnvironmentVariable('AGENT_OPS_PICK_TEST');`)
	if err != nil || got != want {
		t.Fatalf("got %q, %v", got, err)
	}
	if got, err := runFolderPicker(context.Background(), ``); err != nil || got != "" {
		t.Fatalf("a cancelled dialog must return nothing: %q, %v", got, err)
	}
}

func TestSetupCanBeSkippedWithoutProjectsAndKeepsThemeAndShortcuts(t *testing.T) {
	settingsFixture(t)
	if !setupRequired() {
		t.Fatal("a new settings file needs setup")
	}
	w, out := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"setupComplete": true})
	if w.Code != 200 || out["setupComplete"] != true || out["setupRequired"] != false || len(out["projects"].([]any)) != 0 {
		t.Fatal("setup must be skippable with zero projects", w.Code, out)
	}
	if out["theme"] != "system" || out["shortcuts"] != true {
		t.Fatal("defaults", out)
	}
	if w, _ := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"theme": "dark", "shortcuts": false}); w.Code != 200 {
		t.Fatal(w.Code, w.Body)
	}
	saved, err := readAppConfig(configFilePath(dataDir))
	if err != nil || saved.Theme != "dark" || saved.Shortcuts || !saved.SetupComplete {
		t.Fatal("theme and shortcuts not saved", saved, err)
	}
	for _, bad := range []any{"neon", ""} {
		if w, _ := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"theme": bad}); w.Code != 400 {
			t.Fatal("invalid theme accepted", bad, w.Code)
		}
	}
}

func TestConfigWithoutShortcutsKeyDefaultsToOn(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config.json")
	os.WriteFile(file, []byte(`{"version":1,"setupComplete":true,"projects":[]}`), 0o600)
	c, err := readAppConfig(file)
	if err != nil || !c.Shortcuts || c.Theme != "" {
		t.Fatal(c, err)
	}
	os.WriteFile(file, []byte(`{"version":1,"projects":[],"theme":"purple"}`), 0o600)
	if _, err := readAppConfig(file); err == nil {
		t.Fatal("an unknown theme must be rejected")
	}
}

func TestArchivePreferencePersistsWithoutMovingPlanSources(t *testing.T) {
	dir := settingsFixture(t)
	file := filepath.Join(dir, "repo", ".tasks", "finished.md")
	source := []byte("Agent: Codex\nStatus: Done\n\n- [done] Delivered\n")
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, source, 0o600); err != nil {
		t.Fatal(err)
	}
	if w, out := call(t, handleSettings, "GET", "/api/settings", nil); w.Code != 200 || out["autoArchiveDone"] != false {
		t.Fatal(w.Code, out)
	}
	for _, enabled := range []bool{true, false} {
		w, out := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"autoArchiveDone": enabled})
		if w.Code != 200 || out["autoArchiveDone"] != enabled {
			t.Fatal(w.Code, out)
		}
		saved, err := readAppConfig(configFilePath(dataDir))
		if err != nil || saved.AutoArchiveDone != enabled {
			t.Fatal(saved, err)
		}
		got, err := os.ReadFile(file)
		if err != nil || !bytes.Equal(got, source) {
			t.Fatal("archiving changed source", err)
		}
	}
	if w, _ := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"autoArchiveDone": "true"}); w.Code != 400 {
		t.Fatal("non-boolean archive preference accepted", w.Code)
	}
}

// recordToasts replaces the notification seam and returns the notices shown.
func recordToasts(t *testing.T) func() []string {
	t.Helper()
	var mutex sync.Mutex
	var shown []string
	old := showToast
	showToast = func(title, body, target string) {
		mutex.Lock()
		defer mutex.Unlock()
		shown = append(shown, title+" | "+body)
	}
	t.Cleanup(func() { showToast = old })
	return func() []string {
		mutex.Lock()
		defer mutex.Unlock()
		return append([]string{}, shown...)
	}
}

// Adding or enabling a project that holds many plans left in Implementing for weeks
// must not fire one "stale" toast per plan. The plans are still logged once, and a
// plan that goes stale afterwards is announced as usual.
func TestAddingOrEnablingAProjectDoesNotToastEveryStalePlan(t *testing.T) {
	dir := settingsFixture(t)
	toasts := recordToasts(t)
	plan := "Agent: Codex\nStatus: Implementing\nGoal: Ship\n\n- [doing] Step\n"
	repos := map[string]string{}
	for _, name := range []string{"alpha", "beta"} {
		repo := mkRepo(t, filepath.Join(dir, name))
		os.MkdirAll(filepath.Join(repo, ".tasks"), 0o700)
		for _, file := range []string{"one", "two", "three"} {
			path := filepath.Join(repo, ".tasks", file+".md")
			os.WriteFile(path, []byte(plan), 0o600)
			old := time.Now().Add(-3 * staleAfter)
			os.Chtimes(path, old, old)
		}
		repos[name] = repo
	}
	add := func(path string) string {
		w, out := call(t, handleProjects, "POST", "/api/projects", map[string]any{"path": path})
		if w.Code != 200 {
			t.Fatal(w.Code, out)
		}
		return out["project"].(map[string]any)["id"].(string)
	}
	add(repos["alpha"])
	if n := kinds(events)["stale"]; n != 3 {
		t.Fatal("stale plans of a new project are still logged once", n, kinds(events))
	}
	if got := toasts(); len(got) != 0 {
		t.Fatal("the first project announced its stale plans", got)
	}
	betaID := add(repos["beta"])
	if kinds(events)["stale"] != 6 || len(staleSeen) != 6 {
		t.Fatal("stale plans are recorded as seen", kinds(events), len(staleSeen))
	}
	if got := toasts(); len(got) != 0 {
		t.Fatal("adding a project announced its stale plans", got)
	}
	// While a project is disabled its plans keep going stale; enabling it again stays quiet too.
	betaSeen := func() []string {
		var keys []string
		for k := range staleSeen {
			if strings.HasPrefix(k, betaID+"/") {
				keys = append(keys, k)
			}
		}
		return keys
	}
	call(t, handleProject, "PATCH", "/api/projects/"+betaID, map[string]any{"enabled": false})
	for _, k := range betaSeen() {
		delete(staleSeen, k)
	}
	call(t, handleProject, "PATCH", "/api/projects/"+betaID, map[string]any{"enabled": true})
	if got := toasts(); len(got) != 0 {
		t.Fatal("enabling a project announced its stale plans", got)
	}
	if len(betaSeen()) != 3 {
		t.Fatal("the plans of the enabled project were not recorded as seen", betaSeen())
	}
	// A plan that goes stale while the project is already read still announces itself.
	delete(staleSeen, betaSeen()[0])
	checkStale()
	if got := toasts(); len(got) != 1 || !strings.Contains(got[0], "Đứng im") {
		t.Fatal("a plan that goes stale in a read project must still notify once", got)
	}
}
