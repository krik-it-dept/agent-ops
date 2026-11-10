package main

// Local diagnostics: a size-capped rotating log under <data-dir>\logs, panic
// recovery for background work with a crash marker, and capture of fatal Go
// runtime output. Nothing leaves the machine.

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"runtime/debug"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	logMaxBytes   = 1 << 20
	logRotations  = 4 // agent-ops.log plus agent-ops.1.log .. agent-ops.4.log
	fatalLogName  = "fatal.log"
	fatalLogsKept = 5
)

var (
	appLog   = slog.New(slog.DiscardHandler)
	logFile  *rotatingFile
	logDir   string
	crashMu  sync.Mutex
	crashDir string
)

func logInfo(msg string, args ...any)  { appLog.Info(msg, args...) }
func logWarn(msg string, args ...any)  { appLog.Warn(msg, args...) }
func logError(msg string, args ...any) { appLog.Error(msg, args...) }

// rotatingFile is an append-only log file that rolls over at max bytes and keeps
// a fixed number of older files.
type rotatingFile struct {
	mu   sync.Mutex
	path string
	max  int64
	keep int
	f    *os.File
	size int64
}

func openRotating(file string, max int64, keep int) (*rotatingFile, error) {
	if err := os.MkdirAll(filepath.Dir(file), 0o700); err != nil {
		return nil, err
	}
	r := &rotatingFile{path: file, max: max, keep: keep}
	return r, r.open(os.O_APPEND)
}

func (r *rotatingFile) open(mode int) error {
	f, err := os.OpenFile(r.path, os.O_CREATE|os.O_WRONLY|mode, 0o600)
	if err != nil {
		return err
	}
	info, err := f.Stat()
	if err != nil {
		f.Close()
		return err
	}
	r.f, r.size = f, info.Size()
	return nil
}

func (r *rotatingFile) rotated(i int) string {
	return strings.TrimSuffix(r.path, ".log") + fmt.Sprintf(".%d.log", i)
}

func (r *rotatingFile) Write(p []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.f != nil && r.size > 0 && r.size+int64(len(p)) > r.max {
		r.f.Close()
		r.f = nil
		_ = os.Remove(r.rotated(r.keep))
		for i := r.keep - 1; i >= 1; i-- {
			_ = os.Rename(r.rotated(i), r.rotated(i+1))
		}
		if err := os.Rename(r.path, r.rotated(1)); err != nil {
			// Another process (a second instance on the same data folder) still
			// has the file open, so Windows refuses the rename. Keep appending
			// instead of truncating its log, and retry after another max bytes.
			if err := r.open(os.O_APPEND); err != nil {
				return 0, err
			}
			r.size = 0
		} else if err := r.open(os.O_TRUNC); err != nil {
			return 0, err
		}
	}
	if r.f == nil {
		if err := r.open(os.O_APPEND); err != nil {
			return 0, err
		}
	}
	n, err := r.f.Write(p)
	r.size += int64(n)
	return n, err
}

// initLogging sends the structured log to <data>\logs\<name>. The app writes
// agent-ops.log; the update helper writes update.log so the two never interleave.
func initLogging(data, name string) error {
	dir := filepath.Join(data, "logs")
	w, err := openRotating(filepath.Join(dir, name), logMaxBytes, logRotations)
	if err != nil {
		return err
	}
	closeLogging()
	logFile, logDir, crashDir = w, dir, data
	appLog = slog.New(slog.NewTextHandler(w, &slog.HandlerOptions{Level: slog.LevelInfo}))
	return nil
}

// closeLogging stops file logging; tests use it to release their temp folders.
func closeLogging() {
	appLog = slog.New(slog.DiscardHandler)
	if logFile != nil {
		logFile.mu.Lock()
		if logFile.f != nil {
			logFile.f.Close()
			logFile.f = nil
		}
		logFile.mu.Unlock()
		logFile = nil
	}
}

// ---------- crash marker ----------

type crashRecord struct {
	Time    string `json:"time"`
	Version string `json:"version"`
	Kind    string `json:"kind"` // "panic" (recovered) or "fatal" (the previous run ended)
	Where   string `json:"where"`
	Message string `json:"message"`
	Count   int    `json:"count"`
}

func crashFile() string { return filepath.Join(crashDir, "crash.json") }

func firstLine(s string) string {
	s, _, _ = strings.Cut(strings.TrimSpace(s), "\n")
	if len(s) > 300 {
		s = s[:300]
	}
	return strings.TrimSpace(s)
}

