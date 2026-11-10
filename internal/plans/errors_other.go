//go:build !windows

package plans

import (
	"errors"
	"os/exec"
	"syscall"
)

func retryable(err error) bool { return errors.Is(err, syscall.EBUSY) }

func isNotDir(err error) bool { return errors.Is(err, syscall.ENOTDIR) }

func hide(*exec.Cmd) {}
