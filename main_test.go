package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/krik-it-dept/agent-ops/internal/plans"
)

func isolated(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp(".", ".test-")
	if err != nil {
		t.Fatal(err)
	}
	dir, err = filepath.Abs(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	return dir
}
func fixture(steps ...Step) Plan {
	return Plan{Repo: "sample", Name: "plan", Owner: "Lan", Status: "Implementing", Mtime: time.Now(), Steps: steps, Milestones: []Milestone{{ID: "M1", Title: "Delivery", Steps: steps}}}
}
func one(p Plan) map[string]Plan { return map[string]Plan{planKey(p): p} }

// stateFixture is a repository folder with one plan, read through the real collector.
func stateFixture(t *testing.T) string {
	t.Helper()
	root := isolated(t)
	oldRepos, oldPrev, oldState, oldData := reposDir, prev, stateFile, dataDir
	oldRaw, oldEvents, oldError, oldStale := rawState, events, refreshError, staleSeen
	t.Cleanup(func() {
		reposDir, prev, stateFile, dataDir = oldRepos, oldPrev, oldState, oldData
		rawState, events, refreshError, staleSeen = oldRaw, oldEvents, oldError, oldStale
	})
	reposDir = root
	dir := filepath.Join(root, "sample", ".tasks")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "plan.md")
	if err := os.WriteFile(file, []byte("Next: Test\nStatus: Implementing - build UI\nOwner: Lan\n\n## M1: Delivery\n- [doing] Build\n- [todo] Test\n"), 0600); err != nil {
		t.Fatal(err)
	}
	dataDir = filepath.Join(root, "app-data")
	os.MkdirAll(dataDir, 0700)
	stateFile = filepath.Join(dataDir, "state.json")
	rawState, prev, events, refreshError, staleSeen = nil, nil, nil, "", map[string]time.Time{}
	return file
}
func kinds(events []Event) map[string]int {
	m := map[string]int{}
	for _, e := range events {
		m[e.Kind]++
	}
	return m
}
func TestDiff(t *testing.T) {
	cases := []struct {
		name   string
		change func(*Plan)
		want   map[string]int
	}{
		{"reworded step completed", func(p *Plan) {
			p.Steps = []Step{{Status: "done", Text: "Hoàn thành giao diện mới"}}
			p.Milestones[0].Steps = p.Steps
		}, map[string]int{"done": 1, "milestone": 1}},
		{"new decision", func(p *Plan) { p.Decisions = []Entry{{Text: "Use the existing design", Key: "202611090900"}} }, map[string]int{"decision": 1}},
		{"answered question", func(p *Plan) { p.Questions = []Entry{{Ask: "Ship today?", Answer: "Yes", Open: false}} }, map[string]int{"answer": 1}},
		{"milestone done", func(p *Plan) { p.Milestones[0].State = "done"; p.Milestones[0].Summary = "Evidence #1234" }, map[string]int{"milestone": 1}},
		{"unchanged", func(p *Plan) {}, map[string]int{}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			old := fixture(Step{Status: "doing", Text: "Xây dựng giao diện"})
			old.Questions = []Entry{{Ask: "Ship today?", Open: true}}
			b, _ := json.Marshal(old)
			var cur Plan
			json.Unmarshal(b, &cur)
			tc.change(&cur)
			got := diff(one(old), one(cur))
			if !reflect.DeepEqual(kinds(got), tc.want) {
				t.Fatalf("events: %+v; want %v", got, tc.want)
			}
			for _, e := range got {
				if e.Actor != "Lan" {
					t.Fatalf("wrong actor: %+v", e)
				}
			}
			if again := diff(one(cur), one(cur)); len(again) != 0 {
				t.Fatalf("duplicate events: %+v", again)
			}
		})
	}
	t.Run("closed plan", func(t *testing.T) {
		if got := kinds(diff(one(fixture()), map[string]Plan{})); !reflect.DeepEqual(got, map[string]int{"closed": 1}) {
			t.Fatal(got)
		}
	})
	t.Run("done rewording is silent", func(t *testing.T) {
		a := fixture(Step{Status: "done", Text: "Build UI"})
		b := fixture(Step{Status: "done", Text: "Deliver interface"})
		if got := diff(one(a), one(b)); len(got) != 0 {
			t.Fatal(got)
		}
	})
	t.Run("insertions and duplicate text", func(t *testing.T) {
		a := fixture(Step{Status: "done", Text: "Build UI"}, Step{Status: "todo", Text: "Test UI"}, Step{Status: "todo", Text: "Test UI"})
		b := fixture(Step{Status: "todo", Text: "New step"}, Step{Status: "done", Text: "Build UI"}, Step{Status: "done", Text: "Test UI"}, Step{Status: "todo", Text: "Test UI"})
		if got := kinds(diff(one(a), one(b))); !reflect.DeepEqual(got, map[string]int{"done": 1}) {
			t.Fatal(got)
		}
	})
	t.Run("same text across milestones", func(t *testing.T) {
		a := fixture(Step{Status: "done", Text: "Test"})
		a.Milestones = append(a.Milestones, Milestone{ID: "M2", Steps: []Step{{Status: "todo", Text: "Test"}}})
		a.Steps = append(a.Steps, Step{Status: "todo", Text: "Test"})
		b := fixture(Step{Status: "done", Text: "Test"}, Step{Status: "done", Text: "Test"})
		b.Milestones = []Milestone{{ID: "M1", Steps: b.Steps[:1]}, {ID: "M2", Steps: b.Steps[1:]}}
		if got := kinds(diff(one(a), one(b))); !reflect.DeepEqual(got, map[string]int{"done": 1, "milestone": 1}) {
			t.Fatal(got)
		}
	})
}
func TestActor(t *testing.T) {
	p := fixture()
	if actor(p) != "Lan" {
		t.Fatal(actor(p))
	}
	p.Owner = ""
	if actor(p) != "sample" {
		t.Fatal(actor(p))
	}
}
func TestSeed(t *testing.T) {
	p := fixture(Step{Status: "done", Text: "Done"})
	p.Milestones[0].Summary = "Proof"
	p.Decisions = []Entry{{Key: "202611090930", Text: "Dated"}, {Text: "Undated"}}
	p.Questions = []Entry{{Key: "202611089999", Ask: "Date only", Open: true}}
	ev := seed(one(p))
	if !reflect.DeepEqual(kinds(ev), map[string]int{"decision": 1, "question": 1, "milestone": 1}) {
		t.Fatal(ev)
	}
	if !ev[2].TS.Equal(p.Mtime) {
		t.Fatal("milestone must use mtime")
	}
	p.Milestones[0].Summary = ""
	if kinds(seed(one(p)))["milestone"] != 0 {
		t.Fatal("invented milestone evidence")
	}
}
func TestStaleBoundary(t *testing.T) {
	now := time.Now()
	for _, status := range []string{"Planning", "Implementing", "Reviewing", "Fixing review", "Testing"} {
		p := Plan{Status: status + " - detail", Mtime: now.Add(-staleAfter)}
		if !isStale(p, now) {
			t.Fatal(status)
		}
		if isStale(p, now.Add(-time.Nanosecond)) {
			t.Fatal("too early")
		}
	}
	for _, status := range []string{"Waiting for CI", "Waiting for owner", "Shipping", "Blocked", "Done", "Testing extra"} {
		if isStale(Plan{Status: status, Mtime: now.Add(-3 * time.Hour)}, now) {
			t.Fatal(status)
		}
	}
}
func TestActivation(t *testing.T) {
	want := "repo/plan tiếng Việt & #"
	if got := activationPlan(planURI("repo/plan tiếng Việt & #")); got != want {
		t.Fatal(got)
	}
	if activationPlan("https://example.com?plan=x") != "" {
		t.Fatal("wrong scheme")
	}
}
func TestConfigOverrides(t *testing.T) {
	dir := isolated(t)
	oldArgs, oldFlags := os.Args, flag.CommandLine
	oldRepos, oldState, oldAddr, oldData, oldBackground, oldActivation := reposDir, stateFile, addr, dataDir, background, activation
	t.Cleanup(func() {
		os.Args = oldArgs
		flag.CommandLine = oldFlags
		reposDir, stateFile, addr, dataDir, background, activation = oldRepos, oldState, oldAddr, oldData, oldBackground, oldActivation
	})
	for k, v := range map[string]string{"AGENT_OPS_REPOS_DIR": dir, "AGENT_OPS_STATE_FILE": filepath.Join(dir, "state.json"), "AGENT_OPS_ADDR": "127.0.0.1:17990"} {
		t.Setenv(k, v)
	}
	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = []string{"test", "--background", "--data-dir", dir, "--addr", "127.0.0.1:17991"}
	config()
	if reposDir != dir || stateFile != filepath.Join(dir, "state.json") || addr != "127.0.0.1:17991" || !background || dataDir != dir {
		t.Fatal("overrides not applied")
	}
}
func TestRefreshLastGoodAndPersistence(t *testing.T) {
	stateFixture(t)
	saved := collectPlans
	t.Cleanup(func() { collectPlans = saved })
	refresh(true)
	if refreshError != "" || !strings.Contains(string(rawState), `"name":"plan"`) {
		t.Fatalf("refresh: %s %s", refreshError, rawState)
	}
	if b, err := os.ReadFile(stateFile); err != nil || string(b) != string(rawState) {
		t.Fatal("the state file is not the served state", err)
	}
	good := string(rawState)
	collectPlans = func(context.Context, plans.Options) (*plans.Overview, error) {
		return nil, errors.New("deliberate failure")
	}
	refresh(true)
	if !strings.Contains(refreshError, "deliberate failure") || string(rawState) != good {
		t.Fatal(refreshError, string(rawState))
	}
	collectPlans = func(ctx context.Context, o plans.Options) (*plans.Overview, error) {
		overview, err := saved(ctx, o)
		overview.Plans = append(overview.Plans, overview.Plans...)
		return overview, err
	}
	refresh(true)
	if !strings.Contains(refreshError, "duplicate plan") || string(rawState) != good {
		t.Fatal(refreshError)
	}
	collectPlans = func(ctx context.Context, o plans.Options) (*plans.Overview, error) {
		overview, err := saved(ctx, o)
		overview.Plans = nil
		return overview, err
	}
	refresh(true)
	if !strings.Contains(refreshError, "plans must be an array") || string(rawState) != good {
		t.Fatal(refreshError)
	}
	rawState = nil
	prev = nil
	loadPersisted()
	if string(rawState) != good || prev == nil {
		t.Fatal("last good state not persisted")
	}
}

