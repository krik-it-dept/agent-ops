package main

import (
	"encoding/base64"
	"encoding/binary"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unsafe"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/registry"
)

func (hkcu) GetDWORD(path, name string) (uint32, bool) {
	k, err := registry.OpenKey(registry.CURRENT_USER, path, registry.QUERY_VALUE)
	if err != nil {
		return 0, false
	}
	defer k.Close()
	v, _, err := k.GetIntegerValue(name)
	return uint32(v), err == nil
}
func (hkcu) SetDWORD(path, name string, value uint32) error {
	k, _, err := registry.CreateKey(registry.CURRENT_USER, path, registry.SET_VALUE)
	if err != nil {
		return err
	}
	defer k.Close()
	return k.SetDWordValue(name, value)
}

func nativeInstallEffects(l installLayout) installEffects {
	return installEffects{Registry: hkcu{}, Shortcut: createInstallShortcut, Stop: stopInstallProcesses,
		Launch: func(exe string) (int, error) {
			args := []string{}
			if background {
				args = append(args, "--background")
			}
			if activation != "" {
				args = append(args, "--activate", activation)
			}
			cmd := hidden(exec.Command(exe, args...))
			cmd.Dir = filepath.Dir(exe)
			if err := cmd.Start(); err != nil {
				return 0, err
			}
			pid := cmd.Process.Pid
			_ = cmd.Process.Release()
			return pid, nil
		}, // The app may have moved to another port; session.json names it and the secret.
		Healthy: func(pid int) bool { return updateHealthSession(l.Data, appVersion, pid, 45*time.Second) },
		Migrate: func(l installLayout) (*migrationResult, error) {
			if migrationDone(l.Data) {
				return nil, nil
			}
			return migrateClients(setupMigrationOptions(l))
		}, FinishMigration: func(l installLayout, result *migrationResult) error {
			opts := setupMigrationOptions(l)
			retireLegacyData(opts, result)
			return finishMigration(opts, result)
		}}
}

func setupMigrationOptions(l installLayout) migrationOptions {
	return migrationOptions{Profile: userHome(), DataDir: l.Data, LegacyDataDir: legacyDefaultDataDir(), RuntimeDir: l.Root}
}

func lockNativeSetup() (func(), error) {
	runtime.LockOSThread() // Win32 mutex ownership belongs to the calling thread.
	owned := false
	defer func() {
		if !owned {
			runtime.UnlockOSThread()
		}
	}()
	name, _ := windows.UTF16PtrFromString(`Local\KrikIT.AgentOps.Setup`)
	h, err := windows.CreateMutex(nil, false, name)
	if err != nil && !errors.Is(err, windows.ERROR_ALREADY_EXISTS) {
		return nil, err
	}
	result, err := windows.WaitForSingleObject(h, 0)
	if err != nil || (result != windows.WAIT_OBJECT_0 && result != windows.WAIT_ABANDONED) {
		windows.CloseHandle(h)
		return nil, errors.New("Another Agent Ops setup is running; retry after it finishes")
	}
	owned = true
	return func() { windows.ReleaseMutex(h); windows.CloseHandle(h); runtime.UnlockOSThread() }, nil
}

// Enumerate processes, then verify the image on the opened handle before stopping
// it. A matching name alone must never stop another checkout or application.
func stopInstallProcesses(root string) error {
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	entry := windows.ProcessEntry32{Size: uint32(unsafe.Sizeof(windows.ProcessEntry32{}))}
	for err = windows.Process32First(snapshot, &entry); err == nil; err = windows.Process32Next(snapshot, &entry) {
		name := windows.UTF16ToString(entry.ExeFile[:])
		if entry.ProcessID == uint32(os.Getpid()) || (!strings.EqualFold(name, "agent-ops.exe") && !strings.EqualFold(name, legacyAliasExe)) {
			continue
		}
		h, e := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_TERMINATE|windows.SYNCHRONIZE, false, entry.ProcessID)
		if e != nil {
			if errors.Is(e, windows.ERROR_INVALID_PARAMETER) {
				continue
			}
			return fmt.Errorf("Could not inspect a running application: %w", e)
		}
		buffer := make([]uint16, 32768)
		size := uint32(len(buffer))
		e = windows.QueryFullProcessImageName(h, 0, &buffer[0], &size)
		if e == nil && (samePath(windows.UTF16ToString(buffer[:size]), filepath.Join(root, "agent-ops.exe")) || samePath(windows.UTF16ToString(buffer[:size]), filepath.Join(root, legacyAliasExe))) {
			e = windows.TerminateProcess(h, 0)
			if e == nil {
				e = waitUpdateParent(h, 15*time.Second)
			}
		}
		windows.CloseHandle(h)
		if e != nil {
			return e
		}
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	return nil
}

