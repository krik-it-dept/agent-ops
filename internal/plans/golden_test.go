package plans

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// goldenPlans are plan files the Go collector must read exactly like the Node
// collector of earlier releases (testdata/node). Plans whose reading changed on
// purpose are in intentionalPlans (parse_test.go) instead.
var goldenPlans = map[string]string{
	// The current format, with a title line above the header.
	"alpha/.tasks/current.md": "# Release plan\n\nNext: ship the build\nStatus: Implementing - wiring the collector #12\nGoal: Ship the Go collector\nSpec: docs/spec.md\nOwner: Claude\n\n" +
		"## Decisions\n- 2026-11-10 18:40: Use Go\n  continued on the next line\n- 2026-11-09: Keep the JSON contract\n* undated decision\n\n" +
		"## Questions\n- 2026-11-10 17:45: Keep Node? | Answer: No\n- 2026-11-10 9:05: Which port? | Answer: open\n- Undated question\n- Open source? | Answer: Open-source lib\n\n" +
		"## M1: Parser [done]\nSummary: parser ported, PR #3\n- [done] Port the parser ~2h\n- [done] Golden tests ~30 phút\n\n" +
		"## M2. Collector\n- [doing] Collect plans <!-- Executor: Codex -->\n- [todo] Remove Node ~1.5 ngày\n- [blocked] Wait for review\n- [partial] Docs ~5m written\n\n" +
		"### M2a – Sub milestone [blocked]\n* [todo] Nested step\n- [x] GitHub checkbox is ignored\n\n## Notes\n- [done] Loose step after a heading\n",
	// Code fences: steps and sections inside are ignored; a longer or tilde fence nests.
	"alpha/.tasks/fences.md": "Status: Testing\nGoal: Fenced examples\n\n## M1: Fences\n- [doing] Before the fence\n```\n- [done] inside a backtick fence\n## M9: not a milestone\n```\n- [todo] Between fences\n~~~~\n- [done] inside tilde\n```\n- [done] still inside tilde\n~~~~\n````md\n## Decisions\n- not a decision\n````\n- [done] After the fences\n",
	// The same step text twice in one milestone and across milestones.
	"alpha/.tasks/duplicates.md": "Status: Reviewing\nNext: dedupe\n\n## M1: First\n- [done] Run tests\n- [todo] Run tests\n- [done] Run tests\n\n## M2: Second\n- [doing] Run tests\n\n- [todo] Run tests\n",
	// Windows line endings and a byte order mark.
	"beta/.tasks/crlf-bom.md": "\xef\xbb\xbfNext: CRLF and BOM\r\nStatus: Planning\r\nGoal: Windows files\r\n\r\n## M1: Windows [doing]\r\nSummary: line endings\r\n- [doing] CRLF step ~2h\r\n- [done] Second CRLF step\r\n\r\n## Questions\r\n- 2026-01-02 03:04: CRLF question | Answer: yes\r\n",
	// No header at all: the status is derived from the steps.
	"beta/.tasks/no-header.md":         "## M1: Only steps\n- [done] One\n- [done] Two\n",
	"beta/.tasks/no-header-blocked.md": "- [todo] Loose\n- [blocked] Stuck step\n",
	"beta/.tasks/empty.md":             "",
	"beta/.tasks/free-label.md":        "Status: chờ owner duyệt\nGoal: Older free-text status\n\n- [done] Done\n",
	"beta/.tasks/done-label.md":        "Status: merged and shipped\n- [done] Done\n",
	// Vietnamese text, the older Vietnamese header keys and the emoji format.
	"beta/.tasks/tieng-viet.md": "Tiếp theo: viết lại bộ đọc plan\nTrạng thái: Đang làm\nGoal: Bỏ yêu cầu Node cho người dùng Việt\n\n" +
		"## Decisions\n- 2026-11-10 14:30: Dùng Go thay cho Node\n\n## M1: Bộ đọc [doing]\nSummary: đọc tiêu đề, mốc và bước\n" +
		"✅ Đọc tiêu đề ~1 giờ\n🔄 Đọc các mốc ~2 giờ\n⬜ Viết tài liệu ~1g\n⚠️ Kiểm tra tiếng Việt có dấu\n❌ Chặn bởi review\n- [todo] Bước có ~5 phút ước lượng giữa câu\n- [todo] Không phải ước lượng ~5mét\n",
	// Milestone heading variants and a state in brackets.
	"gamma/.tasks/headings.md": "Status: Done\n\n## m3: lower case id [DONE]\n- [done] a\n#### M4 - dash title\n- [todo] b\n## M5:no space\n- [partial] c\n## Decisions\n- decision line\n# Top heading resets\n- [doing] after top heading\n",
	"gamma/.tasks/tong-hop.md": "generated index, never a plan",
	"gamma/.tasks/notes.txt":   "not a plan",
}

