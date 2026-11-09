// Agent Ops: a tray app that shows the owner's task plans (.tasks/*.md in each repo) as a
// Jira-style board. It watches the plan files, regenerates the state with tasks-overview.mjs,
// derives an activity feed from what changed, serves the UI on 127.0.0.1 and opens it in an Edge
// app window. No model calls, no tokens.
package main

import (
	"bytes"
	"context"
	"crypto/sha1"
	"embed"
	"encoding/json"
	"flag"
	"fmt"
	"io/fs"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unicode"

	"fyne.io/systray"
	"golang.org/x/sys/windows/registry"
)

var (
	addr       = "127.0.0.1:7790"
	reposDir   = `D:\1_PROJECTS\_REPOS`
	slotsFile  = `D:\1_PROJECTS\_WORKTREES\slots.json`
	stateFile  = `D:\1_PROJECTS\tong-hop-chung.json`
	scriptFile = defaultCollector()
)

const (
	runKey     = `Software\Microsoft\Windows\CurrentVersion\Run`
	runName    = "KRIK Workboard"
	staleAfter = 120 * time.Minute
	maxEvents  = 3000
)

//go:embed web/index.html
var indexHTML []byte

//go:embed web/icons/*
var iconFiles embed.FS

// ---------- state from tasks-overview.mjs ----------

type Step struct {
	ExecutionHistory *struct {
		VerifiedAt time.Time `json:"verifiedAt"`
	} `json:"executionHistory"`
	Execution *struct {
		State string `json:"state"`
	} `json:"execution"`
	Executors []string `json:"executors"`
	Line      int      `json:"line"`
	Milestone string   `json:"milestone,omitempty"`
	Index     int      `json:"index"`
	Status    string   `json:"status"`
	Text      string   `json:"text"`
}
type Milestone struct {
	ID      string `json:"id"`
	Title   string `json:"title"`
	State   string `json:"state"`
	Summary string `json:"summary"`
	Steps   []Step `json:"steps"`
}
type Entry struct {
	Key    string `json:"key"`
	When   string `json:"when"`
	Text   string `json:"text"`
	Ask    string `json:"ask"`
	Answer string `json:"answer"`
	Open   bool   `json:"open"`
}
type Plan struct {
	HistoricalExecutors []string             `json:"historicalExecutors"`
	ExecutionReports    []ExecutionReport    `json:"executionReports"`
	ExecutionUpdatedAt  time.Time            `json:"executionUpdatedAt"`
	Executors           []string             `json:"executors"`
	ExecutorSource      string               `json:"executorSource"`
	Agent               string               `json:"agent"`
	AgentSource         string               `json:"agentSource"`
	Revision            string               `json:"revision"`
	Owner               string               `json:"owner"`
	Repo                string               `json:"repo"`
	Name                string               `json:"name"`
	Status              string               `json:"status"`
	Mtime               time.Time            `json:"mtime"`
	Slot                *struct{ By string } `json:"slot"`
	Decisions           []Entry              `json:"decisions"`
	Questions           []Entry              `json:"questions"`
	Milestones          []Milestone          `json:"milestones"`
	Steps               []Step               `json:"steps"`
}
type State struct {
	Plans []Plan `json:"plans"`
}
type ExecutionReport struct {
	ID          string    `json:"id"`
	Agent       string    `json:"agent"`
	Coordinator string    `json:"coordinator"`
	Event       string    `json:"event"`
	At          time.Time `json:"at"`
	Task        struct {
		Text string `json:"text"`
	} `json:"task"`
	Result string `json:"result"`
}

func executionEvent(p Plan, r ExecutionReport) Event {
	return Event{TS: r.At, Repo: p.Repo, Plan: p.Name, Kind: "execution-report", Text: r.Task.Text, Extra: r.Event + ": " + r.Result, Actor: r.Agent, Agent: r.Coordinator, Executors: []string{r.Agent}}
}

type Event struct {
	Executors []string  `json:"executors"`
	Agent     string    `json:"agent,omitempty"`
	TS        time.Time `json:"ts"`
	Repo      string    `json:"repo"`
	Plan      string    `json:"plan"`
	Kind      string    `json:"kind"` // new, closed, status, done, blocked, partial, decision, question, answer, milestone, waiting, stale
	Text      string    `json:"text"`
	Extra     string    `json:"extra,omitempty"`
	Actor     string    `json:"actor"`
}

