package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestReplacePlanStatus(t *testing.T) {
	for _, tc := range []struct{ name, before, after string }{
		{"complete", "Next: Build\nStatus: Implementing - detail\n\n- [todo] Test\n", "Next: Build\nStatus: Done\n\n- [todo] Test\n"},
		{"legacy CRLF BOM", "\ufeffTiếp theo: Kiểm thử\r\n  Trạng thái: Testing  \r\n\r\n## M1: Ship\r\n- [doing] Test\r\n", "\ufeffTiếp theo: Kiểm thử\r\n  Trạng thái: Done  \r\n\r\n## M1: Ship\r\n- [doing] Test\r\n"},
		{"missing", "Next: Build\r\n\r\n## M1: Work\r\nStatus: Example\r\n", "Status: Done\r\nNext: Build\r\n\r\n## M1: Work\r\nStatus: Example\r\n"},
		{"title", "# Delivery\n\nStatus: Testing\nGoal: Ship", "# Delivery\n\nStatus: Done\nGoal: Ship"},
		{"same", "Status: Done", "Status: Done"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got, err := replacePlanStatus([]byte(tc.before), "Done")
			if err != nil || string(got) != tc.after {
				t.Fatalf("got %q, %v; want %q", got, err, tc.after)
			}
		})
	}
	if _, err := replacePlanStatus([]byte("Status: Testing\nStatus: Planning\n"), "Done"); err == nil {
		t.Fatal("ambiguous header accepted")
	}
}

func statusFixture(t *testing.T) (string, statusChange) {
	t.Helper()
	root := isolated(t)
	oldRepos, oldPrev := reposDir, prev
	t.Cleanup(func() { reposDir, prev = oldRepos, oldPrev })
	reposDir = root
	dir := filepath.Join(root, "sample", ".tasks")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(dir, "plan.md")
	original := []byte("Next: Test\nStatus: Implementing - build UI\nOwner: Lan\n\n## M1: Delivery\n- [doing] Build\n- [todo] Test\n")
	if err := os.WriteFile(file, original, 0600); err != nil {
		t.Fatal(err)
	}
	p := fixture()
	p.Project = projectIDFor(root)
	prev = one(p)
	return file, statusChange{Project: p.Project, Repo: "sample", Plan: "plan", Status: "Done", Revision: revisionOf(original)}
}

