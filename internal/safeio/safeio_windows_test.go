package safeio

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

// holdExclusively opens file with no sharing, like an editor saving or an
// antivirus scan, and releases it after d.
func holdExclusively(t *testing.T, file string, d time.Duration) <-chan struct{} {
	t.Helper()
	name, _ := windows.UTF16PtrFromString(file)
	h, err := windows.CreateFile(name, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		t.Fatal(err)
	}
	released := make(chan struct{})
	go func() {
		time.Sleep(d)
		windows.CloseHandle(h)
		close(released)
	}()
	return released
}

func TestWriteFileWaitsOutASharingViolation(t *testing.T) {
	file := filepath.Join(t.TempDir(), "state.json")
	if err := WriteFile(file, []byte(`{"old":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	released := holdExclusively(t, file, 300*time.Millisecond)
	start := time.Now()
	if err := WriteFile(file, []byte(`{"new":true}`), 0o644); err != nil {
		t.Fatal(err)
	}
	<-released
	if time.Since(start) < 250*time.Millisecond {
		t.Error("the write did not wait for the held file")
	}
	if b, _ := os.ReadFile(file); string(b) != `{"new":true}` {
		t.Fatalf("content %s", b)
	}
	if entries, _ := os.ReadDir(filepath.Dir(file)); len(entries) != 1 {
		t.Errorf("temporary files left: %v", entries)
	}
}

func TestReadFileWaitsOutASharingViolation(t *testing.T) {
	file := filepath.Join(t.TempDir(), "config.json")
	if err := os.WriteFile(file, []byte("data"), 0o644); err != nil {
		t.Fatal(err)
	}
	holdExclusively(t, file, 200*time.Millisecond)
	if _, err := os.ReadFile(file); !Busy(err) {
		t.Fatalf("expected a sharing violation from a plain read, got %v", err)
	}
	b, err := ReadFile(file)
	if err != nil || string(b) != "data" {
		t.Fatalf("%q %v", b, err)
	}
}

func TestWriteFileGivesUpOnAPersistentLockAndKeepsTheOldFile(t *testing.T) {
	saved := RetryFor
	RetryFor = 200 * time.Millisecond
	defer func() { RetryFor = saved }()
	file := filepath.Join(t.TempDir(), "locked.json")
	if err := os.WriteFile(file, []byte("old"), 0o644); err != nil {
		t.Fatal(err)
	}
	released := holdExclusively(t, file, time.Second)
	if err := WriteFile(file, []byte("new"), 0o644); !Busy(err) {
		t.Fatalf("expected a busy error, got %v", err)
	}
	<-released
	if b, _ := os.ReadFile(file); string(b) != "old" {
		t.Fatalf("the old file must stay intact, got %q", b)
	}
	if entries, _ := os.ReadDir(filepath.Dir(file)); len(entries) != 1 {
		t.Errorf("temporary files left: %v", entries)
	}
}

func TestReadTailDropsTheCutLine(t *testing.T) {
	file := filepath.Join(t.TempDir(), "activity.jsonl")
	lines := []string{`{"n":1}`, `{"n":2}`, `{"n":3}`, `{"n":4}`}
	whole := strings.Join(lines, "\n") + "\n"
	if err := os.WriteFile(file, []byte(whole), 0o644); err != nil {
		t.Fatal(err)
	}
	if b, err := ReadTail(file, 12); err != nil || !bytes.Equal(b, []byte(`{"n":4}`+"\n")) {
		t.Fatalf("%q %v", b, err)
	}
	if b, err := ReadTail(filepath.Join(filepath.Dir(file), "none"), 10); b != nil || err != nil {
		t.Fatalf("missing file: %q %v", b, err)
	}
	if b, _ := ReadTail(file, 1<<20); string(b) != whole {
		t.Fatalf("whole file %q", b)
	}
}