var (
	mu           sync.Mutex
	rawState     []byte
	prev         map[string]Plan
	events       []Event
	staleSeen    = map[string]time.Time{}
	subs         = map[chan struct{}]bool{}
	dataDir      string
	refreshMu    sync.Mutex
	refreshError string
	background   bool
	activation   string
	trayReady    atomic.Bool
)

func defaultCollector() string {
	exe, _ := os.Executable()
	home, _ := os.UserHomeDir()
	candidates := []string{filepath.Join(filepath.Dir(exe), "tasks-overview.mjs"), filepath.Join(home, ".claude", "tools", "workboard", "tasks-overview.mjs"), filepath.Join(home, ".claude", "tools", "tasks-overview.mjs")}
	for _, file := range candidates {
		if _, err := os.Stat(file); err == nil {
			return file
		}
	}
	return candidates[0]
}

func collectorCompanion(name string) string {
	file := filepath.Join(filepath.Dir(scriptFile), name)
	if _, err := os.Stat(file); err == nil {
		return file
	}
	legacy := filepath.Join(filepath.Dir(scriptFile), "workboard", name)
	if _, err := os.Stat(legacy); err == nil {
		return legacy
	}
	return file
}

func config() {
	env := func(name, fallback string) string {
		if v := os.Getenv(name); v != "" {
			return v
		}
		return fallback
	}
	flag.StringVar(&reposDir, "repos-dir", env("KRIK_REPOS_DIR", reposDir), "Repository directory")
	flag.StringVar(&slotsFile, "slots-file", env("KRIK_SLOTS_FILE", slotsFile), "Slots JSON file")
	flag.StringVar(&stateFile, "state-file", env("KRIK_STATE_FILE", stateFile), "Generated state JSON file")
	flag.StringVar(&scriptFile, "script", env("KRIK_SCRIPT", scriptFile), "Overview Node script")
	flag.StringVar(&addr, "addr", env("KRIK_ADDR", addr), "Loopback listen address")
	flag.StringVar(&dataDir, "data-dir", filepath.Join(os.Getenv("LOCALAPPDATA"), "krik-workboard"), "Persistence directory")
	flag.BoolVar(&background, "background", false, "Start tray without opening a window")
	flag.StringVar(&activation, "activate", "", "Toast activation URI")
	flag.Parse()
}

func main() {
	config()
	host, _, err := net.SplitHostPort(addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		return
	}
	// A second manual launch or toast opens the existing instance; login stays quiet.
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		if !background || activation != "" {
			openWindow()
		}
		return
	}
	_ = os.MkdirAll(dataDir, 0o755)
	if addr == "127.0.0.1:7790" && dataDir == filepath.Join(os.Getenv("LOCALAPPDATA"), "krik-workboard") {
		registerProtocol()
		migrateStartup()
	}
	loadPersisted()
	refresh(true)
	go serve(ln)
	go watch()
	systray.Run(onReady, func() {})
}

// ---------- watching and diffing ----------

func signature() string {
	h := sha1.New()
	attributionFile := os.Getenv("KRIK_AGENT_MAP")
	if attributionFile == "" {
		attributionFile = collectorCompanion("agent-attributions.json")
	}
	if data, err := os.ReadFile(attributionFile); err == nil {
		h.Write(data)
	}
	historyFile := os.Getenv("KRIK_HISTORY_MAP")
	if historyFile == "" {
		historyFile = collectorCompanion("historical-executions.json")
	}
	if data, err := os.ReadFile(historyFile); err == nil {
		h.Write(data)
	}
	reportsDir := os.Getenv("KRIK_EXECUTION_DIR")
	if reportsDir == "" {
		reportsDir = filepath.Join(filepath.Dir(stateFile), "workboard-executions")
	}
	reports, _ := filepath.Glob(filepath.Join(reportsDir, "*.json"))
	for _, file := range reports {
		if st, err := os.Stat(file); err == nil {
			fmt.Fprintf(h, "report|%s|%d|%d\n", file, st.Size(), st.ModTime().UnixNano())
		}
	}
	dirs, _ := os.ReadDir(reposDir)
	for _, d := range dirs {
		files, _ := filepath.Glob(filepath.Join(reposDir, d.Name(), ".tasks", "*.md"))
		for _, f := range files {
			if strings.HasSuffix(f, "tong-hop.md") {
				continue
			}
			if st, err := os.Stat(f); err == nil {
				fmt.Fprintf(h, "%s|%d|%d\n", f, st.Size(), st.ModTime().UnixNano())
			}
		}
	}
	if st, err := os.Stat(slotsFile); err == nil {
		fmt.Fprintf(h, "slots|%d|%d\n", st.Size(), st.ModTime().UnixNano())
	}
	return fmt.Sprintf("%x", h.Sum(nil))
}

