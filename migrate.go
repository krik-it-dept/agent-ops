package main

// One-time migration from the Workboard releases (v0.2.x and earlier) to the
// Agent Ops work ledger. It runs from the update helper and from the installer,
// is idempotent, backs up everything it changes or deletes into
// <data>\backups\migration-<time>, and writes files atomically.
//
// Phase 1 (clients, before the new version starts; the update helper can roll it
// back): copy config.json into the new data folder, remove the reporting hooks
// from every Claude settings.json, remove the managed instruction blocks, replace
// SKILL.md copies that are still an unedited reporting template, and carry the
// old integration record into config.json.
//
// Phase 1 also drops run-only events and keys from the app's own data folder
// when it is shared with the previous release (an isolated install).
//
// Phase 2 (data, after the new version is healthy): delete the run history:
// execution reports, history registries, and the old data folder's activity,
// snapshots and generated state.
//
// Text the owner wrote outside the markers is never edited. Owner-authored text
// that still mentions the old name is listed in a checklist instead.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

const migrationVersion = 1
const migrationFile = "migration.json"
const maxChecklist = 40

type migrationOptions struct {
	Profile string
	// DataDir is the Agent Ops data folder that receives config.json and migration.json.
	DataDir string
	// LegacyDataDir is the previous data folder when it differs from DataDir.
	LegacyDataDir string
	// RuntimeDir is the install folder (run history registries); empty skips it.
	RuntimeDir string
	Now        time.Time
}

type checkItem struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

type migrationResult struct {
	Version        int         `json:"version"`
	At             string      `json:"at"`
	Backup         string      `json:"backup"`
	ConfigCopied   bool        `json:"configCopied,omitempty"`
	HooksRemoved   []string    `json:"hooksRemoved,omitempty"`
	BlocksRemoved  []string    `json:"blocksRemoved,omitempty"`
	SkillsReplaced []string    `json:"skillsReplaced,omitempty"`
	Kept           []string    `json:"kept,omitempty"`
	Deleted        []string    `json:"deleted,omitempty"`
	Checklist      []checkItem `json:"checklist,omitempty"`
	Errors         []string    `json:"errors,omitempty"`
}

func (r *migrationResult) fail(format string, args ...any) {
	r.Errors = append(r.Errors, fmt.Sprintf(format, args...))
}

func newMigration(opts migrationOptions) (*migrationResult, string) {
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	backup := filepath.Join(opts.DataDir, "backups", "migration-"+opts.Now.Format("20060102-150405"))
	return &migrationResult{Version: migrationVersion, At: opts.Now.UTC().Format(time.RFC3339), Backup: backup}, backup
}

// migrationDone reports whether the data folder already has a finished migration.
func migrationDone(dataDir string) bool {
	_, err := os.Stat(filepath.Join(dataDir, migrationFile))
	return err == nil
}

func readMigrationResult(dataDir string) *migrationResult {
	b, err := os.ReadFile(filepath.Join(dataDir, migrationFile))
	if err != nil {
		return nil
	}
	var r migrationResult
	if json.Unmarshal(b, &r) != nil {
		return nil
	}
	return &r
}

// runMigration runs both phases and records the result in <data>\migration.json.
func runMigration(opts migrationOptions) (*migrationResult, error) {
	r, err := migrateClients(opts)
	if err != nil {
		return r, err
	}
	retireLegacyData(opts, r)
	return r, finishMigration(opts, r)
}

func finishMigration(opts migrationOptions, r *migrationResult) error {
	if err := os.MkdirAll(opts.DataDir, 0o755); err != nil {
		return err
	}
	return writeUpdateJSON(filepath.Join(opts.DataDir, migrationFile), r)
}

// ---------- phase 1: clients ----------

func legacyIntegrationParts(profile string) map[string]string {
	var ledger struct {
		Parts map[string]string `json:"parts"`
	}
	b, err := os.ReadFile(filepath.Join(profile, ".agents", legacyIntegrationsFile))
	if err != nil || json.Unmarshal(b, &ledger) != nil || ledger.Parts == nil {
		return map[string]string{}
	}
	return ledger.Parts
}

