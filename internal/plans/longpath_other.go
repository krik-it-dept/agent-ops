//go:build !windows

package plans

// longPath: short names exist only on Windows.
func longPath(p string) string { return p }
