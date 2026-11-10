package main

import (
	"bufio"
	"errors"
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
	os.MkdirAll(profileDir, 0o700)
	return profileDir
}

func targetByID(p integrationsPayload, id string) targetStatus {
	for _, c := range p.Targets {
		if c.ID == id {
			return c
		}
	}
	return targetStatus{}
}

func act(t *testing.T, id, action string) (*httptest.ResponseRecorder, map[string]any) {
	t.Helper()
	return call(t, handleIntegrationAction, http.MethodPost, "/api/integrations/"+id+"/"+action, map[string]any{})
}

// addTarget posts a folder and returns its id ("" on failure) and the response.
func addTarget(t *testing.T, body map[string]any) (string, *httptest.ResponseRecorder) {
	t.Helper()
	w, out := call(t, handleIntegrations, http.MethodPost, "/api/integrations", body)
	id, _ := out["added"].(string)
	return id, w
}

func junction(t *testing.T, link, target string) {
	t.Helper()
	os.MkdirAll(filepath.Dir(link), 0o700)
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skip("junctions unavailable:", err, string(out))
	}
}

func TestIntegrationsOnlySuggestAndManageTheSkillPerFolder(t *testing.T) {
	profile := integrationsFixture(t)
	state := currentIntegrations()
	if len(state.Targets) != 0 || len(state.Suggestions) != 0 || state.SkillVersion != 2 {
		t.Fatalf("a clean profile has nothing listed or suggested: %+v", state)
	}
	os.MkdirAll(filepath.Join(profile, ".claude"), 0o700)
	os.MkdirAll(filepath.Join(profile, ".codex"), 0o700)
	state = currentIntegrations()
	if len(state.Targets) != 0 || len(state.Suggestions) != 2 {
		t.Fatalf("detection must only suggest: %+v", state)
	}
	claude := state.Suggestions[0]
	if claude.Label != "Claude Code" || claude.SkillDir != filepath.Join(profile, ".claude", "skills") || claude.InstructionFile != filepath.Join(profile, ".claude", "CLAUDE.md") {
		t.Fatalf("%+v", claude)
	}
	if s := state.Suggestions[1]; s.SkillDir != filepath.Join(profile, ".agents", "skills") || s.InstructionFile != filepath.Join(profile, ".codex", "AGENTS.md") {
		t.Fatalf("%+v", s)
	}
	if cfg, err := readAppConfig(configFilePath(dataDir)); err == nil && len(cfg.Integrations) != 0 {
		t.Fatal("detection wrote config", cfg.Integrations)
	}
	// Writes need the local header.
	r := httptest.NewRequest(http.MethodPost, "http://"+addr+"/api/integrations", strings.NewReader(`{"skillDir":"C:\\x"}`))
	r.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleIntegrations(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatal("write without the Agent Ops header", w.Code)
	}
	id, w := addTarget(t, map[string]any{"skillDir": claude.SkillDir, "instructionFile": claude.InstructionFile})
	if w.Code != http.StatusOK || id == "" {
		t.Fatal(w.Code, w.Body.String())
	}
	state = currentIntegrations()
	tg := targetByID(state, id)
	if tg.Source != "detected" || tg.Label != "Claude Code" || !tg.Enabled || tg.State != "not-installed" || tg.Instructions.State != "off" || len(state.Suggestions) != 1 {
		t.Fatalf("%+v %+v", tg, state.Suggestions)
	}
	r = httptest.NewRequest(http.MethodPost, "http://"+addr+"/api/integrations/"+id+"/install", nil)
	w = httptest.NewRecorder()
	handleIntegrationAction(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatal("action without the Agent Ops header", w.Code)
	}
	if w, out := act(t, id, "install"); w.Code != http.StatusOK {
		t.Fatal(w.Code, out)
	}
	skill := filepath.Join(profile, ".claude", "skills", "task-plan", "SKILL.md")
	if mread(t, skill) != string(embeddedSkill) {
		t.Fatal("skill not written")
	}
	if tg := targetByID(currentIntegrations(), id); tg.State != "installed" || tg.InstalledVersion != 2 {
		t.Fatalf("%+v", tg)
	}
	cfg, err := readAppConfig(configFilePath(dataDir))
	if err != nil || len(cfg.Integrations) != 1 || cfg.Integrations[0].SHA256 != sha256Hex([]byte(lfText(embeddedSkill))) || cfg.Integrations[0].Version != 2 || cfg.Integrations[0].InstalledAt == "" {
		t.Fatal(err, cfg.Integrations)
	}
	// A file Agent Ops wrote for an older skill version shows Update available.
	older := "---\nname: task-plan\nagent-ops-skill: 1\n---\nolder\n"
	mput(t, skill, older)
	cfgMu.Lock()
	appCfg.Integrations[0].SHA256, appCfg.Integrations[0].Version = sha256Hex([]byte(older)), 1
	cfgMu.Unlock()
	if tg := targetByID(currentIntegrations(), id); tg.State != "update-available" || tg.InstalledVersion != 1 {
		t.Fatalf("%+v", tg)
	}
	if w, _ := act(t, id, "update"); w.Code != http.StatusOK || mread(t, skill) != string(embeddedSkill) {
		t.Fatal("update", w.Code)
	}
	// An owner edit is modified locally: install, update and remove refuse; keep records it.
	edited := string(embeddedSkill) + "\n## Owner\n"
	mput(t, skill, edited)
	if tg := targetByID(currentIntegrations(), id); tg.State != "modified" || tg.Kept {
		t.Fatalf("%+v", tg)
	}
	for _, action := range []string{"install", "update", "remove"} {
		if w, _ := act(t, id, action); w.Code != http.StatusConflict || mread(t, skill) != edited {
			t.Fatal(action, "overwrote an owner edit", w.Code)
		}
	}
	w, out := call(t, handleIntegrationAction, http.MethodGet, "/api/integrations/"+id+"/diff", nil)
	if w.Code != 200 || out["identical"] != false || !strings.Contains(w.Body.String(), `{"op":"-","text":"## Owner"}`) {
		t.Fatal(w.Code, w.Body.String())
	}
	if w, _ := act(t, id, "keep"); w.Code != 200 || !targetByID(currentIntegrations(), id).Kept {
		t.Fatal("keep mine", w.Code)
	}
	if w, _ := act(t, id, "replace"); w.Code != 200 || mread(t, skill) != string(embeddedSkill) {
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
	if w, _ := act(t, id, "remove"); w.Code != 200 || exists(skill) {
		t.Fatal("remove skill", w.Code)
	}
	if tg := targetByID(currentIntegrations(), id); tg.State != "not-installed" || tg.ID != id {
		t.Fatalf("Remove skill keeps the folder listed: %+v", tg)
	}
	if w, _ := act(t, "nobody", "install"); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
	if w, _ := act(t, id, "format-disk"); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
	if w, _ := act(t, "../x", "install"); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
}

func TestInstructionBlockIsOptInAndNeverTouchesOwnerText(t *testing.T) {
	profile := integrationsFixture(t)
	file := filepath.Join(profile, "tool", "AGENTS.md")
	owner := "# Owner\r\nKeep this.\r\n"
	mput(t, file, owner)
	id, w := addTarget(t, map[string]any{"skillDir": filepath.Join(profile, "tool", "skills"), "instructionFile": file})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if tg := targetByID(currentIntegrations(), id); tg.Instructions.State != "off" || tg.Source != "custom" || tg.Label != "tool" {
		t.Fatalf("%+v", tg)
	}
	if w, _ := act(t, id, "instructions-on"); w.Code != 200 {
		t.Fatal(w.Code)
	}
	got := mread(t, file)
	if !strings.HasPrefix(got, owner) || !strings.Contains(got, instructionLine) || strings.Count(got, "\n") != strings.Count(got, "\r\n") {
		t.Fatalf("%q", got)
	}
	if tg := targetByID(currentIntegrations(), id); tg.Instructions.State != "on" {
		t.Fatalf("%+v", tg)
	}
	if cfg, _ := readAppConfig(configFilePath(dataDir)); !cfg.Integrations[0].InstructionBlock {
		t.Fatal("instructionBlock not recorded")
	}
	if w, _ := act(t, id, "instructions-on"); w.Code != 200 || mread(t, file) != got {
		t.Fatal("a second enable changed the file")
	}
	// The instruction file cannot move while the reminder is in it.
	other := filepath.Join(profile, "tool", "OTHER.md")
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"instructionFile": other}); w.Code != http.StatusConflict {
		t.Fatal("moved the instruction file while the block is in it", w.Code)
	}
	if w, _ := act(t, id, "instructions-off"); w.Code != 200 || mread(t, file) != owner {
		t.Fatalf("%q", mread(t, file))
	}
	// An edited block is left for the owner.
	mput(t, file, owner+"\r\n"+instructionStart+"\r\nmy own words\r\n"+instructionEnd+"\r\n")
	if tg := targetByID(currentIntegrations(), id); tg.Instructions.State != "modified" {
		t.Fatalf("%+v", tg)
	}
	if w, _ := act(t, id, "instructions-off"); w.Code != http.StatusConflict || !strings.Contains(mread(t, file), "my own words") {
		t.Fatal("removed an edited block", w.Code)
	}
	// Without an instruction file there is nothing to toggle.
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"instructionFile": ""}); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if tg := targetByID(currentIntegrations(), id); tg.Instructions.State != "none" {
		t.Fatalf("%+v", tg)
	}
	if w, _ := act(t, id, "instructions-on"); w.Code != http.StatusConflict {
		t.Fatal(w.Code)
	}
}