func writeCrash(rec crashRecord) {
	if crashDir == "" {
		return
	}
	crashMu.Lock()
	defer crashMu.Unlock()
	if old, ok := readCrash(); ok {
		rec.Count = old.Count
	}
	rec.Count++
	if rec.Time == "" {
		rec.Time = time.Now().Format(time.RFC3339)
	}
	if rec.Version == "" {
		rec.Version = appVersion
	}
	_ = writeUpdateJSON(crashFile(), rec)
}

func readCrash() (crashRecord, bool) {
	var rec crashRecord
	if crashDir == "" {
		return rec, false
	}
	b, err := os.ReadFile(crashFile())
	if err != nil || len(b) > 64<<10 || json.Unmarshal(b, &rec) != nil || rec.Kind == "" {
		return rec, false
	}
	return rec, true
}

func dismissCrash() error {
	crashMu.Lock()
	defer crashMu.Unlock()
	if crashDir == "" {
		return nil
	}
	if err := os.Remove(crashFile()); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// recordPanic logs a recovered panic with its stack and leaves a crash marker
// that the UI shows until dismissed.
func recordPanic(where string, v any) {
	logError("panic recovered", "where", where, "panic", fmt.Sprint(v), "stack", string(debug.Stack()))
	writeCrash(crashRecord{Kind: "panic", Where: where, Message: firstLine(fmt.Sprint(v))})
}

// safeGo runs fn once in a goroutine; a panic is recorded instead of ending the app.
func safeGo(where string, fn func()) {
	go func() {
		defer func() {
			if v := recover(); v != nil {
				recordPanic(where, v)
			}
		}()
		fn()
	}()
}

// superviseGo runs a long-lived loop and restarts it after a panic, with a
// growing delay so a persistent fault cannot spin.
func superviseGo(where string, fn func()) {
	go func() {
		delay := 5 * time.Second
		for runRecovered(where, fn) {
			time.Sleep(delay)
			if delay < 2*time.Minute {
				delay *= 2
			}
			logInfo("restarting background task", "where", where)
		}
	}()
}

func runRecovered(where string, fn func()) (panicked bool) {
	defer func() {
		if v := recover(); v != nil {
			recordPanic(where, v)
			panicked = true
		}
	}()
	fn()
	return false
}

// recoverHandler records a handler panic and answers 500. net/http would recover
// it too, but silently.
func recoverHandler(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if v := recover(); v != nil {
				if v == http.ErrAbortHandler {
					panic(v)
				}
				recordPanic("http "+r.Method+" "+r.URL.Path, v)
				http.Error(w, "Internal error. The log has details.", http.StatusInternalServerError)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// initCrashOutput turns fatal output left by the previous run into a crash
// marker, then sends this run's fatal runtime output (unrecovered panics,
// runtime fatal errors) to logs\fatal.log.
func initCrashOutput() {
	if logDir == "" {
		return
	}
	fatal := filepath.Join(logDir, fatalLogName)
	if info, err := os.Stat(fatal); err == nil && info.Mode().IsRegular() && info.Size() > 0 {
		f, err := os.Open(fatal)
		if err == nil {
			head, _ := io.ReadAll(io.LimitReader(f, 4096))
			f.Close()
			archived := filepath.Join(logDir, "fatal-"+info.ModTime().Format("20060102-150405")+".log")
			_ = os.Rename(fatal, archived)
			message := firstLine(string(head))
			sc := bufio.NewScanner(bytes.NewReader(head))
			for sc.Scan() {
				if line := strings.TrimSpace(sc.Text()); strings.HasPrefix(line, "panic:") || strings.HasPrefix(line, "fatal error:") {
					message = firstLine(line)
					break
				}
			}
			writeCrash(crashRecord{Kind: "fatal", Where: "previous run", Message: message, Time: info.ModTime().Format(time.RFC3339)})
			logError("previous run ended with a fatal error", "message", message, "output", archived)
		}
	}
	pruneFatalLogs()
	f, err := os.OpenFile(fatal, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return
	}
	defer f.Close()
	if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		logWarn("could not capture fatal output", "error", err.Error())
	}
}

func pruneFatalLogs() {
	files, _ := filepath.Glob(filepath.Join(logDir, "fatal-*.log"))
	sort.Sort(sort.Reverse(sort.StringSlice(files)))
	for i := fatalLogsKept; i < len(files); i++ {
		_ = os.Remove(files[i])
	}
}
