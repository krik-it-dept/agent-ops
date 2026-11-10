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
// Every file phase 1 changes is recorded with the hash of what it held before
// and what it holds after (Writes). If the new version then fails to start,
// rollbackClients restores a file only while it still holds exactly what the
// migration wrote; a file that changed since is left alone and reported.
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

// An unfinished migration (one with errors) is retried when the app starts, at
// most once per backoff period: 15 minutes after the first attempt, doubling up
// to a day. Earlier results are kept so their backup paths stay findable.
const migrationRetryFirst = 15 * time.Minute
const migrationRetryMax = 24 * time.Hour
const migrationHistoryKept = 5

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

// installedInstance reports the profile's own installation: its default install
// folder together with its default data folder. Only that instance migrates the
// real home's AI client files and deletes its legacy locations.
func (o migrationOptions) installedInstance() bool {
	return o.RuntimeDir != "" && samePath(o.RuntimeDir, filepath.Join(o.Profile, legacyRuntimeRel)) &&
		samePath(o.DataDir, filepath.Join(profileLocalAppData(o.Profile), "AgentOps"))
}

// clientsInScope reports whether this run may edit the profile's AI client
// files: always for a temporary profile (it belongs to the run that names it),
// and for this user's real home only from the installed instance. An isolated
// install, smoke test or dev instance with the default profile leaves them alone.
func (o migrationOptions) clientsInScope() bool {
	return !isRealProfile(o.Profile) || o.installedInstance()
}

// deletionScope returns the folders this run may delete in, or all=true for the
// installed instance of the real home. A temporary profile keeps to the profile
// and the folders named for the run. An isolated runtime or data folder used with
// the real home keeps to those folders, never the installed instance's own
// install folder or data folders (even when a copied config.json names them).
func (o migrationOptions) deletionScope() (roots []string, all bool) {
	if !isRealProfile(o.Profile) {
		return []string{o.Profile, o.DataDir, o.LegacyDataDir, o.RuntimeDir}, false
	}
	if o.installedInstance() {
		return nil, true
	}
	local := profileLocalAppData(o.Profile)
	installed := []string{filepath.Join(o.Profile, legacyRuntimeRel), filepath.Join(local, "AgentOps"), filepath.Join(local, legacyDataDirName)}
	for _, dir := range []string{o.RuntimeDir, o.DataDir} {
		own := dir != ""
		for _, p := range installed {
			own = own && !samePath(dir, p)
		}
		if own {
			roots = append(roots, dir)
		}
	}
	return roots, false
}

func (o migrationOptions) inDeletionScope(path string) bool {
	roots, all := o.deletionScope()
	if all {
		return true
	}
	key := strings.ToLower(filepath.Clean(path))
	for _, root := range roots {
		if root == "" {
			continue
		}
		if r := strings.ToLower(filepath.Clean(root)); key == r || pathWithin(key, r) {
			return true
		}
	}
	return false
}

type checkItem struct {
	File string `json:"file"`
	Line int    `json:"line"`
	Text string `json:"text"`
}

type migrationResult struct {
	Version int    `json:"version"`
	At      string `json:"at"`
	// Done is set only when a run finished without errors; until then the next
	// start retries (see NextRetryAt).
	Done           bool        `json:"done"`
	Attempts       int         `json:"attempts,omitempty"`
	NextRetryAt    string      `json:"nextRetryAt,omitempty"`
	Backup         string      `json:"backup"`
	ConfigCopied   bool        `json:"configCopied,omitempty"`
	HooksRemoved   []string    `json:"hooksRemoved,omitempty"`
	BlocksRemoved  []string    `json:"blocksRemoved,omitempty"`
	SkillsReplaced []string    `json:"skillsReplaced,omitempty"`
	Kept           []string    `json:"kept,omitempty"`
	Deleted        []string    `json:"deleted,omitempty"`
	Checklist      []checkItem `json:"checklist,omitempty"`
	Errors         []string    `json:"errors,omitempty"`
	// Writes are the files phase 1 changed, oldest first, for a rollback.
	Writes []clientWrite `json:"writes,omitempty"`
	// Previous are earlier runs, oldest first (without their own history).
	Previous []migrationResult `json:"previous,omitempty"`
}

