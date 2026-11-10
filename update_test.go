package main

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/krik-it-dept/agent-ops/internal/pkgmanifest"
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
func digestOf(b []byte) string { sum := sha256.Sum256(b); return hex.EncodeToString(sum[:]) }

func updateFixture(t *testing.T) (*appUpdater, updateManifest) {
	t.Helper()
	base := t.TempDir()
	root := filepath.Join(base, "installed runtime")
	data := filepath.Join(base, "data")
	profile := filepath.Join(base, "profile")
	stage := filepath.Join(data, "updates", "update-fixture")
	pkg := filepath.Join(stage, "package")
	m := updateManifest{Version: 1, Tag: "v0.2.0", Root: root, Data: data, Profile: profile, Package: pkg, ParentPID: os.Getpid(), Addr: addr, Hashes: map[string]string{}}
	for _, name := range legacyRuntimeFiles {
		updatePut(t, filepath.Join(root, filepath.FromSlash(name)), []byte("old:"+name))
		b := []byte("new:" + name)
		updatePut(t, filepath.Join(pkg, filepath.FromSlash(name)), b)
		m.Hashes[name] = digestOf(b)
	}
	u := newAppUpdater(root, data, profile, []string{"--background"})
	u.state.Current = "v0.1.2"
	return u, m
}

// bridgeFiles is the v0.2.0-compatible package content.
func bridgeFiles() map[string]string {
	files := map[string]string{"scripts/install.ps1": "new:scripts/install.ps1"}
	for _, name := range legacyRuntimeFiles {
		files[name] = "new:" + name
	}
	return files
}

type zipEntry struct {
	name, body string
	symlink    bool
}

func buildZIP(t *testing.T, entries []zipEntry) []byte {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, e := range entries {
		h := &zip.FileHeader{Name: e.name, Method: zip.Deflate}
		if e.symlink {
			h.SetMode(os.ModeSymlink | 0777)
		}
		w, err := z.CreateHeader(h)
		if err != nil {
			t.Fatal(err)
		}
		_, _ = w.Write([]byte(e.body))
	}
	if err := z.Close(); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

// fixturePackage returns a ZIP of files and the release manifest describing it.
func fixturePackage(t *testing.T, tag string, files map[string]string, remove []string) ([]byte, []byte) {
	t.Helper()
	m := pkgmanifest.Manifest{Format: 1, Version: tag, Remove: remove}
	var entries []zipEntry
	for name, body := range files {
		m.Files = append(m.Files, pkgmanifest.File{Path: name, SHA256: digestOf([]byte(body)), Size: int64(len(body))})
		entries = append(entries, zipEntry{name: name, body: body})
	}
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
	sort.Slice(entries, func(i, j int) bool { return entries[i].name < entries[j].name })
	raw, err := pkgmanifest.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pkgmanifest.Parse(raw); err != nil {
		t.Fatal(err)
	}
	return buildZIP(t, entries), raw
}

func fixtureRelease(tag string, archive, manifest []byte) appRelease {
	return appRelease{Tag: tag, Body: "Actual changes", Assets: []releaseAsset{
		{updateArchive, int64(len(archive)), "sha256:" + digestOf(archive)},
		{updateArchive + ".sha256", int64(len(digestOf(archive) + "  " + updateArchive + "\n")), ""},
		{updateManifestAsset, int64(len(manifest)), "sha256:" + digestOf(manifest)},
	}}
}

// releaseFeed imitates the GitHub latest-release API and asset downloads.
type releaseFeed struct {
	mu       sync.Mutex
	server   *httptest.Server
	release  appRelease
	assets   map[string][]byte
	latest   int
	notMod   int
	gate     chan struct{}
	override func(http.ResponseWriter) bool
}

func newReleaseFeed(t *testing.T, tag string, archive, manifest []byte) *releaseFeed {
	t.Helper()
	f := &releaseFeed{release: fixtureRelease(tag, archive, manifest), assets: map[string][]byte{
		updateArchive:             archive,
		updateArchive + ".sha256": []byte(digestOf(archive) + "  " + updateArchive + "\n"),
		updateManifestAsset:       manifest,
	}}
	f.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		gate, override := f.gate, f.override
		f.mu.Unlock()
		if r.URL.Path == "/repos/"+updateRepository+"/releases/latest" {
			if r.Header.Get("User-Agent") == "" || r.Header.Get("Authorization") != "" {
				t.Error("release check must be anonymous with a user agent")
			}
			f.mu.Lock()
			f.latest++
			f.mu.Unlock()
			if gate != nil {
				<-gate
			}
			if override != nil && override(w) {
				return
			}
			if r.Header.Get("If-None-Match") == `"fixture"` {
				f.mu.Lock()
				f.notMod++
				f.mu.Unlock()
				w.WriteHeader(http.StatusNotModified)
				return
			}
			w.Header().Set("ETag", `"fixture"`)
			_ = json.NewEncoder(w).Encode(f.release)
			return
		}
		prefix := "/" + updateRepository + "/releases/download/" + f.release.Tag + "/"
		if name, ok := strings.CutPrefix(r.URL.Path, prefix); ok {
			if b, ok := f.assets[name]; ok {
				_, _ = w.Write(b)
				return
			}
		}
		http.NotFound(w, r)
	}))
	t.Cleanup(f.server.Close)
	return f
}

