package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"unicode/utf8"

	"golang.org/x/sys/windows"
)

var planStages = map[string]bool{
	"Planning": true, "Implementing": true, "Reviewing": true, "Fixing review": true,
	"Testing": true, "Waiting for CI": true, "Waiting for owner": true,
	"Shipping": true, "Blocked": true, "Done": true,
}

type statusChange struct {
	Repo     string `json:"repo"`
	Plan     string `json:"plan"`
	Status   string `json:"status"`
	Revision string `json:"revision"`
}

type statusError struct {
	code int
	text string
}

func (e *statusError) Error() string { return e.text }

func statusConflict() error {
	return &statusError{http.StatusConflict, "This plan changed or is being edited. Refresh and try again."}
}

func validPlanComponent(s string) bool {
	return s != "" && s != "." && s != ".." && strings.TrimSpace(s) == s &&
		!strings.ContainsAny(s, "/\\:\x00") && !strings.HasSuffix(s, ".")
}

// Change only the plan header, preserving all other bytes, including BOM and CRLF.
// Stop before headings/fences so a quoted Status line in a milestone is never edited.
var statusHeader = regexp.MustCompile("(?i)^([\\t ]*(?:Status|Trạng thái):[\\t ]*)(.*?)([\\t ]*)$")

func replacePlanStatus(original []byte, target string) ([]byte, error) {
	return replacePlanHeader(original, "Status", target)
}

func replacePlanHeader(original []byte, field, target string) ([]byte, error) {
	header := statusHeader
	if field == "Agent" {
		header = regexp.MustCompile("(?i)^([\\t ]*Agent:[\\t ]*)(.*?)([\\t ]*)$")
	}
	if field == "Executor" {
		header = regexp.MustCompile("(?i)^([\\t ]*(?:Executor|Executors):[\\t ]*)(.*?)([\\t ]*)$")
	}
	if !utf8.Valid(original) {
		return nil, fmt.Errorf("plan must use UTF-8")
	}
	bom := []byte{}
	content := original
	if bytes.HasPrefix(content, []byte{0xef, 0xbb, 0xbf}) {
		bom, content = content[:3], content[3:]
	}
	lines := strings.Split(string(content), "\n")
	found := -1
	for i, line := range lines {
		line = strings.TrimSuffix(line, "\r")
		trimmed := strings.TrimSpace(line)
		if (strings.HasPrefix(trimmed, "#") && i != 0) || strings.HasPrefix(trimmed, "```") || strings.HasPrefix(trimmed, "~~~") {
			break
		}
		if header.MatchString(line) {
			if found >= 0 {
				return nil, fmt.Errorf("plan has more than one status header")
			}
			found = i
		}
	}
	if found >= 0 {
		line := strings.TrimSuffix(lines[found], "\r")
		match := header.FindStringSubmatch(line)
		ending := ""
		if strings.HasSuffix(lines[found], "\r") {
			ending = "\r"
		}
		lines[found] = match[1] + target + match[3] + ending
		return append(append([]byte{}, bom...), []byte(strings.Join(lines, "\n"))...), nil
	}
	newline := "\n"
	if bytes.Contains(content, []byte("\r\n")) {
		newline = "\r\n"
	}
	result := append(append([]byte{}, bom...), []byte(field+": "+target+newline)...)
	return append(result, content...), nil
}

func revisionOf(b []byte) string { return fmt.Sprintf("%x", sha256.Sum256(b)) }

