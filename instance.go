package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"

	"github.com/krik-it-dept/agent-ops/internal/safeio"
)

// One Agent Ops instance runs per data folder and Windows logon session. It
// listens on a loopback port, 7790 by default; when another user or program
// holds that port it falls back to another one. session.json in the data folder
// (readable only by this Windows user, like the rest of %LOCALAPPDATA%) names
// the port and the session secret, so a second launch, a toast click, the
// update helper and the tests can reach the running instance.

const (
	defaultAddr     = "127.0.0.1:7790"
	sessionFileName = "session.json"
	// sessionHeader carries the secret for clients that are not the app window.
	sessionHeader = "X-Agent-Ops-Session"
)

// fallbackPorts are tried, in order, when the default port is taken by
// someone else; port 0 (any free port) comes last.
var fallbackPorts = []int{7791, 7792, 7793, 7794, 7795, 7796, 7797, 7798, 7799, 0}

// sessionInfo is session.json.
type sessionInfo struct {
	PID     int    `json:"pid"`
	Addr    string `json:"addr"`
	Secret  string `json:"secret"`
	Version string `json:"version"`
}

var (
	// sessionSecret authenticates every API request (cookie or sessionHeader).
	// Empty means no request is accepted.
	sessionSecret string
	// explicitAddr is set when --addr or AGENT_OPS_ADDR named an address other
	// than the default: that address is used as it is, without a fallback.
	explicitAddr bool
	// resumeSession keeps the previous session secret (internal; restarts and
	// updates pass it, so an open window keeps working).
	resumeSession bool
	instanceMutex windows.Handle
)

func sessionFilePath(data string) string { return filepath.Join(data, sessionFileName) }

func readSession(data string) (sessionInfo, bool) {
	var s sessionInfo
	b, err := safeio.ReadFile(sessionFilePath(data))
	if err != nil || len(b) > 4096 || json.Unmarshal(b, &s) != nil || s.PID <= 0 || !validSecret(s.Secret) || !loopbackAddr(s.Addr) {
		return sessionInfo{}, false
	}
	return s, true
}

func validSecret(s string) bool {
	if len(s) != 64 {
		return false
	}
	_, err := hex.DecodeString(s)
	return err == nil
}

func loopbackAddr(a string) bool {
	host, port, err := net.SplitHostPort(a)
	return err == nil && port != "" && port != "0" && (host == "127.0.0.1" || host == "localhost" || host == "::1")
}

func newSecret() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return hex.EncodeToString(b)
}

// chooseSecret starts a new session, or with --resume-session keeps the
// previous one so a window opened before a restart or an update keeps working.
func chooseSecret(data string, resume bool) string {
	if resume {
		if s, ok := readSession(data); ok {
			return s.Secret
		}
	}
	return newSecret()
}

func writeSession(data string, s sessionInfo) error {
	b, err := json.Marshal(s)
	if err != nil {
		return err
	}
	return safeio.WriteFile(sessionFilePath(data), b, 0o600)
}

// acquireInstance takes the per-user, per-data-folder instance lock. It
// returns false when another instance of this data folder already runs in this
// logon session.
func acquireInstance(data string) bool {
	sum := sha256.Sum256([]byte(strings.ToLower(filepath.Clean(data))))
	name, err := windows.UTF16PtrFromString(`Local\AgentOps-` + hex.EncodeToString(sum[:8]))
	if err != nil {
		return true
	}
	h, err := windows.CreateMutex(nil, false, name)
	if errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		if h != 0 {
			windows.CloseHandle(h)
		}
		return false
	}
	if err != nil {
		// Without a lock the port remains the only guard, as in earlier releases.
		logWarn("could not create the instance lock", "error", err.Error())
		return true
	}
	instanceMutex = h // held for the life of the process
	return true
}

// listenCandidates are the addresses to try: an explicit address alone;
// otherwise the default port, the port of the previous session, then the
// fallback ports.
func listenCandidates(configured string, explicit bool, previous string) []string {
	if explicit {
		return []string{configured}
	}
	out := []string{configured}
	seen := map[string]bool{configured: true}
	if loopbackAddr(previous) && !seen[previous] {
		out = append(out, previous)
		seen[previous] = true
	}
	host, _, _ := net.SplitHostPort(configured)
	for _, port := range fallbackPorts {
		a := net.JoinHostPort(host, fmt.Sprint(port))
		if !seen[a] {
			out = append(out, a)
			seen[a] = true
		}
	}
	return out
}

// listen binds the first free candidate address.
func listen(candidates []string) (net.Listener, error) {
	var last error
	for _, a := range candidates {
		ln, err := net.Listen("tcp", a)
		if err == nil {
			return ln, nil
		}
		last = err
	}
	return nil, last
}

// instanceRequest calls the running instance named by session.json.
func instanceRequest(s sessionInfo, method, path string, body any) (*http.Response, error) {
	var payload io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		payload = bytes.NewReader(b)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, "http://"+s.Addr+path, payload)
	if err != nil {
		return nil, err
	}
	req.Header.Set(sessionHeader, s.Secret)
	req.Header.Set("X-Agent-Ops", "1")
	req.Header.Set("Content-Type", "application/json")
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		return nil, err
	}
	b, _ := io.ReadAll(io.LimitReader(resp.Body, 64<<10))
	resp.Body.Close()
	resp.Body = io.NopCloser(bytes.NewReader(b))
	return resp, nil
}

// handOff asks the instance already running for this data folder to open its
// window (or a plan), waiting up to wait for it to finish starting.
func handOff(data string, open bool, plan string, wait time.Duration) bool {
	deadline := time.Now().Add(wait)
	for {
		if s, ok := readSession(data); ok {
			path, method := "/api/instance", http.MethodGet
			var body any
			if open {
				path, method, body = "/api/instance/open", http.MethodPost, map[string]string{"plan": plan}
			}
			if resp, err := instanceRequest(s, method, path, body); err == nil && resp.StatusCode == http.StatusOK {
				return true
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		time.Sleep(250 * time.Millisecond)
	}
}

// instanceRoutes serve the second launch and the update helper.
func instanceRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/instance", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"pid": os.Getpid(), "version": appVersion})
	})
	mux.HandleFunc("/api/instance/open", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.WriteHeader(http.StatusMethodNotAllowed)
			return
		}
		if !trustedLocalWrite(r) {
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "Only Agent Ops may open its window."})
			return
		}
		var in struct {
			Plan string `json:"plan"`
		}
		if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&in); err != nil || len(in.Plan) > 1024 {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": "Invalid request."})
			return
		}
		openPlanWindow(in.Plan)
		writeJSON(w, http.StatusOK, map[string]any{"pid": os.Getpid()})
	})
}
