package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func agentStateFixture(t *testing.T) string {
	t.Helper()
	path, _ := statusFixture(t)
	oldState, oldScript, oldSlots, oldData := stateFile, scriptFile, slotsFile, dataDir
	oldRaw, oldEvents, oldError, oldStale := rawState, events, refreshError, staleSeen
	t.Cleanup(func() {
		stateFile, scriptFile, slotsFile, dataDir = oldState, oldScript, oldSlots, oldData
		rawState, events, refreshError, staleSeen = oldRaw, oldEvents, oldError, oldStale
	})
	dataDir = filepath.Join(reposDir, "app-data")
	os.MkdirAll(dataDir, 0700)
	stateFile = filepath.Join(dataDir, "state.json")
	scriptFile, _ = filepath.Abs("tasks-overview.mjs")
	slotsFile = filepath.Join(dataDir, "slots.json")
	os.WriteFile(slotsFile, []byte("{}"), 0600)
	rawState, prev, events, refreshError, staleSeen = nil, nil, nil, "", map[string]time.Time{}
	return path
}

func TestAgentMetadata(t *testing.T) {
	path := agentStateFixture(t)
	dir := filepath.Dir(path)
	cases := []struct{ name, header, want, source string }{
		{"explicit", "Agent: Codex\n", "Codex", "Agent header"},
		{"anti", "Agent: Google Antigravity\n", "Anti", "Agent header"},
		{"owner", "Owner: Claude Code\n", "Claude", "Owner header"},
		{"slot-plan", "", "Claude", "Slot agent"},
		{"plain", "", "Unknown", "Not specified"},
		{"ambiguous", "Agent: Codex + Claude\n", "Unknown", "Agent header"},
		{"unknown", "Agent: Unknown\nOwner: Claude Code\n", "Unknown", "Agent header"},
	}
	for _, tc := range cases {
		// Tool names in a task description are not evidence of assignment.
		os.WriteFile(filepath.Join(dir, tc.name+".md"), []byte(tc.header+"Status: Implementing - discuss Codex and Claude\n\n- [todo] Test\n"), 0600)
	}
	os.WriteFile(slotsFile, []byte("{\"A\":{\"task\":\"slot-plan\",\"by\":\"slot-plan\",\"agent\":\"Claude\"}}"), 0600)
	refresh(true)
	if refreshError != "" {
		t.Fatal(refreshError)
	}
	for _, tc := range cases {
		p := prev["sample/"+tc.name]
		if p.Agent != tc.want || p.AgentSource != tc.source {
			t.Fatalf("%s: %s (%s); want %s (%s)", tc.name, p.Agent, p.AgentSource, tc.want, tc.source)
		}
	}
}

func TestAgentSnapshotUpgrade(t *testing.T) {
	before := fixture()
	after := fixture()
	after.Agent = "Unknown"
	if got := diff(one(before), one(after)); len(got) != 0 {
		t.Fatal("upgrading an old snapshot invented assignment events", got)
	}
}

func TestHistoricalAttribution(t *testing.T) {
	path := agentStateFixture(t)
	original, _ := os.ReadFile(path)
	mapping := filepath.Join(dataDir, "agent-map.json")
	entry := map[string]any{
		"file": path, "revision": revisionOf(original), "agent": "Claude",
		"evidence": map[string]string{"session": "verified", "callId": "verified", "confirmedAt": "2026-11-09T02:50:03Z"},
	}
	mapped, _ := json.Marshal(map[string]any{"version": 1, "records": []any{entry}})
	os.WriteFile(mapping, mapped, 0600)
	t.Setenv("KRIK_AGENT_MAP", mapping)
	refresh(true)
	if refreshError != "" || prev["sample/plan"].Agent != "Claude" {
		t.Fatal(refreshError, prev["sample/plan"].Agent)
	}
	if got, _ := os.ReadFile(path); !bytes.Equal(got, original) {
		t.Fatal("attribution rewrote a plan")
	}
	// An explicit handoff always wins, and an unlabelled new version is not guessed.
	os.WriteFile(path, append([]byte("Agent: Codex\n"), original...), 0600)
	refresh(true)
	if prev["sample/plan"].Agent != "Codex" {
		t.Fatal("history overrode an explicit agent")
	}
	os.WriteFile(path, append(original, []byte("\n- [todo] More work\n")...), 0600)
	refresh(true)
	if prev["sample/plan"].Agent != "Unknown" {
		t.Fatal("stale history was reused")
	}
}

func TestAgentIdentityCannotBeAssignedThroughApp(t *testing.T) {
	path := agentStateFixture(t)
	before, _ := os.ReadFile(path)
	for _, endpoint := range []string{"agent", "executor", "step-executor"} {
		r := httptest.NewRequest(http.MethodPost, "http://"+addr+"/api/plans/"+endpoint, bytes.NewBufferString(`{"agent":"Codex","executor":"Codex","stepLine":6}`))
		w := httptest.NewRecorder()
		handleReadOnlyAgent(w, r)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatal(endpoint, w.Code)
		}
	}
	if after, _ := os.ReadFile(path); !bytes.Equal(before, after) {
		t.Fatal("read-only identity endpoint changed source tasks")
	}
}
