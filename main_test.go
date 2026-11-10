package main

import (
	"encoding/json"
	"flag"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
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
	p.Slot = &struct{ By string }{"Slot owner"}
	if actor(p) != "Slot owner" {
		t.Fatal(actor(p))
	}
	p.Slot = nil
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
	oldRepos, oldSlots, oldState, oldScript, oldAddr, oldData, oldBackground, oldActivation := reposDir, slotsFile, stateFile, scriptFile, addr, dataDir, background, activation
	t.Cleanup(func() {
		os.Args = oldArgs
		flag.CommandLine = oldFlags
		reposDir, slotsFile, stateFile, scriptFile, addr, dataDir, background, activation = oldRepos, oldSlots, oldState, oldScript, oldAddr, oldData, oldBackground, oldActivation
	})
	for k, v := range map[string]string{"KRIK_REPOS_DIR": dir, "KRIK_SLOTS_FILE": filepath.Join(dir, "slots.json"), "KRIK_STATE_FILE": filepath.Join(dir, "state.json"), "KRIK_SCRIPT": filepath.Join(dir, "script.mjs"), "KRIK_ADDR": "127.0.0.1:17990"} {
		t.Setenv(k, v)
	}
	flag.CommandLine = flag.NewFlagSet("test", flag.ContinueOnError)
	os.Args = []string{"test", "--background", "--data-dir", dir, "--addr", "127.0.0.1:17991"}
	config()
	if reposDir != dir || slotsFile != filepath.Join(dir, "slots.json") || stateFile != filepath.Join(dir, "state.json") || scriptFile != filepath.Join(dir, "script.mjs") || addr != "127.0.0.1:17991" || !background || dataDir != dir {
		t.Fatal("overrides not applied")
	}
}
func TestRefreshLastGoodAndPersistence(t *testing.T) {
	dir := isolated(t)
	oldRepos, oldSlots, oldState, oldScript, oldData := reposDir, slotsFile, stateFile, scriptFile, dataDir
	t.Cleanup(func() {
		reposDir, slotsFile, stateFile, scriptFile, dataDir = oldRepos, oldSlots, oldState, oldScript, oldData
		prev = nil
		events = nil
		rawState = nil
		refreshError = ""
		staleSeen = map[string]time.Time{}
	})
	reposDir, slotsFile, stateFile, scriptFile, dataDir = dir, filepath.Join(dir, "slots.json"), filepath.Join(dir, "generated.json"), filepath.Join(dir, "script.mjs"), dir
	// The fake script verifies that flag values actually reach the subprocess environment.
	script := `import fs from 'node:fs'; if(process.env.KRIK_REPOS_DIR!==` + strconvQuote(dir) + ` || process.env.KRIK_SLOTS_FILE!==` + strconvQuote(slotsFile) + `)process.exit(9); fs.writeFileSync(process.env.KRIK_STATE_FILE, JSON.stringify({plans:[]}));`
	os.WriteFile(scriptFile, []byte(script), 0600)
	prev = nil
	events = nil
	rawState = nil
	refresh(true)
	if refreshError != "" || string(rawState) != "{\"plans\":[]}" {
		t.Fatalf("refresh: %s %s", refreshError, rawState)
	}
	good := string(rawState)
	os.WriteFile(scriptFile, []byte(`process.stderr.write('deliberate failure'); process.exit(7)`), 0600)
	refresh(true)
	if !strings.Contains(refreshError, "deliberate failure") || string(rawState) != good {
		t.Fatal(refreshError, string(rawState))
	}
	os.WriteFile(scriptFile, []byte(`import fs from 'node:fs'; fs.writeFileSync(process.env.KRIK_STATE_FILE, '{broken')`), 0600)
	refresh(true)
	if !strings.Contains(refreshError, "Invalid state JSON") || string(rawState) != good {
		t.Fatal(refreshError)
	}
	os.WriteFile(scriptFile, []byte(`import fs from 'node:fs'; fs.writeFileSync(process.env.KRIK_STATE_FILE, '{}')`), 0600)
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
	exe := `C:\Users\Owner Name\workboard\krik-workboard.exe`
	if got := protocolCommand(exe); got != `"`+exe+`" --activate "%1"` {
		t.Fatal(got)
	}
}

// testKey is the plan key produced for the --repos-dir override used by these tests.
func testKey(repo, plan string) string { return projectIDFor(reposDir) + "/" + repo + "/" + plan }