func watch() {
	last := signature()
	ticks := 0
	for {
		time.Sleep(2 * time.Second)
		ticks++
		mu.Lock()
		retry := refreshError != "" && ticks%5 == 0
		mu.Unlock()
		if s := signature(); s != last || retry {
			last = s
			refresh(false)
		}
		checkStale()
	}
}

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd
}

func refresh(first bool) {
	refreshMu.Lock()
	defer refreshMu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	cmd := hidden(exec.CommandContext(ctx, "node", scriptFile))
	overrides := map[string]string{"KRIK_REPOS_DIR": reposDir, "KRIK_SLOTS_FILE": slotsFile, "KRIK_STATE_FILE": stateFile, "KRIK_TASKS_OUT_DIR": filepath.Dir(stateFile)}
	for _, v := range os.Environ() {
		k, _, _ := strings.Cut(v, "=")
		if _, ok := overrides[k]; !ok {
			cmd.Env = append(cmd.Env, v)
		}
	}
	for k, v := range overrides {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	output, err := cmd.CombinedOutput()
	if err != nil {
		reason := strings.TrimSpace(string(output))
		if len(reason) > 400 {
			reason = reason[:400]
		}
		setRefreshError(fmt.Sprintf("Node failed: %v %s", err, reason))
		return
	}
	raw, err := os.ReadFile(stateFile)
	if err != nil {
		setRefreshError("Read state: " + err.Error())
		return
	}
	var st State
	if err := json.Unmarshal(raw, &st); err != nil {
		setRefreshError("Invalid state JSON: " + err.Error())
		return
	}
	if err := validateState(st); err != nil {
		setRefreshError("Invalid state JSON: " + err.Error())
		return
	}
	mu.Lock()
	rawState = raw
	refreshError = ""
	_ = os.WriteFile(filepath.Join(dataDir, "state.json"), raw, 0o644)
	cur := map[string]Plan{}
	for _, p := range st.Plans {
		cur[p.Repo+"/"+p.Name] = p
	}
	var fresh []Event
	if prev != nil {
		fresh = diff(prev, cur)
	} else {
		fresh = seed(cur)
	}
	prev = cur
	events = append(events, fresh...)
	if len(events) > maxEvents {
		events = events[len(events)-maxEvents:]
	}
	persist(fresh)
	mu.Unlock()
	checkStale()
	if !first {
		notify(fresh)
	}
	updateTray()
	broadcast()
}

func validateState(st State) error {
	if st.Plans == nil {
		return fmt.Errorf("plans must be an array")
	}
	seen := map[string]bool{}
	for _, p := range st.Plans {
		key := p.Repo + "/" + p.Name
		if p.Repo == "" || p.Name == "" || p.Mtime.IsZero() || p.Steps == nil || p.Milestones == nil || p.Decisions == nil || p.Questions == nil {
			return fmt.Errorf("incomplete plan %q", key)
		}
		if seen[key] {
			return fmt.Errorf("duplicate plan %q", key)
		}
		seen[key] = true
		validStep := func(s Step) bool {
			return s.Status == "todo" || s.Status == "doing" || s.Status == "done" || s.Status == "partial" || s.Status == "blocked"
		}
		for _, step := range p.Steps {
			if !validStep(step) {
				return fmt.Errorf("invalid step status in %q", key)
			}
		}
		for _, m := range p.Milestones {
			if m.Steps == nil {
				return fmt.Errorf("missing milestone steps in %q", key)
			}
			for _, step := range m.Steps {
				if !validStep(step) {
					return fmt.Errorf("invalid milestone step in %q", key)
				}
			}
		}
	}
	return nil
}

func setRefreshError(reason string) {
	mu.Lock()
	changed := refreshError != reason
	refreshError = reason
	mu.Unlock()
	if changed {
		broadcast()
	}
}

func entryTime(e Entry) (time.Time, bool) {
	key := e.Key
	if len(key) != 12 {
		return time.Time{}, false
	}
	if strings.HasSuffix(key, "9999") {
		key = key[:8] + "0000"
	}
	t, err := time.ParseInLocation("200601021504", key, time.Local)
	return t, err == nil
}

func seed(cur map[string]Plan) []Event {
	var out []Event
	for _, p := range cur {
		for _, r := range p.ExecutionReports {
			out = append(out, executionEvent(p, r))
		}
		for _, d := range p.Decisions {
			if t, ok := entryTime(d); ok {
				out = append(out, Event{TS: t, Repo: p.Repo, Plan: p.Name, Kind: "decision", Text: d.Text, Extra: d.When, Actor: actor(p), Agent: p.Agent})
			}
		}
		for _, q := range p.Questions {
			if t, ok := entryTime(q); ok {
				out = append(out, Event{TS: t, Repo: p.Repo, Plan: p.Name, Kind: "question", Text: q.Ask, Extra: q.Answer, Actor: actor(p), Agent: p.Agent})
			}
		}
		for _, m := range p.Milestones {
			if msDone(m) && strings.TrimSpace(m.Summary) != "" {
				out = append(out, Event{TS: p.Mtime, Repo: p.Repo, Plan: p.Name, Kind: "milestone", Text: m.ID + ": " + m.Title, Extra: m.Summary, Actor: actor(p), Agent: p.Agent})
			}
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].TS.Before(out[j].TS) })
	return out
}

