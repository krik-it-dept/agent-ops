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
	"errors"
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
	"unicode/utf8"

	"fyne.io/systray"
	"golang.org/x/sys/windows/registry"
)

var (
	addr = "127.0.0.1:7790"
	// reposDir is set only by --repos-dir or KRIK_REPOS_DIR and then replaces the
	// configured projects for this run. stateFile and slotsFile fall back to config.json.
	reposDir   string
	slotsFile  string
	stateFile  string
	scriptFile = defaultCollector()
	// Values given by flag or environment; restarts preserve exactly these.
	explicitRepos, explicitState, explicitSlots bool
	// Legacy built-in paths received as launch values; used only for migration.
	legacyLaunch legacyPaths
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
	Project             string               `json:"project,omitempty"`
	ProjectName         string               `json:"projectName,omitempty"`
	Root                string               `json:"root,omitempty"`
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
	Plans    []Plan         `json:"plans"`
	Projects []ProjectState `json:"projects"`
}

// ProjectState is the collector's result for one enabled project.
type ProjectState struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Status  string `json:"status"` // ok, missing or error
	Message string `json:"message,omitempty"`
	Repos   int    `json:"repos"`
	Plans   int    `json:"plans"`
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
	return Event{TS: r.At, Project: p.Project, Repo: p.Repo, Plan: p.Name, Kind: "execution-report", Text: r.Task.Text, Extra: r.Event + ": " + r.Result, Actor: r.Agent, Agent: r.Coordinator, Executors: []string{r.Agent}}
}

type Event struct {
	Executors []string  `json:"executors"`
	Agent     string    `json:"agent,omitempty"`
	TS        time.Time `json:"ts"`
	Project   string    `json:"project,omitempty"`
	Repo      string    `json:"repo"`
	Plan      string    `json:"plan"`
	Kind      string    `json:"kind"` // new, closed, status, done, blocked, partial, decision, question, answer, milestone, waiting, stale
	Text      string    `json:"text"`
	Extra     string    `json:"extra,omitempty"`
	Actor     string    `json:"actor"`
}

var (
	mu                  sync.Mutex
	rawState            []byte
	prev                map[string]Plan
	events              []Event
	staleSeen           = map[string]time.Time{}
	subs                = map[chan struct{}]bool{}
	dataDir             string
	refreshMu           sync.Mutex
	refreshError        string
	refreshErrorKind    string
	background          bool
	activation          string
	trayReady           atomic.Bool
	profileDir          string
	disableUpdateChecks bool
	printVersion        bool
	applyUpdateFile     string
	updateFeed          string
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
	flag.StringVar(&reposDir, "repos-dir", "", "Folder of repositories; replaces the configured projects for this run")
	flag.StringVar(&slotsFile, "slots-file", "", "Optional slots JSON file")
	flag.StringVar(&stateFile, "state-file", "", `Generated state JSON file (default <data-dir>\state\tong-hop-chung.json)`)
	flag.StringVar(&scriptFile, "script", env("KRIK_SCRIPT", scriptFile), "Overview Node script")
	flag.StringVar(&addr, "addr", env("KRIK_ADDR", addr), "Loopback listen address")
	flag.StringVar(&dataDir, "data-dir", filepath.Join(os.Getenv("LOCALAPPDATA"), "krik-workboard"), "Persistence directory")
	flag.BoolVar(&background, "background", false, "Start tray without opening a window")
	flag.StringVar(&activation, "activate", "", "Toast activation URI")
	home, _ := os.UserHomeDir()
	flag.StringVar(&profileDir, "profile-dir", home, "Profile whose managed reporting instructions are updated")
	flag.BoolVar(&disableUpdateChecks, "no-update-check", false, "Disable automatic release checks (manual checks remain available)")
	flag.BoolVar(&printVersion, "version", false, "Print the application version and exit")
	flag.StringVar(&applyUpdateFile, "apply-update", "", "Internal verified update-helper manifest")
	flag.StringVar(&updateFeed, "update-feed", "", "Loopback http://127.0.0.1:<port> release feed for isolated update tests")
	flag.Parse()
	// Precedence: flag > environment > config.json (applied by initSettings) > default.
	given := map[string]bool{}
	flag.Visit(func(f *flag.Flag) { given[f.Name] = true })
	for _, item := range []struct {
		name, env string
		value     *string
	}{{"repos-dir", "KRIK_REPOS_DIR", &reposDir}, {"slots-file", "KRIK_SLOTS_FILE", &slotsFile}, {"state-file", "KRIK_STATE_FILE", &stateFile}} {
		if !given[item.name] {
			*item.value = os.Getenv(item.env)
		}
	}
	// Restarting from a staging helper must preserve the resolved configuration,
	// including when the original launch used relative paths.
	for _, value := range []*string{&reposDir, &slotsFile, &stateFile, &scriptFile, &dataDir, &profileDir} {
		if *value == "" {
			continue
		}
		if absolute, err := filepath.Abs(*value); err == nil {
			*value = absolute
		}
	}
	// Releases before config.json always passed their built-in paths as flags, and an
	// in-app update relaunches with the previous release's arguments. Those values are
	// not user overrides: they only feed migration and are never passed on again.
	legacyLaunch = legacyPaths{}
	for _, item := range []struct {
		value     *string
		legacy    string
		migration *string
	}{{&reposDir, legacyDefaults.repos, &legacyLaunch.repos}, {&stateFile, legacyDefaults.state, &legacyLaunch.state}, {&slotsFile, legacyDefaults.slots, &legacyLaunch.slots}} {
		if *item.value != "" && samePath(*item.value, item.legacy) {
			*item.migration, *item.value = *item.value, ""
		}
	}
	explicitRepos, explicitState, explicitSlots = reposDir != "", stateFile != "", slotsFile != ""
}

