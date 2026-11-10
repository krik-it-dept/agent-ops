package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func updatePut(t *testing.T, file string, b []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, b, 0600); err != nil {
		t.Fatal(err)
	}
}
func updateFixture(t *testing.T) (*appUpdater, updateManifest) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "installed runtime")
	data := filepath.Join(base, "data")
	profile := filepath.Join(base, "profile")
	stage := filepath.Join(data, "updates", "update-fixture")
	pkg := filepath.Join(stage, "package")
	m := updateManifest{Version: 1, Tag: "v0.2.0", Root: root, Data: data, Profile: profile, Package: pkg, ParentPID: os.Getpid(), Addr: addr, Hashes: map[string]string{}}
	for _, name := range runtimeFiles {
		updatePut(t, filepath.Join(root, filepath.FromSlash(name)), []byte("old:"+name))
		b := []byte("new:" + name)
		updatePut(t, filepath.Join(pkg, filepath.FromSlash(name)), b)
		sum := sha256.Sum256(b)
		m.Hashes[name] = hex.EncodeToString(sum[:])
	}
	u := newAppUpdater(root, data, profile, []string{"--background"})
	u.state.Current = "v0.1.2"
	return u, m
}
func fixtureRelease(t *testing.T, archive []byte) appRelease {
	t.Helper()
	sum := sha256.Sum256(archive)
	return appRelease{Tag: "v0.2.0", Body: "Actual changes", Assets: []releaseAsset{{updateArchive, int64(len(archive)), "sha256:" + hex.EncodeToString(sum[:])}, {updateArchive + ".sha256", 94, ""}}}
}
func fixtureZIP(t *testing.T, extra string, duplicate bool, symlink bool) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, name := range append(append([]string{}, runtimeFiles...), "scripts/install.ps1") {
		w, err := z.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte("new:" + name))
	}
	if extra != "" {
		h := &zip.FileHeader{Name: extra, Method: zip.Store}
		if symlink {
			h.SetMode(os.ModeSymlink | 0777)
		}
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte("untrusted"))
	}
	if duplicate {
		w, _ := z.Create("agent-ops.exe")
		_, _ = w.Write([]byte("duplicate"))
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}
func awaitUpdate(t *testing.T, u *appUpdater) updateState {
	t.Helper()
	for i := 0; i < 200; i++ {
		s := u.snapshot()
		if s.Phase != "checking" {
			return s
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("Check did not finish")
	return updateState{}
}

func TestStableVersionComparison(t *testing.T) {
	for _, tc := range []struct {
		next, current string
		newer         bool
	}{{"v0.1.10", "v0.1.9", true}, {"v1.0.0", "v0.99.99", true}, {"v1.2.3", "v1.2.3", false}, {"v0.1.1", "v0.1.2", false}, {"v1.2.3-beta", "v1.2.2", false}, {"v01.2.3", "v1.2.2", false}, {"--help", "v1.2.2", false}, {"v999999999999.0.0", "v1.0.0", false}} {
		if got := newerVersion(tc.next, tc.current); got != tc.newer {
			t.Fatal(tc, got)
		}
	}
}

func TestParallelChecksAndStatusWritesDuringRestartAreRejected(t *testing.T) {
	u, _ := updateFixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	r := fixtureRelease(t, []byte("zip"))
	u.run = func(context.Context, string, ...string) ([]byte, error) {
		close(started)
		<-release
		return json.Marshal(r)
	}
	if !u.startCheck() {
		t.Fatal("not started")
	}
	<-started
	if u.startCheck() {
		t.Fatal("parallel check accepted")
	}
	if err := u.startApply("v0.2.0"); err == nil {
		t.Fatal("apply accepted during check")
	}
	close(release)
	awaitUpdate(t, u)
	updateRestarting.Store(true)
	defer updateRestarting.Store(false)
	err := writePlanStatus(statusChange{Repo: "sample", Plan: "work", Status: "Done", Revision: strings.Repeat("a", 64)})
	var status *statusError
	if !errors.As(err, &status) || status.code != http.StatusServiceUnavailable {
		t.Fatal("write was not rejected", err)
	}
	req := httptest.NewRequest("POST", "http://"+addr+"/api/refresh", nil)
	req.Header.Set("X-Workboard", "1")
	w := httptest.NewRecorder()
	handleRefresh(w, req)
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestPrepareRejectsWrongBinaryVersionBeforeHandoff(t *testing.T) {
	u, _ := updateFixture(t)
	b := fixtureZIP(t, "", false, false)
	r := fixtureRelease(t, b)
	sum := sha256.Sum256(b)
	handedOff := false
	u.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			stage := args[len(args)-1]
			updatePut(t, filepath.Join(stage, updateArchive), b)
			updatePut(t, filepath.Join(stage, updateArchive+".sha256"), []byte(hex.EncodeToString(sum[:])+"  "+updateArchive))
			return nil, nil
		}
		return []byte("v0.1.0"), nil
	}
	u.handoff = func(string) error { handedOff = true; return nil }
	if err := u.prepareRelease(r); err == nil || handedOff {
		t.Fatal("unverified version reached handoff")
	}
	if b, _ := os.ReadFile(filepath.Join(u.root, "agent-ops.exe")); string(b) != "old:agent-ops.exe" {
		t.Fatal("old app changed")
	}
}
func TestReleaseCheckSkipAndReadOnlyStatus(t *testing.T) {
	u, _ := updateFixture(t)
	r := fixtureRelease(t, []byte("zip"))
	calls := 0
	u.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		calls++
		if name != "gh" || strings.Join(args, " ") != "api --method GET repos/krik-it-dept/agent-ops/releases/latest" {
			t.Error(name, args)
		}
		return json.Marshal(r)
	}
	if !u.startCheck() {
		t.Fatal("not started")
	}
	s := awaitUpdate(t, u)
	if !s.Available || s.Latest != "v0.2.0" || s.Notes != "Actual changes" || s.CheckedAt == "" {
		t.Fatal(s)
	}
	if err := u.skip("v0.1.9"); err == nil {
		t.Fatal("accepted another tag")
	}
	if err := u.skip(r.Tag); err != nil {
		t.Fatal(err)
	}
	u2 := newAppUpdater(u.root, u.data, u.profile, nil)
	if u2.skipped != r.Tag {
		t.Fatal("skip not persisted")
	}
	previous := updates
	updates = u
	t.Cleanup(func() { updates = previous })
	mux := http.NewServeMux()
	updateRoutes(mux)
	for i := 0; i < 3; i++ {
		req := httptest.NewRequest("GET", "http://"+addr+"/api/updates", nil)
		w := httptest.NewRecorder()
		localBoundary(mux).ServeHTTP(w, req)
		if w.Code != 200 {
			t.Fatal(w.Code)
		}
	}
	if calls != 1 {
		t.Fatal("status reads performed network checks", calls)
	}
}
func TestCheckFailureDoesNotLeakCLIOutputOrAllowStaleApply(t *testing.T) {
	u, _ := updateFixture(t)
	u.state.Available = true
	u.run = func(context.Context, string, ...string) ([]byte, error) {
		return []byte("private account details"), errors.New("private token")
	}
	u.startCheck()
	s := awaitUpdate(t, u)
	if s.Phase != "error" || s.Available || strings.Contains(s.Error, "private token") || strings.Contains(s.Error, "account details") {
		t.Fatal(s)
	}
	if err := u.startApply("v0.2.0"); err == nil {
		t.Fatal("applied stale release")
	}
}
func TestUpdateEndpointsRejectCrossSiteRequestsAndUnselectedVersions(t *testing.T) {
	u, _ := updateFixture(t)
	previous := updates
	updates = u
	t.Cleanup(func() { updates = previous })
	mux := http.NewServeMux()
	updateRoutes(mux)
	handler := localBoundary(mux)
	for _, action := range []string{"check", "apply", "skip"} {
		for _, origin := range []string{"", "https://other.invalid"} {
			req := httptest.NewRequest("POST", "http://"+addr+"/api/updates/"+action, strings.NewReader(`{"version":"v0.2.0"}`))
			if origin != "" {
				req.Header.Set("Origin", origin)
				req.Header.Set("X-Workboard", "1")
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != 403 {
				t.Fatal(action, w.Code)
			}
		}
	}
	req := httptest.NewRequest("POST", "http://"+addr+"/api/updates/apply", strings.NewReader(`{"version":"v0.2.0","root":"C:/elsewhere"}`))
	req.Header.Set("X-Workboard", "1")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	req = httptest.NewRequest("POST", "http://"+addr+"/api/updates/apply", strings.NewReader(`{"version":"v0.2.0"}`))
	req.Header.Set("X-Workboard", "1")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
}
func TestUpdateZIPRejectsTraversalDuplicatesUnknownFilesAndSymlinks(t *testing.T) {
	for _, tc := range []struct {
		name, extra        string
		duplicate, symlink bool
	}{{"traversal", "../private.txt", false, false}, {"absolute", "C:/private.txt", false, false}, {"backslash", `scripts\install.ps1`, false, false}, {"unknown", "historical-executions.json", false, false}, {"duplicate", "", true, false}, {"symlink", "other-link", false, true}} {
		t.Run(tc.name, func(t *testing.T) {
			base := t.TempDir()
			file := filepath.Join(base, "test.zip")
			updatePut(t, file, fixtureZIP(t, tc.extra, tc.duplicate, tc.symlink))
			if err := extractUpdate(file, filepath.Join(base, "package")); err == nil {
				t.Fatal("accepted unsafe package")
			}
			if _, err := os.Stat(filepath.Join(base, "package")); !os.IsNotExist(err) {
				t.Fatal("started extraction before validation")
			}
		})
	}
	base := t.TempDir()
	file := filepath.Join(base, "ok.zip")
	updatePut(t, file, fixtureZIP(t, "", false, false))
	if err := extractUpdate(file, filepath.Join(base, "package")); err != nil {
		t.Fatal(err)
	}
}
func TestArchiveVerificationRequiresChecksumSizeAndGitHubDigest(t *testing.T) {
	stage := t.TempDir()
	b := fixtureZIP(t, "", false, false)
	r := fixtureRelease(t, b)
	sum := sha256.Sum256(b)
	updatePut(t, filepath.Join(stage, updateArchive), b)
	checksum := hex.EncodeToString(sum[:]) + "  " + updateArchive + "\n"
	updatePut(t, filepath.Join(stage, updateArchive+".sha256"), []byte(checksum))
	if err := verifyUpdateArchive(stage, r); err != nil {
		t.Fatal(err)
	}
	r.Assets[0].Digest = "sha256:" + strings.Repeat("0", 64)
	if err := verifyUpdateArchive(stage, r); err == nil {
		t.Fatal("ignored GitHub digest")
	}
	r = fixtureRelease(t, b)
	updatePut(t, filepath.Join(stage, updateArchive), append(b, 1))
	if err := verifyUpdateArchive(stage, r); err == nil {
		t.Fatal("accepted changed ZIP")
	}
}
func TestPrepareOnlyHandsOffVerifiedVersionedPackage(t *testing.T) {
	u, _ := updateFixture(t)
	b := fixtureZIP(t, "", false, false)
	r := fixtureRelease(t, b)
	sum := sha256.Sum256(b)
	var manifest string
	u.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if name == "gh" {
			stage := args[len(args)-1]
			updatePut(t, filepath.Join(stage, updateArchive), b)
			updatePut(t, filepath.Join(stage, updateArchive+".sha256"), []byte(hex.EncodeToString(sum[:])+"  "+updateArchive))
			return nil, nil
		}
		if filepath.Base(name) != "agent-ops.exe" || len(args) != 1 || args[0] != "--version" {
			t.Error(name, args)
		}
		return []byte(r.Tag + "\n"), nil
	}
	u.handoff = func(file string) error { manifest = file; return nil }
	if err := u.prepareRelease(r); err != nil {
		t.Fatal(err)
	}
	if manifest == "" {
		t.Fatal("no handoff")
	}
	m, err := readUpdateManifest(manifest)
	if err != nil {
		t.Fatal(err)
	}
	if m.Root != u.root || m.Profile != u.profile || len(m.Hashes) != len(runtimeFiles) {
		t.Fatal("lost runtime configuration")
	}
	updatePut(t, filepath.Join(m.Package, "task-sync.mjs"), []byte("changed after verification"))
	if _, err := readUpdateManifest(manifest); err == nil {
		t.Fatal("accepted altered stage")
	}
	if b, err := os.ReadFile(filepath.Join(u.root, "task-sync.mjs")); err != nil || string(b) != "old:task-sync.mjs" {
		t.Fatal("prepare touched installed files")
	}
}
func TestInstallRollbackRestoresRuntimeAndInstructionsWithoutTouchingPrivateData(t *testing.T) {
	_, m := updateFixture(t)
	private := filepath.Join(m.Root, "historical-executions.json")
	updatePut(t, private, []byte("private sentinel"))
	updatePut(t, filepath.Join(m.Root, "krik-workboard.exe"), []byte("old alias"))
	profiles := profileUpdateFiles(m.Profile)
	updatePut(t, profiles[0], []byte("owner instructions"))
	rollback, err := installUpdateFiles(m)
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range runtimeFiles {
		b, _ := os.ReadFile(filepath.Join(m.Root, filepath.FromSlash(name)))
		if string(b) != "new:"+name {
			t.Fatal(name)
		}
	}
	updatePut(t, profiles[0], []byte("replacement instructions"))
	updatePut(t, profiles[1], []byte("new instructions"))
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	for _, name := range runtimeFiles {
		b, _ := os.ReadFile(filepath.Join(m.Root, filepath.FromSlash(name)))
		if string(b) != "old:"+name {
			t.Fatal(name)
		}
	}
	if b, _ := os.ReadFile(profiles[0]); string(b) != "owner instructions" {
		t.Fatal("profile not restored")
	}
	if _, err := os.Stat(profiles[1]); !os.IsNotExist(err) {
		t.Fatal("new profile not rolled back")
	}
	if b, _ := os.ReadFile(private); string(b) != "private sentinel" {
		t.Fatal("private data changed")
	}
	if b, _ := os.ReadFile(filepath.Join(m.Root, "krik-workboard.exe")); string(b) != "old alias" {
		t.Fatal("alias not restored")
	}
}
func TestUpdateHealthMustMatchVersionAndExactStartedProcess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/api/state" {
			_, _ = w.Write([]byte(`{"appVersion":"v0.2.0","error":"","state":{"plans":[]}}`))
			return
		}
		_ = json.NewEncoder(w).Encode(updateState{Current: "v0.2.0", ProcessID: 123})
	}))
	defer server.Close()
	if !updateHealth(server.URL, "v0.2.0", 123, time.Second) {
		t.Fatal("healthy process not recognized")
	}
	if updateHealth(server.URL, "v0.2.0", 456, time.Millisecond) {
		t.Fatal("accepted another process")
	}
	if updateHealth(server.URL, "v0.3.0", 123, time.Millisecond) {
		t.Fatal("accepted another version")
	}
	if h, err := openUpdateParent(os.Getpid(), t.TempDir()); err == nil {
		closeUpdateParent(h)
		t.Fatal("accepted unrelated process image")
	}
}