func waitSetupParent(pid int, l installLayout) error {
	for _, root := range []string{l.Root, l.Legacy} {
		h, err := openUpdateParent(pid, root)
		if errors.Is(err, windows.ERROR_INVALID_PARAMETER) {
			return nil
		} // already exited
		if err != nil {
			continue
		}
		defer closeUpdateParent(h)
		return waitUpdateParent(h, 30*time.Second)
	}
	return errors.New("Installer parent is not the installed application")
}

func setupHelperPath(exe string) bool {
	dir := filepath.Dir(exe)
	return samePlace(filepath.Dir(dir), os.TempDir()) && strings.HasPrefix(filepath.Base(dir), "agent-ops-setup-") && filepath.Base(exe) == "agent-ops.exe"
}

func setupPowerShell(script string, env map[string]string) *exec.Cmd {
	units := utf16.Encode([]rune("$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue';\n" + script))
	b := make([]byte, len(units)*2)
	for i, u := range units {
		binary.LittleEndian.PutUint16(b[i*2:], u)
	}
	cmd := hidden(exec.Command("powershell.exe", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", base64.StdEncoding.EncodeToString(b)))
	cmd.Env = os.Environ()
	for k, v := range env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	return cmd
}

func nativeQuestion(title, message string, yesDefault bool) bool {
	flags := uintptr(0x24) // MB_YESNO | MB_ICONQUESTION
	if !yesDefault {
		flags |= 0x100
	}
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(message)
	r, _, _ := windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), flags)
	return r == 6
}
func nativeMessage(title, message string) {
	t, _ := windows.UTF16PtrFromString(title)
	m, _ := windows.UTF16PtrFromString(message)
	windows.NewLazySystemDLL("user32.dll").NewProc("MessageBoxW").Call(0, uintptr(unsafe.Pointer(m)), uintptr(unsafe.Pointer(t)), 0x10)
}

// The shell property store persists PKEY_AppUserModel_ID in the actual .lnk,
// rather than merely registering an AUMID elsewhere in HKCU.
const shortcutScript = `
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($env:AGENT_OPS_LINK)
$link.TargetPath = $env:AGENT_OPS_EXE
$link.WorkingDirectory = [IO.Path]::GetDirectoryName($env:AGENT_OPS_EXE)
$link.IconLocation = $env:AGENT_OPS_EXE + ',0'
$link.Description = 'Agent Ops'
$link.Save()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public uint pid; }
[StructLayout(LayoutKind.Explicit, Size=24)] public struct PropVariant {
 [FieldOffset(0)] public ushort vt;
 [FieldOffset(8)] public IntPtr value;
}
[ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IPropertyStore {
 void GetCount(out uint count);
 void GetAt(uint index, out PropertyKey key);
 void GetValue(ref PropertyKey key, out PropVariant value);
 void SetValue(ref PropertyKey key, ref PropVariant value);
 void Commit();
}
public static class ShortcutIdentity {
 [DllImport("shell32.dll", CharSet=CharSet.Unicode, PreserveSig=false)]
 static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bind, uint flags, ref Guid iid, out IPropertyStore store);
 public static void Set(string path, string id) {
  Guid iid = typeof(IPropertyStore).GUID; IPropertyStore store;
  SHGetPropertyStoreFromParsingName(path, IntPtr.Zero, 2, ref iid, out store);
  PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
  PropVariant value = new PropVariant { vt = 31, value = Marshal.StringToCoTaskMemUni(id) };
  try { store.SetValue(ref key, ref value); store.Commit(); }
  finally { Marshal.FreeCoTaskMem(value.value); Marshal.ReleaseComObject(store); }
 }
}
'@
[ShortcutIdentity]::Set($env:AGENT_OPS_LINK, 'KrikIT.AgentOps')
`

