//go:build !windows

package safeio

import (
	"errors"
	"os"
	"syscall"
)

// Busy reports an error caused by another program holding the file.
func Busy(err error) bool { return errors.Is(err, syscall.EBUSY) }

func replace(source, target string) error { return os.Rename(source, target) }