// partID names a managed part the way the reporting installer recorded it.
func partID(profile, file, part string) string {
	rel, err := filepath.Rel(profile, file)
	if err != nil {
		rel = file
	}
	return filepath.ToSlash(rel) + "#" + part
}

var legacySkillCommand = regexp.MustCompile(`"[^"\n]*/(task-sync|task-report)\.mjs"`)

// unmodifiedLegacySkill reports a SKILL.md that still holds a reporting template
// exactly as the installer rendered it, with any install folder.
func unmodifiedLegacySkill(content []byte, recorded string) bool {
	text := lfText(content)
	if recorded != "" && sha256Hex([]byte(text)) == recorded {
		return true
	}
	template := legacySkillCommand.ReplaceAllString(text, `"`+legacySkillPlaceholder+`/$1.mjs"`)
	return legacySkillTemplates[sha256Hex([]byte(template))]
}

var legacyBlockSkill = regexp.MustCompile("read `([^`\n]*)` before implementation")

// knownLegacyBlock reports a managed block (markers included) the installer
// wrote for client and the owner did not edit.
func knownLegacyBlock(block, client, recorded string) bool {
	text := lfText([]byte(block))
	if recorded != "" && sha256Hex([]byte(text)) == recorded {
		return true
	}
	skill := ""
	if m := legacyBlockSkill.FindStringSubmatch(text); m != nil {
		skill = m[1]
	}
	for _, variant := range legacyBlockText(client, skill) {
		if text == variant {
			return true
		}
	}
	return false
}

// adoptLegacyConfig copies the previous data folder's config.json once, so the
// owner keeps the projects. Slots are dropped (the field no longer exists).
func adoptLegacyConfig(dataDir, legacyDir string) (bool, error) {
	if legacyDir == "" || samePath(dataDir, legacyDir) || exists(configFilePath(dataDir)) {
		return false, nil
	}
	cfg, err := readAppConfig(configFilePath(legacyDir))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("the previous settings could not be copied (%v); add your projects again", err)
	}
	if err := writeAppConfig(configFilePath(dataDir), cfg); err != nil {
		return false, err
	}
	return true, nil
}

