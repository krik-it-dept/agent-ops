package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestLocalBoundaryRejectsRebindingAndCrossSiteReads(t *testing.T) {
	called := 0
	handler := localBoundary(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { called++; w.WriteHeader(200) }))
	for _, tc := range []struct{ host, origin, site string }{
		{"attacker.example", "", ""}, {addr, "https://attacker.example", "cross-site"}, {addr, "null", ""}, {addr, "", "cross-site"},
	} {
		r := httptest.NewRequest("GET", "http://"+addr+"/api/state", nil)
		r.Host = tc.host
		r.Header.Set("Origin", tc.origin)
		r.Header.Set("Sec-Fetch-Site", tc.site)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatal(tc, w.Code)
		}
	}
	if called != 0 {
		t.Fatal("rejected requests reached state handler")
	}
	r := httptest.NewRequest("GET", "http://"+addr+"/api/state", nil)
	r.Header.Set("Origin", "http://"+addr)
	r.Header.Set("Sec-Fetch-Site", "same-origin")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if w.Code != 200 || called != 1 {
		t.Fatal(w.Code, called)
	}
	csp := w.Header().Get("Content-Security-Policy")
	if !strings.Contains(csp, "script-src 'sha256-") || strings.Contains(csp, "script-src 'unsafe-inline'") || w.Header().Get("X-Frame-Options") != "DENY" {
		t.Fatal("unsafe browser boundary", csp)
	}
}

func TestRefreshRejectsCrossSiteWritesBeforeRunningCollector(t *testing.T) {
	for _, headers := range []map[string]string{
		{}, {"X-Workboard": "1", "Origin": "https://attacker.example"}, {"X-Workboard": "1", "Sec-Fetch-Site": "cross-site"},
	} {
		r := httptest.NewRequest("POST", "http://"+addr+"/api/refresh", nil)
		for k, v := range headers {
			r.Header.Set(k, v)
		}
		w := httptest.NewRecorder()
		handleRefresh(w, r)
		if w.Code != 403 {
			t.Fatal(w.Code, w.Body)
		}
	}
}
