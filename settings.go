package main

// Settings state and the local settings API used by first-run setup and the
// Settings page. Every write goes through the same local-request protection as
// status writes, is saved atomically to config.json and triggers a refresh.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"
	"unicode"

	"github.com/krik-it-dept/agent-ops/internal/plans"
)

var (
	cfgMu         sync.Mutex
	appCfg        = defaultAppConfig()
	configWarning string
	// Set when a corrupt config could not be moved aside; writes would destroy it.
	configReadOnly string

	// Replaced in tests so they never touch the registry, Explorer or a dialog.
	startupReader  = startupEnabled
	startupWriter  = setStartup
	startupManaged = defaultInstance
	pickFolder     = pickFolderDialog
	openFolder     = func(path string) error { return exec.Command("explorer.exe", path).Start() }
	pickerBusy     sync.Mutex
	// The first release's fixed paths, replaced in tests.
	legacyDefaults         = legacyPaths{repos: legacyReposDir, state: legacyStateFile}
	legacyMigrationAllowed = func() bool { return strings.EqualFold(filepath.Clean(dataDir), filepath.Clean(defaultDataDir())) }
)

func defaultDataDir() string { return filepath.Join(os.Getenv("LOCALAPPDATA"), "AgentOps") }

// legacyDefaultDataDir is the data folder of releases before v0.3.0.
func legacyDefaultDataDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), legacyDataDirName)
}

// The installed instance owns the Run key and protocol registration; dev, test
// and smoke instances on other ports or data folders never rewrite them.
func defaultInstance() bool {
	return !explicitAddr && strings.EqualFold(filepath.Clean(dataDir), filepath.Clean(defaultDataDir()))
}

// initSettings loads (or migrates) config.json and resolves the state file: flag > environment > config.json > default under dataDir.
func initSettings() {
	// The first release's fixed paths only migrate into the installed app's own data
	// folder; isolated, test and smoke runs never adopt the owner's real folders.
	legacy := legacyPaths{}
	if legacyMigrationAllowed() {
		legacy = legacyDefaults
	}
	for _, item := range []struct {
		target *string
		values []string
	}{
		{&legacy.repos, []string{reposDir, legacyLaunch.repos}},
		{&legacy.state, []string{stateFile, legacyLaunch.state}},
	} {
		for _, v := range item.values {
			if v != "" {
				*item.target = v
				break
			}
		}
	}
	file := configFilePath(dataDir)
	cfg, warning, err := loadOrMigrateConfig(file, legacy, time.Now())
	cfgMu.Lock()
	appCfg, configWarning, configReadOnly = cfg, warning, ""
	if err != nil {
		configWarning = strings.TrimSpace(warning + " " + err.Error())
		if exists(file) {
			configReadOnly = "Settings cannot be saved until " + file + " is fixed or removed."
		}
	}
	cfgMu.Unlock()
	if stateFile == "" {
		stateFile = cfg.StateFile
	}
	if stateFile == "" {
		stateFile = filepath.Join(dataDir, "state", "tong-hop-chung.json")
	}
}

func overrideProject() Project {
	return Project{ID: projectIDFor(reposDir), Path: reposDir, Name: projectDisplayName(reposDir), Kind: "folder", Enabled: true}
}

// effectiveProjects are the projects read this run: the --repos-dir override, or
// the enabled projects in config.json.
func effectiveProjects() []Project {
	if reposDir != "" {
		return []Project{overrideProject()}
	}
	cfgMu.Lock()
	defer cfgMu.Unlock()
	out := []Project{}
	for _, p := range appCfg.Projects {
		if p.Enabled {
			out = append(out, p)
		}
	}
	return out
}

func notificationsEnabled() bool {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return appCfg.Notifications
}

func setupRequired() bool {
	if reposDir != "" {
		return false
	}
	cfgMu.Lock()
	defer cfgMu.Unlock()
	// Setup could not save while the settings file is unusable; show the warning instead.
	return !appCfg.SetupComplete && configReadOnly == ""
}

// legacyProjectFor maps a pre-project "repo/plan" key to the single project that
// contains a repository folder with that name, or "" when it is ambiguous.
func legacyProjectFor(repo string, projects []Project) string {
	found := ""
	for _, p := range projects {
		match := false
		if p.Kind == "repo" {
			match = strings.EqualFold(repoNameOf(p.Path), repo)
		} else if st, err := os.Stat(filepath.Join(p.Path, repo)); err == nil && st.IsDir() {
			match = true
		}
		if match {
			if found != "" && found != p.ID {
				return ""
			}
			found = p.ID
		}
	}
	return found
}