func stage(s string) string {
	if i := strings.Index(s, " - "); i > 0 {
		return s[:i]
	}
	return s
}

func actor(p Plan) string {
	if p.Slot != nil && p.Slot.By != "" {
		return p.Slot.By
	}
	if strings.TrimSpace(p.Owner) != "" {
		return p.Owner
	}
	return p.Repo
}

// Group by milestone in source order, also supporting snapshots from before step metadata.
func stepGroups(p Plan) map[string][]Step {
	groups := map[string][]Step{}
	used := make([]bool, len(p.Steps))
	for _, m := range p.Milestones {
		groups[m.ID] = append(groups[m.ID], m.Steps...)
		for _, step := range m.Steps {
			for i, flat := range p.Steps {
				if !used[i] && flat.Text == step.Text && flat.Status == step.Status {
					used[i] = true
					break
				}
			}
		}
	}
	for i, s := range p.Steps {
		if !used[i] {
			groups[s.Milestone] = append(groups[s.Milestone], s)
		}
	}
	return groups
}
func normalized(text string) string {
	return strings.Join(strings.Fields(strings.Map(func(r rune) rune {
		if unicode.IsLetter(r) || unicode.IsNumber(r) {
			return unicode.ToLower(r)
		}
		return ' '
	}, text)), " ")
}
func similarity(a, b string) float64 {
	aa, bb := strings.Fields(normalized(a)), strings.Fields(normalized(b))
	tokens := map[string]bool{}
	for _, t := range aa {
		tokens[t] = true
	}
	common := 0
	seen := map[string]bool{}
	for _, t := range bb {
		if tokens[t] && !seen[t] {
			common++
		}
		seen[t] = true
	}
	if len(tokens)+len(seen) == 0 {
		return 0
	}
	return 2 * float64(common) / float64(len(tokens)+len(seen))
}

// Exact matches reserve their identity before similarity and positional fallbacks.
// Each old step is consumed once, so duplicate text and insertions cannot double-emit.
func matchSteps(old, cur []Step) []int {
	matches := make([]int, len(cur))
	used := make([]bool, len(old))
	for i := range matches {
		matches[i] = -1
	}
	for i, s := range cur {
		for j, o := range old {
			if !used[j] && normalized(s.Text) == normalized(o.Text) {
				matches[i] = j
				used[j] = true
				break
			}
		}
	}
	for i, s := range cur {
		if matches[i] >= 0 {
			continue
		}
		best, score := -1, 0.49
		for j, o := range old {
			if !used[j] {
				v := similarity(s.Text, o.Text)
				if v > score {
					best, score = j, v
				}
			}
		}
		if best >= 0 {
			matches[i] = best
			used[best] = true
		}
	}
	for i := range cur {
		if matches[i] < 0 && i < len(old) && !used[i] {
			matches[i] = i
			used[i] = true
		}
	}
	return matches
}

