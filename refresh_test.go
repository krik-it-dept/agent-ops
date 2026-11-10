package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/krik-it-dept/agent-ops/internal/plans"
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
		r.Header.Set("X-Agent-Ops", "1")
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
	saved := collectPlans
	t.Cleanup(func() { collectPlans = saved })
	collectPlans = func(context.Context, plans.Options) (*plans.Overview, error) { return nil, errors.New("drive offline") }
	w = request(http.MethodPost)
	if w.Code != 502 || !bytes.Contains(w.Body.Bytes(), []byte("Could not read plans: drive offline")) {
		t.Fatal("refresh reported false success", w.Code, w.Body)
	}
	if !bytes.Equal(previous, rawState) {
		t.Fatal("refresh failure discarded last good state")
	}
}