func samePath(a, b string) bool {
	return a != "" && b != "" && strings.EqualFold(filepath.Clean(a), filepath.Clean(b))
}

// launchArgs are the arguments a restart or in-app update relaunches with. Only
// values given by flag or environment are passed on; everything else comes from
// config.json, so a restart never pins the current config into flags.
func launchArgs() []string {
	args := []string{"--background", "--addr", addr, "--script", scriptFile, "--data-dir", dataDir, "--profile-dir", profileDir}
	if explicitRepos {
		args = append(args, "--repos-dir", reposDir)
	}
	if explicitState {
		args = append(args, "--state-file", stateFile)
	}
	if explicitSlots {
		args = append(args, "--slots-file", slotsFile)
	}
	if disableUpdateChecks {
		args = append(args, "--no-update-check")
	}
	if updateFeed != "" && validUpdateFeed(updateFeed) {
		args = append(args, "--update-feed", updateFeed)
	}
	return args
}

func main() {
	config()
	if printVersion {
		fmt.Println(appVersion)
		return
	}
	if applyUpdateFile != "" {
		if err := applyUpdateManifest(applyUpdateFile); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
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
	if err := initLogging(dataDir, "agent-ops.log"); err == nil {
		initCrashOutput()
	}
	defer func() {
		if v := recover(); v != nil {
			recordPanic("main", v)
			os.Exit(2)
		}
	}()
	logInfo("agent ops started", "version", appVersion, "commit", appCommit, "pid", os.Getpid(), "addr", addr, "dataDir", dataDir, "background", background, "updateChecks", !disableUpdateChecks)
	if defaultInstance() {
		registerProtocol()
		migrateStartup()
		_ = registerToastApp(dataDir)
	}
	initSettings()
	loadPersisted()
	exe, _ := os.Executable()
	updates = newAppUpdater(filepath.Dir(exe), dataDir, profileDir, launchArgs())
	if updateFeed != "" {
		if validUpdateFeed(updateFeed) {
			updates.useFeed(updateFeed)
			logInfo("using a loopback update feed", "feed", updateFeed)
		} else {
			logWarn("ignored an update feed that is not a loopback http origin")
		}
	}
	safeGo("prune update staging", func() { pruneUpdateStages(filepath.Join(dataDir, "updates"), updateStagesKept) })
	refresh(true)
	safeGo("http server", func() { serve(ln) })
	superviseGo("watch", watch)
	if !disableUpdateChecks {
		superviseGo("update schedule", func() {
			time.Sleep(3 * time.Second)
			updates.startInitialCheck()
			ticker := time.NewTicker(6 * time.Hour)
			defer ticker.Stop()
			for range ticker.C {
				updates.startCheck()
			}
		})
	}
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
	for _, p := range effectiveProjects() {
		repos, err := projectRepos(p)
		// A project appearing or disappearing (drive unplugged, folder renamed) changes the signature.
		fmt.Fprintf(h, "project|%s|%v|%d\n", p.ID, err == nil, len(repos))
		for _, repo := range repos {
			for _, f := range planFiles(repo.Path) {
				if st, err := os.Stat(f); err == nil {
					fmt.Fprintf(h, "%s|%d|%d\n", f, st.Size(), st.ModTime().UnixNano())
				}
			}
		}
	}
	if slotsFile != "" {
		if st, err := os.Stat(slotsFile); err == nil {
			fmt.Fprintf(h, "slots|%d|%d\n", st.Size(), st.ModTime().UnixNano())
		}
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
		failed := refreshError != ""
		mu.Unlock()
		// Retry a failed collector every 10 s, but never while there is nothing to collect.
		retry := failed && ticks%5 == 0 && len(effectiveProjects()) > 0
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

// planKey identifies a plan across projects; two repositories with the same folder
// name in different projects stay distinct. Plans from before projects keep repo/plan.
func planKey(p Plan) string {
	if p.Project != "" {
		return p.Project + "/" + p.Repo + "/" + p.Name
	}
	return p.Repo + "/" + p.Name
}

// collectorCommand runs tasks-overview.mjs. AGENT_OPS_CONFIG points every Node
// helper at the same config.json; explicit overrides are passed as flags.
func collectorCommand(ctx context.Context) *exec.Cmd {
	args := []string{scriptFile, "--state-file", stateFile}
	overrides := map[string]string{"AGENT_OPS_CONFIG": configFilePath(dataDir), "KRIK_STATE_FILE": stateFile, "KRIK_TASKS_OUT_DIR": filepath.Dir(stateFile), "KRIK_SLOTS_FILE": "", "KRIK_REPOS_DIR": ""}
	if slotsFile != "" {
		args = append(args, "--slots-file", slotsFile)
		overrides["KRIK_SLOTS_FILE"] = slotsFile
	}
	if reposDir != "" {
		args = append(args, "--repos-dir", reposDir)
		overrides["KRIK_REPOS_DIR"] = reposDir
	}
	cmd := hidden(exec.CommandContext(ctx, "node", args...))
	for _, v := range os.Environ() {
		k, _, _ := strings.Cut(v, "=")
		if _, ok := overrides[strings.ToUpper(k)]; !ok {
			cmd.Env = append(cmd.Env, v)
		}
	}
	for k, v := range overrides {
		if v != "" {
			cmd.Env = append(cmd.Env, k+"="+v)
		}
	}
	return cmd
}

// Fixed refresh failure categories. Diagnostics and the log record only these,
// never the reason text, which can quote plan files, project names or paths.
const (
	refreshKindStateFolder   = "state folder"
	refreshKindNodeMissing   = "node missing"
	refreshKindTimeout       = "timeout"
	refreshKindCollector     = "collector failed"
	refreshKindStateRead     = "state unreadable"
	refreshKindStateInvalid  = "state invalid"
	refreshKindProjectFailed = "project unreadable"
)

func collectorFailure(err error, output []byte) (kind, reason string) {
	if errors.Is(err, exec.ErrNotFound) {
		return refreshKindNodeMissing, "Node.js was not found. Install Node.js 24, then restart Agent Ops."
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return refreshKindTimeout, "Reading plans took longer than 30 seconds and was stopped. Retry, or disable a large project in Settings."
	}
	reason = strings.TrimSpace(string(output))
	if len(reason) > 400 {
		reason = reason[:400]
	}
	return refreshKindCollector, strings.TrimSpace(fmt.Sprintf("Node failed: could not read plans (%v). %s", err, reason))
}

var (
	// Projects whose plans were part of the last successful refresh. Plans of a
	// project that appears are seeded quietly; plans of one that disappears are
	// dropped quietly, so adding or removing a project never floods the activity feed.
	lastProjects map[string]bool
	// Projects whose history has been seeded into the activity log once. A project
	// that returns (re-enabled, or its drive reconnected) is not seeded again, so
	// toggling it never duplicates history. Persisted in seen-projects.json.
	seenProjects map[string]bool
	// Per-project results of the last collector run.
	projectStates []ProjectState
)

func refresh(first bool) {
	refreshMu.Lock()
	defer refreshMu.Unlock()
	if updateRestarting.Load() {
		return
	}
	var st State
	var raw []byte
	if len(effectiveProjects()) == 0 {
		// Nothing to collect: no Node process, no error, an empty board.
		st = State{Plans: []Plan{}, Projects: []ProjectState{}}
		raw = []byte(`{"generatedAt":"` + time.Now().UTC().Format(time.RFC3339) + `","slots":{},"projects":[],"plans":[]}`)
	} else {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		if err := os.MkdirAll(filepath.Dir(stateFile), 0o755); err != nil {
			setRefreshError(refreshKindStateFolder, "Cannot create the state folder "+filepath.Dir(stateFile)+": "+err.Error())
			return
		}
		output, err := collectorCommand(ctx).CombinedOutput()
		if err != nil {
			if ctx.Err() != nil {
				err = ctx.Err()
			}
			setRefreshError(collectorFailure(err, output))
			return
		}
		raw, err = os.ReadFile(stateFile)
		if err != nil {
			setRefreshError(refreshKindStateRead, "Read state: "+err.Error())
			return
		}
		if err := json.Unmarshal(raw, &st); err != nil {
			setRefreshError(refreshKindStateInvalid, "Invalid state JSON: "+err.Error())
			return
		}
		if err := validateState(st); err != nil {
			setRefreshError(refreshKindStateInvalid, "Invalid state JSON: "+err.Error())
			return
		}
		// A project that exists but cannot be read keeps the last good state.
		failed, first := 0, ProjectState{}
		for _, ps := range st.Projects {
			if ps.Status == "error" {
				if failed == 0 {
					first = ps
				}
				failed++
			}
		}
		if failed > 0 {
			setRefreshError(fmt.Sprintf("%s (%d)", refreshKindProjectFailed, failed), "Could not read project “"+first.Name+"” ("+first.Path+"): "+first.Message)
			return
		}
	}
	readable := map[string]bool{}
	for _, ps := range st.Projects {
		if ps.Status == "ok" {
			readable[ps.ID] = true
		}
	}
	mu.Lock()
	rawState = raw
	refreshError, refreshErrorKind = "", ""
	projectStates = st.Projects
	_ = os.WriteFile(filepath.Join(dataDir, "state.json"), raw, 0o644)
	cur := map[string]Plan{}
	for _, p := range st.Plans {
		cur[planKey(p)] = p
	}
	var fresh, quiet []Event
	if prev != nil {
		before, changed, added := map[string]Plan{}, map[string]Plan{}, map[string]Plan{}
		for k, p := range prev {
			if p.Project == "" || (readable[p.Project] && (lastProjects == nil || lastProjects[p.Project])) {
				before[k] = p
			}
		}
		for k, p := range cur {
			if p.Project == "" || lastProjects == nil || lastProjects[p.Project] {
				changed[k] = p
			} else if !seenProjects[p.Project] {
				added[k] = p
			}
		}
		fresh = diff(before, changed)
		quiet = seed(added)
	} else {
		quiet = seed(cur)
	}
	if seenProjects == nil {
		seenProjects = map[string]bool{}
	}
	for id := range readable {
		seenProjects[id] = true
	}
	// Plans that appear in this refresh (a project added or enabled, or a first run
	// with no snapshot) are logged as stale once but never announced: the owner
	// picked the folder, they did not just stop working on 15 plans.
	quietStale := map[string]bool{}
	for k, p := range cur {
		if prev == nil || (p.Project != "" && lastProjects != nil && !lastProjects[p.Project]) {
			quietStale[k] = true
		}
	}
	lastProjects = readable
	prev = cur
	all := append(append([]Event{}, quiet...), fresh...)
	events = append(events, all...)
	if len(events) > maxEvents {
		events = events[len(events)-maxEvents:]
	}
	persist(all)
	staleNotices := recordStale(quietStale)
	mu.Unlock()
	if len(staleNotices) > 0 {
		notify(staleNotices)
		broadcast()
	}
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
		key := planKey(p)
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

// setRefreshError records a failed refresh. kind is a fixed category (see
// refreshKind*); reason is shown to the owner in the app but is never logged or
// copied into diagnostics because it can quote plan text, project names and paths.
func setRefreshError(kind, reason string) {
	if reason == "" {
		kind = ""
	}
	mu.Lock()
	changed := refreshError != reason
	refreshError, refreshErrorKind = reason, kind
	mu.Unlock()
	if changed {
		if reason != "" {
			logWarn("plan refresh failed", "category", kind, "reasonBytes", len(reason))
		} else {
			logInfo("plan refresh recovered")
		}
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
				out = append(out, Event{TS: t, Project: p.Project, Repo: p.Repo, Plan: p.Name, Kind: "decision", Text: d.Text, Extra: d.When, Actor: actor(p), Agent: p.Agent})
			}
		}
		for _, q := range p.Questions {
			if t, ok := entryTime(q); ok {
				out = append(out, Event{TS: t, Project: p.Project, Repo: p.Repo, Plan: p.Name, Kind: "question", Text: q.Ask, Extra: q.Answer, Actor: actor(p), Agent: p.Agent})
			}
		}
		for _, m := range p.Milestones {
			if msDone(m) && strings.TrimSpace(m.Summary) != "" {
				out = append(out, Event{TS: p.Mtime, Project: p.Project, Repo: p.Repo, Plan: p.Name, Kind: "milestone", Text: m.ID + ": " + m.Title, Extra: m.Summary, Actor: actor(p), Agent: p.Agent})
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
		out = append(out, Event{TS: now, Project: p.Project, Repo: p.Repo, Plan: p.Name, Kind: kind, Text: text, Extra: extra, Actor: actor(p), Agent: p.Agent, Executors: p.Executors})
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
			out = append(out, Event{TS: now, Project: o.Project, Repo: o.Repo, Plan: o.Name, Kind: "closed", Text: "Đóng plan", Actor: actor(o)})
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
	fresh, _ := staleEventsQuiet(cur, seen, now, nil)
	return fresh
}

// staleEventsQuiet returns every new stale event and, of those, the ones to
// announce: plans named in quiet are recorded as seen but not announced.
func staleEventsQuiet(cur map[string]Plan, seen map[string]time.Time, now time.Time, quiet map[string]bool) (fresh, announce []Event) {
	// Plans of a project that is not read now (disabled or disconnected) keep their
	// entry, so a returning project does not announce the same stale work again.
	read := map[string]bool{}
	for _, p := range cur {
		read[p.Project] = true
	}
	for k := range seen {
		if _, ok := cur[k]; ok {
			continue
		}
		if project, rest, _ := strings.Cut(k, "/"); strings.Contains(rest, "/") && !read[project] {
			continue
		}
		delete(seen, k)
	}
	for k, p := range cur {
		if !isStale(p, now) {
			continue
		}
		if t, ok := seen[k]; ok && t.Equal(p.Mtime) {
			continue
		}
		seen[k] = p.Mtime
		e := Event{TS: now, Project: p.Project, Repo: p.Repo, Plan: p.Name, Kind: "stale", Text: fmt.Sprintf("Đứng im %d phút khi đang %s", int(now.Sub(p.Mtime).Minutes()), stage(p.Status)), Actor: "Workboard"}
		fresh = append(fresh, e)
		if !quiet[k] {
			announce = append(announce, e)
		}
	}
	return fresh, announce
}

// recordStale logs the plans that went stale since the last check, with mu held,
// and returns the ones to announce. Plans in quiet are logged without a notice.
func recordStale(quiet map[string]bool) []Event {
	fresh, announce := staleEventsQuiet(prev, staleSeen, time.Now(), quiet)
	events = append(events, fresh...)
	if len(events) > maxEvents {
		events = events[len(events)-maxEvents:]
	}
	if len(fresh) > 0 {
		persist(fresh)
	}
	return announce
}
func checkStale() {
	mu.Lock()
	announce := recordStale(nil)
	mu.Unlock()
	if len(announce) > 0 {
		notify(announce)
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
	_ = upgradeActivityFile(knownProjects())
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
	seenProjects = map[string]bool{}
	if b, err := os.ReadFile(filepath.Join(dataDir, "seen-projects.json")); err == nil {
		_ = json.Unmarshal(b, &seenProjects)
	}
	mapLegacyKeys(knownProjects())
}

func persist(fresh []Event) {
	if b, err := json.Marshal(prev); err == nil {
		_ = os.WriteFile(filepath.Join(dataDir, "snapshot.json"), b, 0o644)
	}
	if b, err := json.Marshal(staleSeen); err == nil {
		_ = os.WriteFile(filepath.Join(dataDir, "stale.json"), b, 0o644)
	}
	if b, err := json.Marshal(seenProjects); err == nil && seenProjects != nil {
		_ = os.WriteFile(filepath.Join(dataDir, "seen-projects.json"), b, 0o644)
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
	updateRoutes(mux)
	settingsRoutes(mux)
	diagnosticsRoutes(mux)
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
	mux.HandleFunc("/api/state", handleState)
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
	server := &http.Server{Handler: localBoundary(recoverHandler(mux)), ReadHeaderTimeout: 5 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 16 << 10}
	_ = server.Serve(ln)
}

func handleState(w http.ResponseWriter, r *http.Request) {
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
	summaries := projectSummaries()
	warnings := stateWarnings(summaries)
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
	projectsJSON, _ := json.Marshal(summaries)
	warningsJSON, _ := json.Marshal(warnings)
	crashJSON, _ := json.Marshal(crashNotice())
	fmt.Fprintf(w, `{"appVersion":%q,"state":%s,"activity":%s,"now":%q,"error":%s,"stale":%s,"setupRequired":%t,"projects":%s,"warnings":%s,"crash":%s}`, appVersion, st, evJSON, time.Now().Format(time.RFC3339), reasonJSON, staleJSON, setupRequired(), projectsJSON, warningsJSON, crashJSON)
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
func planURI(key string) string {
	return "krik-workboard:open?" + url.Values{"plan": {key}}.Encode()
}
func eventKey(e Event) string {
	if e.Project != "" {
		return e.Project + "/" + e.Repo + "/" + e.Plan
	}
	return e.Repo + "/" + e.Plan
}
func openWindow() { openPlanWindow(activationPlan(activation)) }
func openPlanWindow(plan string) {
	fragment := ""
	if plan != "" {
		fragment = "plan=" + url.QueryEscape(plan)
	}
	openWindowAt(fragment)
}
func openWindowAt(fragment string) {
	target := "http://" + addr + "/"
	if fragment != "" {
		target += "#" + fragment
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
		_ = k.SetStringValue(runName, strings.TrimSpace(v)+" --background")
	}
}

var notifyKinds = map[string]string{"waiting": "Cần bạn xử lý", "blocked": "Bị chặn", "stale": "Đứng im", "question": "Câu hỏi mới"}

func notify(fresh []Event) {
	if !notificationsEnabled() {
		return
	}
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
		showToast(title+" · "+e.Plan, body, planURI(eventKey(e)))
	}
}

// The toast script is a constant: plan text (written by agents, or committed in a
// cloned repository) only reaches PowerShell as data in an environment variable,
// never as script text. PowerShell treats typographic quotes as string delimiters,
// so escaping quotes inside a script string is not a safe alternative.
const (
	toastEnv        = "AGENT_OPS_TOAST"
	toastLoadScript = `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null;` +
		`[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null;` +
		`$x = New-Object Windows.Data.Xml.Dom.XmlDocument; $x.LoadXml([Environment]::GetEnvironmentVariable('` + toastEnv + `'));`
)

// toastShowScript shows $x under one of two AUMIDs fixed in this program (the
// registered app or PowerShell's), never under text that came from a plan.
func toastShowScript(appID string) string {
	if appID != toastAppID {
		appID = powershellAppID
	}
	return `[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('` + appID + `').Show([Windows.UI.Notifications.ToastNotification]::new($x))`
}

func toastXML(title, body, target string) string {
	return `<toast activationType="protocol" launch="` + xmlEsc(target) + `"><visual><binding template="ToastGeneric"><text>` +
		xmlEsc(title) + `</text><text>` + xmlEsc(body) + `</text></binding></visual></toast>`
}

// toastCommand runs script with the toast XML in its environment.
func toastCommand(ctx context.Context, script, xml string) *exec.Cmd {
	cmd := hidden(exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", script))
	for _, v := range os.Environ() {
		if k, _, _ := strings.Cut(v, "="); !strings.EqualFold(k, toastEnv) {
			cmd.Env = append(cmd.Env, v)
		}
	}
	cmd.Env = append(cmd.Env, toastEnv+"="+xml)
	return cmd
}

// showToast is the notification seam; tests replace it to count notices.
var showToast = toast

func toast(title, body, target string) {
	xml := toastXML(title, body, target)
	safeGo("toast", func() {
		ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := toastCommand(ctx, toastLoadScript+toastShowScript(currentToastAppID()), xml).Run(); err != nil {
			logWarn("notification failed", "error", err.Error())
		}
	})
}

// xmlEsc escapes markup and every quote character, drops characters XML 1.0
// cannot carry, and caps the length so the environment block stays small.
func xmlEsc(s string) string {
	var b strings.Builder
	n := 0
	for _, r := range s {
		if n++; n > 1000 {
			b.WriteString("…")
			break
		}
		switch {
		case r == '<':
			b.WriteString("&lt;")
		case r == '>':
			b.WriteString("&gt;")
		case r == '&':
			b.WriteString("&amp;")
		case r == '"':
			b.WriteString("&quot;")
		case r == '\'':
			b.WriteString("&apos;")
		case r >= 0x2018 && r <= 0x201F:
			fmt.Fprintf(&b, "&#x%X;", r)
		case r == '\t' || r == '\n' || r == '\r':
			b.WriteRune(r)
		case r < 0x20 || r == 0xFFFE || r == 0xFFFF || r == utf8.RuneError:
			continue
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}

var mOpen, mRefresh, mSettings, mStartup, mQuit *systray.MenuItem

func onReady() {
	trayTheme := taskbarIconName()
	systray.SetIcon(trayIcon(trayTheme))
	systray.SetTitle("Agent Ops")
	systray.SetOnTapped(func() { openPlanWindow("") })
	mOpen = systray.AddMenuItem("Open Agent Ops", "")
	mRefresh = systray.AddMenuItem("Refresh now", "")
	mSettings = systray.AddMenuItem("Settings…", "Projects, notifications and startup")
	systray.AddSeparator()
	mStartup = systray.AddMenuItemCheckbox("Start with Windows", "", startupEnabled())
	systray.AddSeparator()
	mQuit = systray.AddMenuItem("Quit", "")
	trayReady.Store(true)
	updateTray()
	superviseGo("tray menu", func() {
		ticker := time.NewTicker(30 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if next := taskbarIconName(); next != trayTheme {
					trayTheme = next
					systray.SetIcon(trayIcon(trayTheme))
				}
			case <-mOpen.ClickedCh:
				openPlanWindow("")
			case <-mRefresh.ClickedCh:
				refresh(false)
			case <-mSettings.ClickedCh:
				openWindowAt("settings")
			case <-mStartup.ClickedCh:
				setStartup(!mStartup.Checked())
				syncStartupMenu()
			case <-mQuit.ClickedCh:
				logInfo("quit from the tray")
				systray.Quit()
				os.Exit(0)
			}
		}
	})
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
