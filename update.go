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
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/krik-it-dept/agent-ops/internal/pkgmanifest"
)

const updateRepository = "krik-it-dept/agent-ops"
const updateArchive = "agent-ops-windows-amd64.zip"

// The package manifest is a separate release asset: the v0.2.0 updater rejects
// any ZIP entry outside its compiled list, so the bridge ZIP cannot carry it.
// Newer updaters also accept a byte-identical manifest.json inside the ZIP.
const updateManifestAsset = "agent-ops-windows-amd64.manifest.json"
const maxUpdateBytes = pkgmanifest.MaxTotalBytes
const updateStagesKept = 3
const githubAPI = "https://api.github.com"
const githubDownloads = "https://github.com"

var appVersion = "v0.2.2"
var appCommit = "development"
var updates *appUpdater
var updateRestarting atomic.Bool
var stableVersion = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`)
var shaPattern = regexp.MustCompile(`^[a-f0-9]{64}$`)
var stageName = regexp.MustCompile(`^update-[0-9]+$`)

// legacyRuntimeFiles is the file list compiled into the v0.2.0 updater. That
// updater rejects a ZIP that differs from it, so every package keeps exactly these
// files (plus scripts/install.ps1) until all installs have passed this bridge
// release. M2 replaces removed scripts with stubs while that holds.
var legacyRuntimeFiles = []string{"agent-ops.exe", "tasks-overview.mjs", "task-sync.mjs", "task-report.mjs", "plan-reader.mjs", "execution-roles.mjs", "execution-reports.mjs", "historical-executions.mjs", "agent-attribution.mjs", "NOTICE.md", "INSTALL.md", "integrations/install-task-reporting.mjs", "skills/task-plan/SKILL.md"}

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
	// feed replaces both GitHub endpoints with one loopback test server.
	feed   string
	client *http.Client
	// The last release response and its ETag; a 304 reuses it.
	etag, etagBody string
	run            func(context.Context, string, ...string) ([]byte, error)
	handoff        func(string) error
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
	// Child stderr is never returned through the API.
	cmd.Stderr = io.Discard
	out, err := cmd.Output()
	if len(out) > 2<<20 {
		return nil, errors.New("Command response is too large")
	}
	return out, err
}

// validUpdateFeed accepts only a plain http://127.0.0.1:<port> origin, for
// isolated update tests. "localhost" is refused because the hosts file can
// point it anywhere. It does not widen the trust boundary: a local user can already replace
// the installed files directly.
func validUpdateFeed(feed string) bool {
	u, err := url.Parse(feed)
	if err != nil || u.Scheme != "http" || u.User != nil || (u.Path != "" && u.Path != "/") || u.RawQuery != "" || u.Fragment != "" || u.Port() == "" {
		return false
	}
	return u.Host == "127.0.0.1:"+u.Port()
}

func trustedDownloadHost(host string) bool {
	host = strings.ToLower(host)
	return host == "github.com" || host == "api.github.com" || strings.HasSuffix(host, ".githubusercontent.com")
}

// newUpdateClient uses the environment proxy and follows redirects only to GitHub
// HTTPS hosts (release assets redirect to *.githubusercontent.com), or, for a
// test feed, only within that loopback origin.
func newUpdateClient(feed string) *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	return &http.Client{Transport: transport, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		if feed != "" {
			if req.URL.Host != via[0].URL.Host || req.URL.Scheme != "http" {
				return errors.New("redirect left the update feed")
			}
			return nil
		}
		if req.URL.Scheme != "https" || !trustedDownloadHost(req.URL.Hostname()) {
			return errors.New("redirect to an untrusted host")
		}
		return nil
	}}
}

func newAppUpdater(root, data, profile string, args []string) *appUpdater {
	u := &appUpdater{root: root, data: data, profile: profile, launchArgs: args, run: runUpdateCommand, client: newUpdateClient("")}
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

// useFeed points release discovery and downloads at a loopback test server.
func (u *appUpdater) useFeed(feed string) {
	u.mu.Lock()
	defer u.mu.Unlock()
	u.feed = strings.TrimSuffix(feed, "/")
	u.client = newUpdateClient(u.feed)
}

func (u *appUpdater) latestURL() string {
	base := githubAPI
	if u.feed != "" {
		base = u.feed
	}
	return base + "/repos/" + updateRepository + "/releases/latest"
}

// assetURL is built from fixed parts and a validated stable tag; a release
// response never supplies a download URL.
func (u *appUpdater) assetURL(tag, name string) string {
	base := githubDownloads
	if u.feed != "" {
		base = u.feed
	}
	return base + "/" + updateRepository + "/releases/download/" + tag + "/" + name
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
	limits := map[string]int64{updateArchive: maxUpdateBytes, updateArchive + ".sha256": 1024, updateManifestAsset: pkgmanifest.MaxManifestBytes}
	for name, limit := range limits {
		count := 0
		for _, a := range r.Assets {
			if a.Name == name {
				count++
				if a.Size <= 0 || a.Size > limit {
					return errors.New("Invalid update asset size")
				}
			}
		}
		if count != 1 {
			return errors.New("The release does not contain one complete Windows package, checksum and manifest")
		}
	}
	return nil
}

func assetOf(r appRelease, name string) releaseAsset {
	for _, a := range r.Assets {
		if a.Name == name {
			return a
		}
	}
	return releaseAsset{}
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
	go func() {
		defer func() {
			if v := recover(); v != nil {
				recordPanic("update check", v)
				u.failure("The update check stopped after an internal error. The log has details.")
			}
		}()
		u.checkRelease()
	}()
	return true
}

// updateCheckError carries an owner-facing message; the cause goes to the log.
type updateCheckError struct{ message string }

func (e *updateCheckError) Error() string { return e.message }

// fetchLatest reads the latest public release without credentials. An ETag makes
// repeated checks cheap against the unauthenticated rate limit.
func (u *appUpdater) fetchLatest(ctx context.Context) (appRelease, error) {
	var r appRelease
	u.mu.Lock()
	target, client, etag, cached := u.latestURL(), u.client, u.etag, u.etagBody
	u.mu.Unlock()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return r, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "agent-ops/"+appVersion)
	if etag != "" && cached != "" {
		req.Header.Set("If-None-Match", etag)
	}
	resp, err := client.Do(req)
	if err != nil {
		logWarn("update check could not reach GitHub", "error", err.Error())
		return r, &updateCheckError{"Could not reach GitHub to check for updates. Check the internet connection, then retry."}
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
	if err != nil {
		return r, &updateCheckError{"The update check was interrupted. Retry later."}
	}
	switch {
	case resp.StatusCode == http.StatusNotModified && cached != "":
		body = []byte(cached)
	case resp.StatusCode == http.StatusOK:
		u.mu.Lock()
		u.etag, u.etagBody = resp.Header.Get("ETag"), string(body)
		u.mu.Unlock()
	case resp.StatusCode == http.StatusNotFound:
		return r, &updateCheckError{"No published Agent Ops release was found."}
	case resp.StatusCode == http.StatusForbidden || resp.StatusCode == http.StatusTooManyRequests:
		if resp.Header.Get("X-RateLimit-Remaining") == "0" || resp.Header.Get("Retry-After") != "" || resp.StatusCode == http.StatusTooManyRequests {
			message := "GitHub's limit for update checks from this network was reached."
			if reset, err := strconv.ParseInt(resp.Header.Get("X-RateLimit-Reset"), 10, 64); err == nil && reset > 0 {
				message += " Retry after " + time.Unix(reset, 0).Format("15:04") + "."
			} else {
				message += " Retry later."
			}
			logWarn("update check rate limited", "status", resp.StatusCode)
			return r, &updateCheckError{message}
		}
		fallthrough
	default:
		logWarn("update check failed", "status", resp.StatusCode)
		return r, &updateCheckError{fmt.Sprintf("GitHub returned an unexpected response (HTTP %d). Retry later.", resp.StatusCode)}
	}
	if err := json.Unmarshal(body, &r); err != nil {
		return r, &updateCheckError{"The latest release has no valid Windows update package. The current app was kept."}
	}
	return r, nil
}

func (u *appUpdater) checkRelease() {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	r, err := u.fetchLatest(ctx)
	if err == nil && validateRelease(r) != nil {
		logWarn("latest release is not installable", "tag", r.Tag)
		err = &updateCheckError{"The latest release has no valid Windows update package. The current app was kept."}
	}
	if err != nil {
		u.mu.Lock()
		u.state.Available = false
		u.mu.Unlock()
		message := "Could not check for updates. Retry later."
		var known *updateCheckError
		if errors.As(err, &known) {
			message = known.message
		}
		u.failure(message)
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
	logInfo("update check finished", "latest", r.Tag, "available", u.state.Available)
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
	if err := regularUpdateFile(filepath.Join(u.root, pkgmanifest.RequiredFile)); err != nil {
		return errors.New("Install the complete release package in its runtime directory before using in-app updates")
	}
	u.busy = true
	u.state.Phase = "downloading"
	u.state.Error = ""
	u.state.Message = ""
	r := u.release
	logInfo("update started", "from", u.state.Current, "to", r.Tag)
	go u.prepare(r)
	return nil
}

func (u *appUpdater) phase(value string) { u.mu.Lock(); u.state.Phase = value; u.mu.Unlock() }
func (u *appUpdater) prepare(r appRelease) {
	defer func() {
		if v := recover(); v != nil {
			recordPanic("update prepare", v)
			u.failure("The update stopped after an internal error. The current app was kept.")
		}
	}()
	if err := u.prepareRelease(r); err != nil {
		logWarn("update not installed", "tag", r.Tag, "error", err.Error())
		u.failure(err.Error())
	}
}

// download streams one release asset into a new file, bounded by limit.
func (u *appUpdater) download(ctx context.Context, target, file string, limit int64) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", "agent-ops/"+appVersion)
	u.mu.Lock()
	client := u.client
	u.mu.Unlock()
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("download returned HTTP %d", resp.StatusCode)
	}
	if resp.ContentLength > limit {
		return errors.New("download exceeds the release asset size")
	}
	out, err := os.OpenFile(file, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	n, copyErr := io.Copy(out, io.LimitReader(resp.Body, limit+1))
	closeErr := out.Close()
	if copyErr != nil || closeErr != nil {
		return errors.Join(copyErr, closeErr)
	}
	if n > limit {
		return errors.New("download exceeds the release asset size")
	}
	return nil
}

func (u *appUpdater) prepareRelease(r appRelease) error {
	base := filepath.Join(u.data, "updates")
	if err := plainUpdatePath(base); err != nil {
		return errors.New("The update staging path is unsafe")
	}
	if err := os.MkdirAll(base, 0700); err != nil {
		return errors.New("Cannot create the update staging directory")
	}
	pruneUpdateStages(base, updateStagesKept-1)
	stage, err := os.MkdirTemp(base, "update-")
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	for _, name := range []string{updateArchive, updateArchive + ".sha256", updateManifestAsset} {
		if err := u.download(ctx, u.assetURL(r.Tag, name), filepath.Join(stage, name), assetOf(r, name).Size); err != nil {
			logWarn("update download failed", "asset", name, "error", err.Error())
			return errors.New("Update download failed. The current app is still running; retry when GitHub is reachable")
		}
	}
	logInfo("update downloaded", "tag", r.Tag, "stage", stage)
	u.phase("verifying")
	if err := verifyUpdateArchive(stage, r); err != nil {
		return err
	}
	pm, raw, err := verifyPackageManifest(stage, r)
	if err != nil {
		return err
	}
	packageDir := filepath.Join(stage, "package")
	if err := extractUpdate(filepath.Join(stage, updateArchive), packageDir, pm, raw); err != nil {
		return err
	}
	versionCtx, versionCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer versionCancel()
	out, err := u.run(versionCtx, filepath.Join(packageDir, "agent-ops.exe"), "--version")
	if err != nil || strings.TrimSpace(string(out)) != r.Tag {
		return errors.New("The downloaded app version does not match the release. The current app was kept")
	}
	m := updateManifest{Version: 2, Tag: r.Tag, Root: u.root, Data: u.data, Profile: u.profile, Package: packageDir, ParentPID: os.Getpid(), Addr: addr, Args: u.launchArgs, Hashes: map[string]string{}, Remove: pm.Remove}
	for _, f := range pm.Files {
		m.Hashes[f.Path] = f.SHA256
	}
	manifest := filepath.Join(stage, "manifest.json")
	if err := writeUpdateJSON(manifest, m); err != nil {
		return err
	}
	logInfo("update verified, starting helper", "tag", r.Tag, "files", len(pm.Files), "remove", len(pm.Remove))
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
	a := assetOf(r, updateArchive)
	if a.Name == updateArchive {
		if info.Size() != a.Size {
			return errors.New("Update size differs from the GitHub release")
		}
		if a.Digest != "" && a.Digest != "sha256:"+digest {
			return errors.New("Update digest differs from the GitHub release")
		}
	}
	return nil
}

// verifyPackageManifest checks the downloaded manifest asset against the GitHub
// release and the package rules, and that it describes this release.
func verifyPackageManifest(stage string, r appRelease) (pkgmanifest.Manifest, []byte, error) {
	var none pkgmanifest.Manifest
	file := filepath.Join(stage, updateManifestAsset)
	if err := regularUpdateFile(file); err != nil {
		return none, nil, err
	}
	b, err := os.ReadFile(file)
	if err != nil || len(b) > pkgmanifest.MaxManifestBytes {
		return none, nil, errors.New("Missing or invalid update manifest")
	}
	sum := sha256.Sum256(b)
	a := assetOf(r, updateManifestAsset)
	if int64(len(b)) != a.Size || (a.Digest != "" && a.Digest != "sha256:"+hex.EncodeToString(sum[:])) {
		return none, nil, errors.New("Update manifest differs from the GitHub release")
	}
	m, err := pkgmanifest.Parse(b)
	if err != nil {
		logWarn("update manifest rejected", "error", err.Error())
		return none, nil, errors.New("The update manifest is invalid. The current app was kept")
	}
	if m.Version != r.Tag {
		return none, nil, errors.New("The update manifest describes another version. The current app was kept")
	}
	return m, b, nil
}

// extractUpdate accepts exactly the files the manifest lists, with their exact
// sizes and digests, plus an optional manifest.json identical to the asset. All
// entries are checked before anything is written.
func extractUpdate(archive, destination string, pm pkgmanifest.Manifest, rawManifest []byte) error {
	z, err := zip.OpenReader(archive)
	if err != nil {
		return errors.New("Invalid update ZIP")
	}
	defer z.Close()
	expected := pm.Lookup()
	dirs := map[string]bool{}
	for name := range expected {
		for d := path.Dir(name); d != "."; d = path.Dir(d) {
			dirs[d+"/"] = true
		}
	}
	seen := map[string]bool{}
	var total uint64
	var embedded *zip.File
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
		if !entry.Mode().IsRegular() {
			return errors.New("Unexpected or unsafe file in update ZIP")
		}
		if name == pkgmanifest.FileName {
			if entry.UncompressedSize64 != uint64(len(rawManifest)) {
				return errors.New("The packaged manifest differs from the release manifest")
			}
			embedded = entry
			continue
		}
		f, ok := expected[name]
		if !ok {
			return errors.New("Unexpected or unsafe file in update ZIP")
		}
		if entry.UncompressedSize64 != uint64(f.Size) || total > maxUpdateBytes-entry.UncompressedSize64 {
			return errors.New("Update file size differs from the manifest")
		}
		total += entry.UncompressedSize64
	}
	for name := range expected {
		if !seen[strings.ToLower(name)] {
			return fmt.Errorf("Incomplete update package: %s", name)
		}
	}
	if embedded != nil {
		in, err := embedded.Open()
		if err != nil {
			return errors.New("Invalid update ZIP")
		}
		b, err := io.ReadAll(io.LimitReader(in, pkgmanifest.MaxManifestBytes+1))
		in.Close()
		if err != nil || !bytes.Equal(b, rawManifest) {
			return errors.New("The packaged manifest differs from the release manifest")
		}
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return err
	}
	for _, entry := range z.File {
		f, ok := expected[entry.Name]
		if entry.FileInfo().IsDir() || !ok {
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
		h := sha256.New()
		n, copyErr := io.Copy(io.MultiWriter(out, h), io.LimitReader(in, f.Size+1))
		closeErr := out.Close()
		in.Close()
		if copyErr != nil || closeErr != nil || n != f.Size {
			return errors.New("Incomplete ZIP extraction")
		}
		if hex.EncodeToString(h.Sum(nil)) != f.SHA256 {
			return fmt.Errorf("Update file digest differs from the manifest: %s", entry.Name)
		}
	}
	return nil
}

// pruneUpdateStages keeps the newest staging folders (each holds a backup of the
// files it replaced) and removes older ones. Only real directories named like
// the updater's own staging folders are touched; links are never followed.
func pruneUpdateStages(base string, keep int) {
	if keep < 0 || plainUpdatePath(base) != nil {
		return
	}
	entries, err := os.ReadDir(base)
	if err != nil {
		return
	}
	type stageDir struct {
		path string
		mod  time.Time
	}
	var stages []stageDir
	for _, e := range entries {
		if !stageName.MatchString(e.Name()) {
			continue
		}
		file := filepath.Join(base, e.Name())
		info, err := os.Lstat(file)
		if err != nil || !info.IsDir() || info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			continue
		}
		stages = append(stages, stageDir{file, info.ModTime()})
	}
	sort.Slice(stages, func(i, j int) bool { return stages[i].mod.After(stages[j].mod) })
	for i := keep; i < len(stages); i++ {
		if err := os.RemoveAll(stages[i].path); err != nil {
			logWarn("could not prune update staging folder", "path", stages[i].path, "error", err.Error())
			continue
		}
		logInfo("pruned update staging folder", "path", stages[i].path)
	}
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
			logInfo("update helper ready; exiting for replacement", "helper", cmd.Process.Pid)
			go func() { time.Sleep(time.Second); refreshMu.Lock(); os.Exit(0) }()
			return nil
		}
		time.Sleep(50 * time.Millisecond)
	}
	_ = cmd.Process.Kill()
	_ = cmd.Wait()
	return errors.New("Update helper did not become ready")
}
