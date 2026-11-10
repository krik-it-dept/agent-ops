// Package plans reads the owner's task plans (.tasks/*.md in each repository)
// and builds the overview the Agent Ops app shows. It replaces the Node
// collector (tasks-overview.mjs and plan-reader.mjs of releases up to v0.3.x)
// and keeps its JSON contract; docs/overview-schema.md describes it.
//
// The package only reads: plan files, folder listings and Git metadata. It
// never writes into a repository.
package plans

import (
	"crypto/sha256"
	"encoding/hex"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf8"
)

// Step markers. Plans written in the current format use "[todo]" and friends;
// older plans start a step line with a status emoji.
const (
	markTodo    = "⬜"
	markDoing   = "🔄"
	markDone    = "✅"
	markPartial = "⚠"
	markBlocked = "❌"
)

// legacyMarks is the order the Node reader tried the emoji in.
var legacyMarks = []string{markTodo, markDoing, markDone, markPartial, markBlocked}

var wordMarks = map[string]string{"todo": markTodo, "doing": markDoing, "done": markDone, "partial": markPartial, "blocked": markBlocked}

// markStatus maps a marker to the status word of the JSON contract.
var markStatus = map[string]string{markTodo: "todo", markDoing: "doing", markDone: "done", markPartial: "partial", markBlocked: "blocked"}

// ws is JavaScript's \s, so the patterns below match what the Node reader matched.
const ws = `[\t\n\v\f\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`

var (
	milestoneHead = regexp.MustCompile(`(?i)^#{2,4}` + ws + `*(M\d+[a-z]?)` + ws + `*[:.\-–]` + ws + `*(.*?)` + ws + `*(?:\[(todo|doing|done|partial|blocked)\])?` + ws + `*$`)
	decisionsHead = regexp.MustCompile(`(?i)^#{2,4}` + ws + `*decisions\b`)
	questionsHead = regexp.MustCompile(`(?i)^#{2,4}` + ws + `*questions\b`)
	anyHead       = regexp.MustCompile(`^#{1,4}` + ws)
	listItem      = regexp.MustCompile(`^[-*]` + ws + `+(.+)$`)
	answerSplit   = regexp.MustCompile(`(?i)` + ws + `*\|` + ws + `*answer` + ws + `*:` + ws + `*`)
	openAnswer    = regexp.MustCompile(`(?i)^open\b`)
	summaryLine   = regexp.MustCompile(`(?i)^summary:`)
	stepLine      = regexp.MustCompile(`(?i)^(?:[-*]` + ws + `*)?\[(todo|doing|done|partial|blocked)\]` + ws + `*(.*)$`)
	variation     = regexp.MustCompile(`^` + ws + `*\x{FE0F}`)
	executorNote  = regexp.MustCompile(`(?i)` + ws + `*<!--` + ws + `*Executors?:` + ws + `*([^<>]*?)` + ws + `*-->` + ws + `*$`)
	fenceOpen     = regexp.MustCompile("^(`{3,}|~{3,})")
)

// Step is one checklist line of a plan.
type Step struct {
	Status string // marker emoji, see markStatus
	Text   string
	Line   int // 1-based line in the file
}

// Milestone is a "## M<n>: title [state]" section.
type Milestone struct {
	ID      string
	Title   string
	State   string
	Summary string
	Steps   []*Step
}

// Question is a "- <ask> | Answer: <answer>" line under "## Questions".
type Question struct {
	Ask    string
	Answer string
	Open   bool
}

// Parsed is the content of one plan file.
type Parsed struct {
	Revision   string
	Owner      string
	Goal       string
	Spec       string
	Next       string
	Label      string // the Status: header
	Steps      []*Step
	Milestones []*Milestone
	Decisions  []string
	Questions  []Question
	// Problems the reader worked around; each becomes a diagnostics entry.
	InvalidUTF8   bool
	UnclosedFence int // line of a code fence that is never closed, 0 when none
}

// jsTrim trims what JavaScript's String.prototype.trim trims (Go's TrimSpace
// differs on U+FEFF and U+0085).
func jsTrim(s string) string {
	return strings.TrimFunc(s, jsSpace)
}

