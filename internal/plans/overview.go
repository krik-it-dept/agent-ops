package plans

import (
	"regexp"
	"strings"
)

// Overview is the collector's result; docs/overview-schema.md documents it.
type Overview struct {
	GeneratedAt string          `json:"generatedAt"`
	Projects    []ProjectResult `json:"projects"`
	Repos       []Repo          `json:"repos"`
	Plans       []Plan          `json:"plans"`
	Diagnostics []Diagnostic    `json:"diagnostics"`
}

// ProjectResult is the outcome for one enabled project.
type ProjectResult struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Path    string `json:"path"`
	Kind    string `json:"kind"`
	Status  string `json:"status"` // ok or missing
	Message string `json:"message"`
	Repos   int    `json:"repos"`
	Plans   int    `json:"plans"`
}

// Repo is one repository of a project, with its Git worktrees.
type Repo struct {
	Project   string     `json:"project"`
	Name      string     `json:"name"`
	Root      string     `json:"root"`
	GH        string     `json:"gh"`
	Plans     int        `json:"plans"`
	Worktrees []Worktree `json:"worktrees"`
}

// Worktree is one entry of `git worktree list --porcelain`.
type Worktree struct {
	Path   string `json:"path"`
	Branch string `json:"branch"` // short name; empty when detached
}

// Diagnostic is a problem with one plan (or a repository's .tasks folder) that
// the collector worked around. It never fails the refresh.
type Diagnostic struct {
	Project string `json:"project"`
	Repo    string `json:"repo"`
	Plan    string `json:"plan"` // empty for a folder problem
	File    string `json:"file"`
	Kind    string `json:"kind"` // see the Diag* constants
	Message string `json:"message"`
}

// Diagnostic kinds.
const (
	// The plan file could not be read (locked, no permission, removed while
	// reading). The plan is left out of this refresh.
	DiagUnreadable = "unreadable"
	// The plan file exceeds MaxPlanBytes. The plan is left out.
	DiagTooLarge = "too-large"
	// The plan is not valid UTF-8; invalid bytes were replaced. The plan is shown.
	DiagInvalidUTF8 = "invalid-utf8"
	// A code fence opens and never closes, so the rest of the plan is hidden.
	DiagUnclosedFence = "unclosed-fence"
	// The repository's .tasks folder could not be listed.
	DiagFolderUnreadable = "folder-unreadable"
)

// Plan is one plan file in the overview.
type Plan struct {
	Project     string          `json:"project"`
	ProjectName string          `json:"projectName"`
	Repo        string          `json:"repo"`
	Root        string          `json:"root"`
	GH          string          `json:"gh"`
	Name        string          `json:"name"`
	Owner       string          `json:"owner"`
	Goal        string          `json:"goal"`
	Spec        string          `json:"spec"`
	Next        string          `json:"next"`
	Status      string          `json:"status"`
	Tone        string          `json:"tone"`
	Step        int             `json:"step"`
	Mtime       string          `json:"mtime"`
	Revision    string          `json:"revision"`
	Decisions   []Decision      `json:"decisions"`
	Questions   []QuestionEntry `json:"questions"`
	Milestones  []MilestoneJSON `json:"milestones"`
	Steps       []StepJSON      `json:"steps"`
}

type Decision struct {
	Key  string `json:"key"`
	When string `json:"when"`
	Text string `json:"text"`
}

type QuestionEntry struct {
	Key    string `json:"key"`
	When   string `json:"when"`
	Ask    string `json:"ask"`
	Answer string `json:"answer"`
	Open   bool   `json:"open"`
}

type MilestoneJSON struct {
	ID       string     `json:"id"`
	Title    string     `json:"title"`
	State    string     `json:"state"`
	Summary  string     `json:"summary"`
	Progress Progress   `json:"progress"`
	Steps    []StepJSON `json:"steps"`
}

// Progress counts a milestone's steps.
type Progress struct {
	Done  int `json:"done"`
	Total int `json:"total"`
}

type StepJSON struct {
	Status    string `json:"status"`
	Text      string `json:"text"`
	Line      int    `json:"line"`
	Milestone string `json:"milestone"`
	Index     int    `json:"index"`
}

// stages are the fixed stages of the plan format: name, tone and position on
// the main path (-1 = off the path).
var stages = []struct {
	name, tone string
	step       int
}{
	{"Planning", "doing", 0},
	{"Implementing", "doing", 1},
	{"Reviewing", "review", 2},
	{"Fixing review", "review", 2},
	{"Testing", "test", 3},
	{"Waiting for CI", "test", 4},
	{"Dry run", "test", 5},
	{"Waiting for owner", "pending", -1},
	{"Shipping", "doing", 5},
	{"Blocked", "bad", -1},
	{"Done", "ok", 6},
}

