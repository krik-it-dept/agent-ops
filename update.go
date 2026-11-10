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
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const updateRepository = "krik-it-dept/agent-ops"
const updateArchive = "agent-ops-windows-amd64.zip"
const maxUpdateBytes = 128 << 20

var appVersion = "v0.1.4"
var appCommit = "development"
var updates *appUpdater
var updateRestarting atomic.Bool
var stableVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)

// Package contents are a protocol: unknown entries are rejected before stopping
// the running app. User registries, reports and task sources are never targets.
var runtimeFiles = []string{"agent-ops.exe", "tasks-overview.mjs", "task-sync.mjs", "task-report.mjs", "plan-reader.mjs", "execution-roles.mjs", "execution-reports.mjs", "historical-executions.mjs", "agent-attribution.mjs", "NOTICE.md", "INSTALL.md", "integrations/install-task-reporting.mjs", "skills/task-plan/SKILL.md"}

type releaseAsset struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}
type appRelease struct {
	Tag        string         `json:"tag_name"`
	Body       string         `json:"body"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Assets     []releaseAsset `json:"assets"`
}
type updateState struct {
	Current   string `json:"current"`
	Commit    string `json:"commit"`
	ProcessID int    `json:"processId"`
	Latest    string `json:"latest"`
	Notes     string `json:"notes"`
	Available bool   `json:"available"`
	Skipped   bool   `json:"skipped"`
	Phase     string `json:"phase"`
	Error     string `json:"error"`
	Message   string `json:"message"`
	CheckedAt string `json:"checkedAt"`
}
type appUpdater struct {
	mu                  sync.Mutex
	state               updateState
	release             appRelease
	busy                bool
	skipped             string
	root, data, profile string
	launchArgs          []string
	run                 func(context.Context, string, ...string) ([]byte, error)
	handoff             func(string) error
}

func newerVersion(candidate, current string) bool {
	a, b := stableVersion.FindStringSubmatch(candidate), stableVersion.FindStringSubmatch(current)
	if a == nil || b == nil {
		return false
	}
	for i := 1; i <= 3; i++ {
		x, errX := strconv.ParseUint(a[i], 10, 32)
		y, errY := strconv.ParseUint(b[i], 10, 32)
		if errX != nil || errY != nil {
			return false
		}
		if x != y {
			return x > y
		}
	}
	return false
}

func runUpdateCommand(ctx context.Context, name string, args ...string) ([]byte, error) {
	cmd := hidden(exec.CommandContext(ctx, name, args...))
	cmd.Env = append(os.Environ(), "GH_PROMPT_DISABLED=1", "GH_HOST=github.com")
	// CLI stderr can contain account details. It is never returned through the API.
	cmd.Stderr = io.Discard
	out, err := cmd.Output()
	if len(out) > 2<<20 {
		return nil, errors.New("Command response is too large")
	}
	return out, err
}

func newAppUpdater(root, data, profile string, args []string) *appUpdater {
	u := &appUpdater{root: root, data: data, profile: profile, launchArgs: args, run: runUpdateCommand}
	u.state = updateState{Current: appVersion, Commit: appCommit, ProcessID: os.Getpid(), Phase: "idle"}
	var prefs struct {
		Skipped string `json:"skipped"`
	}
	if b, err := os.ReadFile(filepath.Join(data, "update-preferences.json")); err == nil && json.Unmarshal(b, &prefs) == nil {
		u.skipped = prefs.Skipped
	}
	var result updateResult
	if b, err := os.ReadFile(filepath.Join(data, "update-result.json")); err == nil && json.Unmarshal(b, &result) == nil {
		if result.Phase == "updated" && result.Version == appVersion {
			u.state.Phase = "updated"
			u.state.Message = "Updated to " + appVersion
			if strings.HasPrefix(result.Message, u.state.Message) {
				u.state.Message = result.Message
			}
		}
		if result.Phase == "error" {
			u.state.Phase = "error"
			u.state.Error = result.Message
		}
	}
	u.handoff = u.startHelper
	return u
}

func (u *appUpdater) snapshot() updateState { u.mu.Lock(); defer u.mu.Unlock(); return u.state }

// Keep recovery feedback visible until a manual check or the six-hour retry.
func (u *appUpdater) startInitialCheck() {
	if u.snapshot().Phase != "error" {
		u.startCheck()
	}
}
func (u *appUpdater) failure(message string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.busy = false
	u.state.Phase = "error"
	u.state.Error = message
}

func validateRelease(r appRelease) error {
	if r.Draft || r.Prerelease || !stableVersion.MatchString(r.Tag) {
		return errors.New("The release is not a supported stable version")
	}
	for _, name := range []string{updateArchive, updateArchive + ".sha256"} {
		count := 0
		for _, a := range r.Assets {
			if a.Name == name {
				count++
				if a.Size <= 0 || a.Size > maxUpdateBytes || (strings.HasSuffix(name, ".sha256") && a.Size > 1024) {
					return errors.New("Invalid update asset size")
				}
			}
		}
		if count != 1 {
			return errors.New("The release does not contain one complete Windows package and checksum")
		}
	}
	return nil
}

func (u *appUpdater) startCheck() bool {
	u.mu.Lock()
	if u.busy {
		u.mu.Unlock()
		return false
	}
	u.busy = true
	u.state.Phase = "checking"
	u.state.Error = ""
	u.state.Message = ""
	u.mu.Unlock()
	go u.checkRelease()
	return true
}
func (u *appUpdater) checkRelease() {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	b, err := u.run(ctx, "gh", "api", "--method", "GET", "repos/"+updateRepository+"/releases/latest")
	if err != nil {
		u.mu.Lock()
		u.state.Available = false
		u.mu.Unlock()
		u.failure("Could not check the private GitHub release. Install GitHub CLI and sign in to an account with access, then retry.")
		return
	}
	var r appRelease
	if json.Unmarshal(b, &r) != nil || validateRelease(r) != nil {
		u.mu.Lock()
		u.state.Available = false
		u.mu.Unlock()
		u.failure("The latest release has no valid Windows update package. The current app was kept.")
		return
	}
	u.mu.Lock()
	defer u.mu.Unlock()
	u.release = r
	u.busy = false
	u.state.Latest = r.Tag
	u.state.Notes = r.Body
	u.state.CheckedAt = time.Now().Format(time.RFC3339)
	u.state.Available = newerVersion(r.Tag, u.state.Current)
	u.state.Skipped = r.Tag == u.skipped
	u.state.Phase = "idle"
	if u.state.Available {
		u.state.Phase = "available"
	}
}

func (u *appUpdater) skip(version string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.busy || !u.state.Available || version != u.release.Tag {
		return errors.New("Check the available version before skipping it")
	}
	if err := plainUpdatePath(u.data); err != nil {
		return err
	}
	if err := os.MkdirAll(u.data, 0700); err != nil {
		return err
	}
	if err := writeUpdateJSON(filepath.Join(u.data, "update-preferences.json"), map[string]string{"skipped": version}); err != nil {
		return err
	}
	u.skipped = version
	u.state.Skipped = true
	return nil
}

func (u *appUpdater) startApply(version string) error {
	u.mu.Lock()
	defer u.mu.Unlock()
	if u.busy || !u.state.Available || version != u.release.Tag || !newerVersion(version, u.state.Current) {
		return errors.New("Check the newer available version before updating")
	}
	if err := plainUpdatePath(u.root); err != nil {
		return err
	}
	for _, name := range runtimeFiles {
		if err := regularUpdateFile(filepath.Join(u.root, filepath.FromSlash(name))); err != nil {
			return errors.New("Install the complete release package in its runtime directory before using in-app updates")
		}
	}
	u.busy = true
	u.state.Phase = "downloading"
	u.state.Error = ""
	u.state.Message = ""
	r := u.release
	go u.prepare(r)
	return nil
}

func (u *appUpdater) phase(value string) { u.mu.Lock(); u.state.Phase = value; u.mu.Unlock() }
func (u *appUpdater) prepare(r appRelease) {
	if err := u.prepareRelease(r); err != nil {
		u.failure(err.Error())
	}
}
func (u *appUpdater) prepareRelease(r appRelease) error {
	base := filepath.Join(u.data, "updates")
	if err := plainUpdatePath(base); err != nil {
		return errors.New("The update staging path is unsafe")
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		return errors.New("Cannot create the update staging directory")
	}
	stage, err := os.MkdirTemp(base, "update-")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	_, err = u.run(ctx, "gh", "release", "download", r.Tag, "--repo", updateRepository, "--pattern", updateArchive, "--pattern", updateArchive+".sha256", "--dir", stage)
	if err != nil {
		return errors.New("Update download failed. The current app is still running; retry when GitHub is reachable")
	}
	u.phase("verifying")
	if err := verifyUpdateArchive(stage, r); err != nil {
		return err
	}
	packageDir := filepath.Join(stage, "package")
	if err := extractUpdate(filepath.Join(stage, updateArchive), packageDir); err != nil {
		return err
	}
	versionCtx, versionCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer versionCancel()
	out, err := u.run(versionCtx, filepath.Join(packageDir, "agent-ops.exe"), "--version")
	if err != nil || strings.TrimSpace(string(out)) != r.Tag {
		return errors.New("The downloaded app version does not match the release. The current app was kept")
	}
	m := updateManifest{Version: 1, Tag: r.Tag, Root: u.root, Data: u.data, Profile: u.profile, Package: packageDir, ParentPID: os.Getpid(), Addr: addr, Args: u.launchArgs, Hashes: map[string]string{}}
	for _, name := range runtimeFiles {
		b, err := os.ReadFile(filepath.Join(packageDir, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		m.Hashes[name] = hex.EncodeToString(sum[:])
	}
	manifest := filepath.Join(stage, "manifest.json")
	if err := writeUpdateJSON(manifest, m); err != nil {
		return err
	}
	u.phase("installing")
	if err := u.handoff(manifest); err != nil {
		return errors.New("Could not start the update helper. The current app was kept")
	}
	return nil
}

func verifyUpdateArchive(stage string, r appRelease) error {
	file := filepath.Join(stage, updateArchive)
	if err := regularUpdateFile(file); err != nil {
		return err
	}
	info, err := os.Stat(file)
	if err != nil || info.Size() > maxUpdateBytes {
		return errors.New("The update package exceeds the size limit")
	}
	b, err := os.ReadFile(filepath.Join(stage, updateArchive+".sha256"))
	if pathErr := regularUpdateFile(filepath.Join(stage, updateArchive+".sha256")); pathErr != nil {
		return pathErr
	}
	if err != nil || len(b) > 1024 {
		return errors.New("Missing or invalid update checksum")
	}
	parts := strings.Fields(strings.TrimSpace(string(b)))
	if len(parts) != 2 || !shaPattern.MatchString(parts[0]) || parts[1] != updateArchive {
		return errors.New("The checksum file does not describe this package")
	}
	f, err := os.Open(file)
	if err != nil {
		return err
	}
	defer f.Close()
	h := sha256.New()
	if _, err = io.Copy(h, f); err != nil {
		return err
	}
	digest := hex.EncodeToString(h.Sum(nil))
	if digest != parts[0] {
		return errors.New("Update checksum mismatch. No installed files were changed")
	}
	for _, a := range r.Assets {
		if a.Name == updateArchive {
			if info.Size() != a.Size {
				return errors.New("Update size differs from the GitHub release")
			}
			if a.Digest != "" && a.Digest != "sha256:"+digest {
				return errors.New("Update digest differs from the GitHub release")
			}
		}
	}
	return nil
}

func extractUpdate(archive, destination string) error {
	z, err := zip.OpenReader(archive)
	if err != nil {
		return errors.New("Invalid update ZIP")
	}
	defer z.Close()
	allowed := map[string]bool{}
	dirs := map[string]bool{}
	for _, name := range append(append([]string{}, runtimeFiles...), "scripts/install.ps1") {
		allowed[name] = true
		for d := filepath.ToSlash(filepath.Dir(name)); d != "."; d = filepath.ToSlash(filepath.Dir(d)) {
			dirs[d+"/"] = true
		}
	}
	seen := map[string]bool{}
	var total uint64
	for _, entry := range z.File {
		name := entry.Name
		if strings.ContainsAny(name, `\:`) || seen[strings.ToLower(name)] {
			return errors.New("Unsafe or duplicate ZIP path")
		}
		seen[strings.ToLower(name)] = true
		if entry.FileInfo().IsDir() {
			if !dirs[name] {
				return errors.New("Unexpected ZIP directory")
			}
			continue
		}
		if !allowed[name] || !entry.Mode().IsRegular() {
			return errors.New("Unexpected or unsafe file in update ZIP")
		}
		if entry.UncompressedSize64 > maxUpdateBytes || total > maxUpdateBytes-entry.UncompressedSize64 {
			return errors.New("Expanded update exceeds the size limit")
		}
		total += entry.UncompressedSize64
	}
	for name := range allowed {
		if !seen[strings.ToLower(name)] {
			return fmt.Errorf("Incomplete update package: %s", name)
		}
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	for _, entry := range z.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		target := filepath.Join(destination, filepath.FromSlash(entry.Name))
		if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
			return err
		}
		in, err := entry.Open()
		if err != nil {
			return err
		}
		out, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
		if err != nil {
			in.Close()
			return err
		}
		n, copyErr := io.Copy(out, io.LimitReader(in, int64(entry.UncompressedSize64)+1))
		closeErr := out.Close()
		in.Close()
		if copyErr != nil || closeErr != nil || uint64(n) != entry.UncompressedSize64 {
			return errors.New("Incomplete ZIP extraction")
		}
	}
	return nil
}

func updateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/updates", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		if r.Method != "GET" {
			w.WriteHeader(405)
			return
		}
		if updates == nil {
			w.WriteHeader(503)
			return
		}
		_ = json.NewEncoder(w).Encode(updates.snapshot())
	})
	for _, action := range []string{"check", "apply", "skip"} {
		action := action
		mux.HandleFunc("/api/updates/"+action, func(w http.ResponseWriter, r *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.Header().Set("Cache-Control", "no-store")
			if r.Method != "POST" {
				w.WriteHeader(405)
				return
			}
			if !trustedLocalWrite(r) {
				w.WriteHeader(403)
				return
			}
			if updates == nil {
				w.WriteHeader(503)
				return
			}
			var body struct {
				Version string `json:"version"`
			}
			var err error
			if action != "check" {
				d := json.NewDecoder(http.MaxBytesReader(w, r.Body, 1024))
				d.DisallowUnknownFields()
				err = d.Decode(&body)
				if err != nil || d.Decode(&struct{}{}) != io.EOF {
					http.Error(w, "Invalid update request", 400)
					return
				}
			}
			switch action {
			case "check":
				if !updates.startCheck() {
					err = errors.New("An update operation is already running")
				}
			case "apply":
				err = updates.startApply(body.Version)
			case "skip":
				err = updates.skip(body.Version)
			}
			if err != nil {
				w.WriteHeader(409)
				_ = json.NewEncoder(w).Encode(map[string]string{"error": err.Error()})
				return
			}
			w.WriteHeader(202)
			_ = json.NewEncoder(w).Encode(updates.snapshot())
		})
	}
}

func writeUpdateJSON(file string, value any) error {
	b, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return atomicUpdateFile(file, b)
}

func (u *appUpdater) startHelper(manifest string) error {
	m, err := readUpdateManifest(manifest)
	if err != nil {
		return err
	}
	cmd := hidden(exec.Command(filepath.Join(m.Package, "agent-ops.exe"), "--apply-update", manifest))
	if err := cmd.Start(); err != nil {
		return err
	}
	ready := filepath.Join(filepath.Dir(manifest), "ready")
	for i := 0; i < 100; i++ {
		if b, err := os.ReadFile(ready); err == nil && bytes.Equal(b, []byte("ready")) {
			updateRestarting.Store(true)
			go func() { time.Sleep(time.Second); refreshMu.Lock(); os.Exit(0) }()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return errors.New("Update helper did not become ready")
}
