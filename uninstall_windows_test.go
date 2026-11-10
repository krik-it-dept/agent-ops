package main

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestUninstallKeepsDataUnlessSelectedAndOnlyRemovesOwnedEntries(t *testing.T) {
	for _, keep := range []bool{true, false} {
		t.Run(map[bool]string{true: "keep", false: "delete"}[keep], func(t *testing.T) {
			l, _, _, r, _ := setupFixture(t)
			updatePut(t, filepath.Join(l.Root, "agent-ops.exe"), []byte("app"))
			updatePut(t, l.Shortcut, []byte("shortcut"))
			updatePut(t, filepath.Join(l.Data, "config.json"), []byte("preferences"))
			r.SetString(runKey, runName, "app")
			r.SetString(runKey, "Other", "keep")
			for _, key := range []string{protocolKey, toastAppKey, uninstallKey} {
				r.SetString(key, "test", "value")
			}
			integrations := false
			fx := uninstallEffects{Registry: r, Stop: func(string) error { return nil }, RemoveIntegrations: func() error { integrations = true; return nil }, ScheduleDelete: func(root, data string) error {
				if root != l.Root || ((data == "") != keep) {
					t.Fatal("unexpected delete targets", root, data)
				}
				if data != "" {
					if err := removeInstallTree(data); err != nil {
						return err
					}
				}
				return removeInstallTree(root)
			}}
			if err := uninstallSelf(l, uninstallChoice{Confirmed: true, KeepData: keep}, fx); err != nil {
				t.Fatal(err)
			}
			if integrations || exists(l.Root) || exists(l.Shortcut) || exists(l.Data) != keep {
				t.Fatal("uninstall changed wrong files")
			}
			if v, _ := r.GetString(runKey, "Other"); v != "keep" {
				t.Fatal(v)
			}
			if _, ok := r.GetString(runKey, runName); ok {
				t.Fatal("startup retained")
			}
			for _, key := range []string{protocolKey, toastAppKey, uninstallKey} {
				if _, ok := r.GetString(key, "test"); ok {
					t.Fatal("registration retained", key)
				}
			}
		})
	}
}

func TestUninstallCancelAndIntegrationFailurePreserveInstall(t *testing.T) {
	l, _, _, r, _ := setupFixture(t)
	updatePut(t, l.Shortcut, []byte("shortcut"))
	called := false
	fx := uninstallEffects{Registry: r, Stop: func(string) error { called = true; return nil }, RemoveIntegrations: func() error { return errors.New("locally modified") }, ScheduleDelete: func(string, string) error { t.Fatal("delete on failure"); return nil }}
	if err := uninstallSelf(l, uninstallChoice{}, fx); err != nil || called {
		t.Fatal("cancel changed install", err)
	}
	if err := uninstallSelf(l, uninstallChoice{Confirmed: true, KeepData: false, RemoveIntegrations: true}, fx); err == nil {
		t.Fatal("integration failure ignored")
	}
	if !exists(l.Shortcut) {
		t.Fatal("install removed despite integration failure")
	}
}

func TestUninstallReusesGuardedIntegrationRemoval(t *testing.T) {
	integrationsFixture(t)
	cfg := defaultAppConfig()
	dir := filepath.Join(profileDir, "skills")
	file := skillFileOf(dir)
	updatePut(t, file, embeddedSkill)
	text := filepath.Join(profileDir, "AGENTS.md")
	updatePut(t, text, []byte("Owner text\n\n"+instructionBlock()+"\n"))
	cfg.Integrations = []IntegrationTarget{{ID: "test", Label: "test", Source: "custom", SkillDir: dir, InstructionFile: text, InstructionBlock: true, Enabled: false, SHA256: sha256Hex([]byte(lfText(embeddedSkill))), InstructionSHA256: sha256Hex([]byte(instructionBlock()))}}
	if err := writeAppConfig(configFilePath(dataDir), cfg); err != nil {
		t.Fatal(err)
	}
	if err := removeSetupIntegrations(); err != nil {
		t.Fatal(err)
	}
	if exists(file) || mread(t, text) != "Owner text\n" {
		t.Fatal("managed removal differs", mread(t, text))
	}
	cfg, err := readAppConfig(configFilePath(dataDir))
	if err != nil || cfg.Integrations[0].Enabled {
		t.Fatal("disabled preference changed", err)
	}
	backups, _ := filepath.Glob(filepath.Join(dataDir, "backups", "integrations", "*"))
	if len(backups) == 0 {
		t.Fatal("no integration backups")
	}
	updatePut(t, file, []byte("owner edited"))
	cfg.Integrations[0].SHA256 = "recorded-other-hash"
	if err = writeAppConfig(configFilePath(dataDir), cfg); err != nil {
		t.Fatal(err)
	}
	if err = removeSetupIntegrations(); err == nil {
		t.Fatal("removed locally edited skill")
	}
	if mread(t, file) != "owner edited" {
		t.Fatal("edited skill changed")
	}
}

