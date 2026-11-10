package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"
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
	if err := scheduleInstallDelete(root, ""); err != nil {
		t.Fatal(err)
	}
}

func TestDeferredSelfDeleteUsesOnlyTemporaryTarget(t *testing.T) {
	base := t.TempDir()
	target := filepath.Join(base, "installed runtime ' & spaces")
	updatePut(t, filepath.Join(target, "app.exe"), []byte("app"))
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(exe, "-test.run=^TestSetupCleanupChild$")
	cmd.Env = append(os.Environ(), "AGENT_OPS_TEST_DELETE="+target)
	if output, err := cmd.CombinedOutput(); err != nil {
		t.Fatal(err, string(output))
	}
	deadline := time.Now().Add(15 * time.Second)
	for exists(target) && time.Now().Before(deadline) {
		time.Sleep(100 * time.Millisecond)
	}
	if exists(target) {
		t.Fatal("deferred removal did not finish")
	}
}
