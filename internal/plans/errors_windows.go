package plans

import (
	"errors"
	"os/exec"
	"syscall"
)

const (
	errorSharingViolation syscall.Errno = 32
	errorLockViolation    syscall.Errno = 33
	errorDirectory        syscall.Errno = 267
)

// retryable reports a file another program holds without sharing it.
func retryable(err error) bool {
	return errors.Is(err, errorSharingViolation) || errors.Is(err, errorLockViolation)
}

func isNotDir(err error) bool {
	return errors.Is(err, errorDirectory) || errors.Is(err, syscall.ENOTDIR)
}

// hide keeps a console window from flashing for each git call of the tray app.
func hide(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
}