func feedUpdater(t *testing.T, f *releaseFeed) (*appUpdater, updateManifest) {
	u, m := updateFixture(t)
	u.useFeed(f.server.URL)
	return u, m
}

func awaitUpdate(t *testing.T, u *appUpdater) updateState {
	t.Helper()
	for i := 0; i < 400; i++ {
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
	}{{"v0.1.10", "v0.1.9", true}, {"v1.0.0", "v0.99.99", true}, {"v1.2.3", "v1.2.3", false}, {"v0.1.1", "v0.1.2", false}, {"v1.2.3-beta", "v1.2.2", false}, {"v01.2.3", "v1.2.2", false}, {"--help", "v1.2.2", false}, {"v999999999999.0.0", "v1.0.0", false}, {"v0.2.2", "v0.2.1-dev.abcdef0", false}} {
		if got := newerVersion(tc.next, tc.current); got != tc.newer {
			t.Fatal(tc, got)
		}
	}
}

func TestParallelChecksAndRefreshDuringRestartAreRejected(t *testing.T) {
	archive, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	f := newReleaseFeed(t, "v0.2.0", archive, manifest)
	f.gate = make(chan struct{})
	u, _ := feedUpdater(t, f)
	if !u.startCheck() {
		t.Fatal("not started")
	}
	if u.startCheck() {
		t.Fatal("parallel check accepted")
	}
	if err := u.startApply("v0.2.0"); err == nil {
		t.Fatal("apply accepted during check")
	}
	close(f.gate)
	awaitUpdate(t, u)
	updateRestarting.Store(true)
	defer updateRestarting.Store(false)
	req := httptest.NewRequest("POST", "http://"+addr+"/api/refresh", nil)
	req.Header.Set("X-Agent-Ops", "1")
	w := httptest.NewRecorder()
	handleRefresh(w, req)
	if w.Code != 503 {
		t.Fatal(w.Code)
	}
}

func TestPrepareRejectsWrongBinaryVersionBeforeHandoff(t *testing.T) {
	archive, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	f := newReleaseFeed(t, "v0.2.0", archive, manifest)
	u, _ := feedUpdater(t, f)
	handedOff := false
	u.run = func(ctx context.Context, name string, args ...string) ([]byte, error) { return []byte("v0.1.0"), nil }
	u.handoff = func(string) error { handedOff = true; return nil }
	if err := u.prepareRelease(f.release); err == nil || handedOff {
		t.Fatal("unverified version reached handoff")
	}
	if b, _ := os.ReadFile(filepath.Join(u.root, "agent-ops.exe")); string(b) != "old:agent-ops.exe" {
		t.Fatal("old app changed")
	}
}

