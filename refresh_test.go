package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"
)

func TestRefreshReadsLatestAndPreservesLastGoodStateOnFailure(t *testing.T) {
	stateFixture(t)
	refresh(true)
	if refreshError != "" {
		t.Fatal(refreshError)
	}
	request := func(method string) *httptest.ResponseRecorder {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, "http://"+addr+"/api/refresh", nil)
		r.Header.Set("X-Workboard", "1")
		handleRefresh(w, r)
		return w
	}
	w := request(http.MethodPost)
	var response map[string]string
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &response) != nil || response["refreshedAt"] == "" {
		t.Fatal(w.Code, w.Body)
	}
	if w := request(http.MethodGet); w.Code != 405 {
		t.Fatal("refresh accepts GET", w.Code)
	}
	previous := append([]byte{}, rawState...)
	scriptFile = filepath.Join(dataDir, "missing-collector.mjs")
	w = request(http.MethodPost)
	if w.Code != 502 || !bytes.Contains(w.Body.Bytes(), []byte("Node failed")) {
		t.Fatal("refresh reported false success", w.Code, w.Body)
	}
	if !bytes.Equal(previous, rawState) {
		t.Fatal("refresh failure discarded last good state")
	}
}
