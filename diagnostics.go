package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"runtime"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

var processStarted = time.Now()

// nodeVersion is replaced in tests.
var nodeVersion = func() string {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	out, err := runUpdateCommand(ctx, "node", "--version")
	if err != nil {
		return "not found"
	}
	return firstLine(string(out))
}

func yesNo(v bool) string {
	if v {
		return "yes"
	}
	return "no"
}

// diagnosticsText is what "Copy diagnostics" puts on the clipboard: versions,
// OS, a configuration summary and recent failures. It never includes plan
// content, project paths or names.
func diagnosticsText() string {
	var b strings.Builder
	line := func(k, v string) { fmt.Fprintf(&b, "%s: %s\n", k, v) }
	b.WriteString("Agent Ops diagnostics\n")
	line("Version", appVersion+" (commit "+appCommit+")")
	osVersion := "unknown"
	if v := windows.RtlGetVersion(); v != nil {
		osVersion = fmt.Sprintf("Windows %d.%d build %d", v.MajorVersion, v.MinorVersion, v.BuildNumber)
	}
	line("OS", osVersion+" "+runtime.GOARCH)
	line("Go", runtime.Version())
	line("Node.js", nodeVersion())
	line("Started", processStarted.Format(time.RFC3339)+" (pid "+fmt.Sprint(os.Getpid())+")")
	line("Generated", time.Now().Format(time.RFC3339))
	line("Default instance", yesNo(defaultInstance()))

	cfgMu.Lock()
	cfg := appCfg
	projects := append([]Project{}, appCfg.Projects...)
	warning, readOnly := configWarning, configReadOnly
	cfgMu.Unlock()
	enabled, folders := 0, 0
	for _, p := range projects {
		if p.Enabled {
			enabled++
		}
		if p.Kind == "folder" {
			folders++
		}
	}
	line("Projects", fmt.Sprintf("%d configured, %d enabled, %d folders of repositories", len(projects), enabled, folders))
	line("Projects overridden by flag or environment", yesNo(reposDir != ""))
	line("Setup complete", yesNo(cfg.SetupComplete))
	line("Notifications", yesNo(cfg.Notifications))
	line("Theme", themeOrSystem(cfg.Theme))
	line("Single-key shortcuts", yesNo(cfg.Shortcuts))
	line("Automatic update checks", yesNo(!disableUpdateChecks))
	line("Config warning", yesNo(warning != ""))
	line("Config read-only", yesNo(readOnly != ""))

	mu.Lock()
	refreshFailing := refreshError
	plans := len(prev)
	mu.Unlock()
	line("Plans loaded", fmt.Sprint(plans))
	if refreshFailing != "" {
		// Only the first sentence: collector output may quote plan files.
		first, _, _ := strings.Cut(refreshFailing, ". ")
		line("Plan refresh", "failing: "+firstLine(first))
	} else {
		line("Plan refresh", "ok")
	}
	if updates != nil {
		s := updates.snapshot()
		status := s.Phase
		if s.Latest != "" {
			status += ", latest " + s.Latest
		}
		if s.CheckedAt != "" {
			status += ", checked " + s.CheckedAt
		}
		if s.Error != "" {
			status += ", error: " + s.Error
		}
		line("Updates", status)
	}
	if rec, ok := readCrash(); ok {
		line("Last crash", fmt.Sprintf("%s %s in %s at %s (%d total): %s", rec.Version, rec.Kind, rec.Where, rec.Time, rec.Count, rec.Message))
	} else {
		line("Last crash", "none")
	}
	line("Logs", logDir)
	return b.String()
}

func diagnosticsRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/diagnostics", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		w.Header().Set("Cache-Control", "no-store")
		writeJSON(w, http.StatusOK, map[string]string{"text": diagnosticsText()})
	})
	mux.HandleFunc("/api/diagnostics/dismiss-crash", func(w http.ResponseWriter, r *http.Request) {
		if !guardWrite(w, r, http.MethodPost) {
			return
		}
		if err := dismissCrash(); err != nil {
			settingsFail(w, http.StatusInternalServerError, "Could not clear the crash notice: "+err.Error())
			return
		}
		broadcast()
		writeJSON(w, http.StatusOK, map[string]bool{"dismissed": true})
	})
}

// crashNoticeJSON is the crash marker for /api/state, or null.
func crashNotice() any {
	rec, ok := readCrash()
	if !ok {
		return nil
	}
	return map[string]any{"time": rec.Time, "kind": rec.Kind, "version": rec.Version, "count": rec.Count}
}
