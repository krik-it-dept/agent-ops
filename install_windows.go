package main

// The downloadable executable carries its runtime. Installation uses the same
// atomic file replacement and rollback as the updater; the app remains a reader.
import (
	"embed"
	"errors"
	"flag"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/krik-it-dept/agent-ops/internal/pkgmanifest"
)

//go:embed tasks-overview.mjs plan-reader.mjs task-sync.mjs task-report.mjs NOTICE.md INSTALL.md integrations/install-task-reporting.mjs scripts/install.ps1
var installPayload embed.FS

const uninstallKey = `Software\Microsoft\Windows\CurrentVersion\Uninstall\AgentOps`

var installRequested, uninstallRequested, installStartup bool
var setupParent int

// Same retired program files as the ZIP manifest; runtime JSON is never removed.
var selfInstallRemovals = []string{"execution-roles.mjs", "execution-reports.mjs", "historical-executions.mjs", "agent-attribution.mjs", "skills/task-plan/SKILL.md"}

type installLayout struct{ Root, Legacy, Data, Shortcut string }

func userInstallLayout() installLayout {
	home, _ := os.UserHomeDir()
	return installLayout{
		Root:     filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "AgentOps"),
		Legacy:   filepath.Join(home, legacyRuntimeRel),
		Data:     defaultDataDir(),
		Shortcut: filepath.Join(os.Getenv("APPDATA"), "Microsoft", "Windows", "Start Menu", "Programs", "Agent Ops.lnk"),
	}
}

// All machine effects are injected. Unit tests never use HKCU, the Start menu,
// the real install/data folders, or a running installed application's port.
type installRegistry interface {
	registryStore
	GetDWORD(string, string) (uint32, bool)
	SetDWORD(string, string, uint32) error
}
type installEffects struct {
	Registry        installRegistry
	Shortcut        func(string, string) error
	Stop            func(string) error
	Launch          func(string) (int, error)
	Healthy         func(int) bool
	Migrate         func(installLayout) (*migrationResult, error)
	FinishMigration func(installLayout, *migrationResult) error
}

type installValue struct {
	Key, Name, Text string
	Number          uint32
	DWORD           bool
}

func installValues(l installLayout, startup bool, size uint32) []installValue {
	exe := filepath.Join(l.Root, "agent-ops.exe")
	values := []installValue{}
	for name, value := range map[string]string{
		"DisplayName": "Agent Ops", "DisplayVersion": appVersion,
		"Publisher": "Krik IT", "DisplayIcon": exe + ",0",
		"UninstallString": `"` + exe + `" --uninstall`, "InstallLocation": l.Root,
	} {
		values = append(values, installValue{Key: uninstallKey, Name: name, Text: value})
	}
	for name, value := range map[string]uint32{"EstimatedSize": size, "NoModify": 1, "NoRepair": 1} {
		values = append(values, installValue{Key: uninstallKey, Name: name, Number: value, DWORD: true})
	}
	values = append(values,
		installValue{Key: protocolKey, Text: "URL:Agent Ops"},
		installValue{Key: protocolKey, Name: "URL Protocol"},
		installValue{Key: protocolKey + `\shell\open\command`, Text: protocolCommand(exe)},
		installValue{Key: toastAppKey, Name: "DisplayName", Text: toastAppName},
		installValue{Key: toastAppKey, Name: "IconUri", Text: exe},
	)
	if startup {
		values = append(values, installValue{Key: runKey, Name: runName, Text: `"` + exe + `" --background`})
	}
	return values
}

