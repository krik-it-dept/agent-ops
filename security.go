package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
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
		next.ServeHTTP(w, r)
	})
}
