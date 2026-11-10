package plans

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func stepTexts(p *Parsed) string {
	var out []string
	for _, s := range p.Steps {
		out = append(out, markStatus[s.Status]+":"+s.Text)
	}
	return strings.Join(out, "|")
}

// Readings that changed on purpose from the Node collector (review-data #6, #11).
func TestIntentionalDifferencesFromNodeReader(t *testing.T) {
	// Header fields come only from the header block, never from a code fence or a section.
	p := Parse([]byte("# Plan\n\nGoal: real goal\n\n```\nStatus: Done\nSpec: fake.md\n```\n\n## M1: Work\nNext: not a header\n- [doing] step\n"))
	if p.Label != "" || p.Spec != "" || p.Next != "" || p.Goal != "real goal" {
		t.Errorf("header read outside the header block: %+v", p)
	}
	if text, _, _ := statusOf(p); text != "In progress" {
		t.Errorf("status derived from steps, got %q", text)
	}
	// A fence closes only on a bare fence line; an info string does not close it.
	p = Parse([]byte("- [todo] before\n```\n- [done] inside\n```js\n- [done] still inside\n```\n- [todo] after\n"))
	if got := stepTexts(p); got != "todo:before|todo:after" {
		t.Errorf("fence with info string: %s", got)
	}
	// A fence that never closes is reported.
	p = Parse([]byte("- [todo] before\n\n~~~\n- [done] hidden\n"))
	if p.UnclosedFence != 3 || stepTexts(p) != "todo:before" {
		t.Errorf("unclosed fence: line %d, steps %s", p.UnclosedFence, stepTexts(p))
	}
	// Invalid UTF-8 is replaced and reported, never fatal.
	p = Parse([]byte("Status: Testing\n- [todo] bad \xff byte\n"))
	if !p.InvalidUTF8 || p.Label != "Testing" || stepTexts(p) != "todo:bad \uFFFD byte" {
		t.Errorf("invalid UTF-8: %+v %s", p, stepTexts(p))
	}
}

func TestParseKeepsDuplicateStepsApartWithLines(t *testing.T) {
	p := Parse([]byte("Status: Testing\r\n\r\n## M1: A\r\n- [done] Same\r\n- [todo] Same\r\n## M2: B\r\n- [doing] Same\r\n"))
	_, _, milestones, steps := planJSON(p)
	if len(steps) != 3 || steps[0].Line != 4 || steps[1].Line != 5 || steps[2].Line != 7 {
		t.Fatalf("steps %+v", steps)
	}
	if steps[1].Milestone != "M1" || steps[1].Index != 1 || steps[2].Milestone != "M2" || steps[2].Index != 0 {
		t.Errorf("milestone placement %+v", steps)
	}
	if milestones[0].Progress != (Progress{Done: 1, Total: 2}) || milestones[1].Progress != (Progress{Done: 0, Total: 1}) {
		t.Errorf("progress %+v %+v", milestones[0].Progress, milestones[1].Progress)
	}
}