func migrateClients(opts migrationOptions) (*migrationResult, error) {
	r, backup := newMigration(opts)
	profile := opts.Profile
	if !filepath.IsAbs(profile) || !filepath.IsAbs(opts.DataDir) {
		return r, errors.New("migration paths must be absolute")
	}
	copied, err := adoptLegacyConfig(opts.DataDir, opts.LegacyDataDir)
	if err != nil {
		r.fail("%v", err)
	}
	r.ConfigCopied = copied
	parts := legacyIntegrationParts(profile)
	backupProfile := filepath.Join(backup, "profile")

	// Hooks in every Claude configuration folder of the profile.
	for _, home := range claudeHomes(profile) {
		file := filepath.Join(home, "settings.json")
		original, err := readClientFile(file)
		if err != nil {
			r.fail("%s: %v", file, err)
			continue
		}
		if original == nil {
			continue
		}
		updated, n, err := settingsWithoutHooks(original, "task-sync.mjs")
		if err != nil {
			r.fail("%s is not valid JSON; remove its task-sync.mjs hooks by hand", file)
			continue
		}
		if n == 0 {
			continue
		}
		if err := writeClientFile(file, original, updated, profile, backupProfile); err != nil {
			r.fail("%s: %v", file, err)
			continue
		}
		r.HooksRemoved = append(r.HooksRemoved, file)
	}

	// Managed instruction blocks.
	type blockFile struct{ file, client string }
	blocks := []blockFile{{filepath.Join(profile, ".codex", "AGENTS.md"), "Codex"}, {filepath.Join(profile, ".gemini", "GEMINI.md"), "Anti"}}
	for _, home := range claudeHomes(profile) {
		blocks = append(blocks, blockFile{filepath.Join(home, "CLAUDE.md"), "Claude"})
	}
	for _, bf := range blocks {
		original, err := readClientFile(bf.file)
		if err != nil {
			r.fail("%s: %v", bf.file, err)
			continue
		}
		if original == nil {
			continue
		}
		text := string(original)
		a, b, found, ok := findBlock(text, legacyBlockStart, legacyBlockEnd)
		if !found {
			continue
		}
		if !ok {
			r.Kept = append(r.Kept, bf.file+" (incomplete reporting block)")
			r.Checklist = append(r.Checklist, checkItem{File: bf.file, Line: lineOf(text, max(a, b)), Text: "Incomplete reporting block markers; remove the block by hand."})
			continue
		}
		if !knownLegacyBlock(text[a:b], bf.client, parts[partID(profile, bf.file, "block")]) {
			r.Kept = append(r.Kept, bf.file+" (modified locally)")
			r.Checklist = append(r.Checklist, checkItem{File: bf.file, Line: lineOf(text, a), Text: "The reporting block was edited, so it was kept. Remove it by hand: the commands it names no longer record anything."})
			continue
		}
		updated := []byte(removeBlock(text, a, b))
		var content []byte = updated
		if len(bytes.TrimSpace(updated)) == 0 {
			content = nil // the file held only the block
		}
		if err := writeClientFile(bf.file, original, content, profile, backupProfile); err != nil {
			r.fail("%s: %v", bf.file, err)
			continue
		}
		r.BlocksRemoved = append(r.BlocksRemoved, bf.file)
	}

	// SKILL.md copies.
	cfg, cfgErr := readAppConfig(configFilePath(opts.DataDir))
	if errors.Is(cfgErr, fs.ErrNotExist) {
		cfg, cfgErr = defaultAppConfig(), nil
	}
	if cfg.Integrations == nil {
		cfg.Integrations = map[string]IntegrationRecord{}
	}
	cfgChanged := false
	for _, file := range []string{filepath.Join(profile, ".agents", "skills", "task-plan", "SKILL.md"), filepath.Join(profile, ".claude", "skills", "task-plan", "SKILL.md")} {
		original, err := readClientFile(file)
		if err != nil {
			r.fail("%s: %v", file, err)
			continue
		}
		if original == nil || lfText(original) == lfText(embeddedSkill) {
			continue
		}
		if !unmodifiedLegacySkill(original, parts[partID(profile, file, "file")]) {
			r.Kept = append(r.Kept, file+" (modified locally)")
			continue
		}
		if err := writeClientFile(file, original, embeddedSkill, profile, backupProfile); err != nil {
			r.fail("%s: %v", file, err)
			continue
		}
		r.SkillsReplaced = append(r.SkillsReplaced, file)
		for _, c := range integrationClients(profile) {
			if samePath(c.Skill, file) {
				rec := cfg.Integrations[c.ID]
				rec.Path, rec.Version, rec.SHA256, rec.InstalledAt, rec.Kept = file, embeddedSkillVersion, sha256Hex([]byte(lfText(embeddedSkill))), opts.Now.UTC().Format(time.RFC3339), ""
				cfg.Integrations[c.ID] = rec
				cfgChanged = true
			}
		}
	}

	// Carry the old integration record into config.json, then delete it.
	ledgerFile := filepath.Join(profile, ".agents", legacyIntegrationsFile)
	if ledger, err := readClientFile(ledgerFile); err == nil && ledger != nil {
		for id, sum := range parts {
			for _, client := range legacyPartClients(id) {
				rec := cfg.Integrations[client]
				if rec.Legacy == nil {
					rec.Legacy = map[string]string{}
				}
				rec.Legacy[id] = sum
				cfg.Integrations[client] = rec
				cfgChanged = true
			}
		}
		saved := true
		if cfgChanged {
			saved = cfgErr == nil && writeAppConfig(configFilePath(opts.DataDir), cfg) == nil
			cfgChanged = false
		}
		if !saved {
			r.fail("%s was kept because settings could not be saved", ledgerFile)
		} else if err := writeClientFile(ledgerFile, ledger, nil, profile, backupProfile); err != nil {
			r.fail("%s: %v", ledgerFile, err)
		} else {
			r.Deleted = append(r.Deleted, ledgerFile)
		}
	}
	if cfgChanged {
		if cfgErr != nil {
			r.fail("settings could not be updated: %v", cfgErr)
		} else if err := writeAppConfig(configFilePath(opts.DataDir), cfg); err != nil {
			r.fail("settings could not be saved: %v", err)
		}
	}
	stripRunData(opts.DataDir, filepath.Join(backup, "data"), r)
	r.Checklist = append(r.Checklist, ownerChecklist(profile, r.Kept)...)
	if len(r.Checklist) > maxChecklist {
		r.Checklist = r.Checklist[:maxChecklist]
	}
	return r, nil
}