// A collection that hangs (an offline network drive) times out, and the next
// refresh does not start a second one while it still runs.
func TestRefreshTimesOutAHungCollector(t *testing.T) {
	stateFixture(t)
	saved := collectPlans
	t.Cleanup(func() { collectPlans = saved })
	release := make(chan struct{})
	calls := 0
	collectPlans = func(context.Context, plans.Options) (*plans.Overview, error) {
		calls++
		<-release
		return nil, errors.New("late")
	}
	start := time.Now()
	overview, err := runCollectorWithin(100 * time.Millisecond)
	if overview != nil || !errors.Is(err, context.DeadlineExceeded) || time.Since(start) > 5*time.Second {
		t.Fatal(overview, err)
	}
	if kind, _ := collectorFailure(err); kind != refreshKindTimeout {
		t.Fatal(kind)
	}
	if _, err := runCollectorWithin(100 * time.Millisecond); !errors.Is(err, errCollectorBusy) || calls != 1 {
		t.Fatal("a second collection started behind a hung one", err, calls)
	}
	close(release)
	for i := 0; i < 100 && collectorBusy.Load(); i++ {
		time.Sleep(10 * time.Millisecond)
	}
	collectPlans = saved
	if _, err := runCollectorWithin(10 * time.Second); err != nil {
		t.Fatal("the collector did not recover", err)
	}
}
func strconvQuote(s string) string { b, _ := json.Marshal(s); return string(b) }

