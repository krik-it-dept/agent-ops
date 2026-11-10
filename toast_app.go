package main

import (
	"bytes"
	"os"
	"path/filepath"
	"sync/atomic"

	"golang.org/x/sys/windows/registry"

	"github.com/krik-it-dept/agent-ops/internal/safeio"
)

// Toasts carry the app's own name and icon through an AppUserModelID registered
// the unpackaged-desktop way: HKCU\Software\Classes\AppUserModelId\<id> with a
// DisplayName and an IconUri. Windows 10 1903+ and Windows 11 read it without a
// Start-menu shortcut. Only the installed instance registers it (the same rule as
// the Run key and protocol); other instances keep PowerShell's AUMID.
const (
	toastAppID       = "KrikIT.AgentOps"
	toastAppName     = "Agent Ops"
	toastAppKey      = `Software\Classes\AppUserModelId\` + toastAppID
	powershellAppID  = `{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\WindowsPowerShell\v1.0\powershell.exe`
	toastIconRelPath = `icons\agent-ops-toast.png`
)

// toastRegistration is the registry write plan, kept as data so tests check it
// without touching the registry.
type toastRegistration struct {
	Key    string // relative to HKEY_CURRENT_USER
	Values map[string]string
}

func toastAppPlan(iconPath string) toastRegistration {
	return toastRegistration{Key: toastAppKey, Values: map[string]string{"DisplayName": toastAppName, "IconUri": iconPath}}
}

var (
	// Replaced in tests so they never write the registry.
	toastRegistryWriter = writeToastRegistration
	// The AUMID toasts are shown under; switched once registration succeeds.
	toastSender atomic.Value
)

func currentToastAppID() string {
	if id, ok := toastSender.Load().(string); ok && id != "" {
		return id
	}
	return powershellAppID
}

// registerToastApp extracts the embedded icon into the data folder (so it is not
// a new runtime file for the updater) and points the AUMID at it. Idempotent.
func registerToastApp(dir string) error {
	icon, err := writeToastIcon(dir)
	if err != nil {
		return err
	}
	if err := toastRegistryWriter(toastAppPlan(icon)); err != nil {
		return err
	}
	toastSender.Store(toastAppID)
	return nil
}

func writeToastIcon(dir string) (string, error) {
	data, err := iconFiles.ReadFile("web/icons/app.png")
	if err != nil {
		return "", err
	}
	path := filepath.Join(dir, toastIconRelPath)
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return path, nil
	}
	if err := safeio.WriteFile(path, data, 0o644); err != nil {
		return "", err
	}
	return path, nil
}

func writeToastRegistration(plan toastRegistration) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, plan.Key, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	for name, value := range plan.Values {
		if old, _, err := k.GetStringValue(name); err == nil && old == value {
			continue
		}
		if err := k.SetStringValue(name, value); err != nil {
			return err
		}
	}
	return nil
}