func knownProjects() []Project {
	if reposDir != "" {
		return []Project{overrideProject()}
	}
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return append([]Project{}, appCfg.Projects...)
}

// mapLegacyKeys upgrades persisted snapshot, activity and stale keys written
// before plan identity included the project, so history survives the upgrade.
func mapLegacyKeys(projects []Project) {
	cache := map[string]string{}
	lookup := func(repo string) string {
		if id, ok := cache[repo]; ok {
			return id
		}
		cache[repo] = legacyProjectFor(repo, projects)
		return cache[repo]
	}
	for k, p := range prev {
		if p.Project != "" {
			continue
		}
		if id := lookup(p.Repo); id != "" {
			delete(prev, k)
			p.Project = id
			prev[planKey(p)] = p
		}
	}
	for i := range events {
		if events[i].Project == "" && events[i].Repo != "" {
			events[i].Project = lookup(events[i].Repo)
		}
	}
	for k, t := range staleSeen {
		repo, name, ok := strings.Cut(k, "/")
		if !ok || strings.Contains(name, "/") {
			continue
		}
		if id := lookup(repo); id != "" {
			delete(staleSeen, k)
			staleSeen[id+"/"+repo+"/"+name] = t
		}
	}
}

// upgradeActivityFile writes the project into legacy activity lines once, so the
// mapping does not depend on the projects configured at a later start (a second
// project with a same-named folder would make it ambiguous and detach history).
// The original file is kept as activity.jsonl.pre-projects.
func upgradeActivityFile(projects []Project) error {
	file := filepath.Join(dataDir, "activity.jsonl")
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	cache := map[string]string{}
	lines := bytes.Split(b, []byte("\n"))
	changed := false
	for i, line := range lines {
		var e Event
		if len(bytes.TrimSpace(line)) == 0 || json.Unmarshal(line, &e) != nil || e.Project != "" || e.Repo == "" {
			continue
		}
		id, ok := cache[e.Repo]
		if !ok {
			id = legacyProjectFor(e.Repo, projects)
			cache[e.Repo] = id
		}
		if id == "" {
			continue
		}
		e.Project = id
		if mapped, err := json.Marshal(e); err == nil {
			lines[i], changed = mapped, true
		}
	}
	if !changed {
		return nil
	}
	backup := file + ".pre-projects"
	if !exists(backup) {
		if err := os.WriteFile(backup, b, 0o644); err != nil {
			return err
		}
	}
	tmp, err := os.CreateTemp(dataDir, ".activity-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	if _, err = tmp.Write(bytes.Join(lines, []byte("\n"))); err == nil {
		err = tmp.Sync()
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceUpdateFile(tmp.Name(), file)
}

type ProjectSummary struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Enabled bool   `json:"enabled"`
	Status  string `json:"status"` // ok, missing, error, disabled or pending
	Message string `json:"message,omitempty"`
	Repos   int    `json:"repos"`
	Plans   int    `json:"plans"`
}

// projectSummaries merges configured projects with the last collector results.
// The caller holds mu.
func projectSummaries() []ProjectSummary {
	results := map[string]ProjectState{}
	for _, ps := range projectStates {
		results[ps.ID] = ps
	}
	out := []ProjectSummary{}
	for _, p := range knownProjects() {
		s := ProjectSummary{ID: p.ID, Name: p.Name, Path: p.Path, Kind: p.Kind, Enabled: p.Enabled, Status: "pending"}
		if !p.Enabled {
			s.Status = "disabled"
		} else if r, ok := results[p.ID]; ok {
			s.Status, s.Message, s.Repos, s.Plans = r.Status, r.Message, r.Repos, r.Plans
		}
		out = append(out, s)
	}
	return out
}

