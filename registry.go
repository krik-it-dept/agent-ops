package main

// Per-user registry entries of the installed instance: the Run key value (Start
// with Windows) and the agent-ops: URL protocol used by notifications. Only the
// installed instance (default port and data folder) calls these. Registry access
// goes through userRegistry so tests use an in-memory fake.

import (
	"errors"
	"os"
	"strings"

	"golang.org/x/sys/windows/registry"
)

const (
	protocolScheme = "agent-ops"
	protocolKey    = `Software\Classes\` + protocolScheme
)

// registryStore is the subset of HKEY_CURRENT_USER the app uses. Paths are
// relative to HKEY_CURRENT_USER; "" names a key's default value.
type registryStore interface {
	GetString(path, name string) (string, bool)
	SetString(path, name, value string) error
	DeleteValue(path, name string) error
	// DeleteTree removes a key with all its subkeys; a missing key is not an error.
	DeleteTree(path string) error
}

var userRegistry registryStore = hkcu{}

type hkcu struct{}

func (hkcu) GetString(path, name string) (string, bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
	if err != nil {
		return "", false
	}
	defer k.Close()
	v, _, err := k.GetStringValue(name)
	return v, err == nil
}

func (hkcu) SetString(path, name, value string) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.QUERY_VALUE|registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	if old, _, err := k.GetStringValue(name); err == nil && old == value {
		return nil
	}
	return k.SetStringValue(name, value)
}

func (hkcu) DeleteValue(path, name string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer k.Close()
	if err := k.DeleteValue(name); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func (h hkcu) DeleteTree(path string) error {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.ENUMERATE_SUB_KEYS)
	if errors.Is(err, registry.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	names, err := k.ReadSubKeyNames(-1)
	k.Close()
	if err != nil {
		return err
	}
	for _, name := range names {
		if err := h.DeleteTree(path + `\` + name); err != nil {
			return err
		}
	}
	if err := registry.DeleteKey(registry.CURRENT_USER, path); err != nil && !errors.Is(err, registry.ErrNotExist) {
		return err
	}
	return nil
}

func protocolCommand(exe string) string { return `"` + exe + `" --activate "%1"` }

// registerProtocol writes the agent-ops: protocol and removes the protocol of
// releases before v0.3.0. Idempotent.
func registerProtocol(exe string) error {
	for _, v := range []struct{ path, name, value string }{
		{protocolKey, "", "URL:Agent Ops"},
		{protocolKey, "URL Protocol", ""},
		{protocolKey + `\shell\open\command`, "", protocolCommand(exe)},
	} {
		if err := userRegistry.SetString(v.path, v.name, v.value); err != nil {
			return err
		}
	}
	return userRegistry.DeleteTree(`Software\Classes\` + legacyProtocol)
}

// migrateStartup renames the Run value of releases before v0.3.0 to "Agent Ops",
// pointing at this executable, and makes sure a login start stays in the tray.
func migrateStartup(exe string) error {
	if _, ok := userRegistry.GetString(runKey, legacyRunValue); ok {
		if _, has := userRegistry.GetString(runKey, runName); !has {
			if err := userRegistry.SetString(runKey, runName, `"`+exe+`" --background`); err != nil {
				return err
			}
		}
		if err := userRegistry.DeleteValue(runKey, legacyRunValue); err != nil {
			return err
		}
	}
	if v, ok := userRegistry.GetString(runKey, runName); ok && !strings.Contains(v, "--background") {
		return userRegistry.SetString(runKey, runName, strings.TrimSpace(v)+" --background")
	}
	return nil
}

func startupEnabled() bool {
	_, ok := userRegistry.GetString(runKey, runName)
	return ok
}

func setStartup(on bool) {
	if on {
		exe, _ := os.Executable()
		_ = userRegistry.SetString(runKey, runName, `"`+exe+`" --background`)
	} else {
		_ = userRegistry.DeleteValue(runKey, runName)
	}
}
