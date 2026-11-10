package main

import (
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

const testSecret = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func init() { sessionSecret = testSecret }

// withSession signs a test request in, like the update helper does.
func withSession(r *http.Request) *http.Request {
	r.Header.Set(sessionHeader, testSecret)
	return r
}

func boundaryFixture() (http.Handler, *int) {
	called := 0
	return localBoundary(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++; w.WriteHeader(200) })), &called
}

func TestEveryRequestNeedsTheSessionSecret(t *testing.T) {
	handler, called := boundaryFixture()
	serve := func(r *http.Request) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	for _, path := range []string{"/", "/api/state", "/events", "/api/instance", "/api/settings"} {
		w := serve(httptest.NewRequest("GET", "http://"+addr+path, nil))
		if w.Code != 403 {
			t.Fatal(path, "without the secret:", w.Code)
		}
		wrong := httptest.NewRequest("GET", "http://"+addr+path, nil)
		wrong.Header.Set(sessionHeader, strings.Repeat("f", 64))
		wrong.AddCookie(&http.Cookie{Name: sessionCookieName(), Value: "guess"})
		if w := serve(wrong); w.Code != 403 {
			t.Fatal(path, "with a wrong secret:", w.Code)
		}
	}
	if w := serve(httptest.NewRequest("GET", "http://"+addr+"/", nil)); !strings.Contains(w.Body.String(), "Open Agent Ops from its tray icon") || w.Header().Get("Content-Security-Policy") == "" {
		t.Fatal("the page without a session explains how to open the app", w.Body.String())
	}
	if w := serve(httptest.NewRequest("GET", "http://"+addr+"/api/state", nil)); !strings.Contains(w.Body.String(), `"error"`) {
		t.Fatal("API refusal is JSON", w.Body.String())
	}
	if *called != 0 {
		t.Fatal("a request without the secret reached a handler")
	}
	for _, path := range []string{"/icons/app.png", "/fonts/Geist-Variable.woff2"} {
		if w := serve(httptest.NewRequest("GET", "http://"+addr+path, nil)); w.Code != 200 {
			t.Fatal(path, w.Code)
		}
	}
	if w := serve(withSession(httptest.NewRequest("GET", "http://"+addr+"/api/state", nil))); w.Code != 200 {
		t.Fatal("header", w.Code)
	}
	cookie := httptest.NewRequest("GET", "http://"+addr+"/api/state", nil)
	cookie.AddCookie(&http.Cookie{Name: sessionCookieName(), Value: testSecret})
	if w := serve(cookie); w.Code != 200 {
		t.Fatal("cookie", w.Code)
	}
	// The session never replaces the Host, Origin and cross-site checks.
	cross := withSession(httptest.NewRequest("GET", "http://"+addr+"/api/state", nil))
	cross.Header.Set("Origin", "https://other.invalid")
	if w := serve(cross); w.Code != 403 {
		t.Fatal("cross-site with the secret", w.Code)
	}
	saved := sessionSecret
	sessionSecret = ""
	defer func() { sessionSecret = saved }()
	empty := httptest.NewRequest("GET", "http://"+addr+"/api/state", nil)
	empty.Header.Set(sessionHeader, "")
	if w := serve(empty); w.Code != 403 {
		t.Fatal("no session configured must refuse everything", w.Code)
	}
}