func TestStaleOncePerEdit(t *testing.T) {
	now := time.Now()
	p := fixture()
	p.Mtime = now.Add(-3 * time.Hour)
	seen := map[string]time.Time{}
	if got := staleEvents(one(p), seen, now); len(got) != 1 {
		t.Fatal(got)
	}
	if got := staleEvents(one(p), seen, now.Add(time.Minute)); len(got) != 0 {
		t.Fatal("repeated toast", got)
	}
	p.Mtime = p.Mtime.Add(time.Minute)
	if got := staleEvents(one(p), seen, now); len(got) != 1 {
		t.Fatal("new edit must allow one toast", got)
	}
	staleEvents(map[string]Plan{}, seen, now)
	if len(seen) != 0 {
		t.Fatal("deleted plan retained")
	}
}
func TestInvalidPlanShape(t *testing.T) {
	if err := validateState(State{Plans: []Plan{{Repo: "repo", Name: "broken"}}}); err == nil {
		t.Fatal("incomplete plan accepted")
	}
	p := fixture()
	p.Decisions = []Entry{}
	p.Questions = []Entry{}
	p.Steps = []Step{}
	p.Milestones = []Milestone{}
	if err := validateState(State{Plans: []Plan{p}}); err != nil {
		t.Fatal(err)
	}
	if err := validateState(State{Plans: []Plan{p, p}}); err == nil {
		t.Fatal("duplicate plan accepted")
	}
}

func TestProtocolCommand(t *testing.T) {
	exe := `C:\Users\Owner Name\Agent Ops\agent-ops.exe`
	if got := protocolCommand(exe); got != `"`+exe+`" --activate "%1"` {
		t.Fatal(got)
	}
}

// testKey is the plan key produced for the --repos-dir override used by these tests.
func testKey(repo, plan string) string { return projectIDFor(reposDir) + "/" + repo + "/" + plan }