// clientWrite is one file phase 1 changed. Before and After are SHA-256 of the
// content before and after ("" when the file did not exist, or was deleted);
// Backup holds the previous content when there was one.
type clientWrite struct {
	File   string `json:"file"`
	Backup string `json:"backup,omitempty"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
}

func hashOrEmpty(b []byte) string {
	if b == nil {
		return ""
	}
	return sha256Hex(b)
}

func (r *migrationResult) recordWrite(file, backup string, before, after []byte) {
	r.Writes = append(r.Writes, clientWrite{File: file, Backup: backup, Before: hashOrEmpty(before), After: hashOrEmpty(after)})
}

// rollbackClients undoes phase 1, newest write first. A file is put back only
// while it still holds exactly what the migration wrote; one that changed since
// (Claude Code, Orca or the owner wrote it) is left as it is and listed. A file
// is deleted only when the migration created it.
func rollbackClients(r *migrationResult) []string {
	if r == nil {
		return nil
	}
	var problems []string
	for i := len(r.Writes) - 1; i >= 0; i-- {
		w := r.Writes[i]
		current, err := readClientFile(w.File)
		if err != nil {
			problems = append(problems, fmt.Sprintf("%s was not restored: %v", w.File, err))
			continue
		}
		if hashOrEmpty(current) != w.After {
			problems = append(problems, w.File+" changed after the migration and was left as it is")
			continue
		}
		var previous []byte
		if w.Before != "" {
			previous, err = os.ReadFile(w.Backup)
			if err != nil || sha256Hex(previous) != w.Before {
				problems = append(problems, w.File+" was not restored: its backup is missing or changed")
				continue
			}
		}
		if current == nil && previous == nil {
			continue
		}
		if _, err := writeClientFileAt(w.File, current, previous, "", ""); err != nil {
			problems = append(problems, fmt.Sprintf("%s was not restored: %v", w.File, err))
		}
	}
	r.Writes = nil
	return problems
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

// migrationDone reports whether the data folder already has a migration that
// finished without errors. One with errors is not done: the next update helper,
// installer run or app start (after its backoff) runs it again.
func migrationDone(dataDir string) bool {
	r := readMigrationResult(dataDir)
	return r != nil && r.Done
}

func migrationBackoff(attempts int) time.Duration {
	d := migrationRetryFirst
	for i := 1; i < attempts && d < migrationRetryMax; i++ {
		d *= 2
	}
	return min(d, migrationRetryMax)
}

// migrationRetryDue reports an unfinished migration whose backoff has passed.
func migrationRetryDue(r *migrationResult, now time.Time) bool {
	if r == nil || r.Done {
		return false
	}
	next, err := time.Parse(time.RFC3339, r.NextRetryAt)
	return err != nil || !now.Before(next)
}

// retryMigration re-runs an unfinished migration when its backoff has passed. The
// app calls it on start, before it loads its settings and data, so the run does
// not race the app's own writes. It reports whether a run happened.
func retryMigration(opts migrationOptions) (*migrationResult, bool, error) {
	if opts.Now.IsZero() {
		opts.Now = time.Now()
	}
	if !migrationRetryDue(readMigrationResult(opts.DataDir), opts.Now) {
		return nil, false, nil
	}
	r, err := runMigration(opts)
	return r, true, err
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

// finishMigration records r, keeping earlier runs. A run with errors is not
// done and gets the next retry time; a run that changed nothing keeps pointing at
// the backup of the last run that did.
func finishMigration(opts migrationOptions, r *migrationResult) error {
	if err := os.MkdirAll(opts.DataDir, 0o755); err != nil {
		return err
	}
	now := opts.Now
	if now.IsZero() {
		now = time.Now()
	}
	if prev := readMigrationResult(opts.DataDir); prev != nil {
		r.Attempts = prev.Attempts
		earlier := *prev
		earlier.Previous, earlier.Writes = nil, nil
		r.Previous = append(append([]migrationResult{}, prev.Previous...), earlier)
		if n := len(r.Previous); n > migrationHistoryKept {
			r.Previous = r.Previous[n-migrationHistoryKept:]
		}
		if len(r.Writes) == 0 && len(r.Deleted) == 0 && !exists(r.Backup) {
			r.Backup = prev.Backup
		}
	}
	r.Attempts++
	r.Done = len(r.Errors) == 0
	r.NextRetryAt = ""
	if !r.Done {
		r.NextRetryAt = now.Add(migrationBackoff(r.Attempts)).UTC().Format(time.RFC3339)
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
	// config.json is recorded like a client file, so a rollback removes a copy
	// this run created (the retry then copies the settings again).
	configFile := configFilePath(opts.DataDir)
	configBefore, _ := readClientFile(configFile)
	defer func() {
		after, err := readClientFile(configFile)
		if err != nil || bytes.Equal(after, configBefore) && (after == nil) == (configBefore == nil) {
			return
		}
		saved := ""
		if configBefore != nil {
			saved = filepath.Join(backup, "data", "config.json")
			if os.MkdirAll(filepath.Dir(saved), 0o700) != nil || os.WriteFile(saved, configBefore, 0o600) != nil {
				r.fail("%s: the previous settings could not be backed up for a rollback", configFile)
				return
			}
		}
		r.recordWrite(configFile, saved, configBefore, after)
	}()
	copied, err := adoptLegacyConfig(opts.DataDir, opts.LegacyDataDir)
	if err != nil {
		r.fail("%v", err)
	}
	r.ConfigCopied = copied
	if !opts.clientsInScope() {
		r.Kept = append(r.Kept, profile+" (AI client files left alone: this is not the installed Agent Ops; use a temporary --profile-dir to test the migration)")
		if opts.inDeletionScope(opts.DataDir) {
			stripRunData(opts.DataDir, filepath.Join(backup, "data"), r)
		}
		return r, nil
	}
	parts := legacyIntegrationParts(profile)
	backupProfile := filepath.Join(backup, "profile")
	// A linked file or invalid JSON needs the owner, not a retry: it is listed
	// under "Review by hand" instead of being an error that keeps the migration open.
	problem := func(file string, err error) {
		if errors.Is(err, errClientFileLinked) {
			r.Kept = append(r.Kept, file+" (a link; Agent Ops does not edit linked files)")
			r.Checklist = append(r.Checklist, checkItem{File: file, Text: "This file is a link, so the migration left it alone. Remove the Agent Ops reporting parts from it by hand."})
			return
		}
		r.fail("%s: %v", file, err)
	}
	write := func(file string, original, content []byte) error {
		saved, err := writeClientFileAt(file, original, content, profile, backupProfile)
		if err == nil {
			r.recordWrite(file, saved, original, content)
		}
		return err
	}

	// Hooks in every Claude configuration folder of the profile.
	for _, home := range claudeHomes(profile) {
		file := filepath.Join(home, "settings.json")
		original, err := readClientFile(file)
		if err != nil {
			problem(file, err)
			continue
		}
		if original == nil {
			continue
		}
		// Only the shape the reporting installer wrote: a hook the owner wrote
		// that calls task-sync.mjs another way stays.
		updated, n, err := settingsWithoutHooks(original, legacyHookScript, legacyHookFlag)
		if err != nil {
			r.Kept = append(r.Kept, file+" (not valid JSON)")
			r.Checklist = append(r.Checklist, checkItem{File: file, Text: "Not valid JSON (" + err.Error() + "), so its reporting hooks were left. Remove the hooks that run task-sync.mjs --claude-hook by hand."})
			continue
		}
		if n == 0 {
			continue
		}
		if err := write(file, original, updated); err != nil {
			problem(file, err)
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
			problem(bf.file, err)
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
		if err := write(bf.file, original, content); err != nil {
			problem(bf.file, err)
			continue
		}
		r.BlocksRemoved = append(r.BlocksRemoved, bf.file)
	}

	// SKILL.md copies, in every client folder detection finds. The list of
	// integration folders is seeded once from what is found here (a folder that
	// holds a task-plan skill), never from fixed client names. Later runs (the
	// installer, the update helper, the retry on start) only refresh the hashes
	// of folders still listed: a folder the owner removed is never added back.
	cfg, cfgErr := readAppConfig(configFilePath(opts.DataDir))
	configExists := cfgErr == nil
	if errors.Is(cfgErr, fs.ErrNotExist) {
		cfg, cfgErr = defaultAppConfig(), nil
	}
	seed := !cfg.IntegrationsSeeded
	cfgChanged := false
	stamp := opts.Now.UTC().Format(time.RFC3339)
	if opts.Now.IsZero() {
		stamp = time.Now().UTC().Format(time.RFC3339)
	}
	for _, found := range detectIntegrationTargets(profile, nil) {
		file := skillFileOf(found.SkillDir)
		original, err := readClientFile(file)
		if err == nil && linkedPath(filepath.Dir(file)) {
			err = errClientFileLinked // a linked task-plan folder may point into a repository
		}
		if err != nil {
			problem(file, err)
			continue
		}
		if original == nil {
			continue
		}
		legacySum := parts[partID(profile, file, "file")]
		current := lfText(original) == lfText(embeddedSkill)
		if !current {
			if !unmodifiedLegacySkill(original, legacySum) {
				r.Kept = append(r.Kept, file+" (modified locally)")
			} else if err := write(file, original, embeddedSkill); err != nil {
				problem(file, err)
			} else {
				r.SkillsReplaced = append(r.SkillsReplaced, file)
				current = true
			}
		}
		i := -1
		for j, t := range cfg.Integrations {
			if samePlace(t.SkillDir, found.SkillDir) {
				i = j
			}
		}
		if i < 0 && !seed {
			continue
		}
		if i < 0 {
			cfg.Integrations = append(cfg.Integrations, IntegrationTarget{ID: projectIDFor(found.SkillDir), Label: found.Label, SkillDir: found.SkillDir, InstructionFile: found.InstructionFile, Enabled: true, Source: "detected", AddedAt: stamp})
			i = len(cfg.Integrations) - 1
			cfgChanged = true
		}
		t := &cfg.Integrations[i]
		if legacySum != "" && t.LegacySHA256 != legacySum {
			t.LegacySHA256, cfgChanged = legacySum, true
		}
		if current && t.SHA256 != sha256Hex([]byte(lfText(embeddedSkill))) {
			t.Version, t.SHA256, t.InstalledAt, t.Kept = embeddedSkillVersion, sha256Hex([]byte(lfText(embeddedSkill))), stamp, ""
			cfgChanged = true
		}
	}

	// Recorded with the seeded list (the same config.json write). A missing
	// config.json with nothing to seed stays missing, so a later run can still
	// copy the previous settings.
	if seed && cfgErr == nil && (configExists || cfgChanged) {
		cfg.IntegrationsSeeded, cfgChanged = true, true
	}

	// The old integration record was carried into the folders above; delete it.
	ledgerFile := filepath.Join(profile, ".agents", legacyIntegrationsFile)
	if ledger, err := readClientFile(ledgerFile); err == nil && ledger != nil {
		saved := true
		if cfgChanged {
			saved = cfgErr == nil && writeAppConfig(configFilePath(opts.DataDir), cfg) == nil
			cfgChanged = false
		}
		if !saved {
			r.fail("%s was kept because settings could not be saved", ledgerFile)
		} else if err := write(ledgerFile, ledger, nil); err != nil {
			problem(ledgerFile, err)
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
	if opts.inDeletionScope(opts.DataDir) {
		stripRunData(opts.DataDir, filepath.Join(backup, "data"), r)
	}
	r.Checklist = append(r.Checklist, ownerChecklist(profile, r.Kept)...)
	if len(r.Checklist) > maxChecklist {
		r.Checklist = r.Checklist[:maxChecklist]
	}
	return r, nil
}

// legacyIntegrationRecord is the per-client record of v0.3.0 development
// builds (config.json "integrations" as an object keyed by client).
type legacyIntegrationRecord struct {
	Path         string `json:"path,omitempty"`
	Version      int    `json:"version,omitempty"`
	SHA256       string `json:"sha256,omitempty"`
	InstalledAt  string `json:"installedAt,omitempty"`
	Kept         string `json:"kept,omitempty"`
	Instructions *struct {
		Path   string `json:"path"`
		SHA256 string `json:"sha256"`
	} `json:"instructions,omitempty"`
	Legacy map[string]string `json:"legacy,omitempty"`
}

// legacyIntegrationTargets converts the per-client records into the folder list,
// keeping the recorded hashes so "Modified locally" and "Update available" stay
// right. Codex and Gemini shared one skills folder there; a second instruction
// file for the same folder becomes its own entry in the client's folder.
func legacyIntegrationTargets(old map[string]legacyIntegrationRecord, profile string) []IntegrationTarget {
	type client struct{ id, label, home, instructions string }
	clients := []client{
		{"claude", "Claude Code", filepath.Join(profile, ".claude", "skills"), filepath.Join(profile, ".claude", "CLAUDE.md")},
		{"codex", "Codex / shared skills", filepath.Join(profile, ".agents", "skills"), filepath.Join(profile, ".codex", "AGENTS.md")},
		{"gemini", "Antigravity / Gemini", filepath.Join(profile, ".agents", "skills"), filepath.Join(profile, ".gemini", "GEMINI.md")},
	}
	out := []IntegrationTarget{}
	find := func(dir string) int {
		for i, t := range out {
			if samePath(t.SkillDir, dir) {
				return i
			}
		}
		return -1
	}
	for _, c := range clients {
		rec, ok := old[c.id]
		if !ok {
			continue
		}
		dir := c.home
		if rec.Path != "" && filepath.IsAbs(rec.Path) {
			dir = filepath.Dir(filepath.Dir(rec.Path))
		}
		instructions := c.instructions
		if rec.Instructions != nil && filepath.IsAbs(rec.Instructions.Path) {
			instructions = rec.Instructions.Path
		}
		legacy := rec.Legacy[partID(profile, skillFileOf(dir), "file")]
		if rec.Path == "" && rec.Kept == "" && rec.Instructions == nil && legacy == "" {
			continue
		}
		i := find(dir)
		if i >= 0 && rec.Instructions != nil && out[i].InstructionBlock && !samePath(out[i].InstructionFile, instructions) {
			dir, i = filepath.Join(profile, "."+c.id, "skills"), -1
			if j := find(dir); j >= 0 {
				continue
			}
		}
		if i < 0 {
			out = append(out, IntegrationTarget{ID: projectIDFor(dir), Label: c.label, SkillDir: dir, InstructionFile: instructions, Enabled: true, Source: "detected"})
			i = len(out) - 1
		}
		t := &out[i]
		if rec.SHA256 != "" && t.SHA256 == "" {
			t.Version, t.SHA256, t.InstalledAt = rec.Version, rec.SHA256, rec.InstalledAt
		}
		if rec.Kept != "" && t.Kept == "" {
			t.Kept = rec.Kept
		}
		if legacy != "" {
			t.LegacySHA256 = legacy
		}
		if rec.Instructions != nil {
			t.InstructionFile, t.InstructionBlock, t.InstructionSHA256 = instructions, true, rec.Instructions.SHA256
		}
	}
	if len(out) == 0 {
		return nil
	}
	return out
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
	// Only the installed instance deletes the legacy locations; any other run keeps
	// to its own folders (see deletionScope), even when a copied config.json points
	// at a real state folder.
	remove := func(path string) {
		info, err := os.Lstat(path)
		if err != nil {
			return
		}
		if !opts.inDeletionScope(path) {
			r.Kept = append(r.Kept, path+" (outside this instance's own folders, left alone)")
			return
		}
		if info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			r.Kept = append(r.Kept, path+" (a link, left alone)")
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
	if opts.inDeletionScope(opts.DataDir) {
		stripRunData(opts.DataDir, data, r)
	}
}

// stripRunData removes the events and keys that only described runs from a data
// folder shared with the previous release; its plan activity stays. It runs
// before the new version starts, which then appends to the same files.
func stripRunData(dataDir, backup string, r *migrationResult) {
	for _, item := range []struct {
		name  string
		strip func(file, backup string) error
	}{{"activity.jsonl", stripRunActivity}, {"snapshot.json", stripRunSnapshot}} {
		file, saved := filepath.Join(dataDir, item.name), filepath.Join(backup, item.name)
		before, _ := os.ReadFile(file)
		if err := item.strip(file, saved); err != nil {
			r.fail("%s: %v", item.name, err)
			continue
		}
		// Recorded so that a rollback gives the previous release its data back.
		if after, err := os.ReadFile(file); err == nil && before != nil && !bytes.Equal(before, after) {
			r.recordWrite(file, saved, before, after)
		}
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
		out += fmt.Sprintf(". %d item(s) could not be cleaned up yet; Agent Ops retries on a later start, see Settings > Integrations", n)
	}
	return out
}

// appMigrationOptions are the running app's own folders: its profile, data
// folder (with the previous default data folder when it is the default one) and
// the folder of its executable.
func appMigrationOptions() migrationOptions {
	exe, _ := os.Executable()
	opts := migrationOptions{Profile: profileDir, DataDir: dataDir, RuntimeDir: filepath.Dir(exe)}
	if samePath(dataDir, defaultDataDir()) {
		opts.LegacyDataDir = legacyDefaultDataDir()
	}
	return opts
}

// runMigrateCommand is "agent-ops.exe --migrate --profile-dir <home>
// [--runtime-dir <install folder>] [--data-dir <data folder>]", used by the
// installer through integrations/install-task-reporting.mjs. Without --data-dir
// the data folders are taken from the profile. With this user's real home, only
// the installed instance (default install and data folders) edits client files
// or deletes legacy locations; see migrationOptions.deletionScope. It prints the
// result as JSON.
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