// Snapshot each value we own before changing it. Unrelated Run values and
// registrations are never enumerated or overwritten.
func writeInstallValues(r installRegistry, values []installValue) (func() error, error) {
	type saved struct {
		value  installValue
		exists bool
	}
	before := []saved{}
	restore := func() error {
		var errs []error
		for i := len(before) - 1; i >= 0; i-- {
			v := before[i]
			if !v.exists {
				errs = append(errs, r.DeleteValue(v.value.Key, v.value.Name))
			} else if v.value.DWORD {
				errs = append(errs, r.SetDWORD(v.value.Key, v.value.Name, v.value.Number))
			} else {
				errs = append(errs, r.SetString(v.value.Key, v.value.Name, v.value.Text))
			}
		}
		return errors.Join(errs...)
	}
	for _, v := range values {
		old := v
		var exists bool
		if v.DWORD {
			old.Number, exists = r.GetDWORD(v.Key, v.Name)
		} else {
			old.Text, exists = r.GetString(v.Key, v.Name)
		}
		before = append(before, saved{old, exists})
		var err error
		if v.DWORD {
			err = r.SetDWORD(v.Key, v.Name, v.Number)
		} else {
			err = r.SetString(v.Key, v.Name, v.Text)
		}
		if err != nil {
			return nil, errors.Join(err, restore())
		}
	}
	return restore, nil
}

func stageSelfInstaller(exe, stage string) (pkgmanifest.Manifest, error) {
	if err := regularUpdateFile(exe); err != nil {
		return pkgmanifest.Manifest{}, err
	}
	b, err := os.ReadFile(exe)
	if err != nil {
		return pkgmanifest.Manifest{}, err
	}
	if err = atomicUpdateFile(filepath.Join(stage, "agent-ops.exe"), b); err != nil {
		return pkgmanifest.Manifest{}, err
	}
	for _, name := range []string{"tasks-overview.mjs", "plan-reader.mjs", "task-sync.mjs", "task-report.mjs", "NOTICE.md", "INSTALL.md", "integrations/install-task-reporting.mjs", "scripts/install.ps1"} {
		b, err = installPayload.ReadFile(name)
		if err == nil {
			err = atomicUpdateFile(filepath.Join(stage, filepath.FromSlash(name)), b)
		}
		if err != nil {
			return pkgmanifest.Manifest{}, err
		}
	}
	return pkgmanifest.Generate(stage, appVersion, selfInstallRemovals)
}

