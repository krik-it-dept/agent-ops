package plans

import "golang.org/x/sys/windows"

// longPath expands 8.3 short names (C:\Users\RUNNER~1) to the long names Git
// reports, so a repository and its worktrees name the same folder the same
// way. A path that cannot be resolved (missing, no permission) is returned as
// it is.
func longPath(p string) string {
	from, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return p
	}
	buf := make([]uint16, 260)
	for {
		n, err := windows.GetLongPathName(from, &buf[0], uint32(len(buf)))
		if err != nil || n == 0 {
			return p
		}
		if int(n) < len(buf) {
			return windows.UTF16ToString(buf[:n])
		}
		buf = make([]uint16, n)
	}
}
