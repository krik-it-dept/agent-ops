package plans

import (
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unicode/utf16"
)

// Project is one enabled project the collector reads.
type Project struct {
	ID   string
	Name string
	Path string // absolute
	Kind string // "repo" (the folder is one repository) or "folder" (its subfolders are)
}

// Options configure Collect.
type Options struct {
	Projects []Project
	// Git runs git; nil uses the git executable on PATH (see DefaultGit).
	Git GitFunc
	// Now stamps generatedAt; nil uses time.Now.
	Now func() time.Time
	// ReadFile reads a plan; nil uses ReadPlanFile (with a short retry on
	// sharing violations). Tests replace it to inject faults.
	ReadFile func(string) ([]byte, error)
}

// MaxPlanBytes bounds one plan file. Larger files are reported, not read.
const MaxPlanBytes = 8 << 20

// Collect reads every plan of the enabled projects. It fails only when ctx
// ends; a missing project, an unreadable folder or plan, or a malformed plan
// is reported in the overview (projects[].status, diagnostics) instead.
func Collect(ctx context.Context, opt Options) (*Overview, error) {
	now := time.Now
	if opt.Now != nil {
		now = opt.Now
	}
	read := opt.ReadFile
	if read == nil {
		read = ReadPlanFile
	}
	out := &Overview{Projects: []ProjectResult{}, Repos: []Repo{}, Plans: []Plan{}, Diagnostics: []Diagnostic{}}
	type found struct {
		plan  Plan
		mtime time.Time
	}
	var all []found
	var repos []*Repo
	for _, project := range opt.Projects {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		result := ProjectResult{ID: project.ID, Name: project.Name, Path: project.Path, Kind: project.Kind, Status: "ok"}
		if result.Name == "" {
			result.Name = project.Path
		}
		list, err := ProjectRepos(project)
		if err != nil {
			// A project folder that cannot be opened at all (missing, unplugged or
			// offline drive, network share, no permission, now a file) is a
			// warning, so one unreachable project never fails the board.
			result.Status = "missing"
			if errors.Is(err, fs.ErrNotExist) {
				result.Message = "Folder not found."
			} else {
				result.Message = "Folder cannot be opened (" + errorCode(err) + ")."
			}
			out.Projects = append(out.Projects, result)
			continue
		}
		result.Repos = len(list)
		for _, r := range list {
			if err := ctx.Err(); err != nil {
				return nil, err
			}
			// Long names, as Git reports worktrees (see longPath).
			repo := &Repo{Project: project.ID, Name: r.Name, Root: filepath.ToSlash(longPath(r.Root)), Worktrees: []Worktree{}}
			repos = append(repos, repo)
			dir := filepath.Join(r.Root, ".tasks")
			files, err := listPlans(dir)
			if err != nil {
				out.Diagnostics = append(out.Diagnostics, Diagnostic{Project: project.ID, Repo: r.Name, File: filepath.ToSlash(dir), Kind: DiagFolderUnreadable, Message: "The .tasks folder cannot be listed (" + errorCode(err) + ")."})
				continue
			}
			for _, name := range files {
				file := filepath.Join(dir, name)
				plan := strings.TrimSuffix(name, ".md")
				diag := func(kind, message string) {
					out.Diagnostics = append(out.Diagnostics, Diagnostic{Project: project.ID, Repo: r.Name, Plan: plan, File: filepath.ToSlash(file), Kind: kind, Message: message})
				}
				info, err := os.Stat(file)
				if err != nil {
					diag(DiagUnreadable, "The plan cannot be read ("+errorCode(err)+").")
					continue
				}
				if !info.Mode().IsRegular() {
					continue
				}
				if info.Size() > MaxPlanBytes {
					diag(DiagTooLarge, fmt.Sprintf("The plan is %d MB; plans over %d MB are not read.", info.Size()>>20, MaxPlanBytes>>20))
					continue
				}
				source, err := read(file)
				if err != nil {
					diag(DiagUnreadable, "The plan cannot be read ("+errorCode(err)+").")
					continue
				}
				if len(source) > MaxPlanBytes {
					diag(DiagTooLarge, fmt.Sprintf("The plan grew over %d MB while it was read.", MaxPlanBytes>>20))
					continue
				}
				// The file time after the read, so a plan changed while it was read
				// is read again on the next refresh.
				mtime := info.ModTime()
				if after, err := os.Stat(file); err == nil {
					mtime = after.ModTime()
				}
				parsed := Parse(source)
				if parsed.InvalidUTF8 {
					diag(DiagInvalidUTF8, "The plan is not valid UTF-8; unreadable characters are shown as �.")
				}
				if parsed.UnclosedFence > 0 {
					diag(DiagUnclosedFence, fmt.Sprintf("The code block opened on line %d is never closed, so the lines after it are not read.", parsed.UnclosedFence))
				}
				status, tone, step := statusOf(parsed)
				decisions, questions, milestones, steps := planJSON(parsed)
				all = append(all, found{mtime: mtime, plan: Plan{
					Project: project.ID, ProjectName: result.Name, Repo: r.Name, Root: repo.Root, Name: plan,
					Owner: parsed.Owner, Goal: parsed.Goal, Spec: parsed.Spec, Next: parsed.Next,
					Status: status, Tone: tone, Step: step, Mtime: isoTime(mtime), Revision: parsed.Revision,
					Decisions: decisions, Questions: questions, Milestones: milestones, Steps: steps,
				}})
				repo.Plans++
				result.Plans++
			}
		}
		out.Projects = append(out.Projects, result)
	}
	// Git metadata: the GitHub link and the worktrees, for every repository at once.
	if err := gitDetails(ctx, opt.Git, repos); err != nil {
		return nil, err
	}
	gh := map[string]string{}
	for _, r := range repos {
		out.Repos = append(out.Repos, *r)
		gh[r.Project+"\x00"+r.Name] = r.GH
	}
	// Newest first; plans edited at the same time keep their reading order.
	sort.SliceStable(all, func(i, j int) bool {
		return all[i].mtime.Truncate(time.Millisecond).After(all[j].mtime.Truncate(time.Millisecond))
	})
	for _, f := range all {
		f.plan.GH = gh[f.plan.Project+"\x00"+f.plan.Repo]
		out.Plans = append(out.Plans, f.plan)
	}
	out.GeneratedAt = isoTime(now())
	return out, nil
}