func TestReleaseCheckUsesAnonymousAPIWithETagSkipAndReadOnlyStatus(t *testing.T) {
	archive, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	f := newReleaseFeed(t, "v0.2.0", archive, manifest)
	u, _ := feedUpdater(t, f)
	u.run = func(context.Context, string, ...string) ([]byte, error) {
		t.Error("a release check never runs a command")
		return nil, errors.New("unexpected")
	}
	if !u.startCheck() {
		t.Fatal("not started")
	}
	s := awaitUpdate(t, u)
	if !s.Available || s.Latest != "v0.2.0" || s.Notes != "Actual changes" || s.CheckedAt == "" {
		t.Fatal(s)
	}
	if !u.startCheck() {
		t.Fatal("second check not started")
	}
	if s = awaitUpdate(t, u); !s.Available || f.notMod != 1 {
		t.Fatal("ETag response not reused", s, f.notMod)
	}
	if err := u.skip("v0.1.9"); err == nil {
		t.Fatal("accepted another tag")
	}
	if err := u.skip("v0.2.0"); err != nil {
		t.Fatal(err)
	}
	u2 := newAppUpdater(u.root, u.data, u.profile, nil)
	if u2.skipped != "v0.2.0" {
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
	if f.latest != 2 {
		t.Fatal("status reads performed network checks", f.latest)
	}
}

func TestCheckFailuresAreSpecificAndNeverLeakResponses(t *testing.T) {
	archive, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	reset := time.Now().Add(30 * time.Minute)
	for _, tc := range []struct {
		name, want string
		reply      func(http.ResponseWriter) bool
	}{
		{"rate limit", "Retry after " + reset.Format("15:04"), func(w http.ResponseWriter) bool {
			w.Header().Set("X-RateLimit-Remaining", "0")
			w.Header().Set("X-RateLimit-Reset", jsonInt(reset.Unix()))
			w.WriteHeader(403)
			_, _ = w.Write([]byte("private token"))
			return true
		}},
		{"too many", "limit for update checks", func(w http.ResponseWriter) bool { w.WriteHeader(429); return true }},
		{"missing", "No published Agent Ops release", func(w http.ResponseWriter) bool { w.WriteHeader(404); return true }},
		{"server", "HTTP 502", func(w http.ResponseWriter) bool {
			w.WriteHeader(502)
			_, _ = w.Write([]byte("private token"))
			return true
		}},
		{"forbidden", "HTTP 403", func(w http.ResponseWriter) bool { w.WriteHeader(403); return true }},
		{"invalid", "no valid Windows update package", func(w http.ResponseWriter) bool {
			_, _ = w.Write([]byte(`{"tag_name":"v0.2.0","assets":[]}`))
			return true
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newReleaseFeed(t, "v0.2.0", archive, manifest)
			f.override = tc.reply
			u, _ := feedUpdater(t, f)
			u.state.Available = true
			u.startCheck()
			s := awaitUpdate(t, u)
			if s.Phase != "error" || s.Available || !strings.Contains(s.Error, tc.want) || strings.Contains(s.Error, "private") {
				t.Fatal(s)
			}
			if err := u.startApply("v0.2.0"); err == nil {
				t.Fatal("applied stale release")
			}
		})
	}
	f := newReleaseFeed(t, "v0.2.0", archive, manifest)
	u, _ := feedUpdater(t, f)
	f.server.Close()
	u.startCheck()
	if s := awaitUpdate(t, u); s.Phase != "error" || !strings.Contains(s.Error, "Could not reach GitHub") {
		t.Fatal("offline is not reported", s)
	}
}

func jsonInt(v int64) string { b, _ := json.Marshal(v); return string(b) }

func TestInitialCheckDoesNotEraseARecoveryFailure(t *testing.T) {
	archive, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	f := newReleaseFeed(t, "v0.2.0", archive, manifest)
	u, _ := feedUpdater(t, f)
	if err := writeUpdateJSON(filepath.Join(u.data, "update-result.json"), updateResult{"error", "v0.2.0", "Previous version restored."}); err != nil {
		t.Fatal(err)
	}
	restarted := newAppUpdater(u.root, u.data, u.profile, nil)
	restarted.useFeed(f.server.URL)
	restarted.startInitialCheck()
	if f.latest != 0 || restarted.snapshot().Error != "Previous version restored." {
		t.Fatal("Recovery receipt was overwritten")
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
				req.Header.Set("X-Agent-Ops", "1")
			}
			w := httptest.NewRecorder()
			handler.ServeHTTP(w, req)
			if w.Code != 403 {
				t.Fatal(action, w.Code)
			}
		}
	}
	req := httptest.NewRequest("POST", "http://"+addr+"/api/updates/apply", strings.NewReader(`{"version":"v0.2.0","root":"C:/elsewhere"}`))
	req.Header.Set("X-Agent-Ops", "1")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 400 {
		t.Fatal(w.Code)
	}
	req = httptest.NewRequest("POST", "http://"+addr+"/api/updates/apply", strings.NewReader(`{"version":"v0.2.0"}`))
	req.Header.Set("X-Agent-Ops", "1")
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, req)
	if w.Code != 409 {
		t.Fatal(w.Code)
	}
}

