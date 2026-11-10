package pkgmanifest

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func valid() Manifest {
	return Manifest{Format: 1, Version: "v0.2.1", Files: []File{{"agent-ops.exe", digest, 10}, {"skills/task-plan/SKILL.md", digest, 3}}}
}

func TestPathRules(t *testing.T) {
	for _, ok := range []string{"agent-ops.exe", "skills/task-plan/SKILL.md", "integrations/install-task-reporting.mjs", "NOTICE.md", "scripts/install.ps1", "a_b/c.d.mjs"} {
		if err := ValidPath(ok); err != nil {
			t.Error(ok, err)
		}
	}
	for _, bad := range []string{"", "../x.md", "a/../x.md", "./x.md", "/x.md", "C:/x.md", "C:x.md", `a\b.md`, "a.md:stream", "x.md::$DATA", "a//b.md", "a/ b.md", "a b.md", "con.md", "NUL", "aux.txt", "com1.mjs", "LPT9/x.md", "dir./x.md", "x.md.", ".hidden.md", "x.bat", "x.cmd", "x.vbs", "x", "manifest.json", "MANIFEST.json", "a\x00.md", strings.Repeat("a/", 8) + "x.md", strings.Repeat("a", 161) + ".md"} {
		if err := ValidPath(bad); err == nil {
			t.Errorf("accepted %q", bad)
		}
	}
	if RemovablePath("task-sync.mjs") != nil || RemovablePath("historical-executions.json") == nil {
		t.Fatal("removal must be limited to program files")
	}
}

func TestValidate(t *testing.T) {
	if err := valid().Validate(); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*Manifest){
		"format":          func(m *Manifest) { m.Format = 2 },
		"version":         func(m *Manifest) { m.Version = "0.2.1" },
		"prerelease":      func(m *Manifest) { m.Version = "v0.2.1-beta" },
		"no exe":          func(m *Manifest) { m.Files = m.Files[1:] },
		"empty":           func(m *Manifest) { m.Files = nil },
		"bad digest":      func(m *Manifest) { m.Files[0].SHA256 = "ABC" },
		"negative":        func(m *Manifest) { m.Files[1].Size = -1 },
		"too large":       func(m *Manifest) { m.Files[1].Size = MaxTotalBytes },
		"duplicate case":  func(m *Manifest) { m.Files = append(m.Files, File{"Agent-Ops.exe", digest, 1}) },
		"file is dir":     func(m *Manifest) { m.Files = append(m.Files, File{"skills/task-plan/SKILL.md/x.md", digest, 1}) },
		"remove unsafe":   func(m *Manifest) { m.Remove = []string{"../x.mjs"} },
		"remove data":     func(m *Manifest) { m.Remove = []string{"agent-attributions.json"} },
		"remove install":  func(m *Manifest) { m.Remove = []string{"AGENT-OPS.exe"} },
		"remove twice":    func(m *Manifest) { m.Remove = []string{"a.mjs", "A.mjs"} },
		"traversal file":  func(m *Manifest) { m.Files[1].Path = "../outside.md" },
		"absolute file":   func(m *Manifest) { m.Files[1].Path = "C:/Windows/x.dll" },
		"stream file":     func(m *Manifest) { m.Files[1].Path = "x.md:ads" },
		"script type":     func(m *Manifest) { m.Files[1].Path = "run.bat" },
		"too many remove": func(m *Manifest) { m.Remove = make([]string, MaxRemove+1) },
	}
	for name, change := range cases {
		m := valid()
		m.Files = append([]File{}, m.Files...)
		change(&m)
		if err := m.Validate(); err == nil {
			t.Error("accepted", name)
		}
	}
	dev := valid()
	dev.Version = "v0.2.1-dev.0123abc"
	if dev.Validate() != nil {
		t.Fatal("dev builds generate a manifest too")
	}
}

func TestParseIgnoresUnknownFieldsAndRejectsTrailingData(t *testing.T) {
	b, err := Marshal(valid())
	if err != nil {
		t.Fatal(err)
	}
	if _, err := Parse(b); err != nil {
		t.Fatal(err)
	}
	extended := strings.Replace(string(b), `"format": 1,`, `"format": 1, "future": {"x": 1},`, 1)
	if _, err := Parse([]byte(extended)); err != nil {
		t.Fatal("format 1 readers ignore unknown fields", err)
	}
	if _, err := Parse(append(b, []byte("{}")...)); err == nil {
		t.Fatal("accepted trailing data")
	}
	if _, err := Parse(make([]byte, MaxManifestBytes+1)); err == nil {
		t.Fatal("accepted oversized manifest")
	}
}

func TestGenerateHashesRegularFilesAndSkipsManifest(t *testing.T) {
	dir := t.TempDir()
	put := func(name, text string) {
		file := filepath.Join(dir, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(text), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	put("agent-ops.exe", "exe")
	put("skills/task-plan/SKILL.md", "skill")
	put(FileName, "ignored")
	m, err := Generate(dir, "v1.2.3", []string{"task-sync.mjs"})
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Files) != 2 || m.Files[0].Path != "agent-ops.exe" || m.Files[1].Path != "skills/task-plan/SKILL.md" || m.Files[0].Size != 3 || m.Remove[0] != "task-sync.mjs" {
		t.Fatal(m)
	}
	if sum := sha256.Sum256([]byte("exe")); m.Files[0].SHA256 != hex.EncodeToString(sum[:]) {
		t.Fatal("digest")
	}
	put("bad name.md", "x")
	if _, err := Generate(dir, "v1.2.3", nil); err == nil {
		t.Fatal("generated a manifest with an unsafe path")
	}
}
