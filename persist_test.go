package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// persistFixture isolates the persisted stores in a temp data folder.
func persistFixture(t *testing.T) string {
	t.Helper()
	dir := isolated(t)
	oldData, oldPrev, oldEvents, oldStale, oldSeen, oldRaw, oldRepos := dataDir, prev, events, staleSeen, seenProjects, rawState, reposDir
	t.Cleanup(func() {
		dataDir, prev, events, staleSeen, seenProjects, rawState, reposDir = oldData, oldPrev, oldEvents, oldStale, oldSeen, oldRaw, oldRepos
	})
	dataDir, prev, events, staleSeen, seenProjects, rawState, reposDir = dir, nil, nil, nil, nil, nil, ""
	return dir
}

func put(t *testing.T, file, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// A crash can leave half-written stores; each one loads empty and the rest load.
func TestLoadPersistedToleratesHalfWrittenFiles(t *testing.T) {
	dir := persistFixture(t)
	ts := time.Date(2026, 11, 10, 9, 0, 0, 0, time.UTC)
	good, _ := json.Marshal(Event{TS: ts, Repo: "r", Plan: "p", Kind: "done", Text: "kept"})
	put(t, filepath.Join(dir, "activity.jsonl"), string(good)+"\n"+`{"ts":"2026-11-10T09:01:00Z","repo":"r","pl`)
	put(t, filepath.Join(dir, "snapshot.json"), `{"web/plan":{"repo":"web","name":"plan","sta`)
	put(t, filepath.Join(dir, "stale.json"), `{"a/b/c":"2026-`)
	put(t, filepath.Join(dir, "seen-projects.json"), `{"abc":tr`)
	put(t, filepath.Join(dir, "state.json"), `{"plans":[{"repo":"web"`)
	loadPersisted()
	if len(events) != 1 || events[0].Text != "kept" {
		t.Fatalf("events %+v", events)
	}
	if prev != nil || rawState != nil || len(staleSeen) != 0 || len(seenProjects) != 0 {
		t.Fatalf("partial stores must load empty: prev=%v raw=%s stale=%v seen=%v", prev, rawState, staleSeen, seenProjects)
	}
}

// A lost snapshot makes the next refresh seed history again; events already in
// the activity log are not written twice.
func TestSeedingSkipsEventsAlreadyLogged(t *testing.T) {
	persistFixture(t)
	ts := time.Date(2026, 11, 10, 9, 0, 0, 0, time.Local)
	logged := Event{TS: ts, Project: "p", Repo: "r", Plan: "plan", Kind: "decision", Text: "Use Go"}
	events = []Event{logged}
	again := logged
	fresh := Event{TS: ts.Add(time.Minute), Project: "p", Repo: "r", Plan: "plan", Kind: "decision", Text: "New"}
	got := withoutLogged([]Event{again, fresh})
	if len(got) != 1 || got[0].Text != "New" {
		t.Fatalf("%+v", got)
	}
}

func TestActivityLogIsCompactedWhenItGrowsTooLarge(t *testing.T) {
	dir := persistFixture(t)
	file := filepath.Join(dir, "activity.jsonl")
	// An old, oversized log: one huge line block that is no longer in memory.
	big := strings.Repeat(`{"ts":"2020-01-01T00:00:00Z","repo":"old","plan":"p","kind":"done","text":"`+strings.Repeat("x", 200)+`"}`+"\n", activityMaxBytes/220+10)
	put(t, file, big)
	staleSeen = map[string]time.Time{}
	events = []Event{{TS: time.Now(), Repo: "r", Plan: "p", Kind: "done", Text: "kept"}}
	persist([]Event{{TS: time.Now(), Repo: "r", Plan: "p", Kind: "done", Text: "fresh"}})
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) > 4096 || !bytes.Contains(b, []byte(`"kept"`)) || bytes.Contains(b, []byte(`"old"`)) {
		t.Fatalf("not compacted to the in-memory events: %d bytes", len(b))
	}
	// A start reads at most activityMaxBytes of a log another release left oversized.
	put(t, file, big)
	events = nil
	loadPersisted()
	if len(events) == 0 || len(events) > maxEvents {
		t.Fatalf("loaded %d events", len(events))
	}
}

func TestPersistPrunesStoresOfRemovedProjects(t *testing.T) {
	persistFixture(t)
	known := []Project{{ID: "keep", Path: `C:\keep`, Kind: "folder"}}
	staleSeen = map[string]time.Time{"keep/r/p": time.Now(), "gone/r/p": time.Now(), "legacy/p": time.Now()}
	seenProjects = map[string]bool{"keep": true}
	for i := 0; i < maxSeenProjects+20; i++ {
		seenProjects[strings.Repeat("x", 3)+string(rune('a'+i%26))+string(rune('a'+i/26))] = true
	}
	pruneStores(known)
	if _, ok := staleSeen["gone/r/p"]; ok {
		t.Error("stale entry of a removed project kept")
	}
	if _, ok := staleSeen["keep/r/p"]; !ok {
		t.Error("stale entry of a configured project dropped")
	}
	if _, ok := staleSeen["legacy/p"]; !ok {
		t.Error("legacy key dropped")
	}
	if len(seenProjects) > maxSeenProjects || !seenProjects["keep"] {
		t.Errorf("seen projects %d, keep=%v", len(seenProjects), seenProjects["keep"])
	}
}

func TestPersistWritesStoresAtomically(t *testing.T) {
	dir := persistFixture(t)
	prev = map[string]Plan{"p/r/plan": {Project: "p", Repo: "r", Name: "plan"}}
	staleSeen = map[string]time.Time{}
	seenProjects = map[string]bool{"p": true}
	persist(nil)
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	if strings.Join(names, ",") != "seen-projects.json,snapshot.json,stale.json" {
		t.Fatalf("files %v", names)
	}
	var snapshot map[string]Plan
	if b, _ := os.ReadFile(filepath.Join(dir, "snapshot.json")); json.Unmarshal(b, &snapshot) != nil || snapshot["p/r/plan"].Name != "plan" {
		t.Fatalf("snapshot %s", b)
	}
}
