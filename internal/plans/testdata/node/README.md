# Reference Node collector

`tasks-overview.mjs` and `plan-reader.mjs` are the plan collector of Agent Ops up to v0.3.x, kept unchanged
as the reference for the golden test (`golden_test.go`). The app no longer ships or runs them; the Go
collector in this package replaces them. Do not edit them: the golden test checks that the Go collector
produces the same overview.
