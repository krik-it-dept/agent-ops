package main

// Safe edits of AI client files (skills, instruction files, Claude settings). The
// owner and the clients themselves edit these files too, so every change:
//   - starts from bytes read just before, and re-reads the file right before the
//     final rename; if anything changed meanwhile, nothing is written;
//   - backs the previous file up first;
//   - replaces the file atomically (temp file in the same folder, then rename);
//   - never follows a symbolic link or junction.
// Only text inside Agent Ops' own markers, or a whole file Agent Ops wrote, is
// ever changed.

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unicode/utf8"
)

var errClientFileChanged = errors.New("the file changed while Agent Ops was editing it; nothing was written")
var errClientFileLinked = errors.New("the file is a link; Agent Ops does not edit linked files")

// userHomeDir is replaced in tests. Paths outside a profile (APPDATA, CLAUDE_CONFIG_DIR,
// LOCALAPPDATA) are used only when the profile is this user's real home, so a
// test or an isolated install never reaches the real client configuration.
var userHomeDir = os.UserHomeDir

func isRealProfile(profile string) bool {
	home, err := userHomeDir()
	return err == nil && samePath(profile, home)
}

func profileLocalAppData(profile string) string {
	if v := os.Getenv("LOCALAPPDATA"); v != "" && isRealProfile(profile) {
		return v
	}
	return filepath.Join(profile, "AppData", "Local")
}

func profileRoamingAppData(profile string) string {
	if v := os.Getenv("APPDATA"); v != "" && isRealProfile(profile) {
		return v
	}
	return filepath.Join(profile, "AppData", "Roaming")
}