func installSelf(l installLayout, stage string, manifest pkgmanifest.Manifest, startup bool, fx installEffects) (err error) {
	if err = manifest.Validate(); err != nil {
		return err
	}
	if manifest.Version != appVersion {
		return errors.New("Installer manifest version differs from the executable")
	}
	if err = validateInstallLayout(l, stage); err != nil {
		return err
	}
	m := updateManifest{Root: l.Root, Package: stage, Hashes: map[string]string{}, Remove: manifest.Remove}
	var size int64
	for _, f := range manifest.Files {
		if err = plainUpdatePath(filepath.Join(l.Root, filepath.FromSlash(f.Path))); err != nil {
			return err
		}
		file := filepath.Join(stage, filepath.FromSlash(f.Path))
		if err = regularUpdateFile(file); err != nil {
			return err
		}
		b, e := os.ReadFile(file)
		if e != nil {
			return e
		}
		if int64(len(b)) != f.Size || sha256Hex(b) != f.SHA256 {
			return fmt.Errorf("Installer payload changed: %s", f.Path)
		}
		m.Hashes[f.Path] = f.SHA256
		size += f.Size
	}
	for _, name := range manifest.Remove {
		if err = plainUpdatePath(filepath.Join(l.Root, filepath.FromSlash(name))); err != nil {
			return err
		}
	}
	shortcut, e := os.ReadFile(l.Shortcut)
	if e != nil && !os.IsNotExist(e) {
		return e
	}
	shortcutExisted := e == nil
	// The launched app may retire these entries itself when an earlier migration
	// is already recorded. Preserve them until startup has passed its health gate.
	legacyValues := []installValue{}
	for _, item := range []struct{ key, name string }{
		{runKey, legacyRunValue}, {`Software\Classes\` + legacyProtocol, ""},
		{`Software\Classes\` + legacyProtocol, "URL Protocol"},
		{`Software\Classes\` + legacyProtocol + `\shell\open\command`, ""},
	} {
		if value, ok := fx.Registry.GetString(item.key, item.name); ok {
			legacyValues = append(legacyValues, installValue{Key: item.key, Name: item.name, Text: value})
		}
	}
	if err = fx.Stop(l.Root); err != nil {
		return err
	}
	if err = fx.Stop(l.Legacy); err != nil {
		return err
	}
	rollbackFiles, err := installUpdateFiles(m)
	if err != nil {
		return err
	}
	var rollbackRegistry func() error
	launched := false
	committed := false
	var migrated *migrationResult
	defer func() {
		if err == nil || committed {
			return
		}
		if launched {
			err = errors.Join(err, fx.Stop(l.Root))
		}
		for _, problem := range rollbackClients(migrated) {
			err = errors.Join(err, errors.New(problem))
		}
		if rollbackRegistry != nil {
			err = errors.Join(err, rollbackRegistry())
		}
		for _, value := range legacyValues {
			err = errors.Join(err, fx.Registry.SetString(value.Key, value.Name, value.Text))
		}
		if shortcutExisted {
			err = errors.Join(err, atomicUpdateFile(l.Shortcut, shortcut))
		} else if e := os.Remove(l.Shortcut); e != nil && !os.IsNotExist(e) {
			err = errors.Join(err, e)
		}
		err = errors.Join(err, rollbackFiles())
	}()
	// Preserve an existing startup preference, including a legacy installation.
	_, enabled := fx.Registry.GetString(runKey, runName)
	_, legacyEnabled := fx.Registry.GetString(runKey, legacyRunValue)
	rollbackRegistry, err = writeInstallValues(fx.Registry, installValues(l, startup || enabled || legacyEnabled, uint32((size+1023)/1024)))
	if err != nil {
		return err
	}
	if err = fx.Shortcut(l.Shortcut, filepath.Join(l.Root, "agent-ops.exe")); err != nil {
		return err
	}
	if fx.Migrate != nil {
		migrated, err = fx.Migrate(l)
		if err != nil {
			return err
		}
	}
	pid, err := fx.Launch(filepath.Join(l.Root, "agent-ops.exe"))
	if err != nil {
		return err
	}
	launched = true
	if !fx.Healthy(pid) {
		return errors.New("Installed application failed its process/version/state health check; runtime and registrations restored")
	}
	// Health is the transaction's commit point. Subsequent housekeeping failures
	// keep the healthy new runtime and its registrations; the legacy copy stays.
	committed = true
	if migrated != nil && fx.FinishMigration != nil {
		if err = fx.FinishMigration(l, migrated); err != nil {
			return err
		}
	}
	// A whole-folder rename keeps unknown private files too. It removes the old
	// location only after health succeeds, retaining a recovery copy beside it.
	if _, e = os.Stat(l.Legacy); e == nil {
		backup := l.Legacy + ".backup-" + time.Now().Format("20060102-150405.000000000")
		if err = os.Rename(l.Legacy, backup); err != nil {
			return fmt.Errorf("Could not retain the legacy runtime backup: %w", err)
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	// New registrations now own startup/activation. Old entries are retired only
	// after the replacement has proved healthy.
	if err = fx.Registry.DeleteValue(runKey, legacyRunValue); err != nil {
		return err
	}
	if err = fx.Registry.DeleteTree(`Software\Classes\` + legacyProtocol); err != nil {
		return err
	}
	return nil
}

func runInstallerCommand() (bool, error) {
	exe, err := os.Executable()
	if err != nil {
		return true, err
	}
	l := userInstallLayout()
	if installRequested && uninstallRequested {
		return true, errors.New("Choose either install or uninstall")
	}
	if uninstallRequested {
		return true, runUninstall(l)
	}
	if setupParent != 0 {
		if !installRequested || !setupHelperPath(exe) {
			return true, errors.New("Invalid installer helper")
		}
		if err = waitSetupParent(setupParent, l); err != nil {
			return true, err
		}
		defer scheduleSetupCleanup(filepath.Dir(exe))
	}
	if !installRequested && samePlace(filepath.Dir(exe), l.Legacy) && setupDefaultConfiguration() {
		// A release started from the previous runtime moves once, including login
		// starts. The retained directory backup remains available for recovery.
		installRequested = !strings.Contains(appVersion, "-dev.")
	}
	if !installRequested {
		// Explicit development/test configuration never offers or performs an install.
		if !setupDefaultConfiguration() || background || activation != "" || samePlace(filepath.Dir(exe), l.Root) || strings.Contains(appVersion, "-dev.") {
			return false, nil
		}
		if !nativeQuestion("Install Agent Ops?", "Install Agent Ops for this user? No administrator access is required.", true) {
			return false, nil
		}
		installStartup = nativeQuestion("Agent Ops", "Start Agent Ops automatically when you sign in to Windows?", false)
	}
	if !samePath(dataDir, defaultDataDir()) || !samePath(profileDir, userHome()) || addr != "127.0.0.1:7790" {
		return true, errors.New("Self-install uses the current user's default folders; isolated tests must inject installEffects")
	}
	if err = validateInstallLayout(l, ""); err != nil {
		return true, err
	}
	unlock, err := lockNativeSetup()
	if err != nil {
		return true, err
	}
	defer unlock()
	// Run a copy outside the runtime so Windows can replace/rename locked images.
	if samePlace(filepath.Dir(exe), l.Root) || samePlace(filepath.Dir(exe), l.Legacy) {
		helper, e := os.MkdirTemp("", "agent-ops-setup-")
		if e != nil {
			return true, e
		}
		b, e := os.ReadFile(exe)
		if e == nil {
			e = atomicUpdateFile(filepath.Join(helper, "agent-ops.exe"), b)
		}
		if e != nil {
			os.RemoveAll(helper)
			return true, e
		}
		args := []string{"--install", "--setup-parent", strconv.Itoa(os.Getpid())}
		if background {
			args = append(args, "--background")
		}
		if activation != "" {
			args = append(args, "--activate", activation)
		}
		if installStartup {
			args = append(args, "--install-startup")
		}
		cmd := hidden(exec.Command(filepath.Join(helper, "agent-ops.exe"), args...))
		if e = cmd.Start(); e != nil {
			os.RemoveAll(helper)
			return true, e
		}
		return true, nil
	}
	transaction, err := os.MkdirTemp("", "agent-ops-install-")
	if err != nil {
		return true, err
	}
	stage := filepath.Join(transaction, "package")
	manifest, err := stageSelfInstaller(exe, stage)
	if err != nil {
		os.RemoveAll(transaction)
		return true, err
	}
	fx := nativeInstallEffects()
	err = installSelf(l, stage, manifest, installStartup, fx)
	if err != nil {
		return true, fmt.Errorf("%w; recovery files retained at %s", err, transaction)
	}
	return true, os.RemoveAll(transaction)
}

func userHome() string { home, _ := os.UserHomeDir(); return home }

func setupDefaultConfiguration() bool {
	if !defaultInstance() || dataDirGiven || explicitRepos || explicitState || !samePath(profileDir, userHome()) || os.Getenv("AGENT_OPS_SCRIPT") != "" {
		return false
	}
	configured := false
	flag.Visit(func(f *flag.Flag) {
		switch f.Name {
		case "addr", "script", "profile-dir", "update-feed":
			configured = true
		}
	})
	return !configured
}

// Kept separately from flag parsing so --version/update/migration stay noninteractive.
func installerExit() bool {
	handled, err := runInstallerCommand()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		nativeMessage("Agent Ops setup", err.Error())
		os.Exit(1)
	}
	return handled
}

func validateInstallLayout(l installLayout, stage string) error {
	paths := []string{l.Root, l.Legacy, l.Data, l.Shortcut}
	if stage != "" {
		paths = append(paths, stage)
	}
	for i, p := range paths {
		if !filepath.IsAbs(p) || filepath.Dir(p) == p {
			return errors.New("Installer paths must be absolute, non-root paths")
		}
		if err := plainUpdatePath(p); err != nil {
			return err
		}
		for _, other := range paths[:i] {
			a, b := strings.ToLower(filepath.Clean(p)), strings.ToLower(filepath.Clean(other))
			if samePlace(a, b) || pathWithin(a, b) || pathWithin(b, a) {
				return errors.New("Installer paths must not overlap")
			}
		}
	}
	return nil
}
