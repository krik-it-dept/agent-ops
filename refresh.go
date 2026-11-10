package main

import (
	"encoding/json"
	"net/http"
)

func handleReadOnlyAgent(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusMethodNotAllowed)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": "Agent identity is read-only. Execution is reported by the executing client."})
}

func handleRefresh(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		w.WriteHeader(http.StatusMethodNotAllowed)
		return
	}
	if !trustedLocalWrite(r) {
		w.WriteHeader(http.StatusForbidden)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Refresh must come from this Workboard."})
		return
	}
	if updateRestarting.Load() {
		w.WriteHeader(http.StatusServiceUnavailable)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "The app is restarting for an update."})
		return
	}
	refresh(false)
	mu.Lock()
	reason := refreshError
	raw := rawState
	mu.Unlock()
	if reason != "" {
		w.WriteHeader(http.StatusBadGateway)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": reason})
		return
	}
	var state struct {
		GeneratedAt string `json:"generatedAt"`
	}
	_ = json.Unmarshal(raw, &state)
	_ = json.NewEncoder(w).Encode(map[string]string{"refreshedAt": state.GeneratedAt})
}