// isoTime formats like JavaScript's Date.prototype.toISOString.
func isoTime(t time.Time) string {
	return t.UTC().Format("2006-01-02T15:04:05.000Z")
}

// listPlans returns the plan file names of a .tasks folder: *.md except the
// generated tong-hop.md index. A missing folder has no plans.
func listPlans(dir string) ([]string, error) {
	entries, err := os.ReadDir(dir)
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		var pathErr *fs.PathError
		// A file named .tasks is not a plan folder.
		if errors.As(err, &pathErr) && isNotDir(err) {
			return nil, nil
		}
		return nil, err
	}
	var names []string
	for _, e := range entries {
		if name := e.Name(); strings.HasSuffix(name, ".md") && name != "tong-hop.md" {
			names = append(names, name)
		}
	}
	return names, nil
}

// errNotFolder reports a project path that is a file.
var errNotFolder = errors.New("not a folder")

// RepoDir is a repository folder of a project.
type RepoDir struct {
	Name string
	Root string
}

// ProjectRepos lists the repositories a project contributes: the folder itself
// for a repo project, and for a folder project each subfolder holding .git or
// .tasks, in name order. It fails when the project folder cannot be opened.
func ProjectRepos(p Project) ([]RepoDir, error) {
	info, err := os.Stat(p.Path)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() {
		return nil, errNotFolder
	}
	if p.Kind == "repo" {
		return []RepoDir{{Name: RepoNameOf(p.Path), Root: p.Path}}, nil
	}
	entries, err := os.ReadDir(p.Path)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		names = append(names, e.Name())
	}
	sort.Slice(names, func(i, j int) bool { return utf16Less(names[i], names[j]) })
	var out []RepoDir
	for _, name := range names {
		root := filepath.Join(p.Path, name)
		if st, err := os.Stat(root); err != nil || !st.IsDir() {
			continue
		}
		if exists(filepath.Join(root, ".git")) || exists(filepath.Join(root, ".tasks")) {
			out = append(out, RepoDir{Name: name, Root: root})
		}
	}
	return out, nil
}

// utf16Less orders like JavaScript's default sort (UTF-16 code units).
func utf16Less(a, b string) bool {
	x, y := utf16.Encode([]rune(a)), utf16.Encode([]rune(b))
	for i := 0; i < len(x) && i < len(y); i++ {
		if x[i] != y[i] {
			return x[i] < y[i]
		}
	}
	return len(x) < len(y)
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// RepoNameOf names the repository of a repo project. A drive or share root has
// no folder name, so its drive letter or share name is used.
func RepoNameOf(path string) string {
	clean := filepath.Clean(path)
	if !(len(clean) == 3 && clean[1] == ':') {
		clean = strings.TrimRight(clean, `\/`)
	}
	if name := filepath.Base(clean); name != "" && name != "." && !strings.ContainsAny(name, `\/:`) {
		return name
	}
	parts := strings.FieldsFunc(strings.TrimRight(clean, `\/:`), func(r rune) bool { return r == '\\' || r == '/' })
	if len(parts) > 0 {
		return parts[len(parts)-1]
	}
	return "root"
}

// ReadPlanFile reads a plan, retrying briefly while another program holds the
// file without read sharing (an editor saving, antivirus scanning).
func ReadPlanFile(file string) ([]byte, error) {
	var err error
	for attempt := 0; attempt < 8; attempt++ {
		var f *os.File
		f, err = os.Open(file)
		if err == nil {
			var b []byte
			b, err = io.ReadAll(io.LimitReader(f, MaxPlanBytes+1))
			f.Close()
			if err == nil {
				return b, nil
			}
		}
		if !retryable(err) {
			return nil, err
		}
		time.Sleep(time.Duration(25<<min(attempt, 3)) * time.Millisecond)
	}
	return nil, err
}

// errorCode is a short, path-free name for an I/O error, like Node's error codes.
func errorCode(err error) string {
	switch {
	case errors.Is(err, errNotFolder):
		return "ENOTDIR"
	case errors.Is(err, fs.ErrNotExist):
		return "ENOENT"
	case errors.Is(err, errNotFolder) || isNotDir(err):
		return "ENOTDIR"
	case errors.Is(err, fs.ErrPermission):
		return "EACCES"
	case retryable(err):
		return "EBUSY"
	}
	var errno syscall.Errno
	if errors.As(err, &errno) {
		return fmt.Sprintf("errno %d", uintptr(errno))
	}
	return "EIO"
}
