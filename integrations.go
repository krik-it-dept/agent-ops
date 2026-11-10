package main

// Settings > Integrations: the task-plan skill and an optional one-line
// instruction block for Claude Code, Codex and Antigravity / Gemini. Nothing is
// installed without the owner's action; the in-app updater never writes client
// files, it only makes a newer embedded skill show as "Update available".

import (
	"bytes"
	_ "embed"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
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

type integrationClient struct {
	ID, Name     string
	Home         string // detected when this folder exists
	Skill        string
	Instructions string
}

// integrationClients lists the supported clients for a profile. Codex and
// Antigravity share ~/.agents/skills.
func integrationClients(profile string) []integrationClient {
	shared := filepath.Join(profile, ".agents", "skills", "task-plan", "SKILL.md")
	return []integrationClient{
		{"claude", "Claude Code", filepath.Join(profile, ".claude"), filepath.Join(profile, ".claude", "skills", "task-plan", "SKILL.md"), filepath.Join(profile, ".claude", "CLAUDE.md")},
		{"codex", "Codex", filepath.Join(profile, ".codex"), shared, filepath.Join(profile, ".codex", "AGENTS.md")},
		{"gemini", "Antigravity / Gemini", filepath.Join(profile, ".gemini"), shared, filepath.Join(profile, ".gemini", "GEMINI.md")},
	}
}

func (c integrationClient) detected() bool {
	if st, err := os.Stat(c.Home); err == nil && st.IsDir() {
		return true
	}
	if c.ID == "claude" {
		if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" && isRealProfile(profileDir) {
			if st, err := os.Stat(v); err == nil && st.IsDir() {
				return true
			}
		}
	}
	return false
}

type skillStatus struct {
	Path             string   `json:"path"`
	State            string   `json:"state"` // not-detected, not-installed, installed, update-available, modified
	InstalledVersion int      `json:"installedVersion"`
	Kept             bool     `json:"kept"`
	SharedWith       []string `json:"sharedWith"`
}

type instructionStatus struct {
	Path  string `json:"path"`
	State string `json:"state"` // not-detected, off, on, outdated, modified
	Line  string `json:"line"`
}

type clientStatus struct {
	ID           string            `json:"id"`
	Name         string            `json:"name"`
	Detected     bool              `json:"detected"`
	ConfigDir    string            `json:"configDir"`
	Skill        skillStatus       `json:"skill"`
	Instructions instructionStatus `json:"instructions"`
}

type integrationsPayload struct {
	SkillVersion int              `json:"skillVersion"`
	Clients      []clientStatus   `json:"clients"`
	Migration    *migrationResult `json:"migration"`
	ReadOnly     string           `json:"readOnly"`
}

func skillState(c integrationClient, records map[string]IntegrationRecord, profile string) skillStatus {
	st := skillStatus{Path: c.Skill, SharedWith: []string{}}
	for _, other := range integrationClients(profile) {
		if other.ID != c.ID && samePath(other.Skill, c.Skill) {
			st.SharedWith = append(st.SharedWith, other.ID)
		}
	}
	rec := records[c.ID]
	st.InstalledVersion = rec.Version
	content, err := readClientFile(c.Skill)
	switch {
	case err != nil:
		st.State = "modified"
	case content == nil && !c.detected():
		st.State = "not-detected"
	case content == nil:
		st.State = "not-installed"
	case lfText(content) == lfText(embeddedSkill):
		st.State, st.InstalledVersion = "installed", embeddedSkillVersion
	default:
		sum := sha256Hex([]byte(lfText(content)))
		ours := false
		for id, r := range records {
			if r.SHA256 == sum && (id == c.ID || contains(st.SharedWith, id)) {
				ours = true
			}
		}
		parts := map[string]string{}
		for _, r := range records {
			for k, v := range r.Legacy {
				parts[k] = v
			}
		}
		if ours || unmodifiedLegacySkill(content, parts[partID(profile, c.Skill, "file")]) {
			st.State = "update-available"
		} else {
			st.State = "modified"
			for id, r := range records {
				if r.Kept == sum && (id == c.ID || contains(st.SharedWith, id)) {
					st.Kept = true
				}
			}
		}
	}
	return st
}

func contains(list []string, v string) bool {
	for _, x := range list {
		if x == v {
			return true
		}
	}
	return false
}

