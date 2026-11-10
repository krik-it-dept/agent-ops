package main

// Detection of AI client folders. This is a suggestion provider only: it never
// adds anything to config.json by itself. Settings > Integrations and the
// first-run step show its suggestions with "Add"; the owner decides. It and the
// migration code are the only places that know client folder names
// (TestNoClientPathsOutsideDetection).

import (
	"os"
	"path/filepath"
	"sort"
)

type integrationSuggestion struct {
	Client          string `json:"client"` // claude, codex, gemini, orca
	Label           string `json:"label"`
	SkillDir        string `json:"skillDir"`
	InstructionFile string `json:"instructionFile,omitempty"`
}

func isDir(path string) bool {
	st, err := os.Stat(path)
	return err == nil && st.IsDir()
}

// claudeHomes are the Claude Code configuration folders of a profile: ~/.claude,
// CLAUDE_CONFIG_DIR, and every Orca Claude profile (Orca runs Claude with
// CLAUDE_CONFIG_DIR=%APPDATA%\orca\claude-profiles\<id>\home). The migration
// also uses it to find the reporting hooks.
func claudeHomes(profile string) []string {
	homes := []string{filepath.Join(profile, ".claude")}
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" && isRealProfile(profile) && filepath.IsAbs(v) {
		homes = append(homes, filepath.Clean(v))
	}
	orca, _ := filepath.Glob(filepath.Join(orcaProfilesDir(profile), "*", "home"))
	sort.Strings(orca)
	homes = append(homes, orca...)
	out := []string{}
	for _, h := range homes {
		dup := false
		for _, o := range out {
			dup = dup || samePath(o, h)
		}
		if !dup {
			out = append(out, h)
		}
	}
	return out
}

func orcaProfilesDir(profile string) string {
	return filepath.Join(profileRoamingAppData(profile), "orca", "claude-profiles")
}

// detectIntegrationTargets lists the client folders found on this computer, in a
// fixed order, without folders that resolve (through links or junctions) to one
// already listed or to one of existing. An Orca profile whose skills folder links
// to ~/.claude/skills is therefore not suggested twice.
func detectIntegrationTargets(profile string, existing []IntegrationTarget) []integrationSuggestion {
	candidates := []integrationSuggestion{}
	claude := filepath.Join(profile, ".claude")
	for _, home := range claudeHomes(profile) {
		if !isDir(home) {
			continue
		}
		s := integrationSuggestion{Client: "claude", Label: "Claude Code", SkillDir: filepath.Join(home, "skills"), InstructionFile: filepath.Join(home, "CLAUDE.md")}
		if rel, err := filepath.Rel(orcaProfilesDir(profile), home); err == nil && filepath.IsLocal(rel) {
			s.Client, s.Label = "orca", "Orca Claude profile "+shortID(filepath.Base(filepath.Dir(home)))
		} else if !samePath(home, claude) {
			s.Label = "Claude Code (CLAUDE_CONFIG_DIR)"
		}
		candidates = append(candidates, s)
	}
	codex, agents := filepath.Join(profile, ".codex"), filepath.Join(profile, ".agents")
	if isDir(codex) || isDir(agents) {
		s := integrationSuggestion{Client: "codex", Label: "Codex / shared skills", SkillDir: filepath.Join(agents, "skills")}
		if isDir(codex) {
			s.InstructionFile = filepath.Join(codex, "AGENTS.md")
		}
		candidates = append(candidates, s)
	}
	if gemini := filepath.Join(profile, ".gemini"); isDir(gemini) {
		candidates = append(candidates, integrationSuggestion{Client: "gemini", Label: "Antigravity / Gemini", SkillDir: filepath.Join(gemini, "skills"), InstructionFile: filepath.Join(gemini, "GEMINI.md")})
	}
	out := []integrationSuggestion{}
	for _, c := range candidates {
		taken := false
		for _, t := range existing {
			taken = taken || samePlace(t.SkillDir, c.SkillDir)
		}
		for _, o := range out {
			taken = taken || samePlace(o.SkillDir, c.SkillDir)
		}
		if !taken {
			out = append(out, c)
		}
	}
	return out
}

func shortID(id string) string {
	if r := []rune(id); len(r) > 8 {
		return string(r[:8])
	}
	return id
}