func msDone(m Milestone) bool {
	if m.State != "" {
		return m.State == "done"
	}
	if len(m.Steps) == 0 {
		return false
	}
	for _, s := range m.Steps {
		if s.Status != "done" {
			return false
		}
	}
	return true
}

func diff(old, cur map[string]Plan) []Event {
	now := time.Now()
	var out []Event
	add := func(p Plan, kind, text, extra string) {
		out = append(out, Event{TS: now, Repo: p.Repo, Plan: p.Name, Kind: kind, Text: text, Extra: extra, Actor: actor(p), Agent: p.Agent, Executors: p.Executors})
	}
	for k, p := range cur {
		o, ok := old[k]
		knownReports := map[string]bool{}
		for _, r := range o.ExecutionReports {
			knownReports[r.ID] = true
		}
		for _, r := range p.ExecutionReports {
			if !knownReports[r.ID] {
				out = append(out, executionEvent(p, r))
			}
		}
		if !ok {
			add(p, "new", "Mở plan mới", p.Status)
			if strings.EqualFold(stage(p.Status), "Waiting for owner") {
				add(p, "waiting", "Cần bạn xử lý", p.Status)
			}
			for _, s := range p.Steps {
				if s.Status == "blocked" && s.Execution == nil {
					add(p, "blocked", s.Text, "")
					out[len(out)-1].Executors = s.Executors
				}
			}
			for _, q := range p.Questions {
				if q.Open {
					add(p, "question", q.Ask, "")
				}
			}
			continue
		}
		if o.Agent != "" && p.Agent != "" && o.Agent != p.Agent {
			add(p, "assignment", p.Agent, "")
		}
		if len(p.ExecutionReports) == 0 && len(p.HistoricalExecutors) == 0 && executorLabel(o.Executors) != executorLabel(p.Executors) {
			add(p, "execution", executorLabel(p.Executors), p.Agent)
		}
		if stage(o.Status) != stage(p.Status) {
			add(p, "status", stage(o.Status)+" → "+stage(p.Status), p.Status)
			if strings.HasPrefix(strings.ToLower(p.Status), "waiting for owner") {
				add(p, "waiting", "Cần bạn xử lý", p.Status)
			}
		}
		oldGroups := stepGroups(o)
		for group, steps := range stepGroups(p) {
			before := oldGroups[group]
			matches := matchSteps(before, steps)
			for i, s := range steps {
				was := ""
				if matches[i] >= 0 {
					was = before[matches[i]].Status
					if s.Execution == nil && s.ExecutionHistory == nil && executorLabel(before[matches[i]].Executors) != executorLabel(s.Executors) {
						add(p, "step-assignment", s.Text, executorLabel(s.Executors))
						out[len(out)-1].Executors = s.Executors
					}
				}
				if was == s.Status || s.Execution != nil {
					continue
				}
				switch s.Status {
				case "done", "blocked", "partial":
					add(p, s.Status, s.Text, "")
					out[len(out)-1].Executors = s.Executors
				case "doing":
					if was != "" {
						add(p, "doing", s.Text, "")
						out[len(out)-1].Executors = s.Executors
					}
				}
			}
		}
		seenD := map[string]bool{}
		for _, d := range o.Decisions {
			seenD[d.Text] = true
		}
		for _, d := range p.Decisions {
			if !seenD[d.Text] {
				add(p, "decision", d.Text, d.When)
			}
		}
		oq := map[string]Entry{}
		for _, q := range o.Questions {
			oq[q.Ask] = q
		}
		for _, q := range p.Questions {
			was, ok := oq[q.Ask]
			if !ok {
				add(p, "question", q.Ask, q.Answer)
			} else if was.Open && !q.Open {
				add(p, "answer", q.Ask, q.Answer)
			}
		}
		om := map[string]bool{}
		for _, m := range o.Milestones {
			om[m.ID] = msDone(m)
		}
		for _, m := range p.Milestones {
			if msDone(m) && !om[m.ID] {
				add(p, "milestone", m.ID+": "+m.Title, m.Summary)
			}
		}
	}
	for k, o := range old {
		if _, ok := cur[k]; !ok {
			out = append(out, Event{TS: now, Repo: o.Repo, Plan: o.Name, Kind: "closed", Text: "Đóng plan", Actor: actor(o)})
		}
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].Plan < out[j].Plan })
	return out
}