func instructionState(c integrationClient, rec IntegrationRecord) instructionStatus {
	st := instructionStatus{Path: c.Instructions, Line: instructionLine}
	if !c.detected() {
		st.State = "not-detected"
		return st
	}
	content, err := readClientFile(c.Instructions)
	if err != nil {
		st.State = "modified"
		return st
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
	case rec.Instructions != nil && sha256Hex([]byte(lfText([]byte(text[a:b])))) == rec.Instructions.SHA256:
		st.State = "outdated"
	default:
		st.State = "modified"
	}
	return st
}

var integrationsMu sync.Mutex

func currentIntegrations() integrationsPayload {
	cfgMu.Lock()
	records := map[string]IntegrationRecord{}
	for k, v := range appCfg.Integrations {
		records[k] = v
	}
	readOnly := configReadOnly
	cfgMu.Unlock()
	out := integrationsPayload{SkillVersion: embeddedSkillVersion, Clients: []clientStatus{}, Migration: readMigrationResult(dataDir), ReadOnly: readOnly}
	for _, c := range integrationClients(profileDir) {
		out.Clients = append(out.Clients, clientStatus{ID: c.ID, Name: c.Name, Detected: c.detected(), ConfigDir: c.Home, Skill: skillState(c, records, profileDir), Instructions: instructionState(c, records[c.ID])})
	}
	return out
}

type integrationError struct {
	code int
	text string
}

func (e *integrationError) Error() string { return e.text }

func conflict(text string) error { return &integrationError{http.StatusConflict, text} }

const modifiedText = "This file was changed outside Agent Ops. Use View diff, then Keep mine or Replace."

// applyIntegration performs one action for one client and records it.
func applyIntegration(clientID, action string, now time.Time) error {
	var client *integrationClient
	for _, c := range integrationClients(profileDir) {
		if c.ID == clientID {
			c := c
			client = &c
		}
	}
	if client == nil {
		return &integrationError{http.StatusNotFound, "Unknown AI client."}
	}
	integrationsMu.Lock()
	defer integrationsMu.Unlock()
	cfgMu.Lock()
	readOnly := configReadOnly
	records := map[string]IntegrationRecord{}
	for k, v := range appCfg.Integrations {
		records[k] = v
	}
	cfgMu.Unlock()
	if readOnly != "" {
		return conflict(readOnly)
	}
	if updateRestarting.Load() {
		return &integrationError{http.StatusServiceUnavailable, "Agent Ops is restarting for an update. Try again after it reconnects."}
	}
	backup := filepath.Join(dataDir, "backups", "integrations", now.Format("20060102-150405.000000000"))
	stamp := now.UTC().Format(time.RFC3339)
	skill := skillState(*client, records, profileDir)
	sharing := append([]string{client.ID}, skill.SharedWith...)
	writeSkill := func(force bool) error {
		if !client.detected() && skill.State == "not-detected" {
			return conflict(client.Name + " was not found on this computer.")
		}
		if skill.State == "modified" && !force {
			return conflict(modifiedText)
		}
		current, err := readClientFile(client.Skill)
		if err != nil {
			return conflict(err.Error())
		}
		if current == nil || !bytes.Equal(current, embeddedSkill) {
			if err := writeClientFile(client.Skill, current, embeddedSkill, profileDir, backup); err != nil {
				return conflict("Could not write " + client.Skill + ": " + err.Error())
			}
		}
		for _, id := range sharing {
			rec := records[id]
			rec.Path, rec.Version, rec.SHA256, rec.InstalledAt, rec.Kept = client.Skill, embeddedSkillVersion, sha256Hex([]byte(lfText(embeddedSkill))), stamp, ""
			records[id] = rec
		}
		return nil
	}
	var err error
	switch action {
	case "install", "update":
		err = writeSkill(false)
	case "replace":
		err = writeSkill(true)
	case "keep":
		if skill.State != "modified" {
			return conflict("Only a file changed outside Agent Ops can be kept.")
		}
		current, readErr := readClientFile(client.Skill)
		if readErr != nil || current == nil {
			return conflict("The file could not be read.")
		}
		rec := records[client.ID]
		rec.Kept = sha256Hex([]byte(lfText(current)))
		records[client.ID] = rec
	case "remove":
		if skill.State == "modified" {
			return conflict(modifiedText)
		}
		if skill.State == "installed" || skill.State == "update-available" {
			current, readErr := readClientFile(client.Skill)
			if readErr != nil {
				return conflict(readErr.Error())
			}
			if err := writeClientFile(client.Skill, current, nil, profileDir, backup); err != nil {
				return conflict("Could not remove " + client.Skill + ": " + err.Error())
			}
			_ = os.Remove(filepath.Dir(client.Skill)) // only when empty
		}
		for _, id := range sharing {
			rec := records[id]
			rec.Path, rec.Version, rec.SHA256, rec.InstalledAt, rec.Kept = "", 0, "", "", ""
			records[id] = rec
		}
	case "instructions-on", "instructions-off":
		err = toggleInstructions(*client, records, action == "instructions-on", backup, stamp)
	default:
		return &integrationError{http.StatusNotFound, "Unknown action."}
	}
	if err != nil {
		return err
	}
	return saveIntegrationRecords(records)
}