// stateWarnings are problems that do not stop collection; the caller holds mu.
func stateWarnings(summaries []ProjectSummary) []string {
	out := []string{}
	cfgMu.Lock()
	if configWarning != "" {
		out = append(out, configWarning)
	}
	cfgMu.Unlock()
	for _, s := range summaries {
		if s.Status == "missing" {
			reason := "was not found at " + s.Path
			if s.Message != "" && s.Message != "Folder not found." {
				reason = "cannot be opened at " + s.Path + " (" + strings.TrimSuffix(strings.TrimPrefix(s.Message, "Folder cannot be opened ("), ").") + ")"
			}
			out = append(out, "Project “"+s.Name+"” "+reason+". Reconnect the drive or update it in Settings.")
		}
	}
	return append(out, planProblemWarnings(planProblems)...)
}

// maxPlanWarnings bounds the plan problems listed one by one.
const maxPlanWarnings = 5

// planProblemWarnings turns the collector's diagnostics into warnings, so a
// plan left out of the board (unreadable, too large) or partly read is not
// silently missing. Called with mu held.
func planProblemWarnings(list []plans.Diagnostic) []string {
	out := []string{}
	for i, d := range list {
		if i == maxPlanWarnings {
			out = append(out, fmt.Sprintf("%d more plan problems; see the diagnostics in the state file.", len(list)-maxPlanWarnings))
			break
		}
		where := d.Repo
		if d.Plan != "" {
			where += "/" + d.Plan
		}
		out = append(out, "Plan “"+where+"”: "+d.Message)
	}
	return out
}

// ---------- HTTP ----------

type settingsProject struct {
	Project
	Exists bool       `json:"exists"`
	Error  string     `json:"error,omitempty"`
	Repos  []RepoInfo `json:"repos"`
}

type settingsPayload struct {
	SetupRequired      bool              `json:"setupRequired"`
	SetupComplete      bool              `json:"setupComplete"`
	Notifications      bool              `json:"notifications"`
	Theme              string            `json:"theme"`
	Shortcuts          bool              `json:"shortcuts"`
	AutoArchiveDone    bool              `json:"autoArchiveDone"`
	StartWithWindows   bool              `json:"startWithWindows"`
	StartupManaged     bool              `json:"startupManaged"`
	DataDir            string            `json:"dataDir"`
	ConfigFile         string            `json:"configFile"`
	StateFile          string            `json:"stateFile"`
	ProjectsOverridden string            `json:"projectsOverridden"`
	Warning            string            `json:"warning"`
	ReadOnly           string            `json:"readOnly"`
	Version            string            `json:"version"`
	Projects           []settingsProject `json:"projects"`
}

func describeProject(p Project) settingsProject {
	out := settingsProject{Project: p, Repos: []RepoInfo{}}
	repos, err := projectRepos(p)
	if err != nil {
		if os.IsNotExist(err) {
			out.Error = "Folder not found."
		} else {
			out.Error = err.Error()
		}
		return out
	}
	out.Exists, out.Repos = true, repos
	return out
}

func currentSettings() settingsPayload {
	cfgMu.Lock()
	cfg := appCfg
	cfg.Projects = append([]Project{}, appCfg.Projects...)
	warning, readOnly := configWarning, configReadOnly
	cfgMu.Unlock()
	out := settingsPayload{
		SetupRequired: setupRequired(), SetupComplete: cfg.SetupComplete, Notifications: cfg.Notifications,
		Theme: themeOrSystem(cfg.Theme), Shortcuts: cfg.Shortcuts, AutoArchiveDone: cfg.AutoArchiveDone,
		StartWithWindows: startupReader(), StartupManaged: startupManaged(),
		DataDir: dataDir, ConfigFile: configFilePath(dataDir), StateFile: stateFile,
		Warning: warning, ReadOnly: readOnly, Version: appVersion, Projects: []settingsProject{},
	}
	projects := cfg.Projects
	if reposDir != "" {
		out.ProjectsOverridden = "Projects are set by --repos-dir or AGENT_OPS_REPOS_DIR for this run: " + reposDir
		projects = []Project{overrideProject()}
	}
	for _, p := range projects {
		out.Projects = append(out.Projects, describeProject(p))
	}
	return out
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func settingsFail(w http.ResponseWriter, code int, text string) {
	writeJSON(w, code, map[string]string{"error": text})
}

// guardWrite applies the protections of the existing write endpoints.
func guardWrite(w http.ResponseWriter, r *http.Request, methods ...string) bool {
	allowed := false
	for _, m := range methods {
		allowed = allowed || r.Method == m
	}
	if !allowed {
		w.Header().Set("Allow", strings.Join(methods, ", "))
		settingsFail(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return false
	}
	if !trustedLocalWrite(r) {
		settingsFail(w, http.StatusForbidden, "Settings changes must come from this Agent Ops window.")
		return false
	}
	if r.ContentLength != 0 && !strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		settingsFail(w, http.StatusForbidden, "Settings changes must be JSON.")
		return false
	}
	return true
}

func decodeOne(w http.ResponseWriter, r *http.Request, v any) bool {
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8192))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(v); err != nil {
		settingsFail(w, http.StatusBadRequest, "Invalid settings request.")
		return false
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		settingsFail(w, http.StatusBadRequest, "Expected one settings change.")
		return false
	}
	return true
}