// legacyPartClients maps a reporting installer part to the clients it served.
func legacyPartClients(id string) []string {
	switch {
	case strings.HasPrefix(id, ".claude/"):
		return []string{"claude"}
	case strings.HasPrefix(id, ".codex/"):
		return []string{"codex"}
	case strings.HasPrefix(id, ".gemini/"):
		return []string{"gemini"}
	case strings.HasPrefix(id, ".agents/"):
		return []string{"codex", "gemini"}
	}
	return nil
}

func lineOf(text string, offset int) int {
	if offset < 0 || offset > len(text) {
		return 0
	}
	return strings.Count(text[:offset], "\n") + 1
}

// ownerChecklist lists lines outside managed blocks that still mention the old
// product name, in the instruction files, Claude settings and kept skills.
func ownerChecklist(profile string, kept []string) []checkItem {
	files := []string{filepath.Join(profile, ".codex", "AGENTS.md"), filepath.Join(profile, ".gemini", "GEMINI.md")}
	for _, home := range claudeHomes(profile) {
		files = append(files, filepath.Join(home, "CLAUDE.md"), filepath.Join(home, "settings.json"))
	}
	for _, k := range kept {
		if i := strings.LastIndex(k, " ("); i > 0 && strings.HasSuffix(strings.ToLower(k[:i]), "skill.md") {
			files = append(files, k[:i])
		}
	}
	items := []checkItem{}
	seen := map[string]bool{}
	for _, file := range files {
		key := strings.ToLower(filepath.Clean(file))
		if seen[key] {
			continue
		}
		seen[key] = true
		b, err := readClientFile(file)
		if err != nil || b == nil {
			continue
		}
		inBlock := false
		scanner := bufio.NewScanner(bytes.NewReader(b))
		scanner.Buffer(make([]byte, 64<<10), 4<<20)
		for n := 1; scanner.Scan(); n++ {
			line := scanner.Text()
			if strings.Contains(line, legacyBlockStart) {
				inBlock = true
			}
			if !inBlock && strings.Contains(strings.ToLower(line), legacyProductName) {
				text := strings.TrimSpace(line)
				if r := []rune(text); len(r) > 160 {
					text = string(r[:160]) + "…"
				}
				items = append(items, checkItem{File: file, Line: n, Text: text})
			}
			if strings.Contains(line, legacyBlockEnd) {
				inBlock = false
			}
		}
	}
	return items
}

// ---------- phase 2: data ----------

// Old data-folder files that only the Workboard releases used.
var legacyDataFiles = []string{"activity.jsonl", "activity.jsonl.pre-projects", "snapshot.json", "stale.json", "seen-projects.json", "state.json"}

// Event kinds and keys that only served run history.
var runEventKinds = map[string]bool{"execution-report": true, "assignment": true, "execution": true, "step-assignment": true}
var runPlanKeys = []string{"agent", "agentSource", "executors", "executorSource", "declaredExecutors", "historicalExecutors", "executionReports", "executionUpdatedAt", "slot"}
var runStepKeys = []string{"executors", "executorSource", "execution", "executionHistory", "sourceStatus"}

