package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"sort"
	"strings"
	"testing"

	"github.com/krik-it-dept/agent-ops/internal/pkgmanifest"
)

type setupRegistry struct {
	fakeRegistry
	numbers  map[string]uint32
	failName string
}

func newSetupRegistry() *setupRegistry {
	return &setupRegistry{fakeRegistry: fakeRegistry{}, numbers: map[string]uint32{}}
}
func (r *setupRegistry) GetDWORD(key, name string) (uint32, bool) {
	v, ok := r.numbers[key+"/"+name]
	return v, ok
}
func (r *setupRegistry) SetDWORD(key, name string, value uint32) error {
	if name == r.failName {
		return errors.New("injected registry failure")
	}
	r.numbers[key+"/"+name] = value
	return nil
}
func (r *setupRegistry) SetString(key, name, value string) error {
	if name == r.failName {
		return errors.New("injected registry failure")
	}
	return r.fakeRegistry.SetString(key, name, value)
}
func (r *setupRegistry) DeleteValue(key, name string) error {
	delete(r.numbers, key+"/"+name)
	return r.fakeRegistry.DeleteValue(key, name)
}

func setupFixture(t *testing.T) (installLayout, string, pkgmanifest.Manifest, *setupRegistry, installEffects) {
	t.Helper()
	base := t.TempDir()
	l := installLayout{Root: filepath.Join(base, "Programs", "AgentOps"), Legacy: filepath.Join(base, "previous runtime"), Data: filepath.Join(base, "data"), Shortcut: filepath.Join(base, "start menu", "Agent Ops.lnk")}
	stage := filepath.Join(base, "transaction", "package")
	updatePut(t, filepath.Join(stage, "agent-ops.exe"), []byte("new exe"))
	updatePut(t, filepath.Join(stage, "NOTICE.md"), []byte("notice"))
	for _, name := range legacyStubs {
		updatePut(t, filepath.Join(stage, name), []byte("stub "+name))
	}
	manifest, err := pkgmanifest.Generate(stage, "v0.3.0", nil)
	if err != nil {
		t.Fatal(err)
	}
	r := newSetupRegistry()
	r.failName = "never-fail"
	fx := installEffects{Registry: r, Stop: func(string) error { return nil }, Shortcut: func(path, exe string) error { return atomicUpdateFile(path, []byte(exe+"|"+toastAppID)) }, Launch: func(string) (int, error) { return 123, nil }, Healthy: func(pid int) bool { return pid == 123 }}
	return l, stage, manifest, r, fx
}

