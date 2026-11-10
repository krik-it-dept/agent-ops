package main

import (
	"bufio"
	"flag"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func integrationsFixture(t *testing.T) string {
	t.Helper()
	dir := settingsFixture(t)
	old := profileDir
	t.Cleanup(func() { profileDir = old })
	profileDir = filepath.Join(dir, "profile")
	return profileDir
}

func integrationState(t *testing.T) integrationsPayload {
	t.Helper()
	return currentIntegrations()
}

func clientByID(p integrationsPayload, id string) clientStatus {
	for _, c := range p.Clients {
		if c.ID == id {
			return c
		}
	}
	return clientStatus{}
}

func act(t *testing.T, client, action string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return call(t, handleIntegrationAction, http.MethodPost, "/api/integrations/"+client+"/"+action, map[string]any{})
}

func TestIntegrationsDetectInstallKeepReplaceAndRemove(t *testing.T) {
	profile := integrationsFixture(t)
	state := integrationState(t)
	if len(state.Clients) != 3 || state.SkillVersion != 2 {
		t.Fatalf("%+v", state)
	}
	for _, c := range state.Clients {
		if c.Detected || c.Skill.State != "not-detected" || c.Instructions.State != "not-detected" {
			t.Fatalf("nothing is installed on a clean profile: %+v", c)
		}
	}
	if w, _ := act(t, "claude", "install"); w.Code != http.StatusConflict {
		t.Fatal("installed into a client that is not there", w.Code)
	}
	os.MkdirAll(filepath.Join(profile, ".claude"), 0o700)
	os.MkdirAll(filepath.Join(profile, ".codex"), 0o700)
	state = integrationState(t)
	if c := clientByID(state, "claude"); !c.Detected || c.Skill.State != "not-installed" {
		t.Fatalf("%+v", c)
	}
	if c := clientByID(state, "codex"); c.Skill.State != "not-installed" || strings.Join(c.Skill.SharedWith, ",") != "gemini" {
		t.Fatalf("%+v", c)
	}
	// Writes need the local header.
	r := httptest.NewRequest(http.MethodPost, "http://"+addr+"/api/integrations/claude/install", nil)
	w := httptest.NewRecorder()
	handleIntegrationAction(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatal("write without the Agent Ops header", w.Code)
	}
	if w, out := act(t, "claude", "install"); w.Code != http.StatusOK {
		t.Fatal(w.Code, out)
	}
	skill := filepath.Join(profile, ".claude", "skills", "task-plan", "SKILL.md")
	if mread(t, skill) != string(embeddedSkill) {
		t.Fatal("skill not written")
	}
	if c := clientByID(integrationState(t), "claude"); c.Skill.State != "installed" || c.Skill.InstalledVersion != 2 {
		t.Fatalf("%+v", c)
	}
	cfg, err := readAppConfig(configFilePath(dataDir))
	if err != nil || cfg.Integrations["claude"].SHA256 != sha256Hex([]byte(lfText(embeddedSkill))) || cfg.Integrations["claude"].Version != 2 || cfg.Integrations["claude"].InstalledAt == "" {
		t.Fatal(err, cfg.Integrations)
	}
	// A file Agent Ops wrote for an older skill version shows Update available.
	older := "---\nname: task-plan\nagent-ops-skill: 1\n---\nolder\n"
	mput(t, skill, older)
	cfgMu.Lock()
	rec := appCfg.Integrations["claude"]
	rec.SHA256, rec.Version = sha256Hex([]byte(older)), 1
	appCfg.Integrations["claude"] = rec
	cfgMu.Unlock()
	if c := clientByID(integrationState(t), "claude"); c.Skill.State != "update-available" {
		t.Fatalf("%+v", c)
	}
	if w, _ := act(t, "claude", "update"); w.Code != http.StatusOK || mread(t, skill) != string(embeddedSkill) {
		t.Fatal("update", w.Code)
	}
	// An owner edit is modified locally: install and remove refuse, keep records it.
	edited := string(embeddedSkill) + "\n## Owner\n"
	mput(t, skill, edited)
	if c := clientByID(integrationState(t), "claude"); c.Skill.State != "modified" || c.Skill.Kept {
		t.Fatalf("%+v", c)
	}
	for _, action := range []string{"install", "update", "remove"} {
		if w, _ := act(t, "claude", action); w.Code != http.StatusConflict || mread(t, skill) != edited {
			t.Fatal(action, "overwrote an owner edit", w.Code)
		}
	}
	w, out := call(t, handleIntegrationAction, http.MethodGet, "/api/integrations/claude/diff", nil)
	if w.Code != 200 || out["identical"] != false || !strings.Contains(w.Body.String(), `{"op":"-","text":"## Owner"}`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w, _ := act(t, "claude", "keep"); w.Code != 200 || !clientByID(integrationState(t), "claude").Skill.Kept {
		t.Fatal("keep mine", w.Code)
	}
	if w, _ := act(t, "claude", "replace"); w.Code != 200 || mread(t, skill) != string(embeddedSkill) {
		t.Fatal("replace", w.Code)
	}
	backups, _ := filepath.Glob(filepath.Join(dataDir, "backups", "integrations", "*", ".claude", "skills", "task-plan", "SKILL.md"))
	found := false
	for _, b := range backups {
		found = found || mread(t, b) == edited
	}
	if !found {
		t.Fatal("replace kept no backup of the owner's file", backups)
	}
	if w, _ := act(t, "claude", "remove"); w.Code != 200 || exists(skill) {
		t.Fatal("remove", w.Code)
	}
	if c := clientByID(integrationState(t), "claude"); c.Skill.State != "not-installed" {
		t.Fatalf("%+v", c)
	}
	// A shared skill is recorded for both clients that read it.
	if w, _ := act(t, "codex", "install"); w.Code != 200 {
		t.Fatal(w.Code)
	}
	cfg, _ = readAppConfig(configFilePath(dataDir))
	if cfg.Integrations["codex"].SHA256 == "" || cfg.Integrations["gemini"].SHA256 == "" {
		t.Fatal(cfg.Integrations)
	}
	if w, _ := act(t, "nobody", "install"); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
	if w, _ := act(t, "codex", "format-disk"); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
}

func TestInstructionBlockIsOptInAndNeverTouchesOwnerText(t *testing.T) {
	profile := integrationsFixture(t)
	os.MkdirAll(filepath.Join(profile, ".codex"), 0o700)
	file := filepath.Join(profile, ".codex", "AGENTS.md")
	owner := "# Owner\r\nKeep this.\r\n"
	mput(t, file, owner)
	if c := clientByID(integrationState(t), "codex"); c.Instructions.State != "off" {
		t.Fatalf("%+v", c)
	}
	if w, _ := act(t, "codex", "instructions-on"); w.Code != 200 {
		t.Fatal(w.Code)
	}
	got := mread(t, file)
	if !strings.HasPrefix(got, owner) || !strings.Contains(got, instructionLine) || strings.Count(got, "\n") != strings.Count(got, "\r\n") {
		t.Fatalf("%q", got)
	}
	if c := clientByID(integrationState(t), "codex"); c.Instructions.State != "on" {
		t.Fatalf("%+v", c)
	}
	if w, _ := act(t, "codex", "instructions-on"); w.Code != 200 || mread(t, file) != got {
		t.Fatal("a second enable changed the file")
	}
	if w, _ := act(t, "codex", "instructions-off"); w.Code != 200 || mread(t, file) != owner {
		t.Fatalf("%q", mread(t, file))
	}
	// An edited block is left for the owner.
	mput(t, file, owner+"\r\n"+instructionStart+"\r\nmy own words\r\n"+instructionEnd+"\r\n")
	if c := clientByID(integrationState(t), "codex"); c.Instructions.State != "modified" {
		t.Fatalf("%+v", c)
	}
	if w, _ := act(t, "codex", "instructions-off"); w.Code != http.StatusConflict || !strings.Contains(mread(t, file), "my own words") {
		t.Fatal("removed an edited block", w.Code)
	}
}

func TestRemovedPlanWriteRoutesAreGone(t *testing.T) {
	settingsFixture(t)
	mux := newServeMux()
	for _, path := range []string{"/api/plans/status", "/api/plans/agent", "/api/plans/executor", "/api/plans/step-executor"} {
		r := httptest.NewRequest(http.MethodPost, "http://"+addr+path, strings.NewReader(`{}`))
		r.Header.Set("X-Agent-Ops", "1")
		r.Header.Set("Content-Type", "application/json")
		w := httptest.NewRecorder()
		mux.ServeHTTP(w, r)
		if w.Code != http.StatusNotFound {
			t.Fatal(path, w.Code)
		}
	}
	// Every route the app registers, from the sources.
	allowed := map[string]bool{"/": true, "/icons/": true, "/events": true, "/api/state": true, "/api/refresh": true,
		"/api/settings": true, "/api/settings/pick-folder": true, "/api/settings/open-folder": true, "/api/projects": true, "/api/projects/": true,
		"/api/integrations": true, "/api/integrations/": true, "/api/updates": true, "/api/updates/": true, "/api/diagnostics": true, "/api/diagnostics/dismiss-crash": true}
	pattern := regexp.MustCompile(`(?:mux\.HandleFunc|mux\.Handle)\("([^"]+)"`)
	files, _ := filepath.Glob("*.go")
	seen := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") {
			continue
		}
		for _, m := range pattern.FindAllStringSubmatch(mread(t, file), -1) {
			seen++
			if !allowed[m[1]] {
				t.Errorf("%s registers %s, which is not a read-only ledger route", file, m[1])
			}
		}
	}
	if seen < 10 {
		t.Fatal("routes not found in the sources", seen)
	}
}