func writeFixture(t *testing.T, root string, files map[string]string) {
	t.Helper()
	base := time.Date(2026, 11, 10, 12, 0, 0, 0, time.UTC)
	i := 0
	for name, text := range files {
		file := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(file, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
		// Distinct times keep the newest-first order independent of map order.
		when := base.Add(time.Duration(len(name)*7919%86400+i) * time.Second)
		i++
		if err := os.Chtimes(file, when, when); err != nil {
			t.Fatal(err)
		}
	}
}

// nodeOverview runs the reference Node collector against config.json.
func nodeOverview(t *testing.T, config, state string) map[string]any {
	t.Helper()
	script, _ := filepath.Abs(filepath.Join("testdata", "node", "tasks-overview.mjs"))
	cmd := exec.Command("node", script, "--state-file", state)
	cmd.Env = append(os.Environ(), "AGENT_OPS_CONFIG="+config, "AGENT_OPS_REPOS_DIR=", "AGENT_OPS_STATE_FILE=")
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("node collector: %v\n%s", err, out)
	}
	b, err := os.ReadFile(state)
	if err != nil {
		t.Fatal(err)
	}
	var v map[string]any
	if err := json.Unmarshal(b, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func asJSON(t *testing.T, v any) map[string]any {
	t.Helper()
	b, err := json.Marshal(v)
	if err != nil {
		t.Fatal(err)
	}
	var out map[string]any
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	return out
}

func requireNode(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("node"); err != nil {
		t.Skip("the golden test compares with the Node collector and needs node on PATH")
	}
}

func TestGoCollectorMatchesNodeCollector(t *testing.T) {
	requireNode(t)
	root := t.TempDir()
	repos := filepath.Join(root, "repos")
	writeFixture(t, repos, goldenPlans)
	// A real Git repository with a GitHub remote, and a repo project next to the folder project.
	if _, err := exec.LookPath("git"); err == nil {
		for _, args := range [][]string{{"init", "-q"}, {"remote", "add", "origin", "git@github.com:krik-it-dept/sample.git"}} {
			cmd := exec.Command("git", append([]string{"-C", filepath.Join(repos, "alpha")}, args...)...)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("git %v: %v %s", args, err, out)
			}
		}
	}
	single := filepath.Join(root, "single repo")
	writeFixture(t, single, map[string]string{".tasks/solo.md": "Status: Shipping\nGoal: A repo project\n\n## M1: Solo\n- [done] One\n"})
	if err := os.MkdirAll(filepath.Join(repos, "no-tasks", ".git"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(repos, "plain-folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	projects := []Project{
		{ID: "work", Name: "Work", Path: repos, Kind: "folder"},
		{ID: "solo", Name: "", Path: single, Kind: "repo"},
		{ID: "gone", Name: "Gone", Path: filepath.Join(root, "missing"), Kind: "folder"},
	}
	type configProject struct {
		ID      string `json:"id"`
		Path    string `json:"path"`
		Name    string `json:"name"`
		Kind    string `json:"kind"`
		Enabled bool   `json:"enabled"`
	}
	cfg := map[string]any{"version": 1, "setupComplete": true, "projects": []configProject{}}
	for _, p := range projects {
		cfg["projects"] = append(cfg["projects"].([]configProject), configProject{p.ID, p.Path, p.Name, p.Kind, true})
	}
	cfg["projects"] = append(cfg["projects"].([]configProject), configProject{"off", filepath.Join(root, "off"), "Off", "folder", false})
	b, _ := json.Marshal(cfg)
	config := filepath.Join(root, "config.json")
	if err := os.WriteFile(config, b, 0o644); err != nil {
		t.Fatal(err)
	}
	node := nodeOverview(t, config, filepath.Join(root, "node-state", "state.json"))

	overview, err := Collect(context.Background(), Options{Projects: projects})
	if err != nil {
		t.Fatal(err)
	}
	got := asJSON(t, overview)

	// Fields the Go collector adds to the contract.
	for _, plan := range got["plans"].([]any) {
		for _, m := range plan.(map[string]any)["milestones"].([]any) {
			delete(m.(map[string]any), "progress")
		}
	}
	if len(got["diagnostics"].([]any)) != 0 {
		t.Errorf("unexpected diagnostics: %v", got["diagnostics"])
	}
	for _, key := range []string{"generatedAt", "repos", "diagnostics"} {
		delete(got, key)
	}
	delete(node, "generatedAt")
	if !reflect.DeepEqual(node["projects"], got["projects"]) {
		t.Errorf("projects differ\nnode: %v\ngo:   %v", node["projects"], got["projects"])
	}
	nodePlans, goPlans := node["plans"].([]any), got["plans"].([]any)
	if len(goPlans) != 12 {
		t.Fatalf("expected the 12 fixture plans, go read %d", len(goPlans))
	}
	for _, p := range overview.Plans {
		if p.Name == "fences" {
			var texts []string
			for _, s := range p.Steps {
				texts = append(texts, s.Text)
			}
			if strings.Join(texts, "|") != "Before the fence|Between fences|After the fences" {
				t.Errorf("fenced steps were read: %q", texts)
			}
		}
	}
	if len(nodePlans) != len(goPlans) {
		t.Fatalf("node read %d plans, go %d", len(nodePlans), len(goPlans))
	}
	for i := range nodePlans {
		n, g := nodePlans[i].(map[string]any), goPlans[i].(map[string]any)
		for key := range n {
			if !reflect.DeepEqual(n[key], g[key]) {
				t.Errorf("plan %v/%v field %s differs\nnode: %#v\ngo:   %#v", n["repo"], n["name"], key, n[key], g[key])
			}
		}
		for key := range g {
			if _, ok := n[key]; !ok {
				t.Errorf("plan %v: go adds field %s", n["name"], key)
			}
		}
	}
	if !reflect.DeepEqual(node, got) && !t.Failed() {
		t.Error("overview differs outside plans and projects")
	}
	if _, err := exec.LookPath("git"); err == nil {
		var alpha *Repo
		for i := range overview.Repos {
			if overview.Repos[i].Name == "alpha" {
				alpha = &overview.Repos[i]
			}
		}
		if alpha == nil || alpha.GH != "https://github.com/krik-it-dept/sample" || len(alpha.Worktrees) != 1 || !strings.EqualFold(alpha.Worktrees[0].Path, filepath.ToSlash(filepath.Join(repos, "alpha"))) {
			t.Errorf("alpha repository Git details: %+v", alpha)
		}
	}
}
