// Package safeio writes the app's state, settings and config files so that a
// reader always sees either the old or the new file, never a partial one, and
// survives the short sharing violations Windows reports while an editor,
// backup tool or antivirus scanner holds a file.
package safeio

import (
	"bytes"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"time"
)

// RetryFor bounds how long a write or read waits for a file another program holds.
var RetryFor = 5 * time.Second

// WriteFile replaces path with data: it writes a temporary file in the same
// folder, flushes it to disk, then renames it over path, retrying while the
// target is held by another program. The folder is created when missing.
func WriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Sync()
	}
	if closeErr := f.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Chmod(tmp, perm)
	}
	if err != nil {
		return err
	}
	return Replace(tmp, path)
}

// Replace renames source over target, retrying while target is held.
func Replace(source, target string) error {
	return retry(func() error { return replace(source, target) })
}

// ReadFile reads path, retrying while another program holds it without read
// sharing. A missing file is reported at once (errors.Is(err, fs.ErrNotExist)).
func ReadFile(path string) ([]byte, error) {
	var out []byte
	err := retry(func() error {
		b, err := os.ReadFile(path)
		out = b
		return err
	})
	return out, err
}

// ReadTail reads at most limit bytes from the end of path, dropping the first
// line when it was cut. A missing file returns nil, nil.
func ReadTail(path string, limit int64) ([]byte, error) {
	var out []byte
	err := retry(func() error {
		f, err := os.Open(path)
		if err != nil {
			return err
		}
		defer f.Close()
		info, err := f.Stat()
		if err != nil {
			return err
		}
		offset := int64(0)
		if info.Size() > limit {
			offset = info.Size() - limit
		}
		if _, err := f.Seek(offset, io.SeekStart); err != nil {
			return err
		}
		out, err = io.ReadAll(io.LimitReader(f, limit))
		if err == nil && offset > 0 {
			if i := bytes.IndexByte(out, '\n'); i >= 0 {
				out = out[i+1:]
			} else {
				out = nil
			}
		}
		return err
	})
	if errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	return out, err
}

// retry runs op until it succeeds, fails for a reason other than a held file,
// or RetryFor passes.
func retry(op func() error) error {
	deadline := time.Now().Add(RetryFor)
	wait := 10 * time.Millisecond
	for {
		err := op()
		if err == nil || !Busy(err) || time.Now().After(deadline) {
			return err
		}
		time.Sleep(wait)
		if wait < 250*time.Millisecond {
			wait *= 2
		}
	}
}
