package main

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"
)

// The desktop service is trusted-local only. A loopback bind alone does not
// prevent DNS rebinding or cross-site requests from an unrelated browser page.
func trustedLocalRequest(r *http.Request) bool {
	return r.Host == addr &&
		(r.Header.Get("Origin") == "" || r.Header.Get("Origin") == "http://"+addr) &&
		r.Header.Get("Sec-Fetch-Site") != "cross-site"
}

func trustedLocalWrite(r *http.Request) bool {
	return trustedLocalRequest(r) && r.Header.Get("X-Agent-Ops") == "1"
}

// A loopback port is reachable by every user and program on the machine, so
// each request must also prove it belongs to this app session: the app window
// carries an HttpOnly session cookie, other clients (a second launch, the
// update helper) send the secret from session.json in sessionHeader. The
// window gets its cookie from a single-use launch token in the URL Agent Ops
// opens (openWindowAt), exchanged at launchPath.
const (
	launchPath      = "/open"
	launchTokenTTL  = 2 * time.Minute
	maxLaunchTokens = 32
)

var (
	launchMu     sync.Mutex
	launchTokens = map[string]time.Time{}
)

// sessionCookieName includes the port: browsers share cookies of 127.0.0.1
// across ports.
func sessionCookieName() string {
	_, port, _ := net.SplitHostPort(addr)
	return "agent_ops_session_" + port
}

func sameSecret(given string) bool {
	return sessionSecret != "" && subtle.ConstantTimeCompare([]byte(given), []byte(sessionSecret)) == 1
}

// sessionRequest reports whether r carries this session's secret.
func sessionRequest(r *http.Request) bool {
	if sameSecret(r.Header.Get(sessionHeader)) {
		return true
	}
	c, err := r.Cookie(sessionCookieName())
	return err == nil && sameSecret(c.Value)
}

// newLaunchToken issues a single-use token for one window launch.
func newLaunchToken() string {
	token := newSecret()
	launchMu.Lock()
	defer launchMu.Unlock()
	now := time.Now()
	for t, expiry := range launchTokens {
		if now.After(expiry) || len(launchTokens) >= maxLaunchTokens {
			delete(launchTokens, t)
		}
	}
	launchTokens[token] = now.Add(launchTokenTTL)
	return token
}

func useLaunchToken(token string) bool {
	if !validSecret(token) {
		return false
	}
	launchMu.Lock()
	defer launchMu.Unlock()
	expiry, ok := launchTokens[token]
	delete(launchTokens, token)
	return ok && time.Now().Before(expiry)
}

// publicPath is served without a session: bundled icons and fonts only.
func publicPath(p string) bool {
	return strings.HasPrefix(p, "/icons/") || strings.HasPrefix(p, "/fonts/")
}

const sessionRequiredPage = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Agent Ops</title></head>` +
	`<body style="font:15px system-ui,sans-serif;margin:40px;max-width:560px"><h1 style="font-size:20px">Open Agent Ops from its tray icon</h1>` +
	`<p>This window is not signed in to the running Agent Ops (it was opened by another program, or Agent Ops restarted with a new session). ` +
	`Close it, then open Agent Ops from the tray icon or the Start menu.</p></body></html>`

// handleLaunch exchanges a launch token for the session cookie and goes to the
// board; the browser keeps the URL fragment (a plan or Settings) on the redirect.
func handleLaunch(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if useLaunchToken(r.URL.Query().Get("token")) {
		http.SetCookie(w, &http.Cookie{Name: sessionCookieName(), Value: sessionSecret, Path: "/", HttpOnly: true, SameSite: http.SameSiteStrictMode})
	} else if !sessionRequest(r) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(sessionRequiredPage))
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	http.Redirect(w, r, "/", http.StatusSeeOther)
}

func localBoundary(next http.Handler) http.Handler {
	start := bytes.Index(indexHTML, []byte("<script>")) + len("<script>")
	end := bytes.Index(indexHTML, []byte("</script>"))
	var script []byte
	if start >= len("<script>") && end >= start {
		script = bytes.ReplaceAll(indexHTML[start:end], []byte("\r\n"), []byte("\n"))
		script = bytes.ReplaceAll(script, []byte("\r"), []byte("\n"))
	}
	hash := sha256.Sum256(script)
	// Fonts and all other UI assets are bundled and served from this origin.
	csp := "default-src 'self'; script-src 'sha256-" + base64.StdEncoding.EncodeToString(hash[:]) + "'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'"
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Security-Policy", csp)
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("Referrer-Policy", "no-referrer")
		if !trustedLocalRequest(r) {
			http.Error(w, "Only local Agent Ops requests are accepted.", http.StatusForbidden)
			return
		}
		switch {
		case r.URL.Path == launchPath:
			handleLaunch(w, r)
			return
		case publicPath(r.URL.Path):
		case !sessionRequest(r):
			w.Header().Set("Cache-Control", "no-store")
			if r.URL.Path == "/" {
				w.Header().Set("Content-Type", "text/html; charset=utf-8")
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(sessionRequiredPage))
				return
			}
			writeJSON(w, http.StatusForbidden, map[string]string{"error": "This window is not signed in to Agent Ops. Close it and open Agent Ops from the tray icon."})
			return
		}
		next.ServeHTTP(w, r)
	})
}
