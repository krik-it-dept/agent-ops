package main

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/krik-it-dept/agent-ops/internal/plans"
)

// The plan collector runs in-process (internal/plans); Node.js is not needed.

// collectTimeout bounds one read of every plan.
const collectTimeout = 30 * time.Second

// collectPlans is the collector; tests replace it to inject failures.
var collectPlans = plans.Collect

// testFault is set only by the update end-to-end test, at link time
// (-X main.testFault=collector), to build an app whose plan collector always
// fails, so the updater's rollback can be exercised. Release builds leave it empty.
var testFault string

func init() {
	if testFault == "collector" {
		collectPlans = func(context.Context, plans.Options) (*plans.Overview, error) {
			return nil, errors.New("collector fault injected for an update test")
		}
	}
}

// collectorBusy is set while a collection runs. A collection that timed out
// (a hung network drive) keeps it set until its read returns, so refreshes do
// not pile up behind it.
var collectorBusy atomic.Bool

var errCollectorBusy = errors.New("an earlier read of the plans has not finished")

// collectorProjects converts the enabled projects for the collector.
func collectorProjects() []plans.Project {
	var out []plans.Project
	for _, p := range effectiveProjects() {
		out = append(out, plans.Project{ID: p.ID, Name: p.Name, Path: p.Path, Kind: p.Kind})
	}
	return out
}

// runCollector reads every plan, giving up after collectTimeout.
func runCollector() (*plans.Overview, error) { return runCollectorWithin(collectTimeout) }

func runCollectorWithin(timeout time.Duration) (*plans.Overview, error) {
	if !collectorBusy.CompareAndSwap(false, true) {
		return nil, errCollectorBusy
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	type result struct {
		overview *plans.Overview
		err      error
	}
	done := make(chan result, 1)
	projects := collectorProjects()
	go func() {
		defer collectorBusy.Store(false)
		defer func() {
			if v := recover(); v != nil {
				recordPanic("plan collector", v)
				done <- result{err: fmt.Errorf("the plan reader stopped unexpectedly")}
			}
		}()
		o, err := collectPlans(ctx, plans.Options{Projects: projects})
		done <- result{o, err}
	}()
	select {
	case r := <-done:
		if r.err == nil && r.overview == nil {
			r.err = errors.New("the plan reader returned nothing")
		}
		return r.overview, r.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// collectorFailure maps a collector error to a fixed category and a message
// for the owner.
func collectorFailure(err error) (kind, reason string) {
	switch {
	case errors.Is(err, context.DeadlineExceeded):
		return refreshKindTimeout, "Reading plans took longer than 30 seconds and was stopped. Retry, or disable a large project in Settings."
	case errors.Is(err, errCollectorBusy):
		return refreshKindTimeout, "An earlier read of the plans has not finished yet (a slow or offline drive?). Agent Ops retries shortly."
	}
	return refreshKindCollector, "Could not read plans: " + err.Error()
}