func retireLegacyData(opts migrationOptions, r *migrationResult) {
	if r.Backup == "" {
		_, r.Backup = newMigration(opts)
	}
	data := filepath.Join(r.Backup, "data")
	remove := func(path string) {
		info, err := os.Lstat(path)
		if err != nil {
			return
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			r.fail("%s is a link and was left alone", path)
			return
		}
		target := filepath.Join(data, strings.ReplaceAll(strings.TrimPrefix(filepath.Clean(path), `\\`), ":", ""))
		if err := copyTree(path, target); err != nil {
			r.fail("%s was not deleted: backup failed (%v)", path, err)
			return
		}
		if err := os.RemoveAll(path); err != nil {
			r.fail("%s could not be deleted: %v", path, err)
			return
		}
		r.Deleted = append(r.Deleted, path)
	}
	stateDirs := []string{filepath.Join(opts.DataDir, "state")}
	if cfg, err := readAppConfig(configFilePath(opts.DataDir)); err == nil && cfg.StateFile != "" {
		stateDirs = append(stateDirs, filepath.Dir(cfg.StateFile))
	}
	if opts.LegacyDataDir != "" && !samePath(opts.LegacyDataDir, opts.DataDir) {
		for _, name := range legacyDataFiles {
			remove(filepath.Join(opts.LegacyDataDir, name))
		}
		remove(filepath.Join(opts.LegacyDataDir, "state"))
	}
	seen := map[string]bool{}
	for _, dir := range stateDirs {
		key := strings.ToLower(filepath.Clean(dir))
		if !seen[key] {
			seen[key] = true
			remove(filepath.Join(dir, legacyExecutionsDir))
		}
	}
	if opts.RuntimeDir != "" {
		for _, name := range legacyRegistryFiles {
			remove(filepath.Join(opts.RuntimeDir, name))
		}
	}
	stripRunData(opts.DataDir, data, r)
}

// stripRunData removes the events and keys that only described runs from a data
// folder shared with the previous release; its plan activity stays. It runs
// before the new version starts, which then appends to the same files.
func stripRunData(dataDir, backup string, r *migrationResult) {
	if err := stripRunActivity(filepath.Join(dataDir, "activity.jsonl"), filepath.Join(backup, "activity.jsonl")); err != nil {
		r.fail("activity: %v", err)
	}
	if err := stripRunSnapshot(filepath.Join(dataDir, "snapshot.json"), filepath.Join(backup, "snapshot.json")); err != nil {
		r.fail("snapshot: %v", err)
	}
}

func copyTree(source, target string) error {
	return filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		dest := filepath.Join(target, rel)
		if d.IsDir() {
			return os.MkdirAll(dest, 0o700)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		b, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0o700); err != nil {
			return err
		}
		return os.WriteFile(dest, b, 0o600)
	})
}

