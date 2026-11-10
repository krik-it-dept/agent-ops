package main

import (
	"bytes"
	"context"
	"encoding/json"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// settingsFixture runs the real collector against config.json in an isolated
// data folder, with no --repos-dir override.
func settingsFixture(t *testing.T) string {
	t.Helper()
	dir := isolated(t)
	old := struct {
		repos, state, slots, script, data string
		cfg                               AppConfig
		warning, readOnly                 string
		prevPlans                         map[string]Plan
		ev                                []Event
		raw                               []byte
		errText                           string
		stale                             map[string]time.Time
		last                              map[string]bool
		states                            []ProjectState
		reader                            func() bool
		writer                            func(bool)
		managed                           func() bool
		picker                            func(context.Context) (string, error)
		opener                            func(string) error
		legacy                            legacyPaths
		allowLegacy                       func() bool
	}{reposDir, stateFile, slotsFile, scriptFile, dataDir, appCfg, configWarning, configReadOnly, prev, events, rawState, refreshError, staleSeen, lastProjects, projectStates, startupReader, startupWriter, startupManaged, pickFolder, openFolder, legacyDefaults, legacyMigrationAllowed}
	t.Cleanup(func() {
		reposDir, stateFile, slotsFile, scriptFile, dataDir = old.repos, old.state, old.slots, old.script, old.data
		appCfg, configWarning, configReadOnly = old.cfg, old.warning, old.readOnly
		prev, events, rawState, refreshError, staleSeen = old.prevPlans, old.ev, old.raw, old.errText, old.stale
		lastProjects, projectStates = old.last, old.states
		startupReader, startupWriter, startupManaged, pickFolder, openFolder = old.reader, old.writer, old.managed, old.picker, old.opener
		legacyDefaults, legacyMigrationAllowed = old.legacy, old.allowLegacy
	})
	legacyDefaults = legacyPaths{repos: filepath.Join(dir, "no-legacy-repos"), state: filepath.Join(dir, "legacy-state.json"), slots: filepath.Join(dir, "legacy-slots.json")}
	reposDir, stateFile, slotsFile = "", "", ""
	dataDir = filepath.Join(dir, "data")
	os.MkdirAll(dataDir, 0o700)
	scriptFile, _ = filepath.Abs("tasks-overview.mjs")
	appCfg, configWarning, configReadOnly = defaultAppConfig(), "", ""
	prev, events, rawState, refreshError, staleSeen, lastProjects, projectStates = nil, nil, nil, "", map[string]time.Time{}, nil, nil
	startupState := false
	startupReader = func() bool { return startupState }
	startupWriter = func(on bool) { startupState = on }
	startupManaged = func() bool { return true }
	pickFolder = func(context.Context) (string, error) { return "", nil }
	openFolder = func(string) error { return nil }
	t.Setenv("KRIK_AGENT_MAP", filepath.Join(dir, "no-agent-map.json"))
	t.Setenv("KRIK_HISTORY_MAP", filepath.Join(dir, "no-history.json"))
	t.Setenv("KRIK_EXECUTION_DIR", "")
	initSettings()
	return dir
}

func writePlan(t *testing.T, file, agent string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(file), 0o700)
	if err := os.WriteFile(file, []byte("Agent: "+agent+"\nStatus: Implementing\nGoal: Ship\n\n## M1: Build\n- [doing] Step\n"), 0o600); err != nil {
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
	r.Header.Set("X-Workboard", "1")
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
	cfg.SlotsFile = filepath.Join(dir, "config-slots.json")
	writeAppConfig(configFilePath(dataDir), cfg)
	parse := func(args ...string) {
		flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
		os.Args = append([]string{"test", "--data-dir", dataDir}, args...)
		config()
		initSettings()
	}
	t.Setenv("KRIK_STATE_FILE", "")
	t.Setenv("KRIK_SLOTS_FILE", "")
	t.Setenv("KRIK_REPOS_DIR", "")
	parse()
	if stateFile != cfg.StateFile || slotsFile != cfg.SlotsFile || reposDir != "" || explicitState {
		t.Fatal("config not applied", stateFile, slotsFile)
	}
	t.Setenv("KRIK_STATE_FILE", filepath.Join(dir, "env-state.json"))
	parse()
	if stateFile != filepath.Join(dir, "env-state.json") || !explicitState || slotsFile != cfg.SlotsFile {
		t.Fatal("environment must beat config", stateFile)
	}
	parse("--state-file", filepath.Join(dir, "flag-state.json"))
	if stateFile != filepath.Join(dir, "flag-state.json") {
		t.Fatal("flag must beat environment", stateFile)
	}
	t.Setenv("KRIK_STATE_FILE", "")
	os.Remove(configFilePath(dataDir))
	parse()
	if stateFile != filepath.Join(dataDir, "state", "tong-hop-chung.json") || slotsFile != "" {
		t.Fatal("default state must live under the data folder", stateFile, slotsFile)
	}
	if !setupRequired() {
		t.Fatal("a fresh profile without a legacy folder must require setup")
	}
	t.Setenv("KRIK_REPOS_DIR", dir)
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
	if prev["work/web/plan"].Agent != "Codex" || prev["oss/web/plan"].Agent != "Claude" || len(prev) != 2 {
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
	// A status change finds the plan in its own project.
	file := filepath.Join(oss, "web", ".tasks", "plan.md")
	original, _ := os.ReadFile(file)
	if err := writePlanStatus(statusChange{Project: "oss", Repo: "web", Plan: "plan", Status: "Testing", Revision: revisionOf(original)}); err != nil {
		t.Fatal(err)
	}
	if updated, _ := os.ReadFile(file); !strings.Contains(string(updated), "Status: Testing") {
		t.Fatal("status not written to the repo project")
	}
	if b, _ := os.ReadFile(filepath.Join(work, "web", ".tasks", "plan.md")); strings.Contains(string(b), "Testing") {
		t.Fatal("wrote the same-named repository in another project")
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
	if w, out := call(t, handleSettings, "PUT", "/api/settings", map[string]any{"setupComplete": true}); w.Code != 400 || !strings.Contains(out["error"].(string), "at least one project") {
		t.Fatal("setup finished without a project", w.Code, out)
	}
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
			t.Fatal("write without X-Workboard accepted", w.Code)
		}
		r = httptest.NewRequest("POST", "http://"+addr+"/x", strings.NewReader(`{}`))
		r.Header.Set("X-Workboard", "1")
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
	pickFolder = func(context.Context) (string, error) { return `C:\Projects\web`, nil }
	if w, out := call(t, handlePickFolder, "POST", "/api/settings/pick-folder", nil); w.Code != 200 || out["path"] != `C:\Projects\web` {
		t.Fatal(w.Code, out)
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
	legacyDefaults = legacyPaths{repos: legacy, state: filepath.Join(dir, "legacy-state.json"), slots: filepath.Join(dir, "legacy-slots.json")}
	os.Remove(configFilePath(dataDir))
	stateFile, slotsFile = "", ""
	initSettings()
	if !setupRequired() || len(effectiveProjects()) != 0 || exists(configFilePath(dataDir)) {
		t.Fatal("an isolated data folder adopted the legacy folder")
	}
	legacyMigrationAllowed = func() bool { return true }
	stateFile, slotsFile = "", ""
	initSettings()
	if setupRequired() || len(effectiveProjects()) != 1 || effectiveProjects()[0].Path != legacy || stateFile != legacyDefaults.state || slotsFile != legacyDefaults.slots {
		t.Fatal("the installed data folder must migrate the legacy folder and keep its state and slots files", stateFile, slotsFile)
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
		explicitRepos, explicitState, explicitSlots = false, false, false
	})
	t.Setenv("KRIK_STATE_FILE", "")
	t.Setenv("KRIK_SLOTS_FILE", "")
	t.Setenv("KRIK_REPOS_DIR", "")
	legacy := filepath.Join(dir, "legacy repos")
	mkRepo(t, filepath.Join(legacy, "sample"), "plan")
	// Spelled with a different case and a trailing separator, as Windows allows.
	legacyDefaults = legacyPaths{repos: legacy, state: filepath.Join(dir, "legacy-state.json"), slots: filepath.Join(dir, "legacy-slots.json")}
	legacyMigrationAllowed = func() bool { return true }
	os.Remove(configFilePath(dataDir))
	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = []string{"agent-ops.exe", "--background", "--addr", addr, "--repos-dir", strings.ToUpper(legacy) + `\`,
		"--slots-file", legacyDefaults.slots, "--state-file", legacyDefaults.state, "--script", scriptFile,
		"--data-dir", dataDir, "--profile-dir", dir}
	config()
	initSettings()
	if reposDir != "" || setupRequired() || currentSettings().ProjectsOverridden != "" {
		t.Fatal("v0.1.4 launch arguments were treated as a --repos-dir override", reposDir)
	}
	if p := effectiveProjects(); len(p) != 1 || !strings.EqualFold(p[0].Path, legacy) {
		t.Fatal("the legacy folder was not migrated", p)
	}
	if stateFile != legacyDefaults.state || slotsFile != legacyDefaults.slots {
		t.Fatal("migration must keep the legacy state and slots files", stateFile, slotsFile)
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