func TestAddFolderValidatesPathsLinksProjectsAndDuplicates(t *testing.T) {
	profile := integrationsFixture(t)
	project := filepath.Join(profile, "repos", "web")
	os.MkdirAll(filepath.Join(project, ".git"), 0o700)
	cfgMu.Lock()
	appCfg.Projects = []Project{{ID: projectIDFor(project), Path: project, Name: "web", Kind: "repo", Enabled: true}}
	cfgMu.Unlock()
	existing := filepath.Join(profile, "client", "skills")
	os.MkdirAll(existing, 0o700)
	mput(t, filepath.Join(profile, "client", "notes.txt"), "x")
	os.MkdirAll(filepath.Join(profile, "client", "rules.md"), 0o700)
	id, w := addTarget(t, map[string]any{"skillDir": `"` + strings.ToUpper(existing) + `"`, "label": "  My client  "})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	if tg := targetByID(currentIntegrations(), id); tg.Label != "My client" || tg.Source != "custom" || tg.State != "not-installed" {
		t.Fatalf("%+v", tg)
	}
	link := filepath.Join(profile, "linked-skills")
	for name, c := range map[string]struct {
		body map[string]any
		want string
	}{
		"relative":            {map[string]any{"skillDir": `client\skills`}, "full folder path"},
		"no parent":           {map[string]any{"skillDir": filepath.Join(profile, "nope", "skills")}, "Neither this folder"},
		"a file":              {map[string]any{"skillDir": filepath.Join(profile, "client", "notes.txt")}, "is a file"},
		"duplicate":           {map[string]any{"skillDir": existing + `\`}, "already in the list as “My client”"},
		"inside a project":    {map[string]any{"skillDir": filepath.Join(project, ".claude", "skills")}, "inside the project “web”"},
		"empty":               {map[string]any{}, "Choose a skills folder"},
		"bad label":           {map[string]any{"skillDir": filepath.Join(profile, "client", "new"), "label": strings.Repeat("x", 81)}, "1 to 80"},
		"instruction dir":     {map[string]any{"skillDir": filepath.Join(profile, "client", "new"), "instructionFile": filepath.Join(profile, "client", "rules.md")}, "is a folder"},
		"instruction gone":    {map[string]any{"skillDir": filepath.Join(profile, "client", "new"), "instructionFile": filepath.Join(profile, "gone", "AGENTS.md")}, "does not exist"},
		"instruction in repo": {map[string]any{"skillDir": filepath.Join(profile, "client", "new"), "instructionFile": filepath.Join(project, "AGENTS.md")}, "inside the project"},
	} {
		if _, w := addTarget(t, c.body); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), c.want) {
			t.Errorf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	if w, _ := call(t, handleIntegrations, http.MethodPost, "/api/integrations", map[string]any{"skillDir": existing, "unknown": 1}); w.Code != http.StatusBadRequest {
		t.Fatal("unknown field accepted", w.Code)
	}
	// A junction to a listed folder is the same place.
	junction(t, link, existing)
	if _, w := addTarget(t, map[string]any{"skillDir": link}); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "already in the list") {
		t.Fatal("a junction to a listed folder was added", w.Code, w.Body.String())
	}
	if _, w := addTarget(t, map[string]any{"skillDir": filepath.Join(link, "sub")}); w.Code != http.StatusOK {
		t.Fatal("a new folder below a junction is a different folder", w.Body.String())
	}
	if cfg, _ := readAppConfig(configFilePath(dataDir)); len(cfg.Integrations) != 2 {
		t.Fatal(cfg.Integrations)
	}
}

func TestEditEnableAndRemoveTargets(t *testing.T) {
	profile := integrationsFixture(t)
	first := filepath.Join(profile, "a", "skills")
	os.MkdirAll(filepath.Dir(first), 0o700)
	id, _ := addTarget(t, map[string]any{"skillDir": first})
	if w, _ := act(t, id, "install"); w.Code != 200 {
		t.Fatal(w.Code)
	}
	// Turned off: no file action, state still shown.
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"enabled": false}); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if tg := targetByID(currentIntegrations(), id); tg.Enabled || tg.State != "installed" {
		t.Fatalf("%+v", tg)
	}
	if w, _ := act(t, id, "replace"); w.Code != http.StatusConflict || !exists(skillFileOf(first)) {
		t.Fatal("a turned-off folder was changed", w.Code)
	}
	call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"enabled": true})
	// Edit path: hashes are content hashes, so a moved copy is still recognised.
	moved := filepath.Join(profile, "b", "skills")
	mput(t, skillFileOf(moved), string(embeddedSkill)[:40])
	cfgMu.Lock()
	appCfg.Integrations[0].SHA256 = sha256Hex([]byte(string(embeddedSkill)[:40]))
	cfgMu.Unlock()
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"skillDir": moved, "label": "Moved"}); w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
	if tg := targetByID(currentIntegrations(), id); tg.SkillDir != moved || tg.Label != "Moved" || tg.State != "update-available" {
		t.Fatalf("%+v", tg)
	}
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"label": ""}); w.Code != http.StatusBadRequest {
		t.Fatal(w.Code)
	}
	// Missing folder: neither the folder nor its parent exists any more.
	os.RemoveAll(filepath.Join(profile, "b"))
	if tg := targetByID(currentIntegrations(), id); tg.State != "missing-folder" {
		t.Fatalf("%+v", tg)
	}
	if w, _ := act(t, id, "install"); w.Code != http.StatusConflict {
		t.Fatal(w.Code)
	}
	// Remove from the list leaves files alone.
	second, _ := addTarget(t, map[string]any{"skillDir": first + "2"})
	act(t, second, "install")
	if w, _ := call(t, handleIntegrationAction, http.MethodDelete, "/api/integrations/"+second, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
	if !exists(skillFileOf(first+"2")) || targetByID(currentIntegrations(), second).ID != "" {
		t.Fatal("remove from list deleted files or kept the entry")
	}
	if w, _ := call(t, handleIntegrationAction, http.MethodDelete, "/api/integrations/"+second, nil); w.Code != http.StatusNotFound {
		t.Fatal(w.Code)
	}
	if w, _ := call(t, handleIntegrationAction, http.MethodPut, "/api/integrations/"+id, map[string]any{}); w.Code != http.StatusMethodNotAllowed {
		t.Fatal(w.Code)
	}
	// Read-only settings refuse every change.
	cfgMu.Lock()
	configReadOnly = "Settings cannot be saved."
	cfgMu.Unlock()
	if _, w := addTarget(t, map[string]any{"skillDir": first + "3"}); w.Code != http.StatusConflict {
		t.Fatal(w.Code)
	}
}

func TestDetectionSkipsFoldersLinkedToListedOnes(t *testing.T) {
	profile := integrationsFixture(t)
	claudeSkills := filepath.Join(profile, ".claude", "skills")
	os.MkdirAll(claudeSkills, 0o700)
	orca := filepath.Join(profile, "AppData", "Roaming", "orca", "claude-profiles")
	junction(t, filepath.Join(orca, "linked", "home", "skills"), claudeSkills)
	os.MkdirAll(filepath.Join(orca, "own", "home"), 0o700)
	os.MkdirAll(filepath.Join(profile, ".gemini"), 0o700)
	got := detectIntegrationTargets(profile, nil)
	labels := []string{}
	for _, s := range got {
		labels = append(labels, s.Label+"="+s.SkillDir)
	}
	want := []string{"Claude Code=" + claudeSkills, "Orca Claude profile own=" + filepath.Join(orca, "own", "home", "skills"), "Antigravity / Gemini=" + filepath.Join(profile, ".gemini", "skills")}
	if strings.Join(labels, "|") != strings.Join(want, "|") {
		t.Fatalf("%v", labels)
	}
	// A listed folder (here through the Orca junction) is no longer suggested.
	got = detectIntegrationTargets(profile, []IntegrationTarget{{SkillDir: filepath.Join(orca, "linked", "home", "skills")}})
	if len(got) != 2 || got[0].Client != "orca" {
		t.Fatalf("%+v", got)
	}
}

func TestPerClientRecordsConvertToTheFolderList(t *testing.T) {
	profile := integrationsFixture(t)
	shared := filepath.Join(profile, ".agents", "skills", "task-plan", "SKILL.md")
	gemini := filepath.Join(profile, ".gemini", "GEMINI.md")
	raw := `{"version":1,"projects":[],"integrations":{
  "claude":{"path":` + jsonString(filepath.Join(profile, ".claude", "skills", "task-plan", "SKILL.md")) + `,"version":2,"sha256":"aa","kept":"kk"},
  "codex":{"path":` + jsonString(shared) + `,"version":2,"sha256":"bb","legacy":{".agents/skills/task-plan/SKILL.md#file":"cc"}},
  "gemini":{"path":` + jsonString(shared) + `,"version":2,"sha256":"bb","instructions":{"path":` + jsonString(gemini) + `,"sha256":"dd"}}}}`
	mput(t, configFilePath(dataDir), raw)
	cfg, err := readAppConfig(configFilePath(dataDir))
	if err != nil || len(cfg.Integrations) != 2 {
		t.Fatal(err, cfg.Integrations)
	}
	c, s := cfg.Integrations[0], cfg.Integrations[1]
	if c.SkillDir != filepath.Join(profile, ".claude", "skills") || c.SHA256 != "aa" || c.Kept != "kk" || c.Version != 2 || c.Label != "Claude Code" || !c.Enabled || c.Source != "detected" {
		t.Fatalf("%+v", c)
	}
	if s.SkillDir != filepath.Join(profile, ".agents", "skills") || s.SHA256 != "bb" || s.LegacySHA256 != "cc" || s.InstructionFile != gemini || !s.InstructionBlock || s.InstructionSHA256 != "dd" {
		t.Fatalf("%+v", s)
	}
	if err := writeAppConfig(configFilePath(dataDir), cfg); err != nil {
		t.Fatal(err)
	}
	if written := mread(t, configFilePath(dataDir)); !strings.Contains(written, `"integrations": [`) || !strings.Contains(written, `"skillDir"`) {
		t.Fatal(written)
	}
	// An invalid list is a content error (the file is moved aside, not overwritten).
	mput(t, configFilePath(dataDir), `{"version":1,"projects":[],"integrations":[{"id":"Bad id","label":"x","skillDir":"C:\\x","source":"custom"}]}`)
	var content *configContentError
	if _, err := readAppConfig(configFilePath(dataDir)); !errors.As(err, &content) {
		t.Fatal(err)
	}
}

// Client folder names live only in the detection provider and the migration
// (plus tests, test scripts, the installer and documents), so a live install
// never depends on where one machine keeps its AI clients.
func TestNoClientPathsOutsideDetection(t *testing.T) {
	out, err := exec.Command("git", "ls-files").Output()
	if err != nil {
		t.Skip("not a git checkout:", err)
	}
	allowed := map[string]bool{"integration_detect.go": true, "migrate.go": true, "legacy.go": true}
	pattern := regexp.MustCompile("(^|[\\\\/~\"'`(\\s])\\.(claude|agents|codex|gemini)\\b|claude-profiles")
	checked := 0
	for _, file := range strings.Fields(string(out)) {
		if allowed[file] || strings.HasSuffix(file, "_test.go") || strings.HasSuffix(file, "test.mjs") || strings.HasSuffix(file, ".md") || strings.HasPrefix(file, "scripts/") || strings.HasPrefix(file, "testdata/") {
			continue
		}
		if !strings.HasSuffix(file, ".go") && !strings.HasSuffix(file, ".mjs") && !strings.HasSuffix(file, ".html") && !strings.HasSuffix(file, ".ps1") {
			continue
		}
		b, err := os.ReadFile(file)
		if err != nil {
			continue
		}
		checked++
		for i, line := range strings.Split(string(b), "\n") {
			if pattern.MatchString(line) {
				t.Errorf("%s:%d names a client folder: %s", file, i+1, strings.TrimSpace(line))
			}
		}
	}
	if checked < 20 {
		t.Fatal("too few files checked", checked)
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
	allowed := map[string]bool{"/": true, "/icons/": true, "/fonts/": true, "/events": true, "/api/state": true, "/api/refresh": true,
		"/api/settings": true, "/api/settings/pick-folder": true, "/api/settings/open-folder": true, "/api/projects": true, "/api/projects/": true,
		"/api/integrations": true, "/api/integrations/": true, "/api/updates": true, "/api/updates/": true, "/api/diagnostics": true, "/api/diagnostics/dismiss-crash": true,
		// The running instance: who it is, and opening its window for a second launch.
		"/api/instance": true, "/api/instance/open": true}
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
	// Before the migration is recorded (a rollback may still restore the previous
	// release) the old entries stay and startup reads as on.
	if err := migrateStartup(exe, false); err != nil || registerProtocol(exe, false) != nil {
		t.Fatal(err)
	}
	if _, ok := reg.GetString(runKey, legacyRunValue); !ok || !startupEnabled() {
		t.Fatal("the old Run value was moved before the migration was recorded")
	}
	if _, ok := reg.GetString(legacyKey, ""); !ok {
		t.Fatal("the old protocol was removed before the migration was recorded")
	}
	if _, ok := reg.GetString(runKey, runName); ok {
		t.Fatal("a second Run value was added next to the old one")
	}
	if err := migrateStartup(exe, true); err != nil {
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
	if err := registerProtocol(exe, true); err != nil {
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
	if err := migrateStartup(exe, true); err != nil || startupEnabled() {
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
	// Migration code, its tests (including the end-to-end update and smoke tests that seed an
	// old installation) and tests asserting the old name is gone.
	migration := map[string]bool{"legacy.go": true, "migrate.go": true, "migrate_test.go": true, "integrations_test.go": true, "testdata/legacy-task-plan-skill.md": true, "scripts/update-e2e.mjs": true, "scripts/smoke.mjs": true, "web_test.mjs": true}
	// Documents may name the install folder and data folder of earlier releases.
	documented := regexp.MustCompile(`(?i)(tools[\\/]+workboard|%LOCALAPPDATA%[\\/]krik-workboard|krik-workboard\.exe|workboard-executions|workboard-integrations\.json|workboard-task-reporting)`)
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
	saved := []any{reposDir, stateFile, ignoredScript, addr, dataDir, background, activation, profileDir, disableUpdateChecks, printVersion, applyUpdateFile, updateFeed, migrateMode, migrateRuntime, dataDirGiven, ignoredSlotsFile, explicitRepos, explicitState, legacyLaunch}
	t.Cleanup(func() {
		flag.CommandLine, os.Args = oldFlags, oldArgs
		reposDir, stateFile, ignoredScript, addr = saved[0].(string), saved[1].(string), saved[2].(string), saved[3].(string)
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

// A file changed between the state read and the write is never overwritten:
// the write expects exactly the bytes the state was computed from.
func TestActionsWriteAgainstTheBytesTheyChecked(t *testing.T) {
	profile := integrationsFixture(t)
	dir := filepath.Join(profile, "tool", "skills")
	instructions := filepath.Join(profile, "tool", "AGENTS.md")
	mput(t, instructions, "# Owner\n")
	id, w := addTarget(t, map[string]any{"skillDir": dir, "instructionFile": instructions})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	old := afterIntegrationRead
	t.Cleanup(func() { afterIntegrationRead = old })
	afterIntegrationRead = func(file string) {
		if file == skillFileOf(dir) {
			mput(t, file, "owner skill written meanwhile")
		}
		if file == instructions {
			mput(t, file, "# Owner\nedited meanwhile\n")
		}
	}
	if w, _ := act(t, id, "install"); w.Code != http.StatusConflict || mread(t, skillFileOf(dir)) != "owner skill written meanwhile" {
		t.Fatal("install overwrote a file written after its check", w.Code)
	}
	if w, _ := act(t, id, "instructions-on"); w.Code != http.StatusConflict || mread(t, instructions) != "# Owner\nedited meanwhile\n" {
		t.Fatal("the reminder overwrote an edit made after its check", w.Code)
	}
}

// A turned-off folder can still be cleaned up, and a folder whose reminder is
// on cannot be dropped from the list (the block would stay unmanaged).
func TestTurnedOffFolderCanBeCleanedUpBeforeRemoval(t *testing.T) {
	profile := integrationsFixture(t)
	dir := filepath.Join(profile, "tool", "skills")
	instructions := filepath.Join(profile, "tool", "AGENTS.md")
	mput(t, instructions, "# Owner\n")
	id, _ := addTarget(t, map[string]any{"skillDir": dir, "instructionFile": instructions})
	for _, action := range []string{"install", "instructions-on"} {
		if w, _ := act(t, id, action); w.Code != 200 {
			t.Fatal(action, w.Code)
		}
	}
	call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+id, map[string]any{"enabled": false})
	if w, _ := call(t, handleIntegrationAction, http.MethodDelete, "/api/integrations/"+id, nil); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "reminder off") {
		t.Fatal("removed from the list with the reminder on", w.Code)
	}
	if w, _ := act(t, id, "instructions-on"); w.Code != http.StatusConflict {
		t.Fatal("a turned-off folder accepted a new write", w.Code)
	}
	for _, action := range []string{"instructions-off", "remove"} {
		if w, _ := act(t, id, action); w.Code != 200 {
			t.Fatal(action, w.Code, w.Body.String())
		}
	}
	if mread(t, instructions) != "# Owner\n" || exists(skillFileOf(dir)) {
		t.Fatal("cleanup left Agent Ops text behind")
	}
	if w, _ := call(t, handleIntegrationAction, http.MethodDelete, "/api/integrations/"+id, nil); w.Code != 200 {
		t.Fatal(w.Code)
	}
}

// A task-plan folder that is a junction into a repository is refused when the
// folder is added and at action time (the junction can appear later).
func TestLinkedTaskPlanFolderIntoAProjectIsNeverWritten(t *testing.T) {
	profile := integrationsFixture(t)
	project := filepath.Join(profile, "repos", "web")
	repoSkill := filepath.Join(project, "skills", "task-plan")
	mput(t, filepath.Join(repoSkill, "SKILL.md"), string(embeddedSkill))
	os.MkdirAll(filepath.Join(project, ".git"), 0o700)
	cfgMu.Lock()
	appCfg.Projects = []Project{{ID: projectIDFor(project), Path: project, Name: "web", Kind: "repo", Enabled: true}}
	cfgMu.Unlock()
	linked := filepath.Join(profile, "client", "skills")
	junction(t, filepath.Join(linked, "task-plan"), repoSkill)
	if _, w := addTarget(t, map[string]any{"skillDir": linked}); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), "inside the project “web”") {
		t.Fatal("a folder linking into a project was added", w.Code, w.Body.String())
	}
	plain := filepath.Join(profile, "other", "skills")
	os.MkdirAll(plain, 0o700)
	id, w := addTarget(t, map[string]any{"skillDir": plain})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	junction(t, filepath.Join(plain, "task-plan"), repoSkill)
	for _, action := range []string{"replace", "remove"} {
		if w, _ := act(t, id, action); w.Code != http.StatusConflict || !strings.Contains(w.Body.String(), "edit the skill at its source") {
			t.Fatal(action, "wrote into a project", w.Code, w.Body.String())
		}
	}
	if mread(t, filepath.Join(repoSkill, "SKILL.md")) != string(embeddedSkill) {
		t.Fatal("the repository copy changed")
	}
}

// Instruction files are Markdown, used by one folder only; network and device
// paths are refused.
func TestInstructionFileAndPathRules(t *testing.T) {
	profile := integrationsFixture(t)
	shared := filepath.Join(profile, "tool", "AGENTS.md")
	mput(t, shared, "# Owner\n")
	mput(t, filepath.Join(profile, "tool", "settings.json"), "{}")
	first, w := addTarget(t, map[string]any{"skillDir": filepath.Join(profile, "tool", "a"), "instructionFile": shared})
	if w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	second, _ := addTarget(t, map[string]any{"skillDir": filepath.Join(profile, "tool", "b")})
	for name, c := range map[string]struct {
		body map[string]any
		want string
	}{
		"json file":   {map[string]any{"skillDir": filepath.Join(profile, "tool", "c"), "instructionFile": filepath.Join(profile, "tool", "settings.json")}, "Markdown"},
		"script":      {map[string]any{"skillDir": filepath.Join(profile, "tool", "c"), "instructionFile": filepath.Join(profile, "tool", "run.ps1")}, "Markdown"},
		"shared file": {map[string]any{"skillDir": filepath.Join(profile, "tool", "c"), "instructionFile": strings.ToUpper(shared)}, "already used by"},
		"device":      {map[string]any{"skillDir": `\\.\pipe\x`}, "on this computer"},
		"long device": {map[string]any{"skillDir": `\\?\` + filepath.Join(profile, "tool", "c")}, "on this computer"},
		"network":     {map[string]any{"skillDir": `\\server\share\skills`}, "on this computer"},
		"network fwd": {map[string]any{"skillDir": `//server/share/skills`}, "on this computer"},
	} {
		if _, w := addTarget(t, c.body); w.Code != http.StatusBadRequest || !strings.Contains(w.Body.String(), c.want) {
			t.Errorf("%s: %d %s", name, w.Code, w.Body.String())
		}
	}
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+second, map[string]any{"instructionFile": shared}); w.Code != http.StatusBadRequest {
		t.Fatal("two folders share one instruction file", w.Code)
	}
	if w, _ := call(t, handleIntegrationAction, http.MethodPatch, "/api/integrations/"+first, map[string]any{"instructionFile": shared, "label": "Same"}); w.Code != 200 {
		t.Fatal("a folder's own instruction file was refused", w.Code, w.Body.String())
	}
}