func TestSetupCleanupChild(t *testing.T) {
	root := os.Getenv("AGENT_OPS_TEST_DELETE")
	if root == "" {
		return
	}
	cmd, err := startInstallDelete(root, "", os.Getenv("AGENT_OPS_TEST_CLEANUP_LOG"))
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("cleanup-pid=%d\n", cmd.Process.Pid)
}

// The cleanup worker waits for the process that scheduled it (here a child
// test process) to exit, then removes only the given folder. The test waits
// for the worker itself, so a slow runner cannot fail it and a refused path
// shows the worker's reason. The short-name case is a temp folder under
// C:\Users\RUNNER~1, as on CI.
func TestDeferredSelfDeleteUsesOnlyTemporaryTarget(t *testing.T) {
	for _, short := range []bool{false, true} {
		t.Run(fmt.Sprint("short=", short), func(t *testing.T) {
			base := t.TempDir()
			target := filepath.Join(base, "installed runtime ' & spaces")
			neighbour := filepath.Join(base, "neighbour", "keep.txt")
			updatePut(t, filepath.Join(target, "app.exe"), []byte("app"))
			updatePut(t, neighbour, []byte("keep"))
			given := target
			if short {
				given = shortPathName(t, target)
				if strings.EqualFold(given, target) {
					t.Skip("this volume has no 8.3 short names")
				}
			}
			log := filepath.Join(t.TempDir(), "cleanup.log")
			exe, err := os.Executable()
			if err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command(exe, "-test.run=^TestSetupCleanupChild$")
			cmd.Env = append(os.Environ(), "AGENT_OPS_TEST_DELETE="+given, "AGENT_OPS_TEST_CLEANUP_LOG="+log)
			output, err := cmd.CombinedOutput()
			if err != nil {
				t.Fatal(err, string(output))
			}
			var pid int
			if _, err = fmt.Sscanf(string(output[bytes.Index(output, []byte("cleanup-pid=")):]), "cleanup-pid=%d", &pid); err != nil {
				t.Fatal(err, string(output))
			}
			if code, waited := waitProcessExit(pid, 3*time.Minute); !waited || code != 0 {
				reason, _ := os.ReadFile(log)
				t.Fatalf("cleanup worker exit %d (waited %v): %s", code, waited, reason)
			}
			if reason, _ := os.ReadFile(log); len(reason) > 0 {
				t.Fatalf("cleanup worker reported: %s", reason)
			}
			if exists(target) {
				t.Fatal("deferred removal did not finish")
			}
			if mread(t, neighbour) != "keep" {
				t.Fatal("removal reached beyond its target")
			}
		})
	}
}

func shortPathName(t *testing.T, p string) string {
	t.Helper()
	from, _ := windows.UTF16PtrFromString(p)
	buf := make([]uint16, 1024)
	n, err := windows.GetShortPathName(from, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		t.Fatal("short path:", err)
	}
	return windows.UTF16ToString(buf[:n])
}

// waitProcessExit waits for a process that is not a child of this one. A
// process already gone counts as exited with code 0; the log then tells.
func waitProcessExit(pid int, timeout time.Duration) (uint32, bool) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, true
	}
	defer windows.CloseHandle(h)
	if ev, _ := windows.WaitForSingleObject(h, uint32(timeout/time.Millisecond)); ev != windows.WAIT_OBJECT_0 {
		return 0, false
	}
	var code uint32
	if windows.GetExitCodeProcess(h, &code) != nil {
		return 1, true
	}
	return code, true
}