// claudeHomes are the Claude Code configuration folders of a profile: ~/.claude,
// CLAUDE_CONFIG_DIR, and every Orca Claude profile (Orca runs Claude with
// CLAUDE_CONFIG_DIR=%APPDATA%\orca\claude-profiles\<id>\home).
func claudeHomes(profile string) []string {
	homes := []string{filepath.Join(profile, ".claude")}
	if v := os.Getenv("CLAUDE_CONFIG_DIR"); v != "" && isRealProfile(profile) && filepath.IsAbs(v) {
		homes = append(homes, filepath.Clean(v))
	}
	orca, _ := filepath.Glob(filepath.Join(profileRoamingAppData(profile), "orca", "claude-profiles", "*", "home"))
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

func sha256Hex(b []byte) string {
	sum := sha256.Sum256(b)
	return hex.EncodeToString(sum[:])
}

// lfText normalizes line endings for comparisons and hashes.
func lfText(b []byte) string { return strings.ReplaceAll(string(b), "\r\n", "\n") }

// linkedPath reports a symbolic link or junction at the file itself.
func linkedPath(file string) bool {
	info, err := os.Lstat(file)
	return err == nil && info.Mode()&(os.ModeSymlink|os.ModeIrregular) != 0
}

// readClientFile returns the content, or nil when the file does not exist.
func readClientFile(file string) ([]byte, error) {
	if linkedPath(file) {
		return nil, errClientFileLinked
	}
	b, err := os.ReadFile(file)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if b == nil && err == nil {
		b = []byte{}
	}
	return b, err
}

// backupClientFile copies file into backupDir, keeping its path below base (or
// its full path without the drive colon when it is not below base).
func backupClientFile(file, base, backupDir string, content []byte) (string, error) {
	rel, err := filepath.Rel(base, file)
	if err != nil || rel == "." || strings.HasPrefix(rel, "..") || filepath.IsAbs(rel) {
		rel = strings.ReplaceAll(strings.TrimPrefix(filepath.Clean(file), `\\`), ":", "")
	}
	target := filepath.Join(backupDir, rel)
	if err := os.MkdirAll(filepath.Dir(target), 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(target, content, 0o600); err != nil {
		return "", err
	}
	return target, nil
}

// writeClientFile replaces file with content (nil deletes it) when the file still
// holds expected (nil: did not exist). The old file is backed up first.
func writeClientFile(file string, expected, content []byte, base, backupDir string) error {
	_, err := writeClientFileAt(file, expected, content, base, backupDir)
	return err
}

// writeClientFileAt is writeClientFile that also returns where the previous
// content was backed up ("" when the file did not exist, or when backupDir is
// empty: a rollback that writes back bytes it already holds needs no backup).
func writeClientFileAt(file string, expected, content []byte, base, backupDir string) (string, error) {
	current, err := readClientFile(file)
	if err != nil {
		return "", err
	}
	if (current == nil) != (expected == nil) || !bytes.Equal(current, expected) {
		return "", errClientFileChanged
	}
	saved := ""
	if current != nil && backupDir != "" {
		if saved, err = backupClientFile(file, base, backupDir, current); err != nil {
			return "", fmt.Errorf("backup failed, nothing was written: %w", err)
		}
	}
	if content == nil {
		if current == nil {
			return "", nil
		}
		// Re-check right before the delete as well.
		if again, err := readClientFile(file); err != nil || !bytes.Equal(again, expected) {
			return "", errClientFileChanged
		}
		return saved, os.Remove(file)
	}
	if err := os.MkdirAll(filepath.Dir(file), 0o755); err != nil {
		return "", err
	}
	f, err := os.CreateTemp(filepath.Dir(file), ".agent-ops-*.tmp")
	if err != nil {
		return "", err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err = f.Write(content); err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return "", err
	}
	again, err := readClientFile(file)
	if err != nil {
		return "", err
	}
	if (again == nil) != (expected == nil) || !bytes.Equal(again, expected) {
		return "", errClientFileChanged
	}
	return saved, replaceUpdateFile(tmp, file)
}

// ---------- marked blocks ----------

// findBlock locates start..end markers. ok is false for an incomplete or
// reversed pair (only a start, only an end, or more than one block).
func findBlock(text, start, end string) (a, b int, found, ok bool) {
	a, b = strings.Index(text, start), strings.Index(text, end)
	if a < 0 && b < 0 {
		return -1, -1, false, true
	}
	if a < 0 || b < 0 || b < a || strings.Count(text, start) > 1 || strings.Count(text, end) > 1 {
		return a, b, true, false
	}
	return a, b + len(end), true, true
}

// removeBlock deletes the text between a and b (a marked block) with its line
// break, and the blank line that was added before it when it was appended at the
// end of the file. Text outside the block is otherwise unchanged.
func removeBlock(text string, a, b int) string {
	before, after := text[:a], text[b:]
	if strings.HasPrefix(after, "\r\n") {
		after = after[2:]
	} else if strings.HasPrefix(after, "\n") {
		after = after[1:]
	}
	if strings.TrimSpace(after) == "" {
		trimmed := strings.TrimRight(before, "\r\n")
		if trimmed == "" {
			return ""
		}
		ending := "\n"
		if strings.Contains(before[len(trimmed):], "\r\n") {
			ending = "\r\n"
		}
		return trimmed + ending
	}
	return before + after
}

// ---------- order-preserving JSON ----------

// jsonNode keeps object key order, so editing Claude's settings.json changes only
// the hooks that are removed.
type jsonNode struct {
	object bool
	array  bool
	keys   []string
	vals   []*jsonNode
	items  []*jsonNode
	raw    json.RawMessage
}

func parseJSONNode(b []byte) (*jsonNode, error) {
	dec := json.NewDecoder(bytes.NewReader(bytes.TrimPrefix(b, []byte{0xef, 0xbb, 0xbf})))
	dec.UseNumber()
	n, err := decodeJSONNode(dec)
	if err != nil {
		return nil, err
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("unexpected data after the JSON value")
	}
	return n, nil
}

func decodeJSONNode(dec *json.Decoder) (*jsonNode, error) {
	tok, err := dec.Token()
	if err != nil {
		return nil, err
	}
	switch t := tok.(type) {
	case json.Delim:
		switch t {
		case '{':
			n := &jsonNode{object: true}
			for dec.More() {
				kt, err := dec.Token()
				if err != nil {
					return nil, err
				}
				key, ok := kt.(string)
				if !ok {
					return nil, errors.New("invalid object key")
				}
				v, err := decodeJSONNode(dec)
				if err != nil {
					return nil, err
				}
				n.keys, n.vals = append(n.keys, key), append(n.vals, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return n, nil
		case '[':
			n := &jsonNode{array: true, items: []*jsonNode{}}
			for dec.More() {
				v, err := decodeJSONNode(dec)
				if err != nil {
					return nil, err
				}
				n.items = append(n.items, v)
			}
			if _, err := dec.Token(); err != nil {
				return nil, err
			}
			return n, nil
		}
		return nil, errors.New("unexpected delimiter")
	default:
		raw, err := marshalNoEscape(t)
		if err != nil {
			return nil, err
		}
		return &jsonNode{raw: raw}, nil
	}
}

func marshalNoEscape(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

func (n *jsonNode) get(key string) *jsonNode {
	for i, k := range n.keys {
		if k == key {
			return n.vals[i]
		}
	}
	return nil
}

func (n *jsonNode) remove(key string) {
	for i, k := range n.keys {
		if k == key {
			n.keys = append(n.keys[:i], n.keys[i+1:]...)
			n.vals = append(n.vals[:i], n.vals[i+1:]...)
			return
		}
	}
}

func (n *jsonNode) str() (string, bool) {
	if n == nil || n.object || n.array {
		return "", false
	}
	var s string
	if json.Unmarshal(n.raw, &s) != nil {
		return "", false
	}
	return s, true
}

// encode writes the node like JSON.stringify(value, null, 2).
func (n *jsonNode) encode(buf *bytes.Buffer, indent string) {
	switch {
	case n.object:
		if len(n.keys) == 0 {
			buf.WriteString("{}")
			return
		}
		buf.WriteString("{\n")
		for i, k := range n.keys {
			key, _ := marshalNoEscape(k)
			buf.WriteString(indent + "  ")
			buf.Write(key)
			buf.WriteString(": ")
			n.vals[i].encode(buf, indent+"  ")
			if i < len(n.keys)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		buf.WriteString(indent + "}")
	case n.array:
		if len(n.items) == 0 {
			buf.WriteString("[]")
			return
		}
		buf.WriteString("[\n")
		for i, v := range n.items {
			buf.WriteString(indent + "  ")
			v.encode(buf, indent+"  ")
			if i < len(n.items)-1 {
				buf.WriteString(",")
			}
			buf.WriteString("\n")
		}
		buf.WriteString(indent + "]")
	default:
		buf.Write(n.raw)
	}
}

// removeHooksMatching drops every Claude hook whose command contains all of
// markers. A rule, event list or the hooks object is dropped only when this
// removal emptied it. It returns the number of hooks removed.
func removeHooksMatching(root *jsonNode, markers []string) int {
	if root == nil || !root.object {
		return 0
	}
	hooks := root.get("hooks")
	if hooks == nil || !hooks.object {
		return 0
	}
	removed := 0
	for _, event := range append([]string{}, hooks.keys...) {
		list := hooks.get(event)
		if list == nil || !list.array {
			continue
		}
		before := len(list.items)
		kept := []*jsonNode{}
		for _, rule := range list.items {
			inner := (*jsonNode)(nil)
			if rule.object {
				inner = rule.get("hooks")
			}
			if inner == nil || !inner.array {
				kept = append(kept, rule)
				continue
			}
			left := []*jsonNode{}
			for _, h := range inner.items {
				if cmd, ok := h.get2("command"); ok && containsAll(cmd, markers) {
					removed++
					continue
				}
				left = append(left, h)
			}
			if len(left) == 0 && len(inner.items) > 0 {
				continue
			}
			inner.items = left
			kept = append(kept, rule)
		}
		list.items = kept
		if len(kept) == 0 && before > 0 {
			hooks.remove(event)
		}
	}
	if removed > 0 && len(hooks.keys) == 0 {
		root.remove("hooks")
	}
	return removed
}

// get2 reads a string property of an object node.
func (n *jsonNode) get2(key string) (string, bool) {
	if n == nil || !n.object {
		return "", false
	}
	return n.get(key).str()
}

func containsAll(s string, parts []string) bool {
	for _, p := range parts {
		if !strings.Contains(s, p) {
			return false
		}
	}
	return len(parts) > 0
}

// settingsWithoutHooks returns the settings file content without the hooks whose
// command contains all of markers, keeping key order, a BOM and the line ending
// style. A file that is not valid UTF-8 is refused: re-encoding it would replace
// the invalid bytes.
func settingsWithoutHooks(original []byte, markers ...string) ([]byte, int, error) {
	if !utf8.Valid(original) {
		return nil, 0, errors.New("not valid UTF-8")
	}
	root, err := parseJSONNode(original)
	if err != nil {
		return nil, 0, err
	}
	n := removeHooksMatching(root, markers)
	if n == 0 {
		return original, 0, nil
	}
	var buf bytes.Buffer
	if bytes.HasPrefix(original, []byte{0xef, 0xbb, 0xbf}) {
		buf.Write([]byte{0xef, 0xbb, 0xbf})
	}
	root.encode(&buf, "")
	buf.WriteString("\n")
	out := buf.Bytes()
	if bytes.Contains(original, []byte("\r\n")) {
		out = bytes.ReplaceAll(out, []byte("\n"), []byte("\r\n"))
	}
	return out, n, nil
}
