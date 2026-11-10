package main

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime/debug"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// isolateCrashState points the log and crash marker at a temp folder.
func isolateCrashState(t *testing.T) string {
	t.Helper()
	data := t.TempDir()
	prevDir, prevCrash := logDir, crashDir
	t.Cleanup(func() {
		_ = debug.SetCrashOutput(nil, debug.CrashOptions{})
		closeLogging()
		logDir, crashDir = prevDir, prevCrash
	})
	if err := initLogging(data, "agent-ops.log"); err != nil {
		t.Fatal(err)
	}
	return data
}

func TestRotatingLogCapsSizeAndKeepsFixedHistory(t *testing.T) {
	file := filepath.Join(t.TempDir(), "logs", "agent-ops.log")
	w, err := openRotating(file, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	line := []byte(strings.Repeat("x", 39) + "\n")
	for i := 0; i < 20; i++ {
		if _, err := w.Write(line); err != nil {
			t.Fatal(err)
		}
	}
	w.f.Close()
	names, _ := filepath.Glob(filepath.Join(filepath.Dir(file), "*.log"))
	if len(names) != 3 {
		t.Fatal("expected the log plus two rotations", names)
	}
	for _, name := range names {
		if info, _ := os.Stat(name); info.Size() > 100 {
			t.Fatal("log exceeded its cap", name, info.Size())
		}
	}
}

func TestLogRecordsKeyEvents(t *testing.T) {
	data := isolateCrashState(t)
	setRefreshError(refreshKindProjectFailed+" (1)", `Could not read project “Secret Client” (C:\clients\secret): plan text`)
	setRefreshError("", "")
	b, _ := os.ReadFile(filepath.Join(data, "logs", "agent-ops.log"))
	if !strings.Contains(string(b), "plan refresh failed") || !strings.Contains(string(b), "project unreadable (1)") || !strings.Contains(string(b), "plan refresh recovered") {
		t.Fatal(string(b))
	}
	for _, secret := range []string{"Secret Client", "secret", "plan text"} {
		if strings.Contains(string(b), secret) {
			t.Fatal("the log kept the refresh reason text", secret)
		}
	}
}

func TestPanicsInBackgroundWorkAndHandlersLeaveACrashMarker(t *testing.T) {
	data := isolateCrashState(t)
	done := make(chan struct{})
	safeGo("test worker", func() { defer close(done); panic("worker failed") })
	<-done
	rec, ok := readCrash()
	deadline := time.Now().Add(5 * time.Second)
	for !ok && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
		rec, ok = readCrash()
	}
	if !ok || rec.Kind != "panic" || rec.Where != "test worker" || rec.Message != "worker failed" || rec.Count != 1 || rec.Version != appVersion {
		t.Fatal(rec)
	}
	handler := recoverHandler(http.HandlerFunc(func(http.ResponseWriter, *http.Request) { panic(errors.New("handler failed")) }))
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "/api/state", nil))
	if w.Code != 500 {
		t.Fatal(w.Code)
	}
	if rec, _ = readCrash(); rec.Count != 2 || rec.Where != "http GET /api/state" {
		t.Fatal(rec)
	}
	logged, _ := os.ReadFile(filepath.Join(data, "logs", "agent-ops.log"))
	if !strings.Contains(string(logged), "panic recovered") || !strings.Contains(string(logged), "goroutine") {
		t.Fatal("the stack is not logged")
	}
	if err := dismissCrash(); err != nil {
		t.Fatal(err)
	}
	if _, ok := readCrash(); ok || crashNotice() != nil {
		t.Fatal("dismiss did not clear the marker")
	}
}

func TestSupervisedLoopRestartsAfterAPanic(t *testing.T) {
	isolateCrashState(t)
	var runs atomic.Int32
	done := make(chan struct{})
	// runRecovered is the supervisor's unit; the delay between runs is not tested.
	for runRecovered("loop", func() {
		if runs.Add(1) == 1 {
			panic("first run")
		}
		close(done)
	}) {
	}
	<-done
	if runs.Load() != 2 {
		t.Fatal(runs.Load())
	}
}

func TestFatalOutputFromThePreviousRunBecomesACrashNotice(t *testing.T) {
	data := isolateCrashState(t)
	fatal := filepath.Join(data, "logs", fatalLogName)
	updatePut(t, fatal, []byte("goroutine 1 [running]:\nfatal error: concurrent map writes\n\nmore stack"))
	initCrashOutput()
	rec, ok := readCrash()
	if !ok || rec.Kind != "fatal" || rec.Message != "fatal error: concurrent map writes" {
		t.Fatal(rec)
	}
	archived, _ := filepath.Glob(filepath.Join(data, "logs", "fatal-*.log"))
	if len(archived) != 1 {
		t.Fatal(archived)
	}
	if info, err := os.Stat(fatal); err != nil || info.Size() != 0 {
		t.Fatal("this run's fatal output file is not ready")
	}
}