func jsSpace(r rune) bool {
	switch r {
	case '\t', '\n', '\v', '\f', '\r', ' ', 0xa0, 0x1680, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000, 0xfeff:
		return true
	}
	return r >= 0x2000 && r <= 0x200a
}

// splitLines splits like /\r?\n/.
func splitLines(text string) []string {
	lines := strings.Split(text, "\n")
	for i, l := range lines {
		lines[i] = strings.TrimSuffix(l, "\r")
	}
	return lines
}

// headerFields are the plan header keys, each with the older Vietnamese key
// that earlier plans used.
var headerFields = map[string][]string{"owner": {"Owner"}, "goal": {"Goal"}, "spec": {"Spec"}, "next": {"Next", "Tiếp theo"}, "status": {"Status", "Trạng thái"}}

// Parse reads a plan. It never fails: unknown lines are ignored, and problems
// the reader worked around are reported in Parsed.InvalidUTF8 and UnclosedFence.
//
// Header fields (Status, Next, Goal, Spec, Owner) are read only from the header
// block: the lines before the first section heading (## and deeper), outside
// code fences. Steps, milestones, decisions and questions are never read from
// inside a code fence. A fence closes only on a line of the same fence
// character, at least as long, with nothing after it (CommonMark).
func Parse(source []byte) *Parsed {
	sum := sha256.Sum256(source)
	p := &Parsed{Revision: hex.EncodeToString(sum[:]), Steps: []*Step{}, Milestones: []*Milestone{}, Decisions: []string{}, Questions: []Question{}}
	text := string(source)
	if !utf8.ValidString(text) {
		p.InvalidUTF8 = true
		text = strings.ToValidUTF8(text, string(utf8.RuneError))
	}
	text = strings.TrimPrefix(text, string(rune(0xFEFF)))
	lines := splitLines(text)

	header := map[string]string{}
	inHeader := true
	var ms *Milestone
	inDecisions, inQuestions := false, false
	fence, fenceLine := "", 0
	for index, raw := range lines {
		l := jsTrim(raw)
		if m := fenceOpen.FindString(l); m != "" {
			if fence == "" {
				fence, fenceLine = m, index+1
			} else if m[0] == fence[0] && len(m) >= len(fence) && jsTrim(strings.TrimLeft(l, m[:1])) == "" {
				fence, fenceLine = "", 0
			}
			continue
		}
		if fence != "" {
			continue
		}
		if head := milestoneHead.FindStringSubmatch(l); head != nil {
			inHeader = false
			ms = &Milestone{ID: strings.ToUpper(head[1]), Title: head[2], State: strings.ToLower(head[3]), Steps: []*Step{}}
			p.Milestones = append(p.Milestones, ms)
			inDecisions, inQuestions = false, false
			continue
		}
		if decisionsHead.MatchString(l) {
			inHeader, inDecisions, inQuestions, ms = false, true, false, nil
			continue
		}
		if questionsHead.MatchString(l) {
			inHeader, inQuestions, inDecisions, ms = false, true, false, nil
			continue
		}
		if anyHead.MatchString(l) {
			// A "# Title" line may stand above the header; deeper headings end it.
			if !strings.HasPrefix(l, "# ") && !strings.HasPrefix(l, "#\t") {
				inHeader = false
			}
			inDecisions, inQuestions, ms = false, false, nil
			continue
		}
		if inHeader {
			lower := strings.ToLower(l)
			for field, keys := range headerFields {
				for _, key := range keys {
					if _, seen := header[field+"|"+key]; !seen && strings.HasPrefix(lower, strings.ToLower(key)+":") {
						header[field+"|"+key] = jsTrim(l[len(strings.ToLower(key))+1:])
					}
				}
			}
		}
		if inQuestions {
			if q := listItem.FindStringSubmatch(l); q != nil {
				parts := answerSplit.Split(q[1], -1)
				answer := jsTrim(strings.Join(parts[1:], " "))
				p.Questions = append(p.Questions, Question{Ask: jsTrim(parts[0]), Answer: answer, Open: answer == "" || openAnswer.MatchString(answer)})
			}
			continue
		}
		if inDecisions {
			if d := listItem.FindStringSubmatch(l); d != nil {
				p.Decisions = append(p.Decisions, d[1])
			} else if l != "" && len(p.Decisions) > 0 {
				p.Decisions[len(p.Decisions)-1] += " " + l
			}
			continue
		}
		if ms != nil && summaryLine.MatchString(l) {
			ms.Summary = jsTrim(l[len("summary:"):])
			continue
		}
		var status, stepText string
		if m := stepLine.FindStringSubmatch(l); m != nil {
			status, stepText = wordMarks[strings.ToLower(m[1])], m[2]
		} else {
			for _, mark := range legacyMarks {
				if strings.HasPrefix(l, mark) {
					status = mark
					break
				}
			}
			if status == "" {
				continue
			}
			stepText = jsTrim(variation.ReplaceAllString(l[len(status):], ""))
		}
		// Plans from earlier releases may end a step with <!-- Executor: ... -->; it is not shown.
		if loc := executorNote.FindStringIndex(stepText); loc != nil {
			stepText = stepText[:loc[0]]
		}
		step := &Step{Status: status, Text: jsTrim(stripEstimates(stepText)), Line: index + 1}
		p.Steps = append(p.Steps, step)
		if ms != nil {
			ms.Steps = append(ms.Steps, step)
		}
	}
	if fence != "" {
		p.UnclosedFence = fenceLine
	}
	field := func(name string) string {
		for _, key := range headerFields[name] {
			if v, ok := header[name+"|"+key]; ok {
				return v
			}
		}
		return ""
	}
	p.Owner, p.Goal, p.Spec, p.Next, p.Label = field("owner"), field("goal"), field("spec"), field("next"), field("status")
	return p
}

