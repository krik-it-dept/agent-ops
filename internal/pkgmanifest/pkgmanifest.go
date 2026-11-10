// Package pkgmanifest defines the update package manifest: the list of files a
// release installs into the runtime directory, with their digests and sizes, and
// the files an update removes. The updater validates a package against this
// manifest plus fixed path rules instead of a file list compiled into each
// version, so later releases can add, rename or drop files.
//
// Format 1 readers ignore unknown JSON fields. A change that older readers must
// understand to stay safe needs a new format number and a new release asset name.
package pkgmanifest

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	Format = 1
	// FileName is the manifest's name when a package carries it inside the ZIP.
	// It is metadata, never installed.
	FileName         = "manifest.json"
	MaxManifestBytes = 256 << 10
	MaxFiles         = 256
	MaxRemove        = 256
	MaxPathLength    = 160
	MaxDepth         = 8
	// MaxTotalBytes bounds one file and the whole expanded package.
	MaxTotalBytes = 128 << 20
	// RequiredFile must be in every package: it is the app and the update helper.
	RequiredFile = "agent-ops.exe"
)

type File struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Size   int64  `json:"size"`
}

type Manifest struct {
	Format  int      `json:"format"`
	Version string   `json:"version"`
	Files   []File   `json:"files"`
	Remove  []string `json:"remove"`
}

var (
	segmentPattern = regexp.MustCompile(`^[A-Za-z0-9_][A-Za-z0-9._-]*$`)
	shaPattern     = regexp.MustCompile(`^[a-f0-9]{64}$`)
	// Release builds are stable tags; untagged builds carry a -dev.<commit> suffix.
	versionPattern = regexp.MustCompile(`^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev\.[0-9a-f]{7,40})?$`)
	reservedNames  = map[string]bool{"con": true, "prn": true, "aux": true, "nul": true, "conin$": true, "conout$": true}
	// Program files only. A package can ship JSON, but an update never deletes it,
	// because user registries in the runtime folder are JSON too.
	installExtensions = map[string]bool{".exe": true, ".dll": true, ".mjs": true, ".js": true, ".cjs": true, ".ps1": true, ".md": true, ".txt": true, ".json": true, ".ico": true, ".png": true}
	removeExtensions  = map[string]bool{".exe": true, ".dll": true, ".mjs": true, ".js": true, ".cjs": true, ".ps1": true, ".md": true, ".txt": true, ".ico": true, ".png": true}
)

func init() {
	for i := 0; i <= 9; i++ {
		reservedNames[fmt.Sprintf("com%d", i)] = true
		reservedNames[fmt.Sprintf("lpt%d", i)] = true
	}
}

// ValidPath accepts a relative, forward-slash path inside the runtime directory:
// no absolute or drive paths, no "." or ".." segments, no backslash, colon
// (alternate data streams), spaces or control characters, no Windows device
// names, no trailing dots, and an allowed program-file extension.
func ValidPath(p string) error { return checkPath(p, installExtensions) }

// RemovablePath is ValidPath restricted to extensions an update may delete.
func RemovablePath(p string) error { return checkPath(p, removeExtensions) }

func checkPath(p string, extensions map[string]bool) error {
	if p == "" || len(p) > MaxPathLength {
		return fmt.Errorf("invalid package path length: %q", p)
	}
	segments := strings.Split(p, "/")
	if len(segments) > MaxDepth {
		return fmt.Errorf("package path is too deep: %q", p)
	}
	for _, s := range segments {
		if !segmentPattern.MatchString(s) || strings.HasSuffix(s, ".") {
			return fmt.Errorf("unsafe package path: %q", p)
		}
		stem, _, _ := strings.Cut(strings.ToLower(s), ".")
		if reservedNames[stem] {
			return fmt.Errorf("reserved device name in package path: %q", p)
		}
	}
	if strings.EqualFold(p, FileName) {
		return fmt.Errorf("%s is reserved for package metadata", FileName)
	}
	if !extensions[strings.ToLower(path.Ext(p))] {
		return fmt.Errorf("file type not allowed in a package: %q", p)
	}
	return nil
}