func TestDiagnosticsSummarizeWithoutPlanContentOrProjectPaths(t *testing.T) {
	isolateCrashState(t)
	prevNode := nodeVersion
	nodeVersion = func() string { return "v24.0.0" }
	t.Cleanup(func() { nodeVersion = prevNode })
	secretPath := filepath.Join(t.TempDir(), "secret-client-project")
	cfgMu.Lock()
	prevCfg := appCfg
	t.Cleanup(func() { cfgMu.Lock(); appCfg = prevCfg; cfgMu.Unlock() })
	appCfg.Projects = []Project{{ID: "p1", Path: secretPath, Name: "Secret Client", Kind: "folder", Enabled: true}}
	cfgMu.Unlock()
	t.Cleanup(func() { mu.Lock(); refreshError, refreshErrorKind = "", ""; mu.Unlock() })
	if text := diagnosticsText(); !strings.Contains(text, "Plan refresh: ok") || !strings.Contains(text, "Last crash: none") {
		t.Fatal(text)
	}
	// Every free-text source the app holds carries a secret: the crash message
	// and location, the update error and each refresh failure reason.
	writeCrash(crashRecord{Kind: "panic", Where: "http GET /api/x/Secret Client", Message: "open " + secretPath + `\plan.md: confidential roadmap`})
	prevUpdates := updates
	updates = &appUpdater{}
	updates.state.Phase = "error"
	updates.state.Error = "Could not write " + secretPath + `\agent-ops.exe`
	t.Cleanup(func() { updates = prevUpdates })
	secrets := []string{secretPath, "Secret Client", "secret-client-project", "confidential roadmap", logDir, `:\`, `\Users\`}
	if user := os.Getenv("USERNAME"); len(user) > 2 {
		secrets = append(secrets, user)
	}
	cases := []struct{ kind, reason, want string }{
		{refreshKindCollector, "Could not read plans: open plan.md. Plan text: confidential roadmap", "Plan refresh: failing: collector failed"},
		{refreshKindProjectFailed + " (2)", "Could not read project “Secret Client” (" + secretPath + "): confidential roadmap", "Plan refresh: failing: project unreadable (2)"},
		{refreshKindStateFolder, "Cannot create the state folder " + secretPath + ": Access is denied.", "Plan refresh: failing: state folder"},
		{"", "Secret Client failed in " + secretPath, "Plan refresh: failing: unknown"},
	}
	for _, c := range cases {
		mu.Lock()
		refreshError, refreshErrorKind = c.reason, c.kind
		mu.Unlock()
		text := diagnosticsText()
		for _, want := range []string{"Version: " + appVersion, "OS: Windows", "Node.js (optional): v24.0.0", "Projects: 1 configured, 1 enabled, 1 folders", c.want, "Updates: error, error reported", "Last crash: " + appVersion + " panic at ", "(1 total)"} {
			if !strings.Contains(text, want) {
				t.Fatal("missing", want, "\n", text)
			}
		}
		for _, secret := range secrets {
			if strings.Contains(strings.ToLower(text), strings.ToLower(secret)) {
				t.Fatal("diagnostics leaked", secret, "\n", text)
			}
		}
	}
	mux := http.NewServeMux()
	diagnosticsRoutes(mux)
	handler := localBoundary(mux)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "http://"+addr+"/api/diagnostics", nil))
	if w.Code != 200 || !strings.Contains(w.Body.String(), "Agent Ops diagnostics") {
		t.Fatal(w.Code, w.Body.String())
	}
	cross := httptest.NewRequest("GET", "http://"+addr+"/api/diagnostics", nil)
	cross.Header.Set("Origin", "https://other.invalid")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, cross)
	if w.Code != 403 {
		t.Fatal("cross-site diagnostics read", w.Code)
	}
	dismiss := httptest.NewRequest("POST", "http://"+addr+"/api/diagnostics/dismiss-crash", nil)
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, dismiss)
	if w.Code != 403 {
		t.Fatal("dismiss without the write header", w.Code)
	}
	dismiss = httptest.NewRequest("POST", "http://"+addr+"/api/diagnostics/dismiss-crash", nil)
	dismiss.Header.Set("X-Agent-Ops", "1")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, dismiss)
	if w.Code != 200 {
		t.Fatal(w.Code, w.Body.String())
	}
}

func TestOpenLogsFolderOpensOnlyTheLogDirectory(t *testing.T) {
	data := isolateCrashState(t)
	var opened []string
	prev := openFolder
	openFolder = func(path string) error { opened = append(opened, path); return nil }
	t.Cleanup(func() { openFolder = prev })
	req := httptest.NewRequest("POST", "http://"+addr+"/api/settings/open-folder", strings.NewReader(`{"target":"logs"}`))
	req.Header.Set("X-Agent-Ops", "1")
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	handleOpenFolder(w, req)
	if w.Code != 200 || len(opened) != 1 || opened[0] != filepath.Join(data, "logs") {
		t.Fatal(w.Code, w.Body.String(), opened)
	}
}

func TestRotationNeverTruncatesALogAnotherProcessHolds(t *testing.T) {
	file := filepath.Join(t.TempDir(), "logs", "agent-ops.log")
	w, err := openRotating(file, 100, 2)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { w.f.Close() }()
	first := []byte(strings.Repeat("a", 79) + "\n")
	if _, err := w.Write(first); err != nil {
		t.Fatal(err)
	}
	// A second handle without delete sharing stands in for another instance.
	other, err := os.Open(file)
	if err != nil {
		t.Fatal(err)
	}
	defer other.Close()
	if _, err := w.Write([]byte(strings.Repeat("b", 39) + "\n")); err != nil {
		t.Fatal(err)
	}
	b, _ := os.ReadFile(file)
	if !strings.HasPrefix(string(b), string(first)) || len(b) != 120 {
		t.Fatal("the held log was truncated:", len(b))
	}
}