func TestStripEstimates(t *testing.T) {
	for in, want := range map[string]string{
		"Port ~2h":                 "Port",
		"Port ~ 1,5 ngày now":      "Port now",
		"Two ~2ph and ~3PHÚT":      "Two and",
		"Not ~5mét an estimate":    "Not ~5mét an estimate",
		"Half ~1.5":                "Half ~1.5",
		"Tight~30min":              "Tight",
		"Mixed ~2m.":               "Mixed.",
		"Vietnamese ~1 giờ rồi":    "Vietnamese rồi",
		"Unit then letter ~2hours": "Unit then letter ~2hours",
	} {
		if got := jsTrim(stripEstimates(in)); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}

func TestParseWorktrees(t *testing.T) {
	out := "worktree D:/repo\nHEAD 1111\nbranch refs/heads/main\n\nworktree D:/wt/feature\nHEAD 2222\nbranch refs/heads/feat/x\n\nworktree D:/wt/detached\nHEAD 3333\ndetached\n\nworktree D:/wt/gone\nHEAD 4444\nbranch refs/heads/old\nprunable gitdir file points to non-existent location\n\n"
	got := parseWorktrees([]byte(strings.ReplaceAll(out, "\n", "\r\n")))
	want := []Worktree{{"D:/repo", "main"}, {"D:/wt/feature", "feat/x"}, {"D:/wt/detached", ""}}
	if len(got) != len(want) {
		t.Fatalf("%+v", got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("%d: %+v, want %+v", i, got[i], want[i])
		}
	}
}

// One bad plan never fails the refresh: it becomes a diagnostics entry and the
// other plans are still read.
func TestCollectReportsBadPlansAndKeepsTheRest(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{
		"web/.tasks/good.md":     "Status: Testing\n- [done] ok\n",
		"web/.tasks/locked.md":   "Status: Testing\n",
		"web/.tasks/half.md":     "Status: Implementing\nGoal: half wr",
		"web/.tasks/fence.md":    "Status: Testing\n```\n- [done] hidden\n",
		"web/.tasks/bad-utf8.md": "Status: Testing\n- [todo] \xff\n",
	})
	if err := os.Mkdir(filepath.Join(root, "web", ".tasks", "folder.md"), 0o755); err != nil {
		t.Fatal(err)
	}
	locked := errors.New("sharing violation")
	read := func(file string) ([]byte, error) {
		if filepath.Base(file) == "locked.md" {
			return nil, locked
		}
		return ReadPlanFile(file)
	}
	noGit := func(context.Context, string, ...string) ([]byte, error) { return nil, errors.New("no git") }
	o, err := Collect(context.Background(), Options{Projects: []Project{{ID: "p", Name: "P", Path: root, Kind: "folder"}}, ReadFile: read, Git: noGit})
	if err != nil {
		t.Fatal(err)
	}
	names := map[string]bool{}
	for _, p := range o.Plans {
		names[p.Name] = true
	}
	if !names["good"] || !names["half"] || !names["fence"] || !names["bad-utf8"] || names["locked"] || names["folder"] {
		t.Errorf("plans read: %v", names)
	}
	kinds := map[string]string{}
	for _, d := range o.Diagnostics {
		kinds[d.Plan] = d.Kind
		if d.Project != "p" || d.Repo != "web" || !strings.HasSuffix(d.File, "/web/.tasks/"+d.Plan+".md") {
			t.Errorf("diagnostic %+v", d)
		}
	}
	if kinds["locked"] != DiagUnreadable || kinds["fence"] != DiagUnclosedFence || kinds["bad-utf8"] != DiagInvalidUTF8 || len(kinds) != 3 {
		t.Errorf("diagnostics %+v", o.Diagnostics)
	}
	if o.Projects[0].Status != "ok" || o.Projects[0].Plans != 4 {
		t.Errorf("project %+v", o.Projects[0])
	}
}

func TestCollectStopsWhenTheContextEnds(t *testing.T) {
	root := t.TempDir()
	writeFixture(t, root, map[string]string{"web/.tasks/a.md": "- [todo] a\n"})
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := Collect(ctx, Options{Projects: []Project{{ID: "p", Path: root, Kind: "folder"}}}); !errors.Is(err, context.Canceled) {
		t.Fatalf("got %v", err)
	}
}

func TestCollectReportsMissingProjects(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "file.txt")
	if err := os.WriteFile(file, []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	o, err := Collect(context.Background(), Options{Projects: []Project{{ID: "gone", Path: filepath.Join(root, "none"), Kind: "folder"}, {ID: "file", Name: "F", Path: file, Kind: "repo"}}, Now: func() time.Time { return time.Unix(0, 0) }})
	if err != nil {
		t.Fatal(err)
	}
	if o.Projects[0].Status != "missing" || o.Projects[0].Message != "Folder not found." || o.Projects[0].Name != filepath.Join(root, "none") {
		t.Errorf("%+v", o.Projects[0])
	}
	if o.Projects[1].Message != "Folder cannot be opened (ENOTDIR)." {
		t.Errorf("%+v", o.Projects[1])
	}
	if o.GeneratedAt != "1970-01-01T00:00:00.000Z" || o.Plans == nil || o.Repos == nil || o.Diagnostics == nil {
		t.Errorf("%+v", o)
	}
}