func TestReleaseRequiresPackageChecksumAndManifestAssets(t *testing.T) {
	archive, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	r := fixtureRelease("v0.2.0", archive, manifest)
	if err := validateRelease(r); err != nil {
		t.Fatal(err)
	}
	for i := range r.Assets {
		broken := r
		broken.Assets = append(append([]releaseAsset{}, r.Assets[:i]...), r.Assets[i+1:]...)
		if validateRelease(broken) == nil {
			t.Fatal("accepted a release without", r.Assets[i].Name)
		}
	}
	big := fixtureRelease("v0.2.0", archive, manifest)
	big.Assets[2].Size = pkgmanifest.MaxManifestBytes + 1
	if validateRelease(big) == nil {
		t.Fatal("accepted an oversized manifest")
	}
}

func TestUpdateZIPMustMatchTheManifestExactly(t *testing.T) {
	files := bridgeFiles()
	_, raw := fixturePackage(t, "v0.2.0", files, nil)
	pm, err := pkgmanifest.Parse(raw)
	if err != nil {
		t.Fatal(err)
	}
	base := func() []zipEntry {
		var entries []zipEntry
		for name, body := range files {
			entries = append(entries, zipEntry{name: name, body: body})
		}
		return entries
	}
	cases := map[string]func([]zipEntry) []zipEntry{
		"traversal": func(e []zipEntry) []zipEntry { return append(e, zipEntry{name: "../private.txt", body: "x"}) },
		"absolute":  func(e []zipEntry) []zipEntry { return append(e, zipEntry{name: "C:/private.txt", body: "x"}) },
		"backslash": func(e []zipEntry) []zipEntry { return append(e, zipEntry{name: `scripts\install.ps1`, body: "x"}) },
		"stream":    func(e []zipEntry) []zipEntry { return append(e, zipEntry{name: "NOTICE.md:hidden", body: "x"}) },
		"unknown": func(e []zipEntry) []zipEntry {
			return append(e, zipEntry{name: "historical-executions.json", body: "x"})
		},
		"duplicate": func(e []zipEntry) []zipEntry {
			return append(e, zipEntry{name: "agent-ops.exe", body: "new:agent-ops.exe"})
		},
		"case duplicate": func(e []zipEntry) []zipEntry { return append(e, zipEntry{name: "AGENT-OPS.exe", body: "x"}) },
		"symlink": func(e []zipEntry) []zipEntry {
			return append(e, zipEntry{name: "other-link", body: "x", symlink: true})
		},
		"unexpected dir":   func(e []zipEntry) []zipEntry { return append(e, zipEntry{name: "extra/", body: ""}) },
		"missing file":     func(e []zipEntry) []zipEntry { return e[1:] },
		"different size":   func(e []zipEntry) []zipEntry { e[0].body += "!"; return e },
		"different digest": func(e []zipEntry) []zipEntry { e[0].body = strings.Repeat("x", len(e[0].body)); return e },
		"different manifest": func(e []zipEntry) []zipEntry {
			return append(e, zipEntry{name: "manifest.json", body: string(raw[:len(raw)-1]) + " "})
		},
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			dir := t.TempDir()
			file := filepath.Join(dir, "test.zip")
			updatePut(t, file, buildZIP(t, change(base())))
			err := extractUpdate(file, filepath.Join(dir, "package"), pm, raw)
			if err == nil {
				t.Fatal("accepted unsafe package")
			}
			if name != "different digest" {
				if _, err := os.Stat(filepath.Join(dir, "package")); !os.IsNotExist(err) {
					t.Fatal("started extraction before validation")
				}
			}
		})
	}
	dir := t.TempDir()
	file := filepath.Join(dir, "ok.zip")
	updatePut(t, file, buildZIP(t, append(base(), zipEntry{name: "manifest.json", body: string(raw)}, zipEntry{name: "skills/", body: ""})))
	if err := extractUpdate(file, filepath.Join(dir, "package"), pm, raw); err != nil {
		t.Fatal("an identical packaged manifest and parent folders are accepted", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "package", "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("package metadata must not be installed")
	}
	if b, _ := os.ReadFile(filepath.Join(dir, "package", "skills", "task-plan", "SKILL.md")); string(b) != "new:skills/task-plan/SKILL.md" {
		t.Fatal("extraction")
	}
}