// Open without sharing reads, writes or deletes. The hash is checked while the same
// handle stays locked, so another editor cannot save between the check and write.
func writePlanStatus(change statusChange) error {
	if !planStages[change.Status] {
		return &statusError{http.StatusBadRequest, "Invalid status."}
	}
	return writePlanHeader(change, "Status")
}
func executorLabel(executors []string) string {
	if executors == nil {
		return "Unknown"
	}
	if len(executors) == 0 {
		return "None"
	}
	return strings.Join(executors, ", ")
}
func writePlanHeader(change statusChange, field string) error {
	if !validPlanComponent(change.Repo) || !validPlanComponent(change.Plan) ||
		strings.EqualFold(change.Plan, "tong-hop") || len(change.Revision) != 64 {
		return &statusError{http.StatusBadRequest, "Invalid plan, status or revision."}
	}
	refreshMu.Lock()
	defer refreshMu.Unlock()
	if updateRestarting.Load() {
		return &statusError{http.StatusServiceUnavailable, "The app is restarting for an update. Retry after it reconnects."}
	}
	mu.Lock()
	_, known := prev[change.Repo+"/"+change.Plan]
	mu.Unlock()
	if !known {
		return &statusError{http.StatusNotFound, "Plan no longer exists. Refresh the board."}
	}
	root, err := filepath.EvalSymlinks(reposDir)
	if err != nil {
		return err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return err
	}
	path := filepath.Join(root, change.Repo, ".tasks", change.Plan+".md")
	resolved, err := filepath.EvalSymlinks(path)
	if errors.Is(err, os.ErrNotExist) {
		return &statusError{http.StatusNotFound, "Plan no longer exists. Refresh the board."}
	}
	if err != nil {
		return err
	}
	if !strings.EqualFold(filepath.Clean(resolved), path) {
		return &statusError{http.StatusBadRequest, "Linked plan paths cannot be edited."}
	}
	ptr, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_ATTRIBUTE_NORMAL, 0)
	if errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
		return statusConflict()
	}
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(handle), path)
	defer file.Close()
	// Verify the opened target too, guarding against a junction changed during open.
	buffer := make([]uint16, 32768)
	n, err := windows.GetFinalPathNameByHandle(handle, &buffer[0], uint32(len(buffer)), 0)
	if err != nil || n >= uint32(len(buffer)) {
		return fmt.Errorf("cannot verify plan path")
	}
	actual := windows.UTF16ToString(buffer[:n])
	actual = strings.TrimPrefix(actual, "\\\\?\\")
	if strings.HasPrefix(actual, "UNC\\") {
		actual = "\\\\" + strings.TrimPrefix(actual, "UNC\\")
	}
	if !strings.EqualFold(filepath.Clean(actual), path) {
		return &statusError{http.StatusBadRequest, "Linked plan paths cannot be edited."}
	}
	info, err := file.Stat()
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() > 2*1024*1024 {
		return &statusError{http.StatusBadRequest, "Plan is not a supported text file."}
	}
	original, err := io.ReadAll(file)
	if err != nil {
		return err
	}
	if revisionOf(original) != change.Revision {
		return statusConflict()
	}
	updated, err := replacePlanStatus(original, change.Status)
	if err != nil {
		return &statusError{http.StatusBadRequest, err.Error()}
	}
	if bytes.Equal(updated, original) {
		return nil
	}
	write := func(b []byte) error {
		if _, err := file.WriteAt(b, 0); err != nil {
			return err
		}
		if err := file.Truncate(int64(len(b))); err != nil {
			return err
		}
		return file.Sync()
	}
	if err := write(updated); err != nil {
		if restoreErr := write(original); restoreErr != nil {
			return fmt.Errorf("save failed: %v; restoring original failed: %v", err, restoreErr)
		}
		return fmt.Errorf("status was not saved: %w", err)
	}
	return nil
}

func handlePlanStatus(w http.ResponseWriter, r *http.Request) { handlePlanUpdate(w, r, "status") }
func handlePlanUpdate(w http.ResponseWriter, r *http.Request, field string) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	fail := func(code int, reason string) {
		w.WriteHeader(code)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
	}
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		fail(http.StatusMethodNotAllowed, "Use POST.")
		return
	}
	// A custom header and same-origin checks protect the local write endpoint from
	// cross-site form submissions, fetches and DNS rebinding. No CORS is enabled.
	if !trustedLocalWrite(r) ||
		!strings.HasPrefix(r.Header.Get("Content-Type"), "application/json") {
		fail(http.StatusForbidden, "Plan changes must come from this Workboard.")
		return
	}
	var change statusChange
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&change); err != nil {
		fail(http.StatusBadRequest, "Invalid plan change.")
		return
	}
	if err := decoder.Decode(new(any)); err != io.EOF {
		fail(http.StatusBadRequest, "Expected one plan change.")
		return
	}
	err := writePlanStatus(change)
	if err != nil {
		var problem *statusError
		if errors.As(err, &problem) {
			fail(problem.code, problem.text)
		} else {
			fail(http.StatusInternalServerError, "Could not save status: "+err.Error())
		}
		return
	}
	refresh(false)
	mu.Lock()
	reason := refreshError
	mu.Unlock()
	_ = json.NewEncoder(w).Encode(map[string]any{"saved": true, "status": change.Status, "error": reason})
}