func TestSelfInstallMigratesOnlyAfterHealthAndKeepsData(t *testing.T) {
	l, stage, m, r, fx := setupFixture(t)
	updatePut(t, filepath.Join(l.Legacy, "private.json"), []byte("private"))
	updatePut(t, filepath.Join(l.Data, "config.json"), []byte("preferences"))
	r.SetString(runKey, legacyRunValue, "old startup")
	r.SetString(runKey, "Unrelated", "keep")
	fx.Healthy = func(pid int) bool {
		if !exists(l.Legacy) {
			t.Error("legacy moved before health")
		}
		if got := mread(t, filepath.Join(l.Root, "agent-ops.exe")); got != "new exe" {
			t.Error(got)
		}
		return true
	}
	if err := installSelf(l, stage, m, false, fx); err != nil {
		t.Fatal(err)
	}
	if exists(filepath.Join(l.Legacy, "private.json")) {
		t.Fatal("old location retained after success")
	}
	backups, _ := filepath.Glob(l.Legacy + ".backup-*")
	if len(backups) != 1 || mread(t, filepath.Join(backups[0], "private.json")) != "private" {
		t.Fatal("legacy backup missing", backups)
	}
	// Older sessions still call the stubs by the previous path.
	for _, name := range legacyStubs {
		if mread(t, filepath.Join(l.Legacy, name)) != "stub "+name {
			t.Fatal("stub not kept at the previous location", name)
		}
	}
	if entries, _ := os.ReadDir(l.Legacy); len(entries) != len(legacyStubs) {
		t.Fatal("previous location holds more than the stubs", entries)
	}
	if mread(t, filepath.Join(l.Data, "config.json")) != "preferences" {
		t.Fatal("data changed")
	}
	if v, _ := r.GetString(runKey, runName); v != `"`+filepath.Join(l.Root, "agent-ops.exe")+`" --background` {
		t.Fatal(v)
	}
	if _, ok := r.GetString(runKey, legacyRunValue); ok {
		t.Fatal("legacy startup not retired")
	}
	if v, _ := r.GetString(runKey, "Unrelated"); v != "keep" {
		t.Fatal(v)
	}
	for _, name := range []string{"DisplayName", "DisplayVersion", "Publisher", "DisplayIcon", "UninstallString", "InstallLocation"} {
		if _, ok := r.GetString(uninstallKey, name); !ok {
			t.Fatal("missing", name)
		}
	}
	for _, name := range []string{"EstimatedSize", "NoModify", "NoRepair"} {
		if _, ok := r.GetDWORD(uninstallKey, name); !ok {
			t.Fatal("missing DWORD", name)
		}
	}
	// Repeat with a fresh transaction; no startup/data preference is lost.
	stage2 := filepath.Join(filepath.Dir(filepath.Dir(stage)), "transaction2", "package")
	for _, f := range m.Files {
		updatePut(t, filepath.Join(stage2, f.Path), []byte(mread(t, filepath.Join(stage, f.Path))))
	}
	fx.Healthy = func(int) bool { return true }
	if err := installSelf(l, stage2, m, false, fx); err != nil {
		t.Fatal(err)
	}
	// A previous location holding only the stubs is not moved again.
	if backups, _ = filepath.Glob(l.Legacy + ".backup-*"); len(backups) != 1 || !exists(filepath.Join(l.Legacy, "task-report.mjs")) {
		t.Fatal("stub-only previous location moved again", backups)
	}
}

func TestSelfInstallRollsBackFailures(t *testing.T) {
	for _, failure := range []string{"registry", "shortcut", "launch", "health", "stop"} {
		t.Run(failure, func(t *testing.T) {
			l, stage, m, r, fx := setupFixture(t)
			updatePut(t, filepath.Join(l.Root, "agent-ops.exe"), []byte("old exe"))
			updatePut(t, l.Shortcut, []byte("old shortcut"))
			updatePut(t, filepath.Join(l.Legacy, "private.json"), []byte("private"))
			r.SetString(uninstallKey, "DisplayName", "previous name")
			r.SetDWORD(uninstallKey, "NoRepair", 7)
			r.SetString(runKey, legacyRunValue, "old startup")
			switch failure {
			case "registry":
				r.failName = "EstimatedSize"
			case "shortcut":
				fx.Shortcut = func(string, string) error { return errors.New("shortcut failure") }
			case "launch":
				fx.Launch = func(string) (int, error) { return 0, errors.New("launch failure") }
			case "health":
				fx.Healthy = func(int) bool { return false }
			case "stop":
				fx.Stop = func(string) error { return errors.New("stop failure") }
			}
			if err := installSelf(l, stage, m, false, fx); err == nil {
				t.Fatal("failure ignored")
			}
			if mread(t, filepath.Join(l.Root, "agent-ops.exe")) != "old exe" || mread(t, l.Shortcut) != "old shortcut" {
				t.Fatal("rollback lost files")
			}
			if !exists(l.Legacy) {
				t.Fatal("legacy moved on failure")
			}
			if v, _ := r.GetString(uninstallKey, "DisplayName"); v != "previous name" {
				t.Fatal("registry not restored", v)
			}
			if v, _ := r.GetDWORD(uninstallKey, "NoRepair"); v != 7 {
				t.Fatal("DWORD not restored", v)
			}
		})
	}
}