func TestArchiveVerificationRequiresChecksumSizeAndGitHubDigest(t *testing.T) {
	stage := t.TempDir()
	b, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	r := fixtureRelease("v0.2.0", b, manifest)
	updatePut(t, filepath.Join(stage, updateArchive), b)
	checksum := digestOf(b) + "  " + updateArchive + "\n"
	updatePut(t, filepath.Join(stage, updateArchive+".sha256"), []byte(checksum))
	if err := verifyUpdateArchive(stage, r); err != nil {
		t.Fatal(err)
	}
	r.Assets[0].Digest = "sha256:" + strings.Repeat("0", 64)
	if err := verifyUpdateArchive(stage, r); err == nil {
		t.Fatal("ignored GitHub digest")
	}
	r = fixtureRelease("v0.2.0", b, manifest)
	updatePut(t, filepath.Join(stage, updateArchive), append(b, 1))
	if err := verifyUpdateArchive(stage, r); err == nil {
		t.Fatal("accepted changed ZIP")
	}
}

func TestManifestAssetMustMatchReleaseAndVersion(t *testing.T) {
	_, manifest := fixturePackage(t, "v0.2.0", bridgeFiles(), nil)
	stage := t.TempDir()
	updatePut(t, filepath.Join(stage, updateManifestAsset), manifest)
	r := fixtureRelease("v0.2.0", []byte("zip"), manifest)
	if _, _, err := verifyPackageManifest(stage, r); err != nil {
		t.Fatal(err)
	}
	r.Assets[2].Digest = "sha256:" + strings.Repeat("0", 64)
	if _, _, err := verifyPackageManifest(stage, r); err == nil {
		t.Fatal("ignored the manifest digest")
	}
	if _, _, err := verifyPackageManifest(stage, fixtureRelease("v0.3.0", []byte("zip"), manifest)); err == nil {
		t.Fatal("accepted a manifest of another version")
	}
	bad := []byte(strings.Replace(string(manifest), `"path": "NOTICE.md"`, `"path": "../NOTICE.md"`, 1))
	updatePut(t, filepath.Join(stage, updateManifestAsset), bad)
	if _, _, err := verifyPackageManifest(stage, fixtureRelease("v0.2.0", []byte("zip"), bad)); err == nil {
		t.Fatal("accepted an unsafe manifest path")
	}
}

func TestDownloadPrepareHandsOffVerifiedManifestPackage(t *testing.T) {
	files := bridgeFiles()
	delete(files, "task-sync.mjs")
	files["CHANGELOG.md"] = "new:CHANGELOG.md"
	archive, manifest := fixturePackage(t, "v0.3.0", files, []string{"task-sync.mjs"})
	f := newReleaseFeed(t, "v0.3.0", archive, manifest)
	u, _ := feedUpdater(t, f)
	u.run = func(ctx context.Context, name string, args ...string) ([]byte, error) {
		if filepath.Base(name) != "agent-ops.exe" || len(args) != 1 || args[0] != "--version" {
			t.Error(name, args)
		}
		return []byte("v0.3.0\n"), nil
	}
	var handoff string
	u.handoff = func(file string) error { handoff = file; return nil }
	u.startCheck()
	if s := awaitUpdate(t, u); !s.Available {
		t.Fatal(s)
	}
	if err := u.prepareRelease(f.release); err != nil {
		t.Fatal(err)
	}
	m, err := readUpdateManifest(handoff)
	if err != nil {
		t.Fatal(err)
	}
	if m.Version != 2 || m.Root != u.root || m.Profile != u.profile || len(m.Hashes) != len(files) || m.Hashes["CHANGELOG.md"] == "" || m.Hashes["task-sync.mjs"] != "" || len(m.Remove) != 1 || m.Remove[0] != "task-sync.mjs" {
		t.Fatal("handoff does not follow the package manifest", m)
	}
	updatePut(t, filepath.Join(m.Package, "CHANGELOG.md"), []byte("changed after verification"))
	if _, err := readUpdateManifest(handoff); err == nil {
		t.Fatal("accepted altered stage")
	}
	if b, err := os.ReadFile(filepath.Join(u.root, "task-sync.mjs")); err != nil || string(b) != "old:task-sync.mjs" {
		t.Fatal("prepare touched installed files")
	}
	// A tampered download is rejected before extraction.
	f.assets[updateArchive] = append([]byte{}, archive...)
	f.assets[updateArchive][len(archive)-1] ^= 1
	if err := u.prepareRelease(f.release); err == nil {
		t.Fatal("accepted a tampered package")
	}
}