func stripRunActivity(file, backup string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var out [][]byte
	changed := false
	for _, line := range bytes.Split(b, []byte("\n")) {
		if len(bytes.TrimSpace(line)) == 0 {
			continue
		}
		var e map[string]any
		if json.Unmarshal(line, &e) != nil {
			out = append(out, line)
			continue
		}
		if kind, _ := e["kind"].(string); runEventKinds[kind] {
			changed = true
			continue
		}
		if _, ok := e["agent"]; ok {
			delete(e, "agent")
			changed = true
		}
		if _, ok := e["executors"]; ok {
			delete(e, "executors")
			changed = true
		}
		clean, _ := json.Marshal(e)
		out = append(out, clean)
	}
	if !changed {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(backup), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(backup, b, 0o600); err != nil {
		return err
	}
	content := bytes.Join(out, []byte("\n"))
	if len(content) > 0 {
		content = append(content, '\n')
	}
	return atomicUpdateFile(file, content)
}

func stripRunSnapshot(file, backup string) error {
	b, err := os.ReadFile(file)
	if err != nil {
		return nil
	}
	var plans map[string]map[string]any
	if json.Unmarshal(b, &plans) != nil {
		return nil
	}
	changed := false
	stripSteps := func(v any) {
		steps, _ := v.([]any)
		for _, s := range steps {
			if m, ok := s.(map[string]any); ok {
				for _, k := range runStepKeys {
					if _, ok := m[k]; ok {
						delete(m, k)
						changed = true
					}
				}
			}
		}
	}
	keys := make([]string, 0, len(plans))
	for k := range plans {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		p := plans[k]
		for _, key := range runPlanKeys {
			if _, ok := p[key]; ok {
				delete(p, key)
				changed = true
			}
		}
		stripSteps(p["steps"])
		if ms, ok := p["milestones"].([]any); ok {
			for _, m := range ms {
				if mm, ok := m.(map[string]any); ok {
					stripSteps(mm["steps"])
				}
			}
		}
	}
	if !changed {
		return nil
	}
	if err := os.MkdirAll(filepath.Dir(backup), 0o700); err != nil {
		return err
	}
	if err := os.WriteFile(backup, b, 0o600); err != nil {
		return err
	}
	clean, err := json.Marshal(plans)
	if err != nil {
		return err
	}
	return atomicUpdateFile(file, clean)
}

// migrationSummary is the update result sentence for a finished migration.
func migrationSummary(r *migrationResult) string {
	if r == nil {
		return ""
	}
	parts := []string{}
	if n := len(r.HooksRemoved); n > 0 {
		parts = append(parts, fmt.Sprintf("removed the reporting hooks from %d Claude settings file(s)", n))
	}
	if n := len(r.BlocksRemoved); n > 0 {
		parts = append(parts, fmt.Sprintf("removed %d reporting instruction block(s)", n))
	}
	if n := len(r.SkillsReplaced); n > 0 {
		parts = append(parts, fmt.Sprintf("updated %d task-plan skill file(s)", n))
	}
	if n := len(r.Deleted); n > 0 {
		parts = append(parts, fmt.Sprintf("deleted %d run history item(s)", n))
	}
	out := ""
	if len(parts) > 0 {
		out = ". Run reporting is retired: " + strings.Join(parts, ", ") + ". Backup: " + r.Backup
	}
	if len(r.Kept) > 0 {
		out += ". Your changes were kept, so these were not updated: " + strings.Join(r.Kept, "; ")
	}
	if n := len(r.Checklist); n > 0 {
		out += fmt.Sprintf(". %d line(s) you wrote still mention the old name; see Settings > Integrations", n)
	}
	if n := len(r.Errors); n > 0 {
		out += fmt.Sprintf(". %d item(s) need attention; see the update log", n)
	}
	return out
}

// runMigrateCommand is "agent-ops.exe --migrate --profile-dir <home>
// [--runtime-dir <install folder>] [--data-dir <data folder>]", used by the
// installer through integrations/install-task-reporting.mjs. Without --data-dir
// the data folders are taken from the profile, so an isolated install never
// touches the real ones. It prints the result as JSON.
func runMigrateCommand(out io.Writer) int {
	local := profileLocalAppData(profileDir)
	data := filepath.Join(local, "AgentOps")
	if dataDirGiven {
		data = dataDir
	}
	legacy := filepath.Join(local, legacyDataDirName)
	if samePath(legacy, data) {
		legacy = ""
	}
	runtime := ""
	if migrateRuntime != "" {
		runtime, _ = filepath.Abs(migrateRuntime)
	}
	r, err := runMigration(migrationOptions{Profile: profileDir, DataDir: data, LegacyDataDir: legacy, RuntimeDir: runtime})
	b, _ := json.MarshalIndent(r, "", "  ")
	fmt.Fprintln(out, string(b))
	if err != nil {
		fmt.Fprintln(os.Stderr, "migration failed:", err)
		return 1
	}
	return 0
}
