package main

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func resetToastSender(t *testing.T) {
	t.Helper()
	oldWriter := toastRegistryWriter
	toastSender.Store("")
	t.Cleanup(func() { toastRegistryWriter = oldWriter; toastSender.Store("") })
}

func TestToastAppPlanNamesTheAppAndIcon(t *testing.T) {
	plan := toastAppPlan(`C:\data\icons\agent-ops-toast.png`)
	if plan.Key != `Software\Classes\AppUserModelId\KrikIT.AgentOps` {
		t.Fatal("unexpected key", plan.Key)
	}
	if len(plan.Values) != 2 || plan.Values["DisplayName"] != "Agent Ops" || plan.Values["IconUri"] != `C:\data\icons\agent-ops-toast.png` {
		t.Fatalf("unexpected values %+v", plan.Values)
	}
}

func TestRegisterToastAppExtractsIconAndSwitchesSender(t *testing.T) {
	resetToastSender(t)
	dir := isolated(t)
	var got []toastRegistration
	toastRegistryWriter = func(p toastRegistration) error { got = append(got, p); return nil }
	if currentToastAppID() != powershellAppID {
		t.Fatal("an unregistered instance must keep the PowerShell AUMID")
	}
	for i := 0; i < 2; i++ { // idempotent
		if err := registerToastApp(dir); err != nil {
			t.Fatal(err)
		}
	}
	icon := filepath.Join(dir, "icons", "agent-ops-toast.png")
	want, _ := iconFiles.ReadFile("web/icons/app.png")
	if b, err := os.ReadFile(icon); err != nil || !bytes.Equal(b, want) {
		t.Fatal("icon not extracted", err)
	}
	if len(got) != 2 || got[1].Values["IconUri"] != icon || got[1].Key != toastAppKey {
		t.Fatalf("unexpected registrations %+v", got)
	}
	if currentToastAppID() != toastAppID || !strings.Contains(toastShowScript(currentToastAppID()), "'KrikIT.AgentOps'") {
		t.Fatal("toasts are not sent under the registered AUMID")
	}
}

func TestRegisterToastAppFailureKeepsPowerShell(t *testing.T) {
	resetToastSender(t)
	toastRegistryWriter = func(toastRegistration) error { return errors.New("denied") }
	if err := registerToastApp(isolated(t)); err == nil {
		t.Fatal("expected the registry failure")
	}
	if currentToastAppID() != powershellAppID {
		t.Fatal("a failed registration must fall back to PowerShell")
	}
}

func TestToastShowScriptOnlyUsesKnownAppIDs(t *testing.T) {
	if s := toastShowScript("x'); calc; ('"); strings.Contains(s, "calc") || !strings.Contains(s, powershellAppID) {
		t.Fatal("unknown AUMID reached the script", s)
	}
}