func isStale(p Plan, now time.Time) bool {
	active := map[string]bool{"planning": true, "implementing": true, "reviewing": true, "fixing review": true, "testing": true}
	last := p.Mtime
	if p.ExecutionUpdatedAt.After(last) {
		last = p.ExecutionUpdatedAt
	}
	return active[strings.ToLower(stage(p.Status))] && !last.IsZero() && now.Sub(last) >= staleAfter
}

func staleEvents(cur map[string]Plan, seen map[string]time.Time, now time.Time) []Event {
	var fresh []Event
	for k := range seen {
		if _, ok := cur[k]; !ok {
			delete(seen, k)
		}
	}
	for k, p := range cur {
		if !isStale(p, now) {
			continue
		}
		if t, ok := seen[k]; ok && t.Equal(p.Mtime) {
			continue
		}
		seen[k] = p.Mtime
		fresh = append(fresh, Event{TS: now, Repo: p.Repo, Plan: p.Name, Kind: "stale", Text: fmt.Sprintf("Đứng im %d phút khi đang %s", int(now.Sub(p.Mtime).Minutes()), stage(p.Status)), Actor: "Workboard"})
	}
	return fresh
}
func checkStale() {
	mu.Lock()
	fresh := staleEvents(prev, staleSeen, time.Now())
	events = append(events, fresh...)
	if len(events) > maxEvents {
		events = events[len(events)-maxEvents:]
	}
	if len(fresh) > 0 {
		persist(fresh)
	}
	mu.Unlock()
	if len(fresh) > 0 {
		notify(fresh)
		broadcast()
	}
}

// ---------- persistence ----------

func loadPersisted() {
	if b, err := os.ReadFile(filepath.Join(dataDir, "state.json")); err == nil {
		var st State
		if json.Unmarshal(b, &st) == nil && validateState(st) == nil {
			rawState = b
		}
	}
	if b, err := os.ReadFile(filepath.Join(dataDir, "snapshot.json")); err == nil {
		_ = json.Unmarshal(b, &prev)
	}
	if b, err := os.ReadFile(filepath.Join(dataDir, "activity.jsonl")); err == nil {
		for _, line := range bytes.Split(b, []byte("\n")) {
			var e Event
			if json.Unmarshal(line, &e) == nil {
				events = append(events, e)
			}
		}
		if len(events) > maxEvents {
			events = events[len(events)-maxEvents:]
		}
	}
	if b, err := os.ReadFile(filepath.Join(dataDir, "stale.json")); err == nil {
		_ = json.Unmarshal(b, &staleSeen)
	}
	if staleSeen == nil {
		staleSeen = map[string]time.Time{}
	}
}

