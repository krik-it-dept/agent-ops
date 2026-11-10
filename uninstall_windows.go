package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

type uninstallChoice struct {
	Confirmed          bool `json:"confirmed"`
	KeepData           bool `json:"keepData"`
	RemoveIntegrations bool `json:"removeIntegrations"`
}
type uninstallEffects struct {
	Registry           registryStore
	Stop               func(string) error
	RemoveIntegrations func() error
	ScheduleDelete     func(string, string) error
}

func uninstallSelf(l installLayout, choice uninstallChoice, fx uninstallEffects) error {
	if !choice.Confirmed {
		return nil
	}
	if err := validateInstallLayout(l, ""); err != nil {
		return err
	}
	if err := fx.Stop(l.Root); err != nil {
		return err
	}
	// Finish guarded integration removals before deleting config or registrations.
	// A locally edited skill/reminder aborts removal, preserving its backup/data.
	if choice.RemoveIntegrations {
		if err := fx.RemoveIntegrations(); err != nil {
			return err
		}
	}
	if err := os.Remove(l.Shortcut); err != nil && !os.IsNotExist(err) {
		return err
	}
	if err := fx.Registry.DeleteValue(runKey, runName); err != nil {
		return err
	}
	for _, key := range []string{protocolKey, toastAppKey, uninstallKey} {
		if err := fx.Registry.DeleteTree(key); err != nil {
			return err
		}
	}
	deleteData := ""
	if !choice.KeepData {
		deleteData = l.Data
	}
	return fx.ScheduleDelete(l.Root, deleteData)
}

const uninstallDialogScript = `
Add-Type -AssemblyName System.Windows.Forms
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'Uninstall Agent Ops'
$form.ClientSize = New-Object Drawing.Size(480,210)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$label = New-Object Windows.Forms.Label
$label.Text = 'Remove Agent Ops from this user account?'
$label.Location = New-Object Drawing.Point(20,20)
$label.Size = New-Object Drawing.Size(440,35)
$keep = New-Object Windows.Forms.CheckBox
$keep.Text = 'Keep settings, backups and browser data (recommended)'
$keep.Checked = $true
$keep.Location = New-Object Drawing.Point(20,65)
$keep.Size = New-Object Drawing.Size(440,25)
$clients = New-Object Windows.Forms.CheckBox
$clients.Text = 'Remove managed AI skills and reminder lines'
$clients.Checked = $false
$clients.Location = New-Object Drawing.Point(20,100)
$clients.Size = New-Object Drawing.Size(440,25)
$ok = New-Object Windows.Forms.Button
$ok.Text = 'Uninstall'
$ok.DialogResult = [Windows.Forms.DialogResult]::OK
$ok.Location = New-Object Drawing.Point(270,155)
$cancel = New-Object Windows.Forms.Button
$cancel.Text = 'Cancel'
$cancel.DialogResult = [Windows.Forms.DialogResult]::Cancel
$cancel.Location = New-Object Drawing.Point(365,155)
$form.Controls.AddRange(@($label,$keep,$clients,$ok,$cancel))
$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.ActiveControl = $cancel
$result = $form.ShowDialog()
@{confirmed=($result -eq [Windows.Forms.DialogResult]::OK); keepData=$keep.Checked; removeIntegrations=$clients.Checked} | ConvertTo-Json -Compress
$form.Dispose()
`

func runUninstall(l installLayout) error {
	if !defaultInstance() || !samePath(profileDir, userHome()) {
		return errors.New("Uninstall uses the current user's default folders")
	}
	if err := validateInstallLayout(l, ""); err != nil {
		return err
	}
	unlock, err := lockNativeSetup()
	if err != nil {
		return err
	}
	defer unlock()
	output, err := setupPowerShell(uninstallDialogScript, nil).Output()
	if err != nil {
		return fmt.Errorf("Could not display uninstall options: %w", err)
	}
	choice := uninstallChoice{KeepData: true}
	if err = json.Unmarshal(output, &choice); err != nil {
		return err
	}
	return uninstallSelf(l, choice, uninstallEffects{Registry: hkcu{}, Stop: stopInstallProcesses,
		RemoveIntegrations: removeSetupIntegrations, ScheduleDelete: scheduleInstallDelete})
}

// Reuse exactly the Settings > Integrations actions: same recorded hashes,
// marker guards, backups, atomic writes and save path. No profile scanning.
func removeSetupIntegrations() error {
	cfg, err := readAppConfig(configFilePath(dataDir))
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	cfgMu.Lock()
	appCfg = cfg
	cfgMu.Unlock()
	for _, target := range cfg.Integrations {
		// Disabled targets still have managed files; enable only in memory for
		// the existing guarded removal action, then restore the preference.
		if !target.Enabled {
			cfgMu.Lock()
			for i := range appCfg.Integrations {
				if appCfg.Integrations[i].ID == target.ID {
					appCfg.Integrations[i].Enabled = true
				}
			}
			cfgMu.Unlock()
		}
		var removeErr error
		if target.InstructionBlock {
			removeErr = applyIntegration(target.ID, "instructions-off", time.Now())
		}
		if removeErr == nil {
			removeErr = applyIntegration(target.ID, "remove", time.Now())
		}
		if !target.Enabled {
			disabled := false
			removeErr = errors.Join(removeErr, editIntegrationTarget(target.ID, targetInput{Enabled: &disabled}))
		}
		if removeErr != nil {
			return fmt.Errorf("AI integration retained; uninstall stopped: %w", removeErr)
		}
	}
	return nil
}

// Used only by isolated tests; production self-deletion is deferred until the
// uninstall process exits so its own executable is no longer locked.
func removeInstallTree(root string) error {
	if !filepath.IsAbs(root) || filepath.Dir(root) == root {
		return errors.New("Unsafe removal root")
	}
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		return plainUpdatePath(path)
	}); err != nil {
		return err
	}
	return os.RemoveAll(root)
}