// Validate checks the manifest structure and every path rule.
func (m Manifest) Validate() error {
	if m.Format != Format {
		return fmt.Errorf("unsupported manifest format %d", m.Format)
	}
	if !versionPattern.MatchString(m.Version) {
		return errors.New("invalid manifest version")
	}
	if len(m.Files) == 0 || len(m.Files) > MaxFiles {
		return errors.New("invalid manifest file count")
	}
	if len(m.Remove) > MaxRemove {
		return errors.New("too many files to remove")
	}
	seen := map[string]bool{}
	var total int64
	required := false
	for _, f := range m.Files {
		if err := ValidPath(f.Path); err != nil {
			return err
		}
		key := strings.ToLower(f.Path)
		if seen[key] {
			return fmt.Errorf("duplicate package path: %q", f.Path)
		}
		seen[key] = true
		if !shaPattern.MatchString(f.SHA256) {
			return fmt.Errorf("invalid digest for %q", f.Path)
		}
		if f.Size < 0 || f.Size > MaxTotalBytes || total > MaxTotalBytes-f.Size {
			return errors.New("package exceeds the size limit")
		}
		total += f.Size
		required = required || f.Path == RequiredFile
	}
	if !required {
		return fmt.Errorf("package does not contain %s", RequiredFile)
	}
	// A file cannot also be a directory of another file ("a" and "a/b").
	for _, f := range m.Files {
		for d := path.Dir(f.Path); d != "."; d = path.Dir(d) {
			if seen[strings.ToLower(d)] {
				return fmt.Errorf("package path %q conflicts with a file", d)
			}
		}
	}
	removed := map[string]bool{}
	for _, r := range m.Remove {
		if err := RemovablePath(r); err != nil {
			return err
		}
		key := strings.ToLower(r)
		if seen[key] || removed[key] {
			return fmt.Errorf("remove entry %q is installed or listed twice", r)
		}
		removed[key] = true
	}
	return nil
}

// Parse decodes and validates a manifest.
func Parse(b []byte) (Manifest, error) {
	var m Manifest
	if len(b) == 0 || len(b) > MaxManifestBytes {
		return m, errors.New("invalid manifest size")
	}
	d := json.NewDecoder(bytes.NewReader(b))
	if err := d.Decode(&m); err != nil {
		return m, fmt.Errorf("invalid manifest JSON: %w", err)
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return m, errors.New("trailing data after manifest")
	}
	return m, m.Validate()
}

// Lookup returns the files keyed by exact path.
func (m Manifest) Lookup() map[string]File {
	out := make(map[string]File, len(m.Files))
	for _, f := range m.Files {
		out[f.Path] = f
	}
	return out
}

// Generate builds the manifest for an unpacked package directory. Only regular
// files are accepted; the in-ZIP manifest name itself is skipped.
func Generate(dir, version string, remove []string) (Manifest, error) {
	m := Manifest{Format: Format, Version: version, Files: []File{}, Remove: append([]string{}, remove...)}
	err := filepath.WalkDir(dir, func(file string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type()&fs.ModeSymlink != 0 || entry.Type()&fs.ModeIrregular != 0 {
			return fmt.Errorf("links are not allowed in a package: %s", file)
		}
		if entry.IsDir() {
			return nil
		}
		rel, err := filepath.Rel(dir, file)
		if err != nil {
			return err
		}
		rel = filepath.ToSlash(rel)
		if rel == FileName {
			return nil
		}
		if !entry.Type().IsRegular() {
			return fmt.Errorf("not a regular file: %s", file)
		}
		b, err := os.ReadFile(file)
		if err != nil {
			return err
		}
		sum := sha256.Sum256(b)
		m.Files = append(m.Files, File{Path: rel, SHA256: hex.EncodeToString(sum[:]), Size: int64(len(b))})
		return nil
	})
	if err != nil {
		return m, err
	}
	sort.Slice(m.Files, func(i, j int) bool { return m.Files[i].Path < m.Files[j].Path })
	sort.Strings(m.Remove)
	return m, m.Validate()
}

// Marshal renders a manifest deterministically.
func Marshal(m Manifest) ([]byte, error) {
	if m.Remove == nil {
		m.Remove = []string{}
	}
	b, err := json.MarshalIndent(m, "", "  ")
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