func createInstallShortcut(path, exe string) error {
	if err := plainUpdatePath(path); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path), "agent-ops-*.lnk")
	if err != nil {
		return err
	}
	tmp := f.Name()
	f.Close()
	os.Remove(tmp) // WScript creates the link; it cannot load an empty link.
	defer os.Remove(tmp)
	output, err := setupPowerShell(shortcutScript, map[string]string{"AGENT_OPS_LINK": tmp, "AGENT_OPS_EXE": exe}).CombinedOutput()
	if err != nil {
		return fmt.Errorf("Create shortcut: %w: %s", err, output)
	}
	return replaceUpdateFile(tmp, path)
}

// The cleanup worker has only explicit paths, checks them again after the parent
// exits, and refuses reparse points. No command text contains interpolated paths.
const cleanupScript = `
trap { if ($env:AGENT_OPS_CLEANUP_LOG) { Add-Content -LiteralPath $env:AGENT_OPS_CLEANUP_LOG -Value ((Get-Date -Format o) + ' ' + $_) }; exit 1 }
$parentProcess = Get-Process -Id ([int]$env:AGENT_OPS_PARENT) -ErrorAction SilentlyContinue
if ($parentProcess) { if (!$parentProcess.WaitForExit(60000)) { throw 'Setup did not exit' } }
foreach ($target in @($env:AGENT_OPS_DELETE, $env:AGENT_OPS_DELETE_DATA)) {
 if (!$target) { continue }
 $full = [IO.Path]::GetFullPath($target)
 if ($full -ne $target -or $full -eq [IO.Path]::GetPathRoot($full)) { throw 'Unsafe cleanup path' }
 for ($ancestor=$full; $ancestor; $ancestor=[IO.Path]::GetDirectoryName($ancestor)) {
  if (Test-Path -LiteralPath $ancestor) {
   if ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup refuses redirected paths' }
  }
 }
 if (!(Test-Path -LiteralPath $full)) { continue }
 $items = @(Get-Item -LiteralPath $full) + @(Get-ChildItem -LiteralPath $full -Force -Recurse)
 foreach ($item in $items) { if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Cleanup refuses reparse points' } }
 for ($attempt=0; $attempt -lt 30; $attempt++) {
  try { Remove-Item -LiteralPath $full -Force -Recurse; break }
  catch { if ($attempt -eq 29) { throw }; Start-Sleep -Milliseconds 200 }
 }
}
`

// cleanupLog records why a deferred removal failed; the worker runs hidden.
func cleanupLog() string { return filepath.Join(os.TempDir(), "agent-ops-cleanup.log") }

func scheduleInstallDelete(root, data string) error {
	_, err := startInstallDelete(root, data, cleanupLog())
	return err
}

// startInstallDelete starts the cleanup worker for root and, when set, data.
// Paths are passed with long names: Windows PowerShell's GetFullPath expands
// 8.3 short names (C:\Users\RUNNER~1), and the worker refuses a path that
// changes when made full.
func startInstallDelete(root, data, log string) (*exec.Cmd, error) {
	paths := []*string{&root, &data}
	for _, p := range paths {
		if *p == "" {
			continue
		}
		if !filepath.IsAbs(*p) || filepath.Dir(*p) == *p {
			return nil, errors.New("Unsafe cleanup path")
		}
		if err := plainUpdatePath(*p); err != nil {
			return nil, err
		}
		*p = longPathName(*p)
	}
	cmd := setupPowerShell(cleanupScript, map[string]string{"AGENT_OPS_DELETE": root, "AGENT_OPS_DELETE_DATA": data, "AGENT_OPS_PARENT": strconv.Itoa(os.Getpid()), "AGENT_OPS_CLEANUP_LOG": log})
	cmd.Dir = os.TempDir()
	return cmd, cmd.Start()
}

// longPathName expands 8.3 short names; a path that cannot be resolved is
// returned unchanged.
func longPathName(p string) string {
	from, err := windows.UTF16PtrFromString(p)
	if err != nil {
		return p
	}
	buf := make([]uint16, 1024)
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
func scheduleSetupCleanup(dir string) {
	if setupHelperPath(filepath.Join(dir, "agent-ops.exe")) {
		_ = scheduleInstallDelete(dir, "")
	}
}
