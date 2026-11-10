package main

import (
	"errors"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
)

func replaceUpdateFile(source, target string) error {
	s, err := windows.UTF16PtrFromString(source)
	if err != nil {
		return err
	}
	t, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	for i := 0; i < 30; i++ {
		err = windows.MoveFileEx(s, t, windows.MOVEFILE_REPLACE_EXISTING|windows.MOVEFILE_WRITE_THROUGH)
		if err == nil {
			return nil
		}
		if err != windows.ERROR_SHARING_VIOLATION && err != windows.ERROR_ACCESS_DENIED {
			return err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return err
}
func openUpdateParent(pid int, root string) (windows.Handle, error) {
	h, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
	if err != nil {
		return 0, err
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err = windows.QueryFullProcessImageName(h, 0, &buffer[0], &size); err != nil {
		windows.CloseHandle(h)
		return 0, err
	}
	image := windows.UTF16ToString(buffer[:size])
	if !strings.EqualFold(image, filepath.Join(root, "agent-ops.exe")) && !strings.EqualFold(image, filepath.Join(root, "krik-workboard.exe")) {
		windows.CloseHandle(h)
		return 0, errors.New("Update parent is not this installed application")
	}
	return h, nil
}
func closeUpdateParent(h windows.Handle) { _ = windows.CloseHandle(h) }
func waitUpdateParent(h windows.Handle, timeout time.Duration) error {
	result, err := windows.WaitForSingleObject(h, uint32(timeout/time.Millisecond))
	if err != nil {
		return err
	}
	if result != windows.WAIT_OBJECT_0 {
		return errors.New("The old application did not exit in time")
	}
	return nil
}