func TestLaunchTokenSignsTheWindowInOnce(t *testing.T) {
	handler, _ := boundaryFixture()
	var opened string
	savedLaunch := launchWindow
	launchWindow = func(target string) { opened = target }
	defer func() { launchWindow = savedLaunch }()
	openPlanWindow("p1/web/plan")
	prefix := "http://" + addr + launchPath + "?token="
	if !strings.HasPrefix(opened, prefix) || !strings.HasSuffix(opened, "#plan=p1%2Fweb%2Fplan") {
		t.Fatal(opened)
	}
	launch := strings.TrimPrefix(opened, "http://"+addr)
	launch = launch[:strings.Index(launch, "#")]
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "http://"+addr+launch, nil))
	if w.Code != http.StatusSeeOther || w.Header().Get("Location") != "/" {
		t.Fatal(w.Code, w.Header())
	}
	cookies := w.Result().Cookies()
	if len(cookies) != 1 || cookies[0].Name != sessionCookieName() || cookies[0].Value != testSecret || !cookies[0].HttpOnly || cookies[0].SameSite != http.SameSiteStrictMode {
		t.Fatalf("%+v", cookies)
	}
	// The token works once.
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "http://"+addr+launch, nil))
	if w.Code != 403 || len(w.Result().Cookies()) != 0 {
		t.Fatal("a used token signed in again", w.Code)
	}
	// An expired token does not sign in.
	token := newLaunchToken()
	launchMu.Lock()
	launchTokens[token] = time.Now().Add(-time.Second)
	launchMu.Unlock()
	w = httptest.NewRecorder()
	handler.ServeHTTP(w, httptest.NewRequest("GET", "http://"+addr+launchPath+"?token="+token, nil))
	if w.Code != 403 {
		t.Fatal("expired token", w.Code)
	}
}

func occupy(t *testing.T) (net.Listener, int) {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { ln.Close() })
	return ln, ln.Addr().(*net.TCPAddr).Port
}

func TestDefaultPortFallsBackWhenAnotherProgramHoldsIt(t *testing.T) {
	_, taken := occupy(t)
	_, previous := occupy(t)
	configured := fmt.Sprintf("127.0.0.1:%d", taken)
	saved := fallbackPorts
	defer func() { fallbackPorts = saved }()
	fallbackPorts = []int{previous, 0}
	candidates := listenCandidates(configured, false, "127.0.0.1:"+fmt.Sprint(previous))
	if len(candidates) != 3 || candidates[0] != configured {
		t.Fatal(candidates)
	}
	ln, err := listen(candidates)
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	if port := ln.Addr().(*net.TCPAddr).Port; port == taken || port == previous {
		t.Fatal("bound a taken port", port)
	}
	// An explicit address is used as it is: no fallback, and no foreign page opened.
	if c := listenCandidates(configured, true, ""); len(c) != 1 {
		t.Fatal(c)
	}
	if _, err := listen(listenCandidates(configured, true, "")); err == nil {
		t.Fatal("an explicit taken address must fail")
	}
	// The previous session's port is tried before the fixed fallbacks.
	if c := listenCandidates(defaultAddr, false, "127.0.0.1:7795"); c[1] != "127.0.0.1:7795" || c[len(c)-1] != "127.0.0.1:0" {
		t.Fatal(c)
	}
}

