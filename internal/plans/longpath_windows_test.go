package plans

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func shortPath(t *testing.T, p string) string {
	t.Helper()
	from, _ := windows.UTF16PtrFromString(p)
	buf := make([]uint16, 1024)
	n, err := windows.GetShortPathName(from, &buf[0], uint32(len(buf)))
	if err != nil || n == 0 {
		t.Fatal("short path:", err)
	}
	return windows.UTF16ToString(buf[:n])
}

// A project configured (or a temp folder reached) through an 8.3 short name:
// Git reports worktrees with long names, and the repository must still list
// itself as its own main worktree, with the same root on the repo and plan.
func TestCollectWritesLongNamesForShortPaths(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("needs git")
	}
	long := filepath.Join(longPath(t.TempDir()), "a long repository folder")
	writeFixture(t, long, map[string]string{".tasks/plan.md": "Status: Testing\n\n## M1: One\n- [doing] Step\n"})
	if out, err := exec.Command("git", "-C", long, "init", "-q").CombinedOutput(); err != nil {
		t.Fatal(err, string(out))
	}
	short := shortPath(t, long)
	if strings.EqualFold(short, long) {
		t.Skip("this volume has no 8.3 short names")
	}
	// Upper case too: the comparison with Git's path ignores case.
	o, err := Collect(context.Background(), Options{Projects: []Project{{ID: "p", Name: "P", Path: strings.ToUpper(short), Kind: "repo"}}})
	if err != nil {
		t.Fatal(err)
	}
	if len(o.Repos) != 1 || len(o.Plans) != 1 {
		t.Fatalf("%+v", o)
	}
	r := o.Repos[0]
	if strings.Contains(r.Root, "~") || !strings.EqualFold(r.Root, filepath.ToSlash(long)) {
		t.Fatalf("root not in long form: %s (long %s)", r.Root, long)
	}
	if len(r.Worktrees) != 1 || r.Worktrees[0].Path != r.Root {
		t.Fatalf("main worktree does not match its repository: root %s, worktrees %+v", r.Root, r.Worktrees)
	}
	if o.Plans[0].Root != r.Root {
		t.Fatalf("plan root %s differs from repo root %s", o.Plans[0].Root, r.Root)
	}
	if _, err := os.Stat(filepath.FromSlash(r.Root)); err != nil {
		t.Fatal(err)
	}
}

func TestSameRootNamesKeepsOtherWorktrees(t *testing.T) {
	root := filepath.Join(longPath(t.TempDir()), "main checkout")
	other := filepath.Join(filepath.Dir(root), "feature tree")
	for _, d := range []string{root, other} {
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	got := sameRootNames([]Worktree{{Path: filepath.ToSlash(strings.ToUpper(shortPath(t, root))), Branch: "main"}, {Path: filepath.ToSlash(shortPath(t, other)), Branch: "feat"}}, filepath.ToSlash(root))
	if got[0].Path != filepath.ToSlash(root) || !strings.EqualFold(got[1].Path, filepath.ToSlash(other)) || strings.Contains(got[1].Path, "~") {
		t.Fatalf("%+v", got)
	}
}