// estimateUnits are the duration units of a "~2h" estimate, in the order the
// Node reader's pattern tried them.
var estimateUnits = []string{"p", "ph", "phút", "m", "min", "h", "g", "giờ", "d", "ngày"}

// stripEstimates removes time estimates such as " ~2h" or "~30 phút" from step
// text, exactly like the Node reader's
// /\s*~\s*\d+(?:[.,]\d+)?\s*(p|ph|phút|m|min|h|g|giờ|d|ngày)(?![\p{L}])/giu.
func stripEstimates(s string) string {
	var b strings.Builder
	i := 0
	for i < len(s) {
		if end := estimateAt(s, i); end > i {
			i = end
			continue
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		b.WriteString(s[i : i+size])
		i += size
	}
	return b.String()
}

// estimateAt returns the end of an estimate starting at byte i, or i.
func estimateAt(s string, i int) int {
	j := skipSpace(s, i)
	if j >= len(s) || s[j] != '~' {
		return i
	}
	j = skipSpace(s, j+1)
	k := skipDigits(s, j)
	if k == j {
		return i
	}
	if k+1 < len(s) && (s[k] == '.' || s[k] == ',') {
		if d := skipDigits(s, k+1); d > k+1 {
			k = d
		}
	}
	k = skipSpace(s, k)
	for _, unit := range estimateUnits {
		end, ok := foldPrefix(s, k, unit)
		if !ok {
			continue
		}
		if r, _ := utf8.DecodeRuneInString(s[end:]); end < len(s) && unicode.IsLetter(r) {
			continue
		}
		return end
	}
	return i
}

func skipSpace(s string, i int) int {
	for i < len(s) {
		r, size := utf8.DecodeRuneInString(s[i:])
		if !jsSpace(r) {
			break
		}
		i += size
	}
	return i
}

func skipDigits(s string, i int) int {
	for i < len(s) && s[i] >= '0' && s[i] <= '9' {
		i++
	}
	return i
}

// foldPrefix reports whether s[i:] starts with word, ignoring case, and where it ends.
func foldPrefix(s string, i int, word string) (int, bool) {
	for _, w := range word {
		if i >= len(s) {
			return i, false
		}
		r, size := utf8.DecodeRuneInString(s[i:])
		if r != w && unicode.SimpleFold(r) != w && !strings.EqualFold(string(r), string(w)) {
			return i, false
		}
		i += size
	}
	return i, true
}