func TestWritePlanStatus(t *testing.T) {
	t.Run("done then reopen preserves work", func(t *testing.T) {
		path, change := statusFixture(t)
		if err := writePlanStatus(change); err != nil {
			t.Fatal(err)
		}
		done, _ := os.ReadFile(path)
		if !bytes.Contains(done, []byte("Status: Done\n")) || !bytes.Contains(done, []byte("- [doing] Build\n- [todo] Test\n")) {
			t.Fatal(string(done))
		}
		change.Status, change.Revision = "Implementing", revisionOf(done)
		if err := writePlanStatus(change); err != nil {
			t.Fatal(err)
		}
		reopened, _ := os.ReadFile(path)
		if !bytes.Equal(reopened, bytes.Replace(done, []byte("Status: Done"), []byte("Status: Implementing"), 1)) {
			t.Fatal("reopen modified checklist")
		}
	})
	t.Run("stale content with unchanged timestamp", func(t *testing.T) {
		path, change := statusFixture(t)
		info, _ := os.Stat(path)
		other := []byte("Status: Testing\nGoal: Another session just changed this\n")
		os.WriteFile(path, other, 0600)
		os.Chtimes(path, info.ModTime(), info.ModTime())
		err := writePlanStatus(change)
		var conflict *statusError
		if !errors.As(err, &conflict) || conflict.code != http.StatusConflict {
			t.Fatalf("expected conflict, got %v", err)
		}
		got, _ := os.ReadFile(path)
		if !bytes.Equal(got, other) {
			t.Fatal("overwrote another session")
		}
	})
	t.Run("open editor blocks writes", func(t *testing.T) {
		path, change := statusFixture(t)
		ptr, _ := windows.UTF16PtrFromString(path)
		handle, err := windows.CreateFile(ptr, windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
		if err != nil {
			t.Fatal(err)
		}
		defer windows.CloseHandle(handle)
		err = writePlanStatus(change)
		var conflict *statusError
		if !errors.As(err, &conflict) || conflict.code != http.StatusConflict {
			t.Fatalf("expected sharing conflict, got %v", err)
		}
	})
	t.Run("invalid inputs and deleted plan", func(t *testing.T) {
		path, valid := statusFixture(t)
		for _, change := range []statusChange{
			{Repo: "..", Plan: "plan", Status: "Done", Revision: valid.Revision},
			{Repo: "sample", Plan: "../plan", Status: "Done", Revision: valid.Revision},
			{Repo: "sample", Plan: "tong-hop", Status: "Done", Revision: valid.Revision},
			{Repo: "sample", Plan: "plan", Status: "Done\n- [done] injected", Revision: valid.Revision},
			{Repo: "sample", Plan: "plan", Status: "Done", Revision: ""},
		} {
			if err := writePlanStatus(change); err == nil {
				t.Fatalf("accepted %+v", change)
			}
		}
		os.Remove(path)
		if err := writePlanStatus(valid); err == nil {
			t.Fatal("recreated deleted plan")
		}
	})
}

func TestStatusEndpointGuards(t *testing.T) {
	for _, tc := range []struct {
		name, method, host, origin, marker, content, body string
		code                                              int
	}{
		{"method", "GET", addr, "", "1", "application/json", "{}", 405},
		{"foreign origin", "POST", addr, "https://example.com", "1", "application/json", "{}", 403},
		{"foreign host", "POST", "example.com", "", "1", "application/json", "{}", 403},
		{"missing marker", "POST", addr, "", "", "application/json", "{}", 403},
		{"form post", "POST", addr, "", "1", "text/plain", "{}", 403},
		{"bad JSON", "POST", addr, "", "1", "application/json", "{", 400},
		{"unknown field", "POST", addr, "", "1", "application/json", "{\"path\":\"C:/file\"}", 400},
		{"multiple bodies", "POST", addr, "", "1", "application/json", "{} {}", 400},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(tc.method, "http://"+tc.host+"/api/plans/status", strings.NewReader(tc.body))
			request.Header.Set("Origin", tc.origin)
			request.Header.Set("X-Workboard", tc.marker)
			request.Header.Set("Content-Type", tc.content)
			response := httptest.NewRecorder()
			handlePlanStatus(response, request)
			if response.Code != tc.code {
				t.Fatalf("%d %s", response.Code, response.Body)
			}
		})
	}
}

func TestStatusEndpointIntegration(t *testing.T) {
	path, change := statusFixture(t)
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
	refresh(true)
	if refreshError != "" {
		t.Fatal(refreshError)
	}
	initial := prev[testKey("sample", "plan")]
	if initial.Revision != change.Revision {
		t.Fatal("parser did not export content revision")
	}
	change.Status = "Done"
	post := func(change statusChange) *httptest.ResponseRecorder {
		body, _ := json.Marshal(change)
		request := httptest.NewRequest(http.MethodPost, "http://"+addr+"/api/plans/status", bytes.NewReader(body))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Workboard", "1")
		request.Header.Set("Origin", "http://"+addr)
		response := httptest.NewRecorder()
		handlePlanStatus(response, request)
		return response
	}
	response := post(change)
	if response.Code != 200 || prev[testKey("sample", "plan")].Status != "Done" {
		t.Fatalf("%d %s %v", response.Code, response.Body, refreshError)
	}
	if kinds(events)["status"] != 1 {
		t.Fatal("move must produce one activity event", events)
	}
	after, _ := os.ReadFile(path)
	if response := post(change); response.Code != 409 {
		t.Fatal("replayed stale move accepted", response.Code)
	}
	change.Status, change.Revision = "Implementing", revisionOf(after)
	if response := post(change); response.Code != 200 || prev[testKey("sample", "plan")].Status != "Implementing" {
		t.Fatal(response.Code, response.Body)
	}
	if kinds(events)["status"] != 2 || kinds(events)["done"] != 0 {
		t.Fatal("moves must not complete steps or duplicate events", events)
	}
	refresh(true)
	if kinds(events)["status"] != 2 {
		t.Fatal("refresh duplicated moves")
	}
}
