package main

// Persistent application settings: <dataDir>\config.json. The Go app and every
// Node helper read the same file, so agents need no machine-specific flags.
// Precedence for each value is flag > environment > config file > built-in default.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

// Legacy defaults from the first, single-machine release. They are only used to
// migrate an existing installation into config.json on its first start.
const (
	legacyReposDir  = `D:\1_PROJECTS\_REPOS`
	legacySlotsFile = `D:\1_PROJECTS\_WORKTREES\slots.json`
	legacyStateFile = `D:\1_PROJECTS\tong-hop-chung.json`
)

const configVersion = 1

type Project struct {
	ID      string    `json:"id"`
	Path    string    `json:"path"`
	Name    string    `json:"name"`
	Kind    string    `json:"kind"` // "repo": a repository; "folder": direct children are repositories
	Enabled bool      `json:"enabled"`
	AddedAt time.Time `json:"addedAt"`
}

type AppConfig struct {
	Version       int       `json:"version"`
	SetupComplete bool      `json:"setupComplete"`
	Projects      []Project `json:"projects"`
	StateFile     string    `json:"stateFile,omitempty"`
	SlotsFile     string    `json:"slotsFile,omitempty"`
	Notifications bool      `json:"notifications"`
}

type RepoInfo struct {
	Name      string `json:"name"`
	Path      string `json:"path"`
	HasTasks  bool   `json:"hasTasks"`
	PlanCount int    `json:"planCount"`
}

func defaultAppConfig() AppConfig {
	return AppConfig{Version: configVersion, Projects: []Project{}, Notifications: true}
}

func configFilePath(dir string) string { return filepath.Join(dir, "config.json") }

// A stable ID derived from the folder keeps plan identity unchanged when the same
// folder is removed and added again, and lets a --repos-dir override share keys.
// projectIdFor in plan-reader.mjs computes the same value for a --repos-dir override.
func projectIDFor(path string) string {
	sum := sha256.Sum256([]byte(strings.ToLower(projectPathForID(path))))
	return hex.EncodeToString(sum[:])[:8]
}

// projectPathForID matches projectPathForId in plan-reader.mjs: a cleaned path
// without a trailing separator, except a drive root such as D:\.
func projectPathForID(path string) string {
	clean := filepath.Clean(path)
	if len(clean) == 3 && clean[1] == ':' {
		return clean
	}
	return strings.TrimRight(clean, `\/`)
}

// repoNameOf names the repository of a repo project; matches repoNameOf in
// plan-reader.mjs. A drive or share root uses its drive letter or share name.
func repoNameOf(path string) string {
	clean := projectPathForID(path)
	if name := filepath.Base(clean); name != "" && name != "." && !strings.ContainsAny(name, `\/:`) {
		return name
	}
	parts := strings.FieldsFunc(strings.TrimRight(clean, `\/:`), func(r rune) bool { return r == '\\' || r == '/' })
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return "root"
}

var projectIDPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,39}$`)

// errNewerConfig marks a config.json written by a newer release (for example after
// a rollback). It is kept as it is, never moved aside or migrated.
var errNewerConfig = errors.New("settings were saved by a newer Agent Ops")

func validateAppConfig(c *AppConfig) error {
	if c.Version > configVersion {
		return fmt.Errorf("%w (settings version %d)", errNewerConfig, c.Version)
	}
	if c.Version != configVersion {
		return fmt.Errorf("unsupported settings version %d", c.Version)
	}
	if c.Projects == nil {
		c.Projects = []Project{}
	}
	seen := map[string]bool{}
	paths := map[string]bool{}
	for i, p := range c.Projects {
		if !projectIDPattern.MatchString(p.ID) {
			return fmt.Errorf("project %d has an invalid id", i+1)
		}
		if seen[p.ID] {
			return fmt.Errorf("duplicate project id %q", p.ID)
		}
		seen[p.ID] = true
		if !filepath.IsAbs(p.Path) {
			return fmt.Errorf("project %q path must be absolute", p.ID)
		}
		key := strings.ToLower(filepath.Clean(p.Path))
		if paths[key] {
			return fmt.Errorf("project path %q is listed twice", p.Path)
		}
		paths[key] = true
		if p.Kind != "repo" && p.Kind != "folder" {
			return fmt.Errorf("project %q kind must be repo or folder", p.ID)
		}
		if strings.TrimSpace(p.Name) == "" || len(p.Name) > 120 {
			return fmt.Errorf("project %q needs a name of at most 120 characters", p.ID)
		}
	}
	// A folder inside another project would be collected twice under two keys.
	for i, a := range c.Projects {
		for _, b := range c.Projects[i+1:] {
			pa, pb := projectPathKey(a.Path), projectPathKey(b.Path)
			if pathWithin(pa, pb) || pathWithin(pb, pa) {
				return fmt.Errorf("projects %q and %q overlap: one folder contains the other", a.Path, b.Path)
			}
		}
	}
	for _, file := range []string{c.StateFile, c.SlotsFile} {
		if file != "" && !filepath.IsAbs(file) {
			return fmt.Errorf("settings file paths must be absolute")
		}
	}
	return nil
}

// readAppConfig returns an error wrapping fs.ErrNotExist when there is no file.
func readAppConfig(file string) (AppConfig, error) {
	b, err := os.ReadFile(file)
	if err != nil {
		return AppConfig{}, err
	}
	var raw struct {
		AppConfig
		Notifications *bool `json:"notifications"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return AppConfig{}, &configContentError{fmt.Errorf("invalid JSON: %w", err)}
	}
	c := raw.AppConfig
	c.Notifications = raw.Notifications == nil || *raw.Notifications
	if err := validateAppConfig(&c); err != nil {
		if errors.Is(err, errNewerConfig) {
			return AppConfig{}, err
		}
		return AppConfig{}, &configContentError{err}
	}
	return c, nil
}