func TestSelfInstallRejectsTamperingAndOverlappingPathsBeforeEffects(t *testing.T) {
	for _, bad := range []string{"tamper", "overlap", "case overlap", "relative", "root"} {
		t.Run(bad, func(t *testing.T) {
			l, stage, m, _, fx := setupFixture(t)
			switch bad {
			case "tamper":
				updatePut(t, filepath.Join(stage, "agent-ops.exe"), []byte("changed"))
			case "overlap":
				l.Data = filepath.Join(l.Root, "data")
			case "case overlap":
				l.Data = strings.ToUpper(l.Root) + `\data`
			case "relative":
				l.Root = "relative"
			case "root":
				l.Root = filepath.VolumeName(l.Root) + `\`
			}
			fx.Stop = func(string) error { t.Fatal("side effect before validation"); return nil }
			if err := installSelf(l, stage, m, false, fx); err == nil {
				t.Fatal("unsafe install accepted")
			}
		})
	}
}

func TestSelfInstallerEmbeddedPayloadMatchesPackage(t *testing.T) {
	stage := filepath.Join(t.TempDir(), "package")
	exe := filepath.Join(t.TempDir(), "source.exe")
	updatePut(t, exe, []byte("fake exe"))
	m, err := stageSelfInstaller(exe, stage)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, f := range m.Files {
		names = append(names, f.Path)
		if f.Path != "agent-ops.exe" && mread(t, filepath.Join(stage, f.Path)) != mread(t, filepath.FromSlash(f.Path)) {
			t.Fatal("embedded payload differs", f.Path)
		}
	}
	if want := append([]string{"agent-ops.exe"}, packagePayload...); !sameSet(names, want) {
		t.Fatal(names, want)
	}
	for _, name := range names {
		if strings.HasSuffix(name, ".mjs") && name != "task-sync.mjs" && name != "task-report.mjs" {
			t.Fatal("Node runtime file in the package", name)
		}
	}
}

// psList reads a single-line PowerShell array assignment such as
// $files = @('a','b') from a script.
func psList(t *testing.T, script, variable string) []string {
	t.Helper()
	m := regexp.MustCompile(`(?m)^\s*\` + variable + ` = @\(([^)]*)\)`).FindStringSubmatch(mread(t, script))
	if m == nil {
		t.Fatalf("%s not found in %s", variable, script)
	}
	out := []string{}
	for _, item := range strings.Split(m[1], ",") {
		out = append(out, strings.Trim(strings.TrimSpace(item), "'"))
	}
	return out
}

func sameSet(a, b []string) bool {
	x, y := append([]string{}, a...), append([]string{}, b...)
	sort.Strings(x)
	sort.Strings(y)
	return reflect.DeepEqual(x, y)
}

// The self-installer, the ZIP build (package and update manifest) and the ZIP
// installer install and retire the same files.
func TestPackageFileListsAgree(t *testing.T) {
	pkg := append([]string{"agent-ops.exe"}, packagePayload...)
	if got := psList(t, "scripts/build.ps1", "$packageFiles"); !sameSet(got, pkg) {
		t.Fatal("build.ps1 package", got, pkg)
	}
	// install.ps1 runs from the package and does not copy itself.
	if got := psList(t, "scripts/install.ps1", "$files"); !sameSet(append(got, "scripts/install.ps1"), pkg) {
		t.Fatal("install.ps1 files", got, pkg)
	}
	for _, script := range []struct{ file, variable string }{{"scripts/build.ps1", "$removedFiles"}, {"scripts/install.ps1", "$retired"}} {
		if got := psList(t, script.file, script.variable); !sameSet(got, selfInstallRemovals) {
			t.Fatal(script.file, got, selfInstallRemovals)
		}
	}
	for _, name := range selfInstallRemovals {
		for _, kept := range pkg {
			if strings.EqualFold(name, kept) {
				t.Fatal("a package file is also removed", name)
			}
		}
	}
}

func TestNewInstallLocationHasMigrationScopeWithoutWideningIsolatedRuns(t *testing.T) {
	home := userHome()
	root := filepath.Join(profileLocalAppData(home), "Programs", "AgentOps")
	o := migrationOptions{Profile: home, DataDir: defaultDataDir(), RuntimeDir: root}
	if !o.installedInstance() || !o.clientsInScope() {
		t.Fatal("new installed location cannot perform existing one-time migration")
	}
	o.DataDir = t.TempDir()
	if o.installedInstance() || o.clientsInScope() || o.inDeletionScope(root) {
		t.Fatal("isolated instance acquired real profile scope")
	}
}

func TestInstallerRefusesJunctionTargetBeforeStoppingProcesses(t *testing.T) {
	l, stage, m, _, fx := setupFixture(t)
	outside := t.TempDir()
	junction(t, l.Root, outside)
	fx.Stop = func(string) error { t.Fatal("process stopped before path rejection"); return nil }
	if err := installSelf(l, stage, m, false, fx); err == nil {
		t.Fatal("junction accepted")
	}
}

func TestSelfInstallRollsBackExistingClientMigrationOnFailedHealth(t *testing.T) {
	l, stage, m, r, fx := setupFixture(t)
	f := newMigrationFixture(t)
	client := filepath.Join(f.profile, ".claude", "settings.json")
	before := mread(t, client)
	r.SetString(runKey, legacyRunValue, "previous startup")
	fx.Migrate = func(installLayout) (*migrationResult, error) { return migrateClients(f.opts) }
	fx.Healthy = func(int) bool {
		if mread(t, client) == before {
			t.Error("client migration never ran")
		}
		r.DeleteValue(runKey, legacyRunValue) // startup may retire it before health
		return false
	}
	fx.FinishMigration = func(installLayout, *migrationResult) error { t.Fatal("migration finalized before health"); return nil }
	if err := installSelf(l, stage, m, false, fx); err == nil {
		t.Fatal("health failure ignored")
	}
	if mread(t, client) != before {
		t.Fatal("client rollback lost owner settings")
	}
	if value, _ := r.GetString(runKey, legacyRunValue); value != "previous startup" {
		t.Fatal("legacy registration was lost", value)
	}
}

func TestNativeShortcutInTemporaryFolderHasAUMID(t *testing.T) {
	base := t.TempDir()
	exe := filepath.Join(base, "app with spaces ' & chars.exe")
	link := filepath.Join(base, "Agent Ops.lnk")
	updatePut(t, exe, []byte("fake"))
	if err := createInstallShortcut(link, exe); err != nil {
		t.Fatal(err)
	}
	output, err := setupPowerShell(`$shell=New-Object -ComObject Shell.Application; $folder=$shell.Namespace([IO.Path]::GetDirectoryName($env:AGENT_OPS_LINK)); $item=$folder.ParseName([IO.Path]::GetFileName($env:AGENT_OPS_LINK)); [Console]::Write($item.ExtendedProperty('System.AppUserModel.ID'))`, map[string]string{"AGENT_OPS_LINK": link}).CombinedOutput()
	if err != nil || string(output) != toastAppID {
		t.Fatal(err, string(output))
	}
}

func TestInstallRegistrationRollbackPreservesUnrelatedValues(t *testing.T) {
	r := newSetupRegistry()
	r.failName = "never-fail"
	r.SetString(runKey, "Other", "value")
	before := fakeRegistry{strings.ToLower(runKey): {"Other": "value"}}
	undo, err := writeInstallValues(r, []installValue{{Key: runKey, Name: runName, Text: "app"}, {Key: uninstallKey, Name: "EstimatedSize", DWORD: true, Number: 42}})
	if err != nil {
		t.Fatal(err)
	}
	if err = undo(); err != nil {
		t.Fatal(err)
	}
	if len(r.numbers) != 0 || !reflect.DeepEqual(r.fakeRegistry[strings.ToLower(runKey)], before[strings.ToLower(runKey)]) {
		t.Fatal(r)
	}
}