const overrideReadOnly = "Projects are set by --repos-dir or AGENT_OPS_REPOS_DIR for this run. Restart Agent Ops without it to manage projects here."

// mutateConfig applies change to a copy, saves it atomically, then refreshes.
func mutateConfig(w http.ResponseWriter, change func(*AppConfig) (int, string)) bool {
	if reposDir != "" {
		settingsFail(w, http.StatusConflict, overrideReadOnly)
		return false
	}
	if updateRestarting.Load() {
		settingsFail(w, http.StatusServiceUnavailable, "Agent Ops is restarting for an update. Try again after it reconnects.")
		return false
	}
	cfgMu.Lock()
	if configReadOnly != "" {
		cfgMu.Unlock()
		settingsFail(w, http.StatusConflict, configReadOnly)
		return false
	}
	next := appCfg
	next.Projects = append([]Project{}, appCfg.Projects...)
	if code, text := change(&next); code != 0 {
		cfgMu.Unlock()
		settingsFail(w, code, text)
		return false
	}
	if err := writeAppConfig(configFilePath(dataDir), next); err != nil {
		cfgMu.Unlock()
		settingsFail(w, http.StatusInternalServerError, "Could not save settings: "+err.Error())
		return false
	}
	appCfg = next
	cfgMu.Unlock()
	refresh(false)
	broadcast()
	return true
}

func themeOrSystem(theme string) string {
	if theme == "" {
		return "system"
	}
	return theme
}

func handleSettings(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, currentSettings())
		return
	}
	if !guardWrite(w, r, http.MethodPut) {
		return
	}
	var body struct {
		Notifications    *bool   `json:"notifications"`
		SetupComplete    *bool   `json:"setupComplete"`
		StartWithWindows *bool   `json:"startWithWindows"`
		Theme            *string `json:"theme"`
		Shortcuts        *bool   `json:"shortcuts"`
		AutoArchiveDone  *bool   `json:"autoArchiveDone"`
	}
	if !decodeOne(w, r, &body) {
		return
	}
	if body.Theme != nil && (*body.Theme == "" || !validTheme(*body.Theme)) {
		settingsFail(w, http.StatusBadRequest, "Theme must be system, light or dark.")
		return
	}
	if body.StartWithWindows != nil {
		if !startupManaged() {
			settingsFail(w, http.StatusConflict, "Start with Windows can only be changed in the installed Agent Ops.")
			return
		}
		startupWriter(*body.StartWithWindows)
		syncStartupMenu()
	}
	if body.Notifications != nil || body.SetupComplete != nil || body.Theme != nil || body.Shortcuts != nil || body.AutoArchiveDone != nil {
		if updateRestarting.Load() {
			settingsFail(w, http.StatusServiceUnavailable, "Agent Ops is restarting for an update. Try again after it reconnects.")
			return
		}
		// One read-modify-write under cfgMu, as in mutateConfig, so a concurrent
		// project change is never written back to disk with a stale project list.
		cfgMu.Lock()
		if configReadOnly != "" {
			readOnly := configReadOnly
			cfgMu.Unlock()
			settingsFail(w, http.StatusConflict, readOnly)
			return
		}
		next := appCfg
		next.Projects = append([]Project{}, appCfg.Projects...)
		if body.Notifications != nil {
			next.Notifications = *body.Notifications
		}
		if body.Theme != nil {
			next.Theme = *body.Theme
		}
		if body.Shortcuts != nil {
			next.Shortcuts = *body.Shortcuts
		}
		if body.AutoArchiveDone != nil {
			next.AutoArchiveDone = *body.AutoArchiveDone
		}
		// Setup may be skipped with no project; the board then offers "Add a project to start".
		if body.SetupComplete != nil {
			next.SetupComplete = *body.SetupComplete
		}
		if err := writeAppConfig(configFilePath(dataDir), next); err != nil {
			cfgMu.Unlock()
			settingsFail(w, http.StatusInternalServerError, "Could not save settings: "+err.Error())
			return
		}
		appCfg = next
		cfgMu.Unlock()
		broadcast()
	}
	writeJSON(w, http.StatusOK, currentSettings())
}