func persist(fresh []Event) {
	if b, err := json.Marshal(prev); err == nil {
		_ = os.WriteFile(filepath.Join(dataDir, "snapshot.json"), b, 0o644)
	}
	if b, err := json.Marshal(staleSeen); err == nil {
		_ = os.WriteFile(filepath.Join(dataDir, "stale.json"), b, 0o644)
	}
	if len(fresh) == 0 {
		return
	}
	f, err := os.OpenFile(filepath.Join(dataDir, "activity.jsonl"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	for _, e := range fresh {
		b, _ := json.Marshal(e)
		f.Write(append(b, '\n'))
	}
}

// ---------- HTTP ----------

func serve(ln net.Listener) {
	mux := http.NewServeMux()
	mux.HandleFunc("/api/plans/status", handlePlanStatus)
	mux.HandleFunc("/api/plans/agent", handleReadOnlyAgent)
	mux.HandleFunc("/api/plans/executor", handleReadOnlyAgent)
	mux.HandleFunc("/api/plans/step-executor", handleReadOnlyAgent)
	icons, _ := fs.Sub(iconFiles, "web/icons")
	mux.Handle("/icons/", http.StripPrefix("/icons/", http.FileServer(http.FS(icons))))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(indexHTML)
	})
	mux.HandleFunc("/api/state", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		mu.Lock()
		ev := make([]Event, len(events))
		copy(ev, events)
		st := rawState
		reason := refreshError
		stale := map[string]bool{}
		for k, p := range prev {
			stale[k] = isStale(p, time.Now())
		}
		mu.Unlock()
		sort.SliceStable(ev, func(i, j int) bool { return ev[i].TS.After(ev[j].TS) })
		if len(ev) > maxEvents {
			ev = ev[:maxEvents]
		}
		evJSON, _ := json.Marshal(ev)
		if st == nil {
			st = []byte(`{"plans":[],"slots":{}}`)
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		reasonJSON, _ := json.Marshal(reason)
		staleJSON, _ := json.Marshal(stale)
		fmt.Fprintf(w, `{"state":%s,"activity":%s,"now":%q,"error":%s,"stale":%s}`, st, evJSON, time.Now().Format(time.RFC3339), reasonJSON, staleJSON)
	})
	mux.HandleFunc("/api/refresh", handleRefresh)
	mux.HandleFunc("/events", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		fl, ok := w.(http.Flusher)
		if !ok {
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		ch := make(chan struct{}, 1)
		mu.Lock()
		subs[ch] = true
		mu.Unlock()
		defer func() { mu.Lock(); delete(subs, ch); mu.Unlock() }()
		fmt.Fprint(w, "retry: 3000\n\n")
		fl.Flush()
		ping := time.NewTicker(25 * time.Second)
		defer ping.Stop()
		for {
			select {
			case <-r.Context().Done():
				return
			case <-ch:
				fmt.Fprint(w, "data: change\n\n")
				fl.Flush()
			case <-ping.C:
				fmt.Fprint(w, ": ping\n\n")
				fl.Flush()
			}
		}
	})
	server := &http.Server{Handler: localBoundary(mux), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	_ = server.Serve(ln)
}

func broadcast() {
	mu.Lock()
	defer mu.Unlock()
	for ch := range subs {
		select {
		case ch <- struct{}{}:
		default:
		}
	}
}

// ---------- window, notifications, tray ----------

func activationPlan(uri string) string {
	u, err := url.Parse(uri)
	if err != nil || u.Scheme != "krik-workboard" {
		return ""
	}
	return u.Query().Get("plan")
}
func planURI(repo, plan string) string {
	return "krik-workboard:open?" + url.Values{"plan": {repo + "/" + plan}}.Encode()
}
func openWindow() { openPlanWindow(activationPlan(activation)) }
func openPlanWindow(plan string) {
	target := "http://" + addr + "/"
	if plan != "" {
		target += "#plan=" + url.QueryEscape(plan)
	}
	for _, p := range []string{
		`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`,
		`C:\Program Files\Microsoft\Edge\Application\msedge.exe`,
	} {
		if _, err := os.Stat(p); err == nil {
			// Edge persists bounds in this dedicated profile after its first window closes.
			_ = exec.Command(p, "--user-data-dir="+filepath.Join(dataDir, "edge"), "--no-first-run", "--app="+target).Start()
			return
		}
	}
	_ = hidden(exec.Command("rundll32", "url.dll,FileProtocolHandler", target)).Start()
}
func protocolCommand(exe string) string { return `"` + exe + `" --activate "%1"` }

func registerProtocol() {
	exe, err := os.Executable()
	if err != nil {
		return
	}
	k, _, err := registry.CreateKey(registry.CURRENT_USER, `Software\Classes\krik-workboard`, registry.SET_VALUE|registry.CREATE_SUB_KEY)
	if err != nil {
		return
	}
	defer k.Close()
	_ = k.SetStringValue("", "URL:KRIK Workboard")
	_ = k.SetStringValue("URL Protocol", "")
	c, _, err := registry.CreateKey(k, `shell\open\command`, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer c.Close()
	_ = c.SetStringValue("", protocolCommand(exe))
}
func migrateStartup() {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	v, _, err := k.GetStringValue(runName)
	if err == nil && !strings.Contains(v, "--background") {
		_ = k.SetStringValue(runName, v+" --background")
	}
}

var notifyKinds = map[string]string{"waiting": "Cần bạn xử lý", "blocked": "Bị chặn", "stale": "Đứng im", "question": "Câu hỏi mới"}

func notify(fresh []Event) {
	for _, e := range fresh {
		title, ok := notifyKinds[e.Kind]
		if e.Kind == "execution-report" && strings.HasPrefix(e.Extra, "blocked:") {
			title, ok = notifyKinds["blocked"], true
		}
		if !ok || (e.Kind == "question" && e.Extra != "" && !strings.HasPrefix(strings.ToLower(e.Extra), "open")) {
			continue
		}
		body := e.Text
		if e.Kind == "waiting" {
			body = e.Extra
		}
		toast(title+" · "+e.Plan, body, planURI(e.Repo, e.Plan))
	}
}

func psq(s string) string { return strings.ReplaceAll(s, "'", "''") }

func toast(title, body, target string) {
	xml := fmt.Sprintf(`<toast activationType='protocol' launch='%s'><visual><binding template='ToastGeneric'><text>%s</text><text>%s</text></binding></visual></toast>`,
		xmlEsc(target), xmlEsc(title), xmlEsc(body))
	script := `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;` +
		`[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;` +
		`$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml('` + psq(xml) + `');` +
		`[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe').Show([Windows.UI.Notifications.ToastNotification]::new($x))`
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = hidden(exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script)).Run()
	}()
}