// fakeRegistry is HKEY_CURRENT_USER in memory.
type fakeRegistry map[string]map[string]string

func (f fakeRegistry) GetString(path, name string) (string, bool) {
	v, ok := f[strings.ToLower(path)][name]
	return v, ok
}
func (f fakeRegistry) SetString(path, name, value string) error {
	key := strings.ToLower(path)
	if f[key] == nil {
		f[key] = map[string]string{}
	}
	f[key][name] = value
	return nil
}
func (f fakeRegistry) DeleteValue(path, name string) error {
	delete(f[strings.ToLower(path)], name)
	return nil
}
func (f fakeRegistry) DeleteTree(path string) error {
	prefix := strings.ToLower(path)
	for k := range f {
		if k == prefix || strings.HasPrefix(k, prefix+`\`) {
			delete(f, k)
		}
	}
	return nil
}

func TestRegistryEntriesMoveToTheNewNames(t *testing.T) {
	old := userRegistry
	t.Cleanup(func() { userRegistry = old })
	reg := fakeRegistry{}
	userRegistry = reg
	exe := `C:\Users\Owner\Apps\agent-ops.exe`
	reg.SetString(runKey, legacyRunValue, `"`+exe+`"`)
	reg.SetString(runKey, "Other app", "other.exe")
	legacyKey := `Software\Classes\` + legacyProtocol
	reg.SetString(legacyKey, "", "URL:old")
	reg.SetString(legacyKey+`\shell\open\command`, "", "old.exe")
	if err := migrateStartup(exe); err != nil {
		t.Fatal(err)
	}
	if v, ok := reg.GetString(runKey, runName); !ok || v != `"`+exe+`" --background` || runName != "Agent Ops" {
		t.Fatal(v, ok)
	}
	if _, ok := reg.GetString(runKey, legacyRunValue); ok {
		t.Fatal("the old Run value is still there")
	}
	if v, _ := reg.GetString(runKey, "Other app"); v != "other.exe" {
		t.Fatal("another app's Run value changed")
	}
	if err := registerProtocol(exe); err != nil {
		t.Fatal(err)
	}
	if v, _ := reg.GetString(protocolKey+`\shell\open\command`, ""); v != protocolCommand(exe) {
		t.Fatal(v)
	}
	if _, ok := reg.GetString(protocolKey, "URL Protocol"); !ok {
		t.Fatal("URL Protocol value missing")
	}
	for k := range reg {
		if strings.HasPrefix(k, strings.ToLower(legacyKey)) {
			t.Fatal("old protocol left:", k)
		}
	}
	// Startup off stays off; the toggle uses the new name.
	setStartup(false)
	if startupEnabled() {
		t.Fatal("startup still on")
	}
	if err := migrateStartup(exe); err != nil || startupEnabled() {
		t.Fatal("migration turned startup on")
	}
	if !strings.HasPrefix(planURI("p/r/n"), "agent-ops:open?") || activationPlan("agent-ops:open?plan=x") != "x" || activationPlan(legacyProtocol+":open?plan=x") != "" {
		t.Fatal("protocol")
	}
}

func TestLegacyDataFolderArgumentMapsToTheNewFolder(t *testing.T) {
	t.Setenv("LOCALAPPDATA", filepath.Join(isolated(t), "Local"))
	parseArgs(t, "--data-dir", legacyDefaultDataDir())
	if dataDir != defaultDataDir() || !strings.HasSuffix(dataDir, `\AgentOps`) {
		t.Fatal(dataDir)
	}
	parseArgs(t)
	if dataDir != defaultDataDir() {
		t.Fatal("default", dataDir)
	}
	other := filepath.Join(os.Getenv("LOCALAPPDATA"), "elsewhere")
	parseArgs(t, "--data-dir", other)
	if dataDir != other {
		t.Fatal("an explicit folder must be kept", dataDir)
	}
	// The first start in the new folder copies the previous settings once.
	legacy := legacyDefaultDataDir()
	cfg := defaultAppConfig()
	cfg.SetupComplete = true
	if err := writeAppConfig(configFilePath(legacy), cfg); err != nil {
		t.Fatal(err)
	}
	if copied, err := adoptLegacyConfig(defaultDataDir(), legacy); !copied || err != nil {
		t.Fatal(copied, err)
	}
	if copied, _ := adoptLegacyConfig(defaultDataDir(), legacy); copied {
		t.Fatal("copied twice")
	}
}

// The old product name may appear only in the migration code, its tests and test
// data, and in the documented install folder path (which moves in a later release).
func TestOldProductNameOnlyInMigrationCode(t *testing.T) {
	out, err := exec.Command("git", "ls-files").Output()
	if err != nil {
		t.Skip("not a git checkout:", err)
	}
	// Migration code, its tests (including the end-to-end update test that seeds an
	// old installation) and tests asserting the old name is gone.
	migration := map[string]bool{"legacy.go": true, "migrate.go": true, "migrate_test.go": true, "integrations_test.go": true, "testdata/legacy-task-plan-skill.md": true, "scripts/update-e2e.mjs": true, "web_test.mjs": true}
	// Documents may name the install folder and data folder of earlier releases.
	documented := regexp.MustCompile(`(?i)(tools[\\/]+workboard|%LOCALAPPDATA%[\\/]krik-workboard|krik-workboard\.exe)`)
	name := regexp.MustCompile(`(?i)workboard`)
	checked := 0
	scanner := bufio.NewScanner(strings.NewReader(string(out)))
	for scanner.Scan() {
		file := scanner.Text()
		if migration[file] || strings.HasPrefix(file, "web/icons/") || strings.HasSuffix(file, ".syso") || strings.HasSuffix(file, ".png") || strings.HasSuffix(file, ".ico") || file == ".gitignore" {
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			continue // deleted in the working tree
		}
		checked++
		for i, line := range strings.Split(string(b), "\n") {
			if !name.MatchString(line) {
				continue
			}
			doc := strings.HasSuffix(file, ".md") || file == "scripts/install.ps1"
			if doc && name.FindAllStringIndex(line, -1) != nil && len(name.FindAllStringIndex(line, -1)) == len(documented.FindAllStringIndex(line, -1)) {
				continue
			}
			t.Errorf("%s:%d mentions the old product name: %s", file, i+1, strings.TrimSpace(line))
		}
	}
	if checked < 30 {
		t.Fatal("too few files checked", checked)
	}
}

// parseArgs runs config() on a fresh command line and restores every value it sets.
func parseArgs(t *testing.T, args ...string) {
	t.Helper()
	oldFlags, oldArgs := flag.CommandLine, os.Args
	saved := []any{reposDir, stateFile, scriptFile, addr, dataDir, background, activation, profileDir, disableUpdateChecks, printVersion, applyUpdateFile, updateFeed, migrateMode, migrateRuntime, dataDirGiven, ignoredSlotsFile, explicitRepos, explicitState, legacyLaunch}
	t.Cleanup(func() {
		flag.CommandLine, os.Args = oldFlags, oldArgs
		reposDir, stateFile, scriptFile, addr = saved[0].(string), saved[1].(string), saved[2].(string), saved[3].(string)
		dataDir, background, activation, profileDir = saved[4].(string), saved[5].(bool), saved[6].(string), saved[7].(string)
		disableUpdateChecks, printVersion, applyUpdateFile, updateFeed = saved[8].(bool), saved[9].(bool), saved[10].(string), saved[11].(string)
		migrateMode, migrateRuntime, dataDirGiven, ignoredSlotsFile = saved[12].(bool), saved[13].(string), saved[14].(bool), saved[15].(string)
		explicitRepos, explicitState, legacyLaunch = saved[16].(bool), saved[17].(bool), saved[18].(legacyPaths)
	})
	t.Setenv("AGENT_OPS_REPOS_DIR", "")
	t.Setenv("AGENT_OPS_STATE_FILE", "")
	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = append([]string{"agent-ops.exe"}, args...)
	config()
}