func TestOneInstancePerDataFolder(t *testing.T) {
	dir := isolated(t)
	saved := instanceMutex
	defer func() { instanceMutex = saved }()
	if !acquireInstance(dir) {
		t.Fatal("first instance")
	}
	if acquireInstance(strings.ToUpper(dir) + `\`) {
		t.Fatal("a second instance of the same data folder started")
	}
	if !acquireInstance(dir + "-other") {
		t.Fatal("another data folder is another instance")
	}
}

// A second launch reaches the running instance through session.json, which
// names its port and secret; a stale or foreign file is not trusted.
func TestSecondLaunchHandsOffToTheRunningInstance(t *testing.T) {
	dir := isolated(t)
	ln, port := occupy(t)
	savedAddr, savedLaunch := addr, launchWindow
	defer func() { addr, launchWindow = savedAddr, savedLaunch }()
	addr = fmt.Sprintf("127.0.0.1:%d", port)
	opened := make(chan string, 1)
	launchWindow = func(target string) { opened <- target }
	server := &http.Server{Handler: localBoundary(newServeMux())}
	go server.Serve(ln)
	defer server.Close()
	if handOff(dir, false, "", 300*time.Millisecond) {
		t.Fatal("handed off without a session file")
	}
	if err := writeSession(dir, sessionInfo{PID: os.Getpid(), Addr: addr, Secret: strings.Repeat("e", 64)}); err != nil {
		t.Fatal(err)
	}
	if handOff(dir, false, "", 300*time.Millisecond) {
		t.Fatal("handed off to an instance with another secret")
	}
	if err := writeSession(dir, sessionInfo{PID: os.Getpid(), Addr: addr, Secret: testSecret, Version: appVersion}); err != nil {
		t.Fatal(err)
	}
	if !handOff(dir, true, "p/web/plan", 5*time.Second) {
		t.Fatal("no hand-off")
	}
	select {
	case target := <-opened:
		if !strings.Contains(target, "/open?token=") || !strings.HasSuffix(target, "#plan=p%2Fweb%2Fplan") {
			t.Fatal(target)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the running instance did not open its window")
	}
	if s, ok := readSession(dir); !ok || s.Addr != addr {
		t.Fatal(s, ok)
	}
	b, _ := json.Marshal(sessionInfo{PID: 1, Addr: "10.0.0.1:80", Secret: testSecret})
	put(t, sessionFilePath(dir), string(b))
	if _, ok := readSession(dir); ok {
		t.Fatal("a session file naming a non-loopback address was trusted")
	}
}

// The update helper finds the new app through session.json, also on a fallback port.
func TestUpdateHealthFollowsTheSessionFile(t *testing.T) {
	dir := isolated(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get(sessionHeader) != testSecret {
			w.WriteHeader(403)
			return
		}
		if r.URL.Path == "/api/state" {
			fmt.Fprintf(w, `{"appVersion":"v9.9.9","error":"","state":{"plans":[]}}`)
			return
		}
		_ = json.NewEncoder(w).Encode(updateState{Current: "v9.9.9", ProcessID: 77})
	}))
	defer server.Close()
	if updateHealthSession(dir, "v9.9.9", 77, 300*time.Millisecond) {
		t.Fatal("healthy without a session file")
	}
	host := strings.TrimPrefix(server.URL, "http://")
	if err := writeSession(dir, sessionInfo{PID: 76, Addr: host, Secret: testSecret}); err != nil {
		t.Fatal(err)
	}
	if updateHealthSession(dir, "v9.9.9", 77, 300*time.Millisecond) {
		t.Fatal("healthy through another process's session")
	}
	if err := writeSession(dir, sessionInfo{PID: 77, Addr: host, Secret: testSecret}); err != nil {
		t.Fatal(err)
	}
	if !updateHealthSession(dir, "v9.9.9", 77, 5*time.Second) {
		t.Fatal("not healthy")
	}
}

func TestRestartKeepsTheSessionAndOnlyAnExplicitAddress(t *testing.T) {
	dir := isolated(t)
	savedAddr, savedExplicit := addr, explicitAddr
	defer func() { addr, explicitAddr = savedAddr, savedExplicit }()
	if err := writeSession(dir, sessionInfo{PID: 5, Addr: "127.0.0.1:7791", Secret: testSecret}); err != nil {
		t.Fatal(err)
	}
	if chooseSecret(dir, true) != testSecret {
		t.Fatal("a restart must keep the session so open windows keep working")
	}
	if s := chooseSecret(dir, false); s == testSecret || !validSecret(s) {
		t.Fatal("a new launch must start a new session")
	}
	addr, explicitAddr = "127.0.0.1:7791", false
	args := strings.Join(launchArgs(), " ")
	if !strings.Contains(args, "--resume-session") || strings.Contains(args, "--addr") {
		t.Fatal(args)
	}
	addr, explicitAddr = "127.0.0.1:18000", true
	if args := strings.Join(launchArgs(), " "); !strings.Contains(args, "--addr 127.0.0.1:18000") {
		t.Fatal(args)
	}
}