func TestHandoffAcceptsV020FormatAndRejectsUnsafeEntries(t *testing.T) {
	_, m := updateFixture(t)
	file := filepath.Join(filepath.Dir(m.Package), "manifest.json")
	write := func(v any) {
		b, err := json.Marshal(v)
		if err != nil {
			t.Fatal(err)
		}
		updatePut(t, file, b)
	}
	// Exactly what the v0.2.0 updater writes before starting the new helper.
	legacy := map[string]any{"version": 1, "tag": m.Tag, "root": m.Root, "data": m.Data, "profile": m.Profile, "package": m.Package, "parentPid": m.ParentPID, "addr": m.Addr, "args": []string{"--background"}, "hashes": m.Hashes}
	write(legacy)
	if got, err := readUpdateManifest(file); err != nil || len(got.Hashes) != len(legacyRuntimeFiles) {
		t.Fatal("v0.2.0 handoff rejected", err)
	}
	for name, change := range map[string]func(map[string]any){
		"v1 with removals": func(v map[string]any) { v["remove"] = []string{"task-sync.mjs"} },
		"unknown version":  func(v map[string]any) { v["version"] = 3 },
		"unknown field":    func(v map[string]any) { v["installDir"] = "C:/elsewhere" },
		"unsafe file": func(v map[string]any) {
			h := map[string]string{}
			for k, s := range m.Hashes {
				h[k] = s
			}
			h["../outside.md"] = strings.Repeat("a", 64)
			v["hashes"] = h
		},
		"no app": func(v map[string]any) {
			h := map[string]string{}
			for k, s := range m.Hashes {
				if k != "agent-ops.exe" {
					h[k] = s
				}
			}
			v["hashes"] = h
		},
		"remove data":      func(v map[string]any) { v["version"] = 2; v["remove"] = []string{"historical-executions.json"} },
		"remove installed": func(v map[string]any) { v["version"] = 2; v["remove"] = []string{"NOTICE.md"} },
		"remove outside":   func(v map[string]any) { v["version"] = 2; v["remove"] = []string{"../x.mjs"} },
	} {
		v := map[string]any{}
		for k, x := range legacy {
			v[k] = x
		}
		change(v)
		write(v)
		if _, err := readUpdateManifest(file); err == nil {
			t.Error("accepted", name)
		}
	}
}

