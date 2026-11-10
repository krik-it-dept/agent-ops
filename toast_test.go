package main

import (
	"context"
	"encoding/xml"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// Plan text reaches the toast as data only. PowerShell treats the typographic
// quotes U+2018-U+201B like an ASCII quote, so a plan line must never be able to
// close a script string and run a command.
func TestToastPlanTextCannotRunPowerShell(t *testing.T) {
	dir := isolated(t)
	marker := func(n string) string { return filepath.Join(dir, "injected-"+n) }
	title := "Plan ’); New-Item -ItemType File -Path '" + marker("1") + "'; (’ ‘x‘ ‚y‚ ‛z‛"
	body := "ok'); New-Item -ItemType File -Path '" + marker("2") + "'; ('" +
		" $(New-Item -ItemType File -Path '" + marker("3") + "') \" <b>&amp; \x01 Tiếng Việt"
	target := "agent-ops://plan/p’);calc;(’/r/n"
	payload := toastXML(title, body, target)
	real := toastCommand(context.Background(), toastLoadScript+toastShowScript, payload)
	if args := strings.Join(real.Args, " "); strings.Contains(args, "New-Item") || strings.Contains(args, "’") || strings.Contains(args, "calc") {
		t.Fatal("plan text reached the PowerShell command line", args)
	}
	for _, q := range []string{"’", "‘", "‚", "‛", "'"} {
		if strings.Contains(payload, q) {
			t.Fatalf("quote %q is not escaped in %s", q, payload)
		}
	}
	// Run the real loading script (without showing a toast) and read the XML back.
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	probe := `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` + toastLoadScript + `[Console]::Out.Write($x.GetXml())`
	out, err := toastCommand(ctx, probe, payload).Output()
	if err != nil {
		t.Fatal("the toast XML did not load", err, string(out))
	}
	for _, n := range []string{"1", "2", "3"} {
		if _, err := os.Stat(marker(n)); err == nil {
			t.Fatal("plan text ran a PowerShell command", n)
		}
	}
	var doc struct {
		Launch string   `xml:"launch,attr"`
		Texts  []string `xml:"visual>binding>text"`
	}
	if err := xml.Unmarshal(out, &doc); err != nil {
		t.Fatal(err, string(out))
	}
	if len(doc.Texts) != 2 || doc.Texts[0] != title || doc.Texts[1] != strings.ReplaceAll(body, "\x01", "") || doc.Launch != target {
		t.Fatalf("toast text changed: %+v", doc)
	}
}