// configContentError is a config.json that was read but is not valid settings;
// only this kind of file is moved aside.
type configContentError struct{ err error }

func (e *configContentError) Error() string { return e.err.Error() }
func (e *configContentError) Unwrap() error { return e.err }

// projectPathKey compares project folders case-insensitively, without I/O.
func projectPathKey(path string) string {
	return strings.ToLower(filepath.Clean(path))
}

// writeAppConfig replaces the file atomically: a reader sees the old or the new
// file, never a partial one.
func writeAppConfig(file string, c AppConfig) error {
	if err := validateAppConfig(&c); err != nil {
		return err
	}
	b, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".config-*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(append(b, '\n')); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return err
	}
	return replaceUpdateFile(tmp, file)
}

type legacyPaths struct{ repos, state, slots string }

// loadOrMigrateConfig reads the config. Without one, an existing legacy repos
// folder becomes a single folder project so an upgraded install looks the same.
// A corrupt file is moved aside (never silently overwritten) and reported.
func loadOrMigrateConfig(file string, legacy legacyPaths, now time.Time) (cfg AppConfig, warning string, err error) {
	cfg, err = readAppConfig(file)
	if err == nil {
		return cfg, "", nil
	}
	var corrupt *configContentError
	if !errors.Is(err, fs.ErrNotExist) && !errors.As(err, &corrupt) {
		// A read failure (file locked by an editor or antivirus, access denied) or
		// a newer release's file is kept untouched: no move aside, no migration.
		// The caller makes settings read-only until the next start.
		return defaultAppConfig(), "", fmt.Errorf("settings file %s could not be used (%v); it was left unchanged", file, err)
	}
	if corrupt != nil {
		aside := file + ".corrupt-" + now.Format("20060102-150405")
		if renameErr := os.Rename(file, aside); renameErr != nil {
			return defaultAppConfig(), "", fmt.Errorf("settings file %s is unreadable (%v) and could not be moved aside: %v", file, err, renameErr)
		}
		warning = fmt.Sprintf("The settings file was unreadable (%v). It was kept as %s. Add your projects again.", err, aside)
	}
	cfg = defaultAppConfig()
	if legacy.repos == "" {
		return cfg, warning, nil
	}
	if info, statErr := os.Stat(legacy.repos); statErr != nil || !info.IsDir() {
		return cfg, warning, nil
	}
	path, _ := filepath.Abs(legacy.repos)
	cfg.Projects = []Project{{ID: projectIDFor(path), Path: path, Name: projectDisplayName(path), Kind: "folder", Enabled: true, AddedAt: now.UTC()}}
	cfg.SetupComplete = true
	cfg.StateFile = legacy.state
	cfg.SlotsFile = legacy.slots
	if writeErr := writeAppConfig(file, cfg); writeErr != nil {
		return cfg, warning, fmt.Errorf("could not save migrated settings: %v", writeErr)
	}
	return cfg, warning, nil
}

func projectDisplayName(path string) string {
	name := filepath.Base(filepath.Clean(path))
	if name == "" || name == "." || name == string(filepath.Separator) || strings.HasSuffix(name, ":\\") {
		return filepath.Clean(path)
	}
	return name
}

func exists(path string) bool { _, err := os.Stat(path); return err == nil }

func isRepoDir(path string) bool {
	return exists(filepath.Join(path, ".git")) || exists(filepath.Join(path, ".tasks"))
}

// planFiles lists source plans, never the generated tong-hop.md index.
func planFiles(repo string) []string {
	files, _ := filepath.Glob(filepath.Join(repo, ".tasks", "*.md"))
	out := files[:0]
	for _, f := range files {
		if !strings.EqualFold(filepath.Base(f), "tong-hop.md") {
			out = append(out, f)
		}
	}
	return out
}

