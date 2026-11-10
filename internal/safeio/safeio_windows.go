package safeio

import (
	"errors"

	"golang.org/x/sys/windows"
)

// Busy reports an error caused by another program holding the file: a sharing
// or lock violation, or access denied while a delete or replace is pending.
func Busy(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION) || errors.Is(err, windows.ERROR_ACCESS_DENIED)
}

func replace(source, target string) error {
	s, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	t, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	return windows.MoveFileEx(s, t, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
}
