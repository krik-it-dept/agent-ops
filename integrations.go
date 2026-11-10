package main

// Settings > Integrations: a list of folders, chosen by the owner, that receive
// the task-plan skill (<folder>\task-plan\SKILL.md), each with an optional
// instruction file for a one-line reminder. The list lives in config.json;
// detection (integration_detect.go) only suggests entries. Nothing is added or
// installed without the owner's action; the in-app updater never writes these
// files, it only makes a newer embedded skill show as "Update available".

import (
	"bytes"
	_ "embed"
	"errors"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

	"golang.org/x/sys/windows"
)

//go:embed skills/task-plan/SKILL.md
var embeddedSkill []byte

var embeddedSkillVersion = skillVersionOf(embeddedSkill)

var skillVersionLine = regexp.MustCompile(`(?m)^agent-ops-skill:\s*(\d+)\s*$`)

// skillVersionOf reads "agent-ops-skill: N" from the front matter; 0 if absent.
func skillVersionOf(b []byte) int {
	text := lfText(b)
	if !strings.HasPrefix(text, "---\n") {
		return 0
	}
	end := strings.Index(text[4:], "\n---")
	if end < 0 {
		return 0
	}
	m := skillVersionLine.FindStringSubmatch(text[4 : 4+end])
	if m == nil {
		return 0
	}
	n, _ := strconv.Atoi(m[1])
	return n
}

const (
	instructionStart = "<!-- agent-ops:start -->"
	instructionEnd   = "<!-- agent-ops:end -->"
	instructionLine  = "For substantial work, keep a plan with the task-plan skill in `<main checkout>/.tasks/`."
)

func instructionBlock() string {
	return instructionStart + "\n" + instructionLine + "\n" + instructionEnd
}

// skillFileOf is the skill file Agent Ops manages inside a target folder.
func skillFileOf(dir string) string { return filepath.Join(dir, "task-plan", "SKILL.md") }

// ---------- path identity ----------

// existingAncestor returns the deepest existing part of path and the rest of
// path below it.
func existingAncestor(path string) (string, string) {
	path = filepath.Clean(path)
	rest := ""
	for {
		if _, err := os.Stat(path); err == nil {
			return path, rest
		}
		parent := filepath.Dir(path)
		if parent == path {
			return "", ""
		}
		if rest == "" {
			rest = filepath.Base(path)
		} else {
			rest = filepath.Join(filepath.Base(path), rest)
		}
		path = parent
	}
}

// samePlace reports whether two paths name the same folder or file, also through
// symbolic links and junctions (compared by file identity, not by text).
func samePlace(a, b string) bool {
	if a == "" || b == "" {
		return false
	}
	if samePath(a, b) {
		return true
	}
	pa, ra := existingAncestor(a)
	pb, rb := existingAncestor(b)
	if pa == "" || pb == "" || !strings.EqualFold(ra, rb) {
		return false
	}
	ia, errA := os.Stat(pa)
	ib, errB := os.Stat(pb)
	return errA == nil && errB == nil && os.SameFile(ia, ib)
}

// insideProject returns the project that contains path (or is path), also
// through links.
func insideProject(path string, projects []Project) (Project, bool) {
	for _, p := range projects {
		key, proj := resolvedProjectPath(path), resolvedProjectPath(p.Path)
		if key == proj || pathWithin(key, proj) {
			return p, true
		}
		for dir := filepath.Clean(path); ; dir = filepath.Dir(dir) {
			if samePlace(dir, p.Path) {
				return p, true
			}
			if filepath.Dir(dir) == dir {
				break
			}
		}
	}
	return Project{}, false
}