func repoInfo(path string) RepoInfo {
	info, err := os.Stat(filepath.Join(path, ".tasks"))
	return RepoInfo{Name: repoNameOf(path), Path: path, HasTasks: err == nil && info.IsDir(), PlanCount: len(planFiles(path))}
}

// projectRepos lists the repositories a project contributes, mirroring the collector.
func projectRepos(p Project) ([]RepoInfo, error) {
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, fmt.Errorf("%s is not a folder", p.Path)
	}
	if p.Kind == "repo" {
		return []RepoInfo{repoInfo(p.Path)}, nil
	}
	entries, err := os.ReadDir(p.Path)
	if err != nil {
		return nil, err
	}
	repos := []RepoInfo{}
	for _, e := range entries {
		child := filepath.Join(p.Path, e.Name())
		if st, err := os.Stat(child); err == nil && st.IsDir() && isRepoDir(child) {
			repos = append(repos, repoInfo(child))
		}
	}
	sort.Slice(repos, func(i, j int) bool { return strings.ToLower(repos[i].Name) < strings.ToLower(repos[j].Name) })
	return repos, nil
}

// detectKind: a Git repository is a "repo"; otherwise a folder whose direct
// children are repositories is a "folder". A folder with only .tasks is a repo.
func detectKind(path string) (string, error) {
	if exists(filepath.Join(path, ".git")) {
		return "repo", nil
	}
	entries, err := os.ReadDir(path)
	if err != nil {
		return "", err
	}
	for _, e := range entries {
		child := filepath.Join(path, e.Name())
		if st, err := os.Stat(child); err == nil && st.IsDir() && isRepoDir(child) {
			return "folder", nil
		}
	}
	if exists(filepath.Join(path, ".tasks")) {
		return "repo", nil
	}
	return "", errors.New("No Git repositories found here. Choose a repository, or a folder whose direct subfolders are repositories.")
}

type projectError struct{ text string }

func (e *projectError) Error() string { return e.text }

func resolvedProjectPath(path string) string {
	if resolved, err := filepath.EvalSymlinks(path); err == nil {
		path = resolved
	}
	return strings.ToLower(filepath.Clean(path))
}

func pathWithin(child, parent string) bool {
	if child == parent {
		return false
	}
	prefix := parent
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(child, prefix)
}

// inspectNewProject validates a folder chosen by the user against the existing
// projects. Errors are user-facing sentences shown inline by the UI.
func inspectNewProject(raw string, existing []Project, now time.Time) (Project, []RepoInfo, error) {
	path := strings.TrimSpace(raw)
	if len(path) >= 2 && path[0] == '"' && path[len(path)-1] == '"' {
		path = strings.TrimSpace(path[1 : len(path)-1])
	}
	if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) {
		return Project{}, nil, &projectError{`Enter a full folder path, for example C:\Projects.`}
	}
	path = filepath.Clean(path)
	info, err := os.Stat(path)
	if errors.Is(err, fs.ErrNotExist) {
		return Project{}, nil, &projectError{"This folder does not exist."}
	}
	if err != nil {
		return Project{}, nil, &projectError{"Agent Ops cannot open this folder: " + err.Error()}
	}
	if !info.IsDir() {
		return Project{}, nil, &projectError{"This path is a file. Choose a folder."}
	}
	if _, err := os.ReadDir(path); err != nil {
		return Project{}, nil, &projectError{"Agent Ops cannot read this folder: " + err.Error()}
	}
	resolved := resolvedProjectPath(path)
	for _, p := range existing {
		other := resolvedProjectPath(p.Path)
		switch {
		case other == resolved:
			return Project{}, nil, &projectError{"This folder is already added as “" + p.Name + "”."}
		case pathWithin(resolved, other):
			return Project{}, nil, &projectError{"This folder is inside the project “" + p.Name + "”, which already includes it."}
		case pathWithin(other, resolved):
			return Project{}, nil, &projectError{"This folder contains the project “" + p.Name + "”. Remove that project first, then add this folder."}
		}
	}
	kind, err := detectKind(path)
	if err != nil {
		return Project{}, nil, &projectError{err.Error()}
	}
	project := Project{ID: projectIDFor(path), Path: path, Name: projectDisplayName(path), Kind: kind, Enabled: true, AddedAt: now.UTC()}
	for _, p := range existing {
		if p.ID == project.ID {
			return Project{}, nil, &projectError{"This folder is already added as “" + p.Name + "”."}
		}
	}
	repos, err := projectRepos(project)
	if err != nil {
		return Project{}, nil, &projectError{"Agent Ops cannot read this folder: " + err.Error()}
	}
	return project, repos, nil
}
