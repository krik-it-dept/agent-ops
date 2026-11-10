package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/krik-it-dept/agent-ops/internal/pkgmanifest"
)

// updateManifest is the handoff from the running app (N-1) to the staged helper
// (N). The helper is always the newer binary, so it must accept every handoff
// version an installed release can still write: 1 (v0.2.0: hashes of its fixed
// file list) and 2 (hashes of the package manifest's files plus removals).
type updateManifest struct {
	Version   int               `json:"version"`
	Tag       string            `json:"tag"`
	Root      string            `json:"root"`
	Data      string            `json:"data"`
	Profile   string            `json:"profile"`
	Package   string            `json:"package"`
	ParentPID int               `json:"parentPid"`
	Addr      string            `json:"addr"`
	Args      []string          `json:"args"`
	Hashes    map[string]string `json:"hashes"`
	Remove    []string          `json:"remove,omitempty"`
}

// installFiles lists the handoff's files in a stable order.
func (m updateManifest) installFiles() []string {
	names := make([]string, 0, len(m.Hashes))
	for name := range m.Hashes {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

type updateResult struct {
	Phase   string `json:"phase"`
	Version string `json:"version"`
	Message string `json:"message"`
}

func plainUpdatePath(path string) error {
	abs, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	for current := abs; ; current = filepath.Dir(current) {
		info, err := os.Lstat(current)
		// Go reports NTFS junctions and other name-surrogate reparse points as
		// ModeIrregular, not ModeSymlink; both would redirect writes elsewhere.
		if err == nil && info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0 {
			return errors.New("Update paths cannot contain symbolic links or junctions")
		}
		if err != nil && !os.IsNotExist(err) {
			return err
		}
		if current == filepath.Dir(current) {
			break
		}
	}
	return nil
}
func regularUpdateFile(file string) error {
	if err := plainUpdatePath(file); err != nil {
		return err
	}
	info, err := os.Stat(file)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return errors.New("Update files must be regular files")
	}
	return nil
}
func atomicUpdateFile(file string, b []byte) error {
	if err := plainUpdatePath(file); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(file), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".agent-ops-write-")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return replaceUpdateFile(tmp, file)
}

// maxHandoffBytes covers a handoff at the package manifest maxima (MaxFiles
// files and MaxRemove removals of MaxPathLength each, with digests and paths),
// which is about 130 KiB, so every manifest the app accepts can be handed off.
const maxHandoffBytes = 512 << 10

func readUpdateManifest(file string) (updateManifest, error) {
	var m updateManifest
	if err := regularUpdateFile(file); err != nil {
		return m, err
	}
	f, err := os.Open(file)
	if err != nil {
		return m, err
	}
	defer f.Close()
	d := json.NewDecoder(io.LimitReader(f, maxHandoffBytes))
	d.DisallowUnknownFields()
	if err = d.Decode(&m); err != nil {
		return m, err
	}
	if (m.Version != 1 && m.Version != 2) || (m.Version == 1 && len(m.Remove) > 0) || !stableVersion.MatchString(m.Tag) || m.ParentPID <= 0 {
		return m, errors.New("Invalid update manifest")
	}
	for _, p := range []string{file, m.Root, m.Data, m.Profile, m.Package} {
		if !filepath.IsAbs(p) {
			return m, errors.New("Update paths must be absolute")
		}
		if err := plainUpdatePath(p); err != nil {
			return m, err
		}
	}
	stage := filepath.Dir(file)
	if filepath.Clean(m.Package) != filepath.Join(stage, "package") || filepath.Dir(stage) != filepath.Join(m.Data, "updates") || !strings.HasPrefix(filepath.Base(stage), "update-") {
		return m, errors.New("Update staging directory does not match its manifest")
	}
	if m.Root == m.Package || m.Root == stage {
		return m, errors.New("Cannot install into the staging directory")
	}
	host, _, err := net.SplitHostPort(m.Addr)
	if err != nil || (host != "127.0.0.1" && host != "localhost" && host != "::1") {
		return m, errors.New("Invalid update health address")
	}
	if len(m.Hashes) == 0 || len(m.Hashes) > pkgmanifest.MaxFiles || len(m.Remove) > pkgmanifest.MaxRemove || m.Hashes[pkgmanifest.RequiredFile] == "" {
		return m, errors.New("Incomplete update manifest")
	}
	installed := map[string]bool{}
	for _, name := range m.installFiles() {
		if err := pkgmanifest.ValidPath(name); err != nil || installed[strings.ToLower(name)] {
			return m, errors.New("Unsafe file in update manifest")
		}
		installed[strings.ToLower(name)] = true
		if !shaPattern.MatchString(m.Hashes[name]) {
			return m, errors.New("Missing update file digest")
		}
		source := filepath.Join(m.Package, filepath.FromSlash(name))
		if err := regularUpdateFile(source); err != nil {
			return m, err
		}
		b, err := os.ReadFile(source)
		if err != nil {
			return m, err
		}
		sum := sha256.Sum256(b)
		if hex.EncodeToString(sum[:]) != m.Hashes[name] {
			return m, errors.New("Staged update changed after verification")
		}
		if err := plainUpdatePath(filepath.Join(m.Root, filepath.FromSlash(name))); err != nil {
			return m, err
		}
	}
	for _, name := range m.Remove {
		if err := pkgmanifest.RemovablePath(name); err != nil || installed[strings.ToLower(name)] {
			return m, errors.New("Unsafe removal in update manifest")
		}
		installed[strings.ToLower(name)] = true
		if err := plainUpdatePath(filepath.Join(m.Root, filepath.FromSlash(name))); err != nil {
			return m, err
		}
	}
	return m, nil
}

