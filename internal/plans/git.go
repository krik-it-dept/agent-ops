package plans

import (
	"bufio"
	"bytes"
	"context"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

// GitFunc runs git in dir and returns its standard output.
type GitFunc func(ctx context.Context, dir string, args ...string) ([]byte, error)

// gitTimeout bounds one git call; a hung git (a network drive, a credential
// prompt) only loses that repository's link and worktrees.
const gitTimeout = 5 * time.Second

// DefaultGit runs the git executable on PATH, read-only, without a window.
func DefaultGit(ctx context.Context, dir string, args ...string) ([]byte, error) {
	ctx, cancel := context.WithTimeout(ctx, gitTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	// No prompt may block a refresh, and no optional lock is taken in the repository.
	cmd.Env = append(cmd.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_OPTIONAL_LOCKS=0")
	hide(cmd)
	return cmd.Output()
}

// gitCacheTTL keeps Git details between refreshes: plan edits refresh often,
// while remotes and worktrees rarely change.
const gitCacheTTL = time.Minute

type gitEntry struct {
	at        time.Time
	gh        string
	worktrees []Worktree
}

var (
	gitCacheMu sync.Mutex
	gitCache   = map[string]gitEntry{}
)

var githubRemote = regexp.MustCompile(`github\.com[:/](.+?)(?:\.git)?$`)

// gitDetails fills each repository's GitHub link and worktrees, a few
// repositories at a time. Only the default git runner is cached.
func gitDetails(ctx context.Context, git GitFunc, repos []*Repo) error {
	cached := git == nil
	if cached {
		git = DefaultGit
	}
	var wg sync.WaitGroup
	limit := make(chan struct{}, 8)
	for _, r := range repos {
		root := filepath.FromSlash(r.Root)
		if !exists(filepath.Join(root, ".git")) {
			continue
		}
		key := strings.ToLower(filepath.Clean(root))
		if cached {
			gitCacheMu.Lock()
			e, ok := gitCache[key]
			gitCacheMu.Unlock()
			if ok && time.Since(e.at) < gitCacheTTL {
				r.GH, r.Worktrees = e.gh, append([]Worktree{}, e.worktrees...)
				continue
			}
		}
		wg.Add(1)
		go func(r *Repo) {
			defer wg.Done()
			select {
			case limit <- struct{}{}:
			case <-ctx.Done():
				return
			}
			defer func() { <-limit }()
			if out, err := git(ctx, root, "remote", "get-url", "origin"); err == nil {
				if m := githubRemote.FindStringSubmatch(strings.TrimSpace(string(out))); m != nil {
					r.GH = "https://github.com/" + m[1]
				}
			}
			if out, err := git(ctx, root, "worktree", "list", "--porcelain"); err == nil {
				r.Worktrees = parseWorktrees(out)
			}
			if cached && ctx.Err() == nil {
				gitCacheMu.Lock()
				gitCache[key] = gitEntry{at: time.Now(), gh: r.GH, worktrees: append([]Worktree{}, r.Worktrees...)}
				gitCacheMu.Unlock()
			}
		}(r)
	}
	wg.Wait()
	return ctx.Err()
}

// parseWorktrees reads `git worktree list --porcelain`: blocks of "worktree
// <path>", "HEAD <sha>", "branch refs/heads/<name>" or "detached", separated by
// blank lines. Bare and prunable (folder gone) entries are skipped.
func parseWorktrees(out []byte) []Worktree {
	list := []Worktree{}
	var cur *Worktree
	skip := false
	flush := func() {
		if cur != nil && !skip && cur.Path != "" {
			list = append(list, *cur)
		}
		cur, skip = nil, false
	}
	scanner := bufio.NewScanner(bytes.NewReader(out))
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		key, value, _ := strings.Cut(line, " ")
		switch key {
		case "":
			flush()
		case "worktree":
			flush()
			cur = &Worktree{Path: filepath.ToSlash(value)}
		case "branch":
			if cur != nil {
				cur.Branch = strings.TrimPrefix(value, "refs/heads/")
			}
		case "bare", "prunable":
			skip = true
		}
	}
	flush()
	return list
}