func TestInstallRemovesListedFilesAndRollbackRestoresEverything(t *testing.T) {
	_, m := updateFixture(t)
	m.Version = 2
	// The new package drops task-sync.mjs and a legacy folder, and adds CHANGELOG.md.
	delete(m.Hashes, "task-sync.mjs")
	updatePut(t, filepath.Join(m.Package, "CHANGELOG.md"), []byte("new:CHANGELOG.md"))
	m.Hashes["CHANGELOG.md"] = digestOf([]byte("new:CHANGELOG.md"))
	// A file in folders that do not exist yet; rollback must remove the folders.
	updatePut(t, filepath.Join(m.Package, "docs", "guides", "new.md"), []byte("new:docs/guides/new.md"))
	m.Hashes["docs/guides/new.md"] = digestOf([]byte("new:docs/guides/new.md"))
	updatePut(t, filepath.Join(m.Root, "legacy", "old.mjs"), []byte("old:legacy"))
	m.Remove = []string{"task-sync.mjs", "legacy/old.mjs", "never-installed.mjs"}
	private := filepath.Join(m.Root, "historical-executions.json")
	updatePut(t, private, []byte("private sentinel"))
	updatePut(t, filepath.Join(m.Root, legacyAliasExe), []byte("old alias"))
	profiles := profileUpdateFiles(m.Profile)
	updatePut(t, profiles[0], []byte("owner instructions"))
	rollback, err := installUpdateFiles(m)
	if err != nil {
		t.Fatal(err)
	}
	for name := range m.Hashes {
		b, _ := os.ReadFile(filepath.Join(m.Root, filepath.FromSlash(name)))
		if string(b) != "new:"+name {
			t.Fatal(name)
		}
	}
	for _, gone := range []string{"task-sync.mjs", "legacy/old.mjs", "legacy"} {
		if _, err := os.Stat(filepath.Join(m.Root, filepath.FromSlash(gone))); !os.IsNotExist(err) {
			t.Fatal("not removed:", gone)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(m.Root, legacyAliasExe)); string(b) != "new:agent-ops.exe" {
		t.Fatal("alias not updated")
	}
	updatePut(t, profiles[0], []byte("replacement instructions"))
	updatePut(t, profiles[1], []byte("new instructions"))
	if err := rollback(); err != nil {
		t.Fatal(err)
	}
	for _, name := range legacyRuntimeFiles {
		b, _ := os.ReadFile(filepath.Join(m.Root, filepath.FromSlash(name)))
		if string(b) != "old:"+name {
			t.Fatal("not restored:", name)
		}
	}
	if b, _ := os.ReadFile(filepath.Join(m.Root, "legacy", "old.mjs")); string(b) != "old:legacy" {
		t.Fatal("removed file not restored")
	}
	if _, err := os.Stat(filepath.Join(m.Root, "CHANGELOG.md")); !os.IsNotExist(err) {
		t.Fatal("added file not rolled back")
	}
	if _, err := os.Stat(filepath.Join(m.Root, "docs")); !os.IsNotExist(err) {
		t.Fatal("rollback left a folder the update created")
	}
	if _, err := os.Stat(filepath.Join(m.Root, "legacy")); err != nil {
		t.Fatal("rollback removed a folder that existed before", err)
	}
	if _, err := os.Stat(filepath.Join(m.Root, "never-installed.mjs")); !os.IsNotExist(err) {
		t.Fatal("rollback created a file that never existed")
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
	if b, _ := os.ReadFile(filepath.Join(m.Root, legacyAliasExe)); string(b) != "old alias" {
		t.Fatal("alias not restored")
	}
}

func TestPruneKeepsNewestStagingFoldersOnly(t *testing.T) {
	base := filepath.Join(t.TempDir(), "updates")
	now := time.Now()
	for i := 1; i <= 5; i++ {
		dir := filepath.Join(base, "update-"+jsonInt(int64(i)))
		updatePut(t, filepath.Join(dir, "backup", "00"), []byte("backup"))
		stamp := now.Add(time.Duration(i) * time.Minute)
		if err := os.Chtimes(dir, stamp, stamp); err != nil {
			t.Fatal(err)
		}
	}
	updatePut(t, filepath.Join(base, "update-fixture", "keep"), []byte("not ours"))
	updatePut(t, filepath.Join(base, "update-9"), []byte("a file, not a stage"))
	pruneUpdateStages(base, 3)
	for i, want := range []bool{false, false, true, true, true} {
		_, err := os.Stat(filepath.Join(base, "update-"+jsonInt(int64(i+1))))
		if (err == nil) != want {
			t.Fatal("stage", i+1, "kept:", err == nil)
		}
	}
	for _, other := range []string{"update-fixture/keep", "update-9"} {
		if _, err := os.Stat(filepath.Join(base, filepath.FromSlash(other))); err != nil {
			t.Fatal("pruned something that is not a staging folder:", other)
		}
	}
}

func TestUpdateFeedAndRedirectsStayOnTrustedHosts(t *testing.T) {
	for feed, ok := range map[string]bool{"http://127.0.0.1:8123": true, "http://127.0.0.1:9000/": true, "http://localhost:9000/": false, "http://[::1]:9000": false, "http://127.000.000.001:9000": false, "http://2130706433:9000": false, "http://127.0.0.2:9000": false, "https://127.0.0.1:8123": false, "http://example.com:80": false, "http://127.0.0.1": false, "http://u:p@127.0.0.1:1": false, "http://127.0.0.1:1/x": false, "http://127.0.0.1:1?q": false, "": false} {
		if validUpdateFeed(feed) != ok {
			t.Error(feed)
		}
	}
	client := newUpdateClient("")
	via := []*http.Request{httptest.NewRequest("GET", "https://github.com/x", nil)}
	for target, ok := range map[string]bool{"https://objects.githubusercontent.com/a": true, "https://release-assets.githubusercontent.com/a": true, "https://github.com/a": true, "http://objects.githubusercontent.com/a": false, "https://evil.example/a": false, "https://githubusercontent.com.evil.example/a": false} {
		err := client.CheckRedirect(httptest.NewRequest("GET", target, nil), via)
		if (err == nil) != ok {
			t.Error(target, err)
		}
	}
	feedClient := newUpdateClient("http://127.0.0.1:1")
	if feedClient.CheckRedirect(httptest.NewRequest("GET", "http://127.0.0.1:2/a", nil), []*http.Request{httptest.NewRequest("GET", "http://127.0.0.1:1/x", nil)}) == nil {
		t.Fatal("a test feed may not redirect elsewhere")
	}
	u, _ := updateFixture(t)
	if got := u.assetURL("v0.2.1", updateArchive); got != "https://github.com/krik-it-dept/agent-ops/releases/download/v0.2.1/agent-ops-windows-amd64.zip" {
		t.Fatal(got)
	}
	if got := u.latestURL(); got != "https://api.github.com/repos/krik-it-dept/agent-ops/releases/latest" {
		t.Fatal(got)
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

// A release built from the VERSION file must report that same version, or the
// updater rejects the download. The source default has to follow VERSION.
func TestSourceVersionMatchesVersionFile(t *testing.T) {
	raw, err := os.ReadFile("VERSION")
	if err != nil {
		t.Fatal(err)
	}
	if want := strings.TrimSpace(string(raw)); appVersion != want {
		t.Fatalf("appVersion default %q does not match VERSION %q", appVersion, want)
	}
}

func TestUpdatePathsRejectJunctions(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "elsewhere")
	if err := os.Mkdir(target, 0o755); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(base, "skills")
	if out, err := exec.Command("cmd", "/c", "mklink", "/J", link, target).CombinedOutput(); err != nil {
		t.Skip("cannot create a junction here:", err, string(out))
	}
	plain := filepath.Join(base, "plain")
	if err := os.Mkdir(plain, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := plainUpdatePath(filepath.Join(plain, "file.txt")); err != nil {
		t.Fatal("a plain folder was rejected:", err)
	}
	for _, path := range []string{link, filepath.Join(link, "task-plan", "SKILL.md")} {
		if err := plainUpdatePath(path); err == nil || !strings.Contains(err.Error(), "junctions") {
			t.Fatal("a junction was accepted:", path, err)
		}
	}
	updatePut(t, filepath.Join(target, "SKILL.md"), []byte("x"))
	if err := regularUpdateFile(filepath.Join(link, "SKILL.md")); err == nil {
		t.Fatal("a file behind a junction was accepted")
	}
}

func TestHandoffAtManifestLimitsIsReadable(t *testing.T) {
	_, m := updateFixture(t)
	m.Version = 2
	padded := func(prefix string, i int) string {
		head := fmt.Sprintf("%s%03d-", prefix, i)
		return head + strings.Repeat("a", pkgmanifest.MaxPathLength-len(head)-len(".md")) + ".md"
	}
	for i := 0; len(m.Hashes) < pkgmanifest.MaxFiles; i++ {
		name := padded("docs/file", i)
		b := []byte(name)
		updatePut(t, filepath.Join(m.Package, filepath.FromSlash(name)), b)
		m.Hashes[name] = digestOf(b)
	}
	for i := 0; len(m.Remove) < pkgmanifest.MaxRemove; i++ {
		m.Remove = append(m.Remove, padded("old/gone", i))
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	if len(b) <= 64<<10 || len(b) > maxHandoffBytes/2 {
		t.Fatal("the fixture does not exercise the limit:", len(b))
	}
	file := filepath.Join(filepath.Dir(m.Package), "manifest.json")
	updatePut(t, file, b)
	got, err := readUpdateManifest(file)
	if err != nil || len(got.Hashes) != pkgmanifest.MaxFiles || len(got.Remove) != pkgmanifest.MaxRemove {
		t.Fatal("a handoff at the manifest limits was rejected:", err)
	}
}