func xmlEsc(s string) string {
	var b bytes.Buffer
	for _, r := range s {
		switch r {
		case '<':
			b.WriteString("&lt;")
		case '>':
			b.WriteString("&gt;")
		case '&':
			b.WriteString("&amp;")
		case '"':
			b.WriteString("&quot;")
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

var mOpen, mRefresh, mStartup, mQuit *systray.MenuItem

func onReady() {
	systray.SetIcon(iconICO())
	systray.SetTitle("Agent Ops")
	systray.SetOnTapped(func() { openPlanWindow("") })
	mOpen = systray.AddMenuItem("Open Agent Ops", "")
	mRefresh = systray.AddMenuItem("Refresh now", "")
	systray.AddSeparator()
	mStartup = systray.AddMenuItemCheckbox("Start with Windows", "", startupEnabled())
	systray.AddSeparator()
	mQuit = systray.AddMenuItem("Quit", "")
	trayReady.Store(true)
	updateTray()
	go func() {
		for {
			select {
			case <-mOpen.ClickedCh:
				openPlanWindow("")
			case <-mRefresh.ClickedCh:
				refresh(false)
			case <-mStartup.ClickedCh:
				if mStartup.Checked() {
					setStartup(false)
					mStartup.Uncheck()
				} else {
					setStartup(true)
					mStartup.Check()
				}
			case <-mQuit.ClickedCh:
				systray.Quit()
				os.Exit(0)
			}
		}
	}()
	if !background || activation != "" {
		openWindow()
	}
}

func updateTray() {
	if !trayReady.Load() {
		return
	}
	mu.Lock()
	waiting, blocked := 0, 0
	for _, p := range prev {
		if strings.HasPrefix(strings.ToLower(p.Status), "waiting for owner") {
			waiting++
		}
		for _, q := range p.Questions {
			if q.Open {
				waiting++
			}
		}
		if strings.HasPrefix(strings.ToLower(p.Status), "blocked") {
			blocked++
		}
	}
	n := len(prev)
	mu.Unlock()
	systray.SetTooltip(fmt.Sprintf("Agent Ops · %d plans · %d waiting for you · %d blocked", n, waiting, blocked))
}

func startupEnabled() bool {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.QUERY_VALUE)
	if err != nil {
		return false
	}
	defer k.Close()
	_, _, err = k.GetStringValue(runName)
	return err == nil
}

func setStartup(on bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER, runKey, registry.SET_VALUE)
	if err != nil {
		return
	}
	defer k.Close()
	if on {
		exe, _ := os.Executable()
		_ = k.SetStringValue(runName, `"`+exe+`" --background`)
	} else {
		_ = k.DeleteValue(runName)
	}
}

// iconICO shares the prebuilt artwork with the window and executable.
func iconICO() []byte {
	data, _ := iconFiles.ReadFile("web/icons/app.ico")
	return data
}