func handleProjects(w http.ResponseWriter, r *http.Request) {
	if !guardWrite(w, r, http.MethodPost) {
		return
	}
	var body struct {
		Path string `json:"path"`
	}
	if !decodeOne(w, r, &body) {
		return
	}
	if reposDir != "" {
		settingsFail(w, http.StatusConflict, overrideReadOnly)
		return
	}
	// Folder checks can wait on a slow or offline share, so they run without
	// cfgMu; /api/state and the watcher keep working meanwhile.
	cfgMu.Lock()
	existing := append([]Project{}, appCfg.Projects...)
	cfgMu.Unlock()
	added, repos, err := inspectNewProject(body.Path, existing, time.Now())
	if err != nil {
		settingsFail(w, http.StatusBadRequest, err.Error())
		return
	}
	ok := mutateConfig(w, func(c *AppConfig) (int, string) {
		// Re-check against projects added meanwhile, by path only (no I/O).
		for _, p := range c.Projects {
			a, b := projectPathKey(added.Path), projectPathKey(p.Path)
			if p.ID == added.ID || a == b || pathWithin(a, b) || pathWithin(b, a) {
				return http.StatusBadRequest, "This folder overlaps the project “" + p.Name + "”, which was just added."
			}
		}
		c.Projects = append(c.Projects, added)
		return 0, ""
	})
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"project": added, "kind": added.Kind, "name": added.Name, "repos": repos, "settings": currentSettings()})
}