type updateBackup struct {
	target, backup string
	existed        bool
}

func profileUpdateFiles(profile string) []string {
	return []string{filepath.Join(profile, ".agents", "skills", "task-plan", "SKILL.md"), filepath.Join(profile, ".claude", "skills", "task-plan", "SKILL.md"), filepath.Join(profile, ".codex", "AGENTS.md"), filepath.Join(profile, ".gemini", "GEMINI.md"), filepath.Join(profile, ".claude", "CLAUDE.md"), filepath.Join(profile, ".claude", "settings.json"), filepath.Join(profile, ".agents", "workboard-integrations.json")}
}

// Back up every replacement and removal before writing any target. The returned
// rollback covers runtime files, removed files and managed instructions, never
// task/history/preferences data.
func installUpdateFiles(m updateManifest) (func() error, error) {
	backupDir := filepath.Join(filepath.Dir(m.Package), "backup")
	if err := os.Mkdir(backupDir, 0700); err != nil {
		return nil, err
	}
	var backups []updateBackup
	var targets []string
	files := m.installFiles()
	for _, name := range files {
		targets = append(targets, filepath.Join(m.Root, filepath.FromSlash(name)))
	}
	var removals []string
	for _, name := range m.Remove {
		removals = append(removals, filepath.Join(m.Root, filepath.FromSlash(name)))
	}
	targets = append(targets, removals...)
	alias := filepath.Join(m.Root, "krik-workboard.exe")
	_, aliasErr := os.Stat(alias)
	hasAlias := aliasErr == nil
	if aliasErr != nil && !os.IsNotExist(aliasErr) {
		return nil, aliasErr
	}
	if hasAlias {
		targets = append(targets, alias)
	}
	targets = append(targets, profileUpdateFiles(m.Profile)...)
	for i, target := range targets {
		if err := plainUpdatePath(target); err != nil {
			return nil, err
		}
		b, err := os.ReadFile(target)
		exists := err == nil
		if err != nil && !os.IsNotExist(err) {
			return nil, err
		}
		backup := filepath.Join(backupDir, fmt.Sprintf("%02d", i))
		if exists {
			if err := os.WriteFile(backup, b, 0600); err != nil {
				return nil, err
			}
		}
		backups = append(backups, updateBackup{target, backup, exists})
	}
	// This manifest makes backups useful for a later manual restore too.
	if err := writeUpdateJSON(filepath.Join(backupDir, "files.json"), targets); err != nil {
		return nil, err
	}
	rollback := func() error {
		var failures []error
		for _, b := range backups {
			if b.existed {
				data, err := os.ReadFile(b.backup)
				if err == nil {
					err = atomicUpdateFile(b.target, data)
				}
				if err != nil {
					failures = append(failures, err)
				}
			} else if err := os.Remove(b.target); err != nil && !os.IsNotExist(err) {
				failures = append(failures, err)
			}
		}
		return errors.Join(failures...)
	}
	for _, name := range files {
		b, err := os.ReadFile(filepath.Join(m.Package, filepath.FromSlash(name)))
		if err == nil {
			err = atomicUpdateFile(filepath.Join(m.Root, filepath.FromSlash(name)), b)
		}
		if err != nil {
			return nil, errors.Join(err, rollback())
		}
	}
	if hasAlias {
		b, err := os.ReadFile(filepath.Join(m.Package, "agent-ops.exe"))
		if err == nil {
			err = atomicUpdateFile(alias, b)
		}
		if err != nil {
			return nil, errors.Join(err, rollback())
		}
	}
	for _, target := range removals {
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			return nil, errors.Join(err, rollback())
		}
		// Drop folders the removal emptied; a non-empty folder is left alone.
		for dir := filepath.Dir(target); !samePath(dir, m.Root) && pathWithin(dir, m.Root); dir = filepath.Dir(dir) {
			if os.Remove(dir) != nil {
				break
			}
		}
	}
	return rollback, nil
}