func toggleInstructions(c integrationClient, records map[string]IntegrationRecord, on bool, backup, stamp string) error {
	rec := records[c.ID]
	state := instructionState(c, rec)
	if state.State == "not-detected" {
		return conflict(c.Name + " was not found on this computer.")
	}
	if state.State == "modified" {
		return conflict("The Agent Ops lines in " + c.Instructions + " were changed by hand. Edit them there.")
	}
	current, err := readClientFile(c.Instructions)
	if err != nil {
		return conflict(err.Error())
	}
	text := string(current)
	a, b, found, _ := findBlock(text, instructionStart, instructionEnd)
	var next []byte
	if on {
		if state.State == "on" {
			return nil
		}
		newline := "\n"
		if strings.Contains(text, "\r\n") {
			newline = "\r\n"
		}
		block := strings.ReplaceAll(instructionBlock(), "\n", newline)
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
		if err := writeClientFile(c.Instructions, current, next, profileDir, backup); err != nil {
			return conflict("Could not write " + c.Instructions + ": " + err.Error())
		}
		rec.Instructions = &InstructionRecord{Path: c.Instructions, SHA256: sha256Hex([]byte(instructionBlock())), InstalledAt: stamp}
	} else {
		if found {
			updated := []byte(removeBlock(text, a, b))
			if len(bytes.TrimSpace(updated)) == 0 && rec.Instructions != nil {
				updated = nil
			}
			if err := writeClientFile(c.Instructions, current, updated, profileDir, backup); err != nil {
				return conflict("Could not write " + c.Instructions + ": " + err.Error())
			}
		}
		rec.Instructions = nil
	}
	records[c.ID] = rec
	return nil
}

func saveIntegrationRecords(records map[string]IntegrationRecord) error {
	cfgMu.Lock()
	defer cfgMu.Unlock()
	next := appCfg
	next.Projects = append([]Project{}, appCfg.Projects...)
	next.Integrations = map[string]IntegrationRecord{}
	for k, v := range records {
		if v.Path != "" || v.Kept != "" || v.Instructions != nil || len(v.Legacy) > 0 {
			next.Integrations[k] = v
		}
	}
	if len(next.Integrations) == 0 {
		next.Integrations = nil
	}
	if err := writeAppConfig(configFilePath(dataDir), next); err != nil {
		return &integrationError{http.StatusInternalServerError, "The change was made, but settings could not be saved: " + err.Error()}
	}
	appCfg = next
	return nil
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

func handleIntegrations(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.Header().Set("Allow", http.MethodGet)
		settingsFail(w, http.StatusMethodNotAllowed, "Method not allowed.")
		return
	}
	writeJSON(w, http.StatusOK, currentIntegrations())
}

func handleIntegrationAction(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.TrimPrefix(r.URL.Path, "/api/integrations/"), "/")
	if len(parts) != 2 {
		settingsFail(w, http.StatusNotFound, "Not found.")
		return
	}
	client, action := parts[0], parts[1]
	if action == "diff" {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", http.MethodGet)
			settingsFail(w, http.StatusMethodNotAllowed, "Method not allowed.")
			return
		}
		for _, c := range integrationClients(profileDir) {
			if c.ID == client {
				current, err := readClientFile(c.Skill)
				if err != nil {
					settingsFail(w, http.StatusConflict, err.Error())
					return
				}
				writeJSON(w, http.StatusOK, map[string]any{"path": c.Skill, "identical": current != nil && lfText(current) == lfText(embeddedSkill), "lines": lineDiff(string(current), string(embeddedSkill))})
				return
			}
		}
		settingsFail(w, http.StatusNotFound, "Unknown AI client.")
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
	if err := applyIntegration(client, action, time.Now()); err != nil {
		var problem *integrationError
		if errors.As(err, &problem) {
			settingsFail(w, problem.code, problem.text)
		} else {
			settingsFail(w, http.StatusInternalServerError, err.Error())
		}
		return
	}
	logInfo("integration changed", "client", client, "action", action)
	writeJSON(w, http.StatusOK, currentIntegrations())
}