func validProjectName(name string) bool {
	if name == "" || len(name) > 120 {
		return false
	}
	for _, r := range name {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

func handleProject(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/projects/")
	if !guardWrite(w, r, http.MethodPatch, http.MethodDelete) {
		return
	}
	if !projectIDPattern.MatchString(id) {
		settingsFail(w, http.StatusNotFound, "Project not found.")
		return
	}
	var body struct {
		Enabled *bool   `json:"enabled"`
		Name    *string `json:"name"`
	}
	if r.Method == http.MethodPatch && !decodeOne(w, r, &body) {
		return
	}
	ok := mutateConfig(w, func(c *AppConfig) (int, string) {
		index := -1
		for i, p := range c.Projects {
			if p.ID == id {
				index = i
			}
		}
		if index < 0 {
			return http.StatusNotFound, "Project not found. Reload Settings."
		}
		if r.Method == http.MethodDelete {
			c.Projects = append(c.Projects[:index], c.Projects[index+1:]...)
			return 0, ""
		}
		if body.Enabled != nil {
			c.Projects[index].Enabled = *body.Enabled
		}
		if body.Name != nil {
			name := strings.TrimSpace(*body.Name)
			if !validProjectName(name) {
				return http.StatusBadRequest, "Enter a project name of 1 to 120 characters."
			}
			c.Projects[index].Name = name
		}
		return 0, ""
	})
	if ok {
		writeJSON(w, http.StatusOK, currentSettings())
	}
}

// pickFolderDialog opens the Windows folder dialog on the desktop. The console
// stays hidden; the dialog is owned by a topmost form so it appears above Edge.
// purpose is "" (a project folder), "skills" (a folder that receives the skill;
// new folders allowed) or "instruction-file" (a file, which may not exist yet).
func pickFolderDialog(ctx context.Context, purpose string) (string, error) {
	switch purpose {
	case "skills":
		return runFolderPicker(ctx, skillsDialogScript)
	case "instruction-file":
		return runFolderPicker(ctx, instructionFileDialogScript)
	}
	return runFolderPicker(ctx, folderDialogScript)
}

// folderDialogScript sets $selected to the chosen folder, or leaves it empty.
const folderDialogScript = `$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};` +
	`$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;` +
	`$dialog.Description='Choose a project folder: a Git repository, or a folder that contains repositories.';` +
	`$dialog.ShowNewFolderButton=$false;` +
	`if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$selected=$dialog.SelectedPath};` +
	`$owner.Dispose();`

const skillsDialogScript = `$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};` +
	`$dialog=New-Object System.Windows.Forms.FolderBrowserDialog;` +
	`$dialog.Description='Choose the skills folder of an AI client. Agent Ops installs task-plan\SKILL.md inside it.';` +
	`$dialog.ShowNewFolderButton=$true;` +
	`if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$selected=$dialog.SelectedPath};` +
	`$owner.Dispose();`

const instructionFileDialogScript = `$owner=New-Object System.Windows.Forms.Form -Property @{TopMost=$true;ShowInTaskbar=$false};` +
	`$dialog=New-Object System.Windows.Forms.OpenFileDialog;` +
	`$dialog.Title='Choose the instruction file of an AI client';` +
	`$dialog.Filter='Markdown (*.md)|*.md|All files (*.*)|*.*';` +
	`$dialog.CheckFileExists=$false;` +
	`if($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK){$selected=$dialog.FileName};` +
	`$owner.Dispose();`

// runFolderPicker runs a constant chooser script and decodes its UTF-8 output, so
// folder names outside the console code page (for example Vietnamese) survive.
func runFolderPicker(ctx context.Context, choose string) (string, error) {
	script := `Add-Type -AssemblyName System.Windows.Forms;` +
		`[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;$selected='';` + choose +
		`if($selected){[Console]::Out.Write($selected)}`
	output, err := hidden(exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-ExecutionPolicy", "Bypass", "-Command", script)).Output()
	if err != nil {
		return "", err
	}
	return strings.TrimSpace(string(output)), nil
}

func handlePickFolder(w http.ResponseWriter, r *http.Request) {
	if !guardWrite(w, r, http.MethodPost) {
		return
	}
	var body struct {
		Purpose string `json:"purpose"`
	}
	if r.ContentLength != 0 && !decodeOne(w, r, &body) {
		return
	}
	if body.Purpose != "" && body.Purpose != "skills" && body.Purpose != "instruction-file" {
		settingsFail(w, http.StatusBadRequest, "Unknown dialog.")
		return
	}
	if !pickerBusy.TryLock() {
		settingsFail(w, http.StatusConflict, "A folder dialog is already open. Finish it first.")
		return
	}
	defer pickerBusy.Unlock()
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Minute)
	defer cancel()
	path, err := pickFolder(ctx, body.Purpose)
	if err != nil {
		settingsFail(w, http.StatusInternalServerError, "Could not open the folder dialog. Paste the path instead.")
		return
	}
	if path == "" {
		writeJSON(w, http.StatusOK, map[string]any{"cancelled": true})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"path": path})
}

// handleOpenFolder opens only the data folder or a configured project in Explorer.
func handleOpenFolder(w http.ResponseWriter, r *http.Request) {
	if !guardWrite(w, r, http.MethodPost) {
		return
	}
	var body struct {
		Target string `json:"target"`
		ID     string `json:"id"`
	}
	if !decodeOne(w, r, &body) {
		return
	}
	path := ""
	switch body.Target {
	case "data":
		path = dataDir
	case "logs":
		if logDir != "" && os.MkdirAll(logDir, 0o700) == nil {
			path = logDir
		}
	case "project":
		for _, p := range knownProjects() {
			if p.ID == body.ID {
				path = p.Path
			}
		}
	}
	if path == "" {
		settingsFail(w, http.StatusNotFound, "Unknown folder.")
		return
	}
	if st, err := os.Stat(path); err != nil || !st.IsDir() {
		settingsFail(w, http.StatusNotFound, "This folder does not exist: "+path)
		return
	}
	if err := openFolder(path); err != nil {
		settingsFail(w, http.StatusInternalServerError, "Could not open Explorer: "+err.Error())
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"opened": true})
}

func settingsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/settings", handleSettings)
	mux.HandleFunc("/api/settings/pick-folder", handlePickFolder)
	mux.HandleFunc("/api/settings/open-folder", handleOpenFolder)
	mux.HandleFunc("/api/projects", handleProjects)
	mux.HandleFunc("/api/projects/", handleProject)
	mux.HandleFunc("/api/integrations", handleIntegrations)
	mux.HandleFunc("/api/integrations/", handleIntegrationAction)
}

func syncStartupMenu() {
	if mStartup == nil || !trayReady.Load() {
		return
	}
	if startupReader() {
		mStartup.Check()
	} else {
		mStartup.Uncheck()
	}
}