var (
	toneBad     = regexp.MustCompile(`chặn|block|lỗi|fail`)
	toneOK      = regexp.MustCompile(`xong|done|merged|shipped`)
	toneReview  = regexp.MustCompile(`review`)
	tonePending = regexp.MustCompile(`wait|chờ|dở|owner|partial`)
	toneTest    = regexp.MustCompile(`test|\bci\b|build|dry`)
)

// statusOf returns the shown status: the plan's "Status:" stage wins; without
// one, a status is derived from the steps.
func statusOf(p *Parsed) (text, tone string, step int) {
	label := p.Label
	for _, s := range stages {
		if label != "" && strings.HasPrefix(strings.ToLower(label), strings.ToLower(s.name)) {
			return label, s.tone, s.step
		}
	}
	if label == "" {
		count := map[string]int{}
		for _, s := range p.Steps {
			count[s.Status]++
		}
		switch {
		case count[markBlocked] > 0:
			return "Blocked", "bad", -1
		case len(p.Steps) > 0 && count[markDone] == len(p.Steps):
			return "Done", "ok", 6
		case count[markDoing] > 0:
			return "In progress", "doing", -1
		case count[markPartial] > 0:
			return "Partly done", "pending", -1
		}
		return "Not started", "idle", -1
	}
	// A free-text label from an older plan: colour it by keywords.
	t := strings.ToLower(label)
	switch {
	case toneBad.MatchString(t):
		return label, "bad", -1
	case toneOK.MatchString(t):
		return label, "ok", -1
	case toneReview.MatchString(t):
		return label, "review", -1
	case tonePending.MatchString(t):
		return label, "pending", -1
	case toneTest.MatchString(t):
		return label, "test", -1
	}
	return label, "doing", -1
}

var stampPattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?` + ws + `*:` + ws + `*`)

// stamped splits a "YYYY-MM-DD HH:MM: text" entry into a sortable key, a short
// display date and the text.
func stamped(text string) (key, when, rest string) {
	m := stampPattern.FindStringSubmatchIndex(text)
	if m == nil {
		return "", "", text
	}
	part := func(i int) string {
		if m[2*i] < 0 {
			return ""
		}
		return text[m[2*i]:m[2*i+1]]
	}
	hour := part(4)
	if len(hour) == 1 {
		hour = "0" + hour
	}
	key = part(1) + part(2) + part(3)
	when = part(3) + "/" + part(2)
	if part(4) != "" {
		key += hour + part(5)
		when += " " + hour + ":" + part(5)
	} else {
		key += "9999"
	}
	return key, when, text[m[1]:]
}

// planJSON converts a parsed plan into its overview entry.
func planJSON(p *Parsed) (decisions []Decision, questions []QuestionEntry, milestones []MilestoneJSON, steps []StepJSON) {
	where := map[*Step]struct {
		id    string
		index int
	}{}
	for _, m := range p.Milestones {
		for i, s := range m.Steps {
			where[s] = struct {
				id    string
				index int
			}{m.ID, i}
		}
	}
	step := func(s *Step, i int) StepJSON {
		if w, ok := where[s]; ok {
			return StepJSON{Status: markStatus[s.Status], Text: s.Text, Line: s.Line, Milestone: w.id, Index: w.index}
		}
		return StepJSON{Status: markStatus[s.Status], Text: s.Text, Line: s.Line, Index: i}
	}
	decisions = make([]Decision, 0, len(p.Decisions))
	for _, d := range p.Decisions {
		key, when, text := stamped(d)
		decisions = append(decisions, Decision{Key: key, When: when, Text: text})
	}
	questions = make([]QuestionEntry, 0, len(p.Questions))
	for _, q := range p.Questions {
		key, when, ask := stamped(q.Ask)
		answer := q.Answer
		if q.Open {
			answer = ""
		}
		questions = append(questions, QuestionEntry{Key: key, When: when, Ask: ask, Answer: answer, Open: q.Open})
	}
	milestones = make([]MilestoneJSON, 0, len(p.Milestones))
	for _, m := range p.Milestones {
		out := MilestoneJSON{ID: m.ID, Title: m.Title, State: m.State, Summary: m.Summary, Steps: make([]StepJSON, 0, len(m.Steps))}
		for i, s := range m.Steps {
			out.Steps = append(out.Steps, step(s, i))
			if s.Status == markDone {
				out.Progress.Done++
			}
		}
		out.Progress.Total = len(m.Steps)
		milestones = append(milestones, out)
	}
	steps = make([]StepJSON, 0, len(p.Steps))
	for i, s := range p.Steps {
		steps = append(steps, step(s, i))
	}
	return
}