func updateHealth(base, version string, pid int, timeout time.Duration) bool {
	client := &http.Client{Timeout: time.Second}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		resp, err := client.Get(base + "/api/updates")
		if err == nil {
			var state updateState
			decodeErr := json.NewDecoder(io.LimitReader(resp.Body, 64<<10)).Decode(&state)
			resp.Body.Close()
			if resp.StatusCode == 200 && decodeErr == nil && state.Current == version && state.ProcessID == pid {
				data, err := client.Get(base + "/api/state")
				if err == nil {
					var snapshot struct {
						Version string `json:"appVersion"`
						Error   string `json:"error"`
						State   struct {
							Plans []json.RawMessage `json:"plans"`
						} `json:"state"`
					}
					err = json.NewDecoder(io.LimitReader(data.Body, 16<<20)).Decode(&snapshot)
					data.Body.Close()
					if data.StatusCode == 200 && err == nil && snapshot.Version == version && snapshot.Error == "" && snapshot.State.Plans != nil {
						return true
					}
				}
			}
		}
		time.Sleep(200 * time.Millisecond)
	}
	return false
}
func launchUpdatedApp(m updateManifest) (*exec.Cmd, error) {
	cmd := hidden(exec.Command(filepath.Join(m.Root, "agent-ops.exe"), m.Args...))
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	return cmd, nil
}

func applyUpdateManifest(file string) error {
	m, err := readUpdateManifest(file)
	if err != nil {
		return err
	}
	if m.ParentPID == os.Getpid() || m.Tag != appVersion {
		return errors.New("Update helper version or parent does not match")
	}
	exe, err := os.Executable()
	if err != nil || !strings.EqualFold(exe, filepath.Join(m.Package, "agent-ops.exe")) {
		return errors.New("Update helper must run from the verified staging package")
	}
	_ = initLogging(m.Data, "update.log")
	logInfo("update helper started", "tag", m.Tag, "handoff", m.Version, "files", len(m.Hashes), "remove", len(m.Remove), "parent", m.ParentPID)
	parent, err := openUpdateParent(m.ParentPID, m.Root)
	if err != nil {
		return err
	}
	defer closeUpdateParent(parent)
	if err := os.WriteFile(filepath.Join(filepath.Dir(file), "ready"), []byte("ready"), 0600); err != nil {
		return err
	}
	if err := waitUpdateParent(parent, 45*time.Second); err != nil {
		return err
	}
	resultFile := filepath.Join(m.Data, "update-result.json")
	logInfo("previous app exited; installing")
	rollback, err := installUpdateFiles(m)
	if err != nil {
		logError("installation failed; previous files restored", "error", err.Error())
		_ = writeUpdateJSON(resultFile, updateResult{"error", m.Tag, "Update installation failed; recovery was attempted. Backups are in the update staging folder."})
		_, _ = launchUpdatedApp(m)
		return err
	}
	recoverOld := func(cause error) error {
		restoreErr := rollback()
		message := "The update could not start. The previous version and reporting instructions were restored."
		if restoreErr != nil {
			message = "Update recovery was incomplete. Restore the saved files from the update staging backup before retrying."
		}
		_ = writeUpdateJSON(resultFile, updateResult{"error", m.Tag, message})
		_, restartErr := launchUpdatedApp(m)
		failure := errors.Join(cause, restoreErr, restartErr)
		logError("update rolled back", "error", failure.Error(), "restored", restoreErr == nil)
		return failure
	}
	message := "Updated to " + m.Tag
	// Only a package that still ships the reporting installer runs it.
	if m.Hashes[integrationInstaller] != "" {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		installed, err := runUpdateCommand(ctx, "node", filepath.Join(m.Root, filepath.FromSlash(integrationInstaller)), "--home", m.Profile, "--runtime-dir", m.Root)
		cancel()
		if err != nil {
			return recoverOld(errors.New("Reporting instruction update failed"))
		}
		message += keptIntegrationsNote(installed)
	}
	cmd, err := launchUpdatedApp(m)
	if err != nil {
		return recoverOld(err)
	}
	if !updateHealth("http://"+m.Addr, m.Tag, cmd.Process.Pid, 45*time.Second) {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		return recoverOld(errors.New("Updated application failed its startup check"))
	}
	logInfo("update installed and healthy", "tag", m.Tag, "pid", cmd.Process.Pid)
	return writeUpdateJSON(resultFile, updateResult{"updated", m.Tag, message})
}

const integrationInstaller = "integrations/install-task-reporting.mjs"

// keptIntegrationsNote names the skill, hook and instruction files the reporting
// installer left alone because the owner changed or removed them.
func keptIntegrationsNote(installerOutput []byte) string {
	var out struct {
		Kept []struct {
			File   string `json:"file"`
			Reason string `json:"reason"`
		} `json:"kept"`
	}
	if json.Unmarshal(installerOutput, &out) != nil || len(out.Kept) == 0 {
		return ""
	}
	seen := map[string]bool{}
	files := []string{}
	for _, k := range out.Kept {
		item := k.File + " (" + k.Reason + ")"
		if !seen[item] {
			seen[item] = true
			files = append(files, item)
		}
	}
	return ". Your changes were kept, so these were not updated: " + strings.Join(files, "; ")
}
