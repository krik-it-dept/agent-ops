package main

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func mkRepo(t *testing.T, path string, plans ...string) string {
	t.Helper()
	if err := os.MkdirAll(filepath.Join(path, ".git"), 0o700); err != nil {
		t.Fatal(err)
	}
	for _, p := range plans {
		os.MkdirAll(filepath.Join(path, ".tasks"), 0o700)
		if err := os.WriteFile(filepath.Join(path, ".tasks", p+".md"), []byte("Agent: Codex\nStatus: Planning\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestConfigSaveLoadRoundTripAndAtomicReplace(t *testing.T) {
	dir := isolated(t)
	file := configFilePath(dir)
	if _, err := readAppConfig(file); !errors.Is(err, fs.ErrNotExist) {
		t.Fatal("missing config must report not-exist", err)
	}
	c := defaultAppConfig()
	c.SetupComplete = true
	c.Notifications = false
	c.Projects = []Project{{ID: "abc12345", Path: filepath.Join(dir, "repos"), Name: "repos", Kind: "folder", Enabled: true, AddedAt: time.Now().UTC().Truncate(time.Second)}}
	if err := writeAppConfig(file, c); err != nil {
		t.Fatal(err)
	}
	got, err := readAppConfig(file)
	if err != nil || !got.SetupComplete || got.Notifications || len(got.Projects) != 1 || got.Projects[0].Kind != "folder" {
		t.Fatal(got, err)
	}
	c.Projects[0].Name = "renamed"
	if err := writeAppConfig(file, c); err != nil {
		t.Fatal(err)
	}
	if got, _ := readAppConfig(file); got.Projects[0].Name != "renamed" {
		t.Fatal("replace failed")
	}
	leftovers, _ := filepath.Glob(filepath.Join(dir, ".config-*"))
	if len(leftovers) != 0 {
		t.Fatal("temporary files left behind", leftovers)
	}
	// Notifications default to on when the field is absent.
	os.WriteFile(file, []byte(`{"version":1,"setupComplete":false,"projects":[]}`), 0o600)
	if got, err := readAppConfig(file); err != nil || !got.Notifications {
		t.Fatal("notifications default", got, err)
	}
	// Invalid content is rejected before it reaches the disk.
	bad := c
	bad.Projects = append(bad.Projects, c.Projects[0])
	if err := writeAppConfig(file, bad); err == nil {
		t.Fatal("duplicate project accepted")
	}
	for _, text := range []string{`{"version":2,"projects":[]}`, `{"version":1,"projects":[{"id":"x","path":"relative","name":"x","kind":"repo"}]}`, `{"version":1,"projects":[{"id":"x","path":"C:\\x","name":"x","kind":"other"}]}`} {
		os.WriteFile(file, []byte(text), 0o600)
		if _, err := readAppConfig(file); err == nil {
			t.Fatal("invalid config accepted", text)
		}
	}
}

func TestCorruptConfigIsMovedAsideWithWarning(t *testing.T) {
	dir := isolated(t)
	file := configFilePath(dir)
	os.WriteFile(file, []byte("{not json"), 0o600)
	cfg, warning, err := loadOrMigrateConfig(file, legacyPaths{}, time.Date(2026, 11, 10, 9, 30, 0, 0, time.UTC))
	if err != nil || cfg.SetupComplete || !strings.Contains(warning, "unreadable") {
		t.Fatal(cfg, warning, err)
	}
	aside := file + ".corrupt-20261110-093000"
	if b, err := os.ReadFile(aside); err != nil || string(b) != "{not json" {
		t.Fatal("corrupt file was not preserved", err)
	}
	if exists(file) {
		t.Fatal("corrupt file must not be silently replaced when there is nothing to migrate")
	}
}

func TestMigrationFromLegacyFolder(t *testing.T) {
	dir := isolated(t)
	repos := filepath.Join(dir, "legacy repos")
	mkRepo(t, filepath.Join(repos, "one"), "plan")
	legacy := legacyPaths{repos: repos, state: filepath.Join(dir, "old-state.json")}
	file := configFilePath(filepath.Join(dir, "data"))
	cfg, warning, err := loadOrMigrateConfig(file, legacy, time.Now())
	if err != nil || warning != "" {
		t.Fatal(err, warning)
	}
	if !cfg.SetupComplete || len(cfg.Projects) != 1 || cfg.Projects[0].Kind != "folder" || cfg.Projects[0].Path != repos || cfg.Projects[0].ID != projectIDFor(repos) || cfg.StateFile != legacy.state || !cfg.Notifications {
		t.Fatalf("%+v", cfg)
	}
	if saved, err := readAppConfig(file); err != nil || saved.Projects[0].Path != repos {
		t.Fatal("migration not saved", err)
	}
	// An existing config wins; migration never runs twice.
	cfg.Projects[0].Enabled = false
	writeAppConfig(file, cfg)
	again, _, _ := loadOrMigrateConfig(file, legacy, time.Now())
	if again.Projects[0].Enabled {
		t.Fatal("existing config was overwritten by migration")
	}
}

func TestMigrationWithoutLegacyFolderRequiresSetup(t *testing.T) {
	dir := isolated(t)
	file := configFilePath(dir)
	cfg, warning, err := loadOrMigrateConfig(file, legacyPaths{repos: filepath.Join(dir, "missing"), state: legacyStateFile}, time.Now())
	if err != nil || warning != "" || cfg.SetupComplete || len(cfg.Projects) != 0 || cfg.StateFile != "" {
		t.Fatal(cfg, warning, err)
	}
	if exists(file) {
		t.Fatal("nothing to migrate must not write a config")
	}
}

func TestProjectValidation(t *testing.T) {
	dir := isolated(t)
	now := time.Now()
	parent := filepath.Join(dir, "work")
	repoA := mkRepo(t, filepath.Join(parent, "alpha"), "one", "two")
	mkRepo(t, filepath.Join(parent, "beta"))
	os.MkdirAll(filepath.Join(parent, "notes"), 0o700) // not a repository, ignored
	os.MkdirAll(filepath.Join(dir, "empty", "notes"), 0o700)
	folder, repos, err := inspectNewProject(`"`+parent+`"`, nil, now)
	if err != nil || folder.Kind != "folder" || folder.Name != "work" || len(repos) != 2 || repos[0].Name != "alpha" || repos[0].PlanCount != 2 || !repos[0].HasTasks || repos[1].HasTasks {
		t.Fatal(folder, repos, err)
	}
	single, repos, err := inspectNewProject(repoA, nil, now)
	if err != nil || single.Kind != "repo" || len(repos) != 1 || repos[0].PlanCount != 2 {
		t.Fatal(single, repos, err)
	}
	existing := []Project{folder}
	cases := map[string]string{
		"relative":                               "full folder path",
		filepath.Join(dir, "nope"):               "does not exist",
		parent:                                   "already added",
		repoA:                                    "inside the project",
		dir:                                      "contains the project",
		filepath.Join(dir, "empty"):              "No Git repositories",
		filepath.Join(repoA, ".git"):             "inside the project",
		strings.ToUpper(parent[:1]) + parent[1:]: "already added",
	}
	for path, want := range cases {
		if _, _, err := inspectNewProject(path, existing, now); err == nil || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: got %v, want %q", path, err, want)
		}
	}
	file := filepath.Join(dir, "file.txt")
	os.WriteFile(file, []byte("x"), 0o600)
	if _, _, err := inspectNewProject(file, nil, now); err == nil || !strings.Contains(err.Error(), "is a file") {
		t.Fatal(err)
	}
	// A missing project is reported by projectRepos, not silently treated as empty.
	if _, err := projectRepos(Project{Path: filepath.Join(dir, "gone"), Kind: "folder"}); err == nil {
		t.Fatal("missing project accepted")
	}
}

// Only a file that was read and is not valid settings is moved aside. A read
// failure or a newer release's file is kept, and nothing is migrated over it.
func TestUnreadableOrNewerConfigIsKeptAndNotMigrated(t *testing.T) {
	dir := isolated(t)
	repos := filepath.Join(dir, "legacy")
	mkRepo(t, filepath.Join(repos, "one"), "plan")
	legacy := legacyPaths{repos: repos}
	newer := configFilePath(filepath.Join(dir, "newer"))
	os.MkdirAll(filepath.Dir(newer), 0o700)
	os.WriteFile(newer, []byte(`{"version":2,"projects":[],"future":true}`), 0o600)
	cfg, _, err := loadOrMigrateConfig(newer, legacy, time.Now())
	if err == nil || len(cfg.Projects) != 0 {
		t.Fatal("a newer settings file must not be replaced by migration", cfg, err)
	}
	if b, _ := os.ReadFile(newer); string(b) != `{"version":2,"projects":[],"future":true}` {
		t.Fatal("a newer settings file was changed")
	}
	// A path that cannot be read as a file (here a folder) stands in for a locked file.
	locked := configFilePath(filepath.Join(dir, "locked"))
	os.MkdirAll(locked, 0o700)
	if _, _, err := loadOrMigrateConfig(locked, legacy, time.Now()); err == nil {
		t.Fatal("a read failure must be reported")
	}
	if matches, _ := filepath.Glob(locked + ".corrupt-*"); len(matches) != 0 || !exists(locked) {
		t.Fatal("an unreadable settings file was moved aside")
	}
}

func TestOverlappingProjectsAreRejectedOnLoad(t *testing.T) {
	dir := isolated(t)
	file := configFilePath(dir)
	outer, inner := filepath.Join(dir, "R"), filepath.Join(dir, "r", "app")
	b := []byte(`{"version":1,"setupComplete":true,"notifications":true,"projects":[` +
		`{"id":"outer","path":` + strconvQuote(outer) + `,"name":"R","kind":"folder","enabled":true},` +
		`{"id":"inner","path":` + strconvQuote(inner) + `,"name":"app","kind":"repo","enabled":true}]}`)
	os.WriteFile(file, b, 0o600)
	if _, err := readAppConfig(file); err == nil || !strings.Contains(err.Error(), "overlap") {
		t.Fatal("overlapping projects were accepted", err)
	}
	cfg := defaultAppConfig()
	cfg.Projects = []Project{{ID: "a", Path: filepath.Join(dir, "ab"), Name: "ab", Kind: "repo"}, {ID: "b", Path: filepath.Join(dir, "a"), Name: "a", Kind: "repo"}}
	if err := validateAppConfig(&cfg); err != nil {
		t.Fatal("sibling folders sharing a prefix are not nested", err)
	}
}