// finalPath resolves every link and junction in an existing path (Windows
// GetFinalPathNameByHandle; filepath.EvalSymlinks does not follow junctions).
func finalPath(path string) (string, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return "", err
	}
	h, err := windows.CreateFile(p, 0, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS, 0)
	if err != nil {
		return "", err
	}
	defer windows.CloseHandle(h)
	buf := make([]uint16, windows.MAX_LONG_PATH)
	n, err := windows.GetFinalPathNameByHandle(h, &buf[0], uint32(len(buf)), 0) // VOLUME_NAME_DOS
	if err != nil {
		return "", err
	}
	if int(n) > len(buf) {
		return "", windows.ERROR_INSUFFICIENT_BUFFER
	}
	out := windows.UTF16ToString(buf[:n])
	if strings.HasPrefix(out, `\\?\UNC\`) {
		return `\\` + out[len(`\\?\UNC\`):], nil
	}
	return strings.TrimPrefix(out, `\\?\`), nil
}

// realPath is path with links and junctions in its existing part resolved; the
// part that does not exist yet is kept as written.
func realPath(path string) string {
	base, rest := existingAncestor(path)
	if base == "" {
		return path
	}
	resolved, err := finalPath(base)
	if err != nil {
		return path
	}
	return filepath.Join(resolved, rest)
}

// skillFolderInProject reports a project that holds the skills folder or its
// task-plan subfolder, where the skill is written, also when either is a link
// or junction into a repository.
func skillFolderInProject(dir string) (Project, bool) {
	projects := currentProjects()
	for _, path := range []string{dir, filepath.Join(dir, "task-plan")} {
		for _, candidate := range []string{path, realPath(path)} {
			if p, inside := insideProject(candidate, projects); inside {
				return p, true
			}
		}
	}
	return Project{}, false
}

// ---------- state ----------

type instructionStatus struct {
	Path  string `json:"path"`
	State string `json:"state"` // none, missing-folder, off, on, outdated, modified
	Line  string `json:"line"`
}

type targetStatus struct {
	ID               string            `json:"id"`
	Label            string            `json:"label"`
	SkillDir         string            `json:"skillDir"`
	SkillFile        string            `json:"skillFile"`
	Enabled          bool              `json:"enabled"`
	Source           string            `json:"source"`
	State            string            `json:"state"` // missing-folder, not-installed, installed, update-available, modified
	InstalledVersion int               `json:"installedVersion"`
	Kept             bool              `json:"kept"`
	Instructions     instructionStatus `json:"instructions"`
}

type integrationsPayload struct {
	SkillVersion int                     `json:"skillVersion"`
	Targets      []targetStatus          `json:"targets"`
	Suggestions  []integrationSuggestion `json:"suggestions"`
	Migration    *migrationResult        `json:"migration"`
	ReadOnly     string                  `json:"readOnly"`
	Added        string                  `json:"added,omitempty"`
}

// folderMissing: neither the folder nor its parent exists, so there is nowhere
// to install. A missing folder whose parent exists is created by Install.
func folderMissing(dir string) bool { return !isDir(dir) && !isDir(filepath.Dir(dir)) }

func skillState(t IntegrationTarget) targetStatus {
	st, _, _ := readSkillState(t)
	return st
}

// readSkillState also returns the bytes the state was computed from, so a write
// uses exactly them as its expected content (no second read in between).
func readSkillState(t IntegrationTarget) (targetStatus, []byte, error) {
	st := targetStatus{ID: t.ID, Label: t.Label, SkillDir: t.SkillDir, SkillFile: skillFileOf(t.SkillDir), Enabled: t.Enabled, Source: t.Source, InstalledVersion: t.Version}
	content, err := readClientFile(st.SkillFile)
	switch {
	case err != nil:
		st.State = "modified"
	case content == nil && folderMissing(t.SkillDir):
		st.State, st.InstalledVersion = "missing-folder", 0
	case content == nil:
		st.State, st.InstalledVersion = "not-installed", 0
	case lfText(content) == lfText(embeddedSkill):
		st.State, st.InstalledVersion = "installed", embeddedSkillVersion
	default:
		sum := sha256Hex([]byte(lfText(content)))
		if v := skillVersionOf(content); v > 0 {
			st.InstalledVersion = v
		}
		if sum == t.SHA256 || unmodifiedLegacySkill(content, t.LegacySHA256) {
			st.State = "update-available"
		} else {
			st.State, st.Kept = "modified", t.Kept != "" && t.Kept == sum
		}
	}
	st.Instructions = instructionState(t)
	return st, content, err
}

func instructionState(t IntegrationTarget) instructionStatus {
	st, _, _ := readInstructionState(t)
	return st
}

// readInstructionState is instructionState with the bytes it read.
func readInstructionState(t IntegrationTarget) (instructionStatus, []byte, error) {
	st := instructionStatus{Path: t.InstructionFile, Line: instructionLine}
	if t.InstructionFile == "" {
		st.State = "none"
		return st, nil, nil
	}
	content, err := readClientFile(t.InstructionFile)
	if err != nil {
		st.State = "modified"
		return st, nil, err
	}
	if content == nil && !isDir(filepath.Dir(t.InstructionFile)) {
		st.State = "missing-folder"
		return st, nil, nil
	}
	text := string(content)
	a, b, found, ok := findBlock(text, instructionStart, instructionEnd)
	switch {
	case !ok:
		st.State = "modified"
	case !found:
		st.State = "off"
	case lfText([]byte(text[a:b])) == instructionBlock():
		st.State = "on"
	case t.InstructionSHA256 != "" && sha256Hex([]byte(lfText([]byte(text[a:b])))) == t.InstructionSHA256:
		st.State = "outdated"
	default:
		st.State = "modified"
	}
	return st, content, nil
}

// afterIntegrationRead runs after an action read a file's state and before it
// writes; tests use it to change the file in between.
var afterIntegrationRead = func(file string) {}

var integrationsMu sync.Mutex

func integrationTargets() ([]IntegrationTarget, string) {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return append([]IntegrationTarget{}, appCfg.Integrations...), configReadOnly
}

func currentIntegrations() integrationsPayload {
	targets, readOnly := integrationTargets()
	out := integrationsPayload{SkillVersion: embeddedSkillVersion, Targets: []targetStatus{}, Migration: readMigrationResult(dataDir), ReadOnly: readOnly}
	for _, t := range targets {
		out.Targets = append(out.Targets, skillState(t))
	}
	out.Suggestions = detectIntegrationTargets(profileDir, targets)
	return out
}

type integrationError struct {
	code int
	text string
}

func (e *integrationError) Error() string { return e.text }

func conflict(text string) error { return &integrationError{http.StatusConflict, text} }
func badInput(text string) error { return &integrationError{http.StatusBadRequest, text} }

const modifiedText = "This file was changed outside Agent Ops. Use View diff, then Keep mine or Replace."
const notListedText = "This folder is no longer in the list. Reload Settings."

func findTarget(list []IntegrationTarget, id string) int {
	for i, t := range list {
		if t.ID == id {
			return i
		}
	}
	return -1
}

// beginIntegrationChange returns a copy of the list, or an error when settings
// cannot be saved now. The caller holds integrationsMu.
func beginIntegrationChange() ([]IntegrationTarget, error) {
	list, readOnly := integrationTargets()
	if readOnly != "" {
		return nil, conflict(readOnly)
	}
	if updateRestarting.Load() {
		return nil, &integrationError{http.StatusServiceUnavailable, "Agent Ops is restarting for an update. Try again after it reconnects."}
	}
	return list, nil
}

var integrationActions = map[string]bool{"install": true, "update": true, "replace": true, "keep": true, "remove": true, "instructions-on": true, "instructions-off": true}

// applyIntegration performs one file action for one target and records it.
func applyIntegration(id, action string, now time.Time) error {
	if !integrationActions[action] {
		return &integrationError{http.StatusNotFound, "Unknown action."}
	}
	integrationsMu.Lock()
	defer integrationsMu.Unlock()
	list, err := beginIntegrationChange()
	if err != nil {
		return err
	}
	i := findTarget(list, id)
	if i < 0 {
		return &integrationError{http.StatusNotFound, notListedText}
	}
	t := list[i]
	// A turned-off folder can still be cleaned up: Remove skill and turning the
	// reminder off only take Agent Ops' own text away.
	if !t.Enabled && action != "remove" && action != "instructions-off" {
		return conflict("This folder is turned off. Turn it on first.")
	}
	backup := filepath.Join(dataDir, "backups", "integrations", now.Format("20060102-150405.000000000"))
	stamp := now.UTC().Format(time.RFC3339)
	skill, current, readErr := readSkillState(t)
	file := skill.SkillFile
	afterIntegrationRead(file)
	inProject := func() error {
		if p, inside := skillFolderInProject(t.SkillDir); inside {
			return conflict("The folder " + filepath.Dir(file) + " is inside the project “" + p.Name + "” (through a link). Agent Ops does not write into repositories; edit the skill at its source.")
		}
		return nil
	}
	writeSkill := func(force bool) error {
		if skill.State == "missing-folder" {
			return conflict("The folder " + t.SkillDir + " does not exist. Edit the path or remove it from the list.")
		}
		if skill.State == "modified" && !force {
			return conflict(modifiedText)
		}
		if readErr != nil {
			return conflict(readErr.Error())
		}
		if err := inProject(); err != nil {
			return err
		}
		if current == nil || !bytes.Equal(current, embeddedSkill) {
			if err := writeClientFile(file, current, embeddedSkill, profileDir, backup); err != nil {
				return conflict("Could not write " + file + ": " + err.Error())
			}
		}
		t.Version, t.SHA256, t.InstalledAt, t.Kept = embeddedSkillVersion, sha256Hex([]byte(lfText(embeddedSkill))), stamp, ""
		return nil
	}
	switch action {
	case "install", "update":
		err = writeSkill(false)
	case "replace":
		err = writeSkill(true)
	case "keep":
		if skill.State != "modified" {
			return conflict("Only a file changed outside Agent Ops can be kept.")
		}
		if readErr != nil || current == nil {
			return conflict("The file could not be read.")
		}
		t.Kept = sha256Hex([]byte(lfText(current)))
	case "remove":
		if skill.State == "modified" {
			return conflict(modifiedText)
		}
		if skill.State == "installed" || skill.State == "update-available" {
			if err := inProject(); err != nil {
				return err
			}
			if err := writeClientFile(file, current, nil, profileDir, backup); err != nil {
				return conflict("Could not remove " + file + ": " + err.Error())
			}
			_ = os.Remove(filepath.Dir(file)) // only when empty
		}
		t.Version, t.SHA256, t.InstalledAt, t.Kept, t.LegacySHA256 = 0, "", "", "", ""
	case "instructions-on", "instructions-off":
		err = toggleInstructions(&t, action == "instructions-on", backup)
	}
	if err != nil {
		return err
	}
	list[i] = t
	return saveIntegrations(list)
}

// toggleInstructions adds or removes the marked one-line block. Only text
// between the markers is changed (see removeBlock for the separator lines).
func toggleInstructions(t *IntegrationTarget, on bool, backup string) error {
	state, current, readErr := readInstructionState(*t)
	afterIntegrationRead(t.InstructionFile)
	switch state.State {
	case "none":
		return conflict("Choose an instruction file for this folder first.")
	case "missing-folder":
		return conflict("The folder of " + t.InstructionFile + " does not exist. Edit the path first.")
	case "modified":
		return conflict("The Agent Ops lines in " + t.InstructionFile + " were changed by hand. Edit them there.")
	}
	if readErr != nil {
		return conflict(readErr.Error())
	}
	text := string(current)
	a, b, found, _ := findBlock(text, instructionStart, instructionEnd)
	if on {
		if state.State != "on" {
			newline := "\n"
			if strings.Contains(text, "\r\n") {
				newline = "\r\n"
			}
			block := strings.ReplaceAll(instructionBlock(), "\n", newline)
			var next []byte
			if found {
				next = []byte(text[:a] + block + text[b:])
			} else {
				sep := ""
				if text != "" {
					if !strings.HasSuffix(text, "\n") {
						sep = newline
					}
					sep += newline
				}
				next = []byte(text + sep + block + newline)
			}
			if err := writeClientFile(t.InstructionFile, current, next, profileDir, backup); err != nil {
				return conflict("Could not write " + t.InstructionFile + ": " + err.Error())
			}
		}
		t.InstructionBlock, t.InstructionSHA256 = true, sha256Hex([]byte(instructionBlock()))
		return nil
	}
	if found {
		updated := []byte(removeBlock(text, a, b))
		if len(bytes.TrimSpace(updated)) == 0 && t.InstructionBlock {
			updated = nil // the file held only the block Agent Ops wrote
		}
		if err := writeClientFile(t.InstructionFile, current, updated, profileDir, backup); err != nil {
			return conflict("Could not write " + t.InstructionFile + ": " + err.Error())
		}
	}
	t.InstructionBlock, t.InstructionSHA256 = false, ""
	return nil
}

func saveIntegrations(list []IntegrationTarget) error {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	next := appCfg
	next.Projects = append([]Project{}, appCfg.Projects...)
	next.Integrations = append([]IntegrationTarget{}, list...)
	next.IntegrationsSeeded = true // the owner manages the list from now on
	if len(next.Integrations) == 0 {
		next.Integrations = nil
	}
	if err := writeAppConfig(configFilePath(dataDir), next); err != nil {
		return &integrationError{http.StatusInternalServerError, "Settings could not be saved: " + err.Error()}
	}
	appCfg = next
	return nil
}

// ---------- adding and editing targets ----------

// cleanInputPath accepts a pasted or picked path: trimmed, without surrounding
// quotes, absolute.
func cleanInputPath(raw string) (string, bool) {
	path := strings.TrimSpace(raw)
	if len(path) >= 2 && path[0] == '"' && path[len(path)-1] == '"' {
		path = strings.TrimSpace(path[1 : len(path)-1])
	}
	// Network (\\server\share) and device (\\.\, \\?\) paths are refused: a
	// device path is not a folder, and an offline share would stall every read.
	if path == "" || !filepath.IsAbs(path) || strings.ContainsRune(path, 0) || strings.HasPrefix(path, `\\`) || strings.HasPrefix(path, "//") {
		return "", false
	}
	return filepath.Clean(path), true
}

func writableDir(dir string) error {
	f, err := os.CreateTemp(dir, ".agent-ops-check-*.tmp")
	if err != nil {
		return err
	}
	name := f.Name()
	f.Close()
	return os.Remove(name)
}

func validLabel(label string) bool {
	if label == "" || len([]rune(label)) > maxIntegrationLabel {
		return false
	}
	for _, r := range label {
		if unicode.IsControl(r) {
			return false
		}
	}
	return true
}

// defaultLabel names a folder by itself, or by its parent for a "skills" folder.
func defaultLabel(dir string) string {
	name := filepath.Base(dir)
	if strings.EqualFold(name, "skills") {
		name = filepath.Base(filepath.Dir(dir))
	}
	name = strings.TrimPrefix(name, ".")
	if name == "" || strings.ContainsAny(name, `\/:`) {
		name = dir
	}
	if r := []rune(name); len(r) > maxIntegrationLabel {
		name = string(r[:maxIntegrationLabel])
	}
	return name
}

func currentProjects() []Project {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	return append([]Project{}, appCfg.Projects...)
}

// checkSkillDir validates a skills folder: absolute, an existing writable folder
// or a creatable one under an existing parent, outside every project, and not
// already listed (also through links). self is the target being edited.
func checkSkillDir(raw string, list []IntegrationTarget, self string) (string, error) {
	dir, ok := cleanInputPath(raw)
	if !ok {
		return "", badInput(`Enter a full folder path on this computer, for example C:\Users\me\tools\skills.`)
	}
	if p, inside := skillFolderInProject(dir); inside {
		return "", badInput("This folder is inside the project “" + p.Name + "”. Choose the AI client's own skills folder, outside your repositories.")
	}
	info, err := os.Stat(dir)
	switch {
	case err == nil && !info.IsDir():
		return "", badInput("This path is a file. Choose the folder that holds the skills.")
	case err == nil:
		if err := writableDir(dir); err != nil {
			return "", badInput("Agent Ops cannot write to this folder: " + err.Error())
		}
	case errors.Is(err, fs.ErrNotExist):
		parent := filepath.Dir(dir)
		if !isDir(parent) {
			return "", badInput("Neither this folder nor its parent folder exists.")
		}
		if err := writableDir(parent); err != nil {
			return "", badInput("Agent Ops cannot create this folder: " + err.Error())
		}
	default:
		return "", badInput("Agent Ops cannot open this folder: " + err.Error())
	}
	for _, t := range list {
		if t.ID != self && samePlace(t.SkillDir, dir) {
			return "", badInput("This folder is already in the list as “" + t.Label + "”.")
		}
	}
	return dir, nil
}

// checkInstructionFile validates an instruction file: absolute, Markdown (.md),
// a writable plain file (not a link) or a new file in an existing folder,
// outside every project, and not used by another folder of the list (both would
// turn one reminder on and off). self is the target being edited.
func checkInstructionFile(raw string, list []IntegrationTarget, self string) (string, error) {
	file, ok := cleanInputPath(raw)
	if !ok {
		return "", badInput(`Enter a full file path on this computer, for example C:\Users\me\tools\AGENTS.md.`)
	}
	if !strings.EqualFold(filepath.Ext(file), ".md") {
		return "", badInput("Choose a Markdown instruction file (.md), for example AGENTS.md or CLAUDE.md.")
	}
	info, err := os.Lstat(file)
	switch {
	case err == nil && info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0:
		return "", badInput("This file is a link. Agent Ops does not edit linked files; choose the file it points to.")
	case err == nil && !info.Mode().IsRegular():
		return "", badInput("This path is a folder. Choose the instruction file itself, for example AGENTS.md.")
	case err == nil:
		f, openErr := os.OpenFile(file, os.O_WRONLY|os.O_APPEND, 0)
		if openErr != nil {
			return "", badInput("Agent Ops cannot write to this file: " + openErr.Error())
		}
		f.Close()
	case errors.Is(err, fs.ErrNotExist):
		if !isDir(filepath.Dir(file)) {
			return "", badInput("The folder of this file does not exist.")
		}
	default:
		return "", badInput("Agent Ops cannot open this file: " + err.Error())
	}
	if p, inside := insideProject(file, currentProjects()); inside {
		return "", badInput("This file is inside the project “" + p.Name + "”. Choose the AI client's own instruction file.")
	}
	for _, t := range list {
		if t.ID != self && samePlace(t.InstructionFile, file) {
			return "", badInput("This instruction file is already used by “" + t.Label + "”.")
		}
	}
	return file, nil
}

type targetInput struct {
	SkillDir        *string `json:"skillDir"`
	InstructionFile *string `json:"instructionFile"`
	Label           *string `json:"label"`
	Enabled         *bool   `json:"enabled"`
}

// addIntegrationTarget adds a folder. It is "detected" when it is one of the
// current suggestions, otherwise "custom". It returns the new id.
func addIntegrationTarget(in targetInput, now time.Time) (string, error) {
	integrationsMu.Lock()
	defer integrationsMu.Unlock()
	list, err := beginIntegrationChange()
	if err != nil {
		return "", err
	}
	if in.SkillDir == nil {
		return "", badInput("Choose a skills folder.")
	}
	dir, err := checkSkillDir(*in.SkillDir, list, "")
	if err != nil {
		return "", err
	}
	t := IntegrationTarget{ID: projectIDFor(dir), SkillDir: dir, Enabled: true, Source: "custom", AddedAt: now.UTC().Format(time.RFC3339), Label: defaultLabel(dir)}
	if in.Enabled != nil {
		t.Enabled = *in.Enabled
	}
	for _, s := range detectIntegrationTargets(profileDir, list) {
		if samePlace(s.SkillDir, dir) {
			t.Source, t.Label = "detected", s.Label
		}
	}
	if in.Label != nil && strings.TrimSpace(*in.Label) != "" {
		t.Label = strings.TrimSpace(*in.Label)
	}
	if !validLabel(t.Label) {
		return "", badInput("Enter a name of 1 to 80 characters.")
	}
	if in.InstructionFile != nil && strings.TrimSpace(*in.InstructionFile) != "" {
		if t.InstructionFile, err = checkInstructionFile(*in.InstructionFile, list, ""); err != nil {
			return "", err
		}
	}
	for findTarget(list, t.ID) >= 0 {
		t.ID = projectIDFor(t.ID + dir)
	}
	return t.ID, saveIntegrations(append(list, t))
}

// editIntegrationTarget changes a folder's name, paths or Enabled. Recorded
// hashes are content hashes and stay. The instruction file cannot change while
// the reminder is in it (the block would be left behind unmanaged).
func editIntegrationTarget(id string, in targetInput) error {
	integrationsMu.Lock()
	defer integrationsMu.Unlock()
	list, err := beginIntegrationChange()
	if err != nil {
		return err
	}
	i := findTarget(list, id)
	if i < 0 {
		return &integrationError{http.StatusNotFound, notListedText}
	}
	t := list[i]
	if in.SkillDir != nil {
		if t.SkillDir, err = checkSkillDir(*in.SkillDir, list, id); err != nil {
			return err
		}
	}
	if in.InstructionFile != nil {
		next := ""
		if strings.TrimSpace(*in.InstructionFile) != "" {
			if next, err = checkInstructionFile(*in.InstructionFile, list, id); err != nil {
				return err
			}
		}
		if !samePath(next, t.InstructionFile) {
			if t.InstructionBlock {
				return conflict("Turn the reminder off before changing the instruction file.")
			}
			t.InstructionFile, t.InstructionSHA256 = next, ""
		}
	}
	if in.Label != nil {
		label := strings.TrimSpace(*in.Label)
		if !validLabel(label) {
			return badInput("Enter a name of 1 to 80 characters.")
		}
		t.Label = label
	}
	if in.Enabled != nil {
		t.Enabled = *in.Enabled
	}
	list[i] = t
	return saveIntegrations(list)
}

// removeIntegrationTarget takes a folder off the list. Files are left as they
// are; "Remove skill" is the action that deletes the skill file. It is refused
// while the reminder is on: the block would be left behind unmanaged.
func removeIntegrationTarget(id string) error {
	integrationsMu.Lock()
	defer integrationsMu.Unlock()
	list, err := beginIntegrationChange()
	if err != nil {
		return err
	}
	i := findTarget(list, id)
	if i < 0 {
		return &integrationError{http.StatusNotFound, notListedText}
	}
	if list[i].InstructionBlock {
		return conflict("Turn the reminder off before removing this folder from the list.")
	}
	return saveIntegrations(append(list[:i], list[i+1:]...))
}

// ---------- diff ----------

type diffLine struct {
	Op   string `json:"op"` // " ", "-" (on disk) or "+" (what Agent Ops would write)
	Text string `json:"text"`
}

// lineDiff is a longest-common-subsequence line diff, bounded for large files.
func lineDiff(oldText, newText string) []diffLine {
	split := func(s string) []string {
		s = strings.TrimSuffix(lfText([]byte(s)), "\n")
		if s == "" {
			return []string{}
		}
		return strings.Split(s, "\n")
	}
	a, b := split(oldText), split(newText)
	if len(a)*len(b) > 4_000_000 {
		out := []diffLine{}
		for _, l := range a {
			out = append(out, diffLine{"-", l})
		}
		for _, l := range b {
			out = append(out, diffLine{"+", l})
		}
		return out
	}
	lcs := make([][]int32, len(a)+1)
	for i := range lcs {
		lcs[i] = make([]int32, len(b)+1)
	}
	for i := len(a) - 1; i >= 0; i-- {
		for j := len(b) - 1; j >= 0; j-- {
			if a[i] == b[j] {
				lcs[i][j] = lcs[i+1][j+1] + 1
			} else if lcs[i+1][j] >= lcs[i][j+1] {
				lcs[i][j] = lcs[i+1][j]
			} else {
				lcs[i][j] = lcs[i][j+1]
			}
		}
	}
	out := []diffLine{}
	i, j := 0, 0
	for i < len(a) && j < len(b) {
		switch {
		case a[i] == b[j]:
			out = append(out, diffLine{" ", a[i]})
			i, j = i+1, j+1
		case lcs[i+1][j] >= lcs[i][j+1]:
			out = append(out, diffLine{"-", a[i]})
			i++
		default:
			out = append(out, diffLine{"+", b[j]})
			j++
		}
	}
	for ; i < len(a); i++ {
		out = append(out, diffLine{"-", a[i]})
	}
	for ; j < len(b); j++ {
		out = append(out, diffLine{"+", b[j]})
	}
	return out
}

// ---------- HTTP ----------

func failIntegration(w http.ResponseWriter, err error) {
	var problem *integrationError
	if errors.As(err, &problem) {
		settingsFail(w, problem.code, problem.text)
		return
	}
	settingsFail(w, http.StatusInternalServerError, err.Error())
}

// handleIntegrations: GET lists the folders and suggestions; POST adds a folder.
func handleIntegrations(w http.ResponseWriter, r *http.Request) {
	if r.Method == http.MethodGet {
		writeJSON(w, http.StatusOK, currentIntegrations())
		return
	}
	if !guardWrite(w, r, http.MethodGet, http.MethodPost) {
		return
	}
	var body targetInput
	if !decodeOne(w, r, &body) {
		return
	}
	id, err := addIntegrationTarget(body, time.Now())
	if err != nil {
		failIntegration(w, err)
		return
	}
	logInfo("integration folder added", "id", id)
	out := currentIntegrations()
	out.Added = id
	writeJSON(w, http.StatusOK, out)
}

// handleIntegrationAction serves /api/integrations/<id> (PATCH, DELETE) and
// /api/integrations/<id>/<action> (GET diff, POST file actions).
func handleIntegrationAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/integrations/"), "/")
	if len(parts) > 2 || !integrationIDPattern.MatchString(parts[0]) {
		settingsFail(w, http.StatusNotFound, "Not found.")
		return
	}
	id := parts[0]
	if len(parts) == 1 {
		if !guardWrite(w, r, http.MethodPatch, http.MethodDelete) {
			return
		}
		var err error
		if r.Method == http.MethodDelete {
			err = removeIntegrationTarget(id)
		} else {
			var body targetInput
			if !decodeOne(w, r, &body) {
				return
			}
			err = editIntegrationTarget(id, body)
		}
		if err != nil {
			failIntegration(w, err)
			return
		}
		logInfo("integration folder changed", "id", id, "method", r.Method)
		writeJSON(w, http.StatusOK, currentIntegrations())
		return
	}
	action := parts[1]
	if action == "diff" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			settingsFail(w, http.StatusMethodNotAllowed, "Method not allowed.")
			return
		}
		list, _ := integrationTargets()
		i := findTarget(list, id)
		if i < 0 {
			settingsFail(w, http.StatusNotFound, notListedText)
			return
		}
		file := skillFileOf(list[i].SkillDir)
		current, err := readClientFile(file)
		if err != nil {
			settingsFail(w, http.StatusConflict, err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"path": file, "identical": current != nil && lfText(current) == lfText(embeddedSkill), "lines": lineDiff(string(current), string(embeddedSkill))})
		return
	}
	if !guardWrite(w, r, http.MethodPost) {
		return
	}
	if r.ContentLength != 0 {
		var body struct{}
		if !decodeOne(w, r, &body) {
			return
		}
	}
	if err := applyIntegration(id, action, time.Now()); err != nil {
		failIntegration(w, err)
		return
	}
	logInfo("integration changed", "id", id, "action", action)
	writeJSON(w, http.StatusOK, currentIntegrations())
}
