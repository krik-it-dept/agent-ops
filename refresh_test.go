package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
	"time"
)

func TestRefreshReadsLatestAndPreservesLastGoodStateOnFailure(t *testing.T) {
	agentStateFixture(t)
	refresh(true)
	if refreshError != "" {
		t.Fatal(refreshError)
	}
	request := func(method string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, "http://"+addr+"/api/refresh", nil)
		r.Header.Set("X-Workboard", "1")
		handleRefresh(w, r)
		return w
	}
	w := request(http.MethodPost)
	var response map[string]string
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response["refreshedAt"] == "" {
		t.Fatal(w.Code, w.Body)
	}
	if w := request(http.MethodGet); w.Code != 405 {
		t.Fatal("refresh accepts GET", w.Code)
	}
	previous := append([]byte{}, rawState...)
	scriptFile = filepath.Join(dataDir, "missing-collector.mjs")
	w = request(http.MethodPost)
	if w.Code != 502 || !bytes.Contains(w.Body.Bytes(), []byte("Node failed")) {
		t.Fatal("refresh reported false success", w.Code, w.Body)
	}
	if !bytes.Equal(previous, rawState) {
		t.Fatal("refresh failure discarded last good state")
	}
}

func TestExecutionReportDiffUsesActualReporterTimeAndDoesNotRepeatOnRefresh(t *testing.T) {
	old := fixture(Step{Status: "doing", Text: "Build"})
	current := fixture(Step{Status: "doing", Text: "Build"})
	var report ExecutionReport
	report.ID = "observed-start"
	report.Agent = "Codex"
	report.Coordinator = "Claude"
	report.Event = "start"
	report.At = time.Now().Add(-time.Minute)
	report.Task.Text = "Build"
	current.ExecutionReports = []ExecutionReport{report}
	got := diff(one(old), one(current))
	if len(got) != 1 || got[0].Kind != "execution-report" || got[0].Actor != "Codex" || got[0].Agent != "Claude" || !got[0].TS.Equal(report.At) {
		t.Fatal(got)
	}
	if again := diff(one(current), one(current)); len(again) != 0 {
		t.Fatal("F5 duplicated observed execution", again)
	}
	found := false
	for _, e := range seed(one(current)) {
		if e.Kind == "execution-report" && e.TS.Equal(report.At) {
			found = true
		}
	}
	if !found {
		t.Fatal("first run missed execution evidence")
	}
	current.Mtime = time.Now().Add(-3 * time.Hour)
	current.ExecutionUpdatedAt = time.Now().Add(-time.Minute)
	if isStale(current, time.Now()) {
		t.Fatal("recent actual progress was marked stale")
	}
}

func TestHistoryBackfillDoesNotCreateAssignmentsOrRefreshStaleWork(t *testing.T) {
	old := fixture(Step{Status: "doing", Text: "Build"})
	old.Mtime = time.Now().Add(-3 * time.Hour)
	b, _ := json.Marshal(old)
	var current Plan
	json.Unmarshal(b, &current)
	current.Executors = []string{"Claude"}
	current.HistoricalExecutors = []string{"Claude"}
	current.Steps[0].Executors = []string{"Claude"}
	json.Unmarshal([]byte(`{"executionHistory":{"verifiedAt":"2026-11-07T12:00:00Z"}}`), &current.Steps[0])
	current.Milestones[0].Steps = current.Steps
	if got := diff(one(old), one(current)); len(got) != 0 {
		t.Fatal("backfill invented current assignment/activity", got)
	}
	if !isStale(current, time.Now()) {
		t.Fatal("historical evidence disguised stale work as current")
	}
}
