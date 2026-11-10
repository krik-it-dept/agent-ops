<#
Agent Ops installer helper, shipped inside the NSIS installer/uninstaller
(build/installer.nsh) and with the app (resources\installer-helper.ps1, used by
src/main/modules/updater/windows.ts). One fixed script, called with fixed
arguments; every path arrives as a parameter value and is never parsed as
PowerShell text.

Actions
  stop               Stops processes whose executable is exactly one of -Executable
                     ('|'-separated). Identity is the file identity (volume serial and
                     file index) of the image of an opened process handle, compared with
                     the target file, so case, 8.3 names and links cannot match another
                     file, and a sibling or nested copy is never touched. The same handle
                     is terminated and waited for, so a reused process id is never hit.
  check-paths        -Actual must be the same folder as -Expected (when given), and no
                     existing part of -Actual or of each -Plain path ('|'-separated) may
                     be a symbolic link or junction; nothing inside each -Tree folder
                     ('|'-separated) may be one either (checked before a recursive delete).
  bootstrap-prepare  Moves a Go install out of -Source as a recoverable transaction:
                     journal (state=prepared, verified) -> stop -> move to a new backup
                     folder under -BackupRoot -> verify -> journal state=moved.
  bootstrap-commit   After the new files are in place: journal state=committed and the
                     receipt for the app's first start (-Receipt).
  bootstrap-restore  Puts the Go install back (a partial new install is kept beside the
                     backup, never deleted): journal state=restored.
  bootstrap-recover  At every installer start: finishes an interrupted transaction from
                     what is on disk (commit a complete new install, else restore).

Exit codes: 0 done (or nothing to do), 1 a process could not be stopped,
2 a process could not be inspected, 3 invalid arguments, 4 unsupported install
folder, 5 a path is a link, 6 the journal could not be written or verified,
7 the move failed (nothing changed), 8 restore failed (the backup is kept).
#>
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [ValidateSet('stop', 'check-paths', 'bootstrap-prepare', 'bootstrap-commit', 'bootstrap-restore', 'bootstrap-recover')]
  [string]$Action,
  [string]$Executable = '',
  [string]$Expected = '',
  [string]$Actual = '',
  [string]$Plain = '',
  [string]$Tree = '',
  [string]$Source = '',
  [string]$BackupRoot = '',
  [string]$Journal = '',
  [string]$Receipt = '',
  [string]$Stamp = '',
  [int]$KeepPid = 0,
  [int]$TimeoutSeconds = 15
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0

function Out-Line([string]$Text) { [Console]::Out.WriteLine($Text) }
function Fail([int]$Code, [string]$Text) { Out-Line "error: $Text"; exit $Code }

$native = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;
public static class AgentOpsNative {
  [StructLayout(LayoutKind.Sequential)]
  struct FileInfo {
    public uint Attributes; public long Created; public long Accessed; public long Written;
    public uint Serial; public uint SizeHigh; public uint SizeLow; public uint Links;
    public uint IndexHigh; public uint IndexLow;
  }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandle(SafeFileHandle file, out FileInfo info);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern uint GetLongPathNameW(string shortPath, StringBuilder longPath, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool QueryFullProcessImageNameW(IntPtr process, int flags, StringBuilder name, ref int size);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool TerminateProcess(IntPtr process, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool CloseHandle(IntPtr handle);

  // Volume serial and file index of an existing file or folder; null when it cannot be opened.
  public static string FileId(string path) {
    using (SafeFileHandle h = CreateFileW(path, 0, 7, IntPtr.Zero, 3, 0x02000000, IntPtr.Zero)) {
      if (h.IsInvalid) return null;
      FileInfo info;
      if (!GetFileInformationByHandle(h, out info)) return null;
      return info.Serial.ToString("x8") + ":" + info.IndexHigh.ToString("x8") + info.IndexLow.ToString("x8");
    }
  }
  public static string LongPath(string path) {
    StringBuilder b = new StringBuilder(32768);
    uint n = GetLongPathNameW(path, b, (uint)b.Capacity);
    return (n == 0 || n > b.Capacity) ? path : b.ToString();
  }
  public static string ImagePath(IntPtr process) {
    StringBuilder b = new StringBuilder(32768);
    int size = b.Capacity;
    return QueryFullProcessImageNameW(process, 0, b, ref size) ? b.ToString(0, size) : null;
  }
}
'@

function Use-Native {
  if (-not ('AgentOpsNative' -as [type])) { Add-Type -TypeDefinition $native -Language CSharp }
}

function Split-List([string]$Value) {
  return @($Value -split '\|' | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne '' })
}

# A plain absolute local path: drive letter, no device or network prefix, no wildcards.
function Assert-LocalPath([string]$Path, [string]$Name) {
  if ($Path -notmatch '^[A-Za-z]:\\' -or $Path.IndexOfAny([char[]]'*?"<>|') -ge 0 -or $Path.Contains([char]0)) {
    Fail 3 "$Name must be a full local path"
  }
}

function Get-Canonical([string]$Path) {
  $full = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Length -eq 2) { $full += '\' }
  if (Test-Path -LiteralPath $full) { $full = [AgentOpsNative]::LongPath($full).TrimEnd('\') }
  return $full
}

# The first existing part of Path (itself or an ancestor) that is a link or junction, else $null.
function Find-Link([string]$Path) {
  $current = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  while ($current -and $current.Length -gt 3) {
    $item = Get-Item -LiteralPath $current -Force -ErrorAction SilentlyContinue
    if ($item -and ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { return $current }
    $current = [System.IO.Path]::GetDirectoryName($current)
  }
  return $null
}

# The first link or junction inside Dir (not followed), else $null.
function Find-LinkBelow([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir -PathType Container)) { return $null }
  $pending = New-Object System.Collections.Generic.Stack[string]
  $pending.Push($Dir)
  while ($pending.Count -gt 0) {
    $current = $pending.Pop()
    foreach ($entry in [System.IO.Directory]::EnumerateFileSystemEntries($current)) {
      $attributes = [System.IO.File]::GetAttributes($entry)
      if ($attributes -band [System.IO.FileAttributes]::ReparsePoint) { return $entry }
      if ($attributes -band [System.IO.FileAttributes]::Directory) { $pending.Push($entry) }
    }
  }
  return $null
}

# ---------- stop ----------

function Stop-Exact([string[]]$Targets) {
  Use-Native
  $stopped = 0
  $code = 0
  foreach ($target in $Targets) {
    Assert-LocalPath $target 'Executable'
    if (-not (Test-Path -LiteralPath $target -PathType Leaf)) { continue } # a running image cannot be deleted
    $long = Get-Canonical $target
    $id = [AgentOpsNative]::FileId($long)
    if (-not $id) { Out-Line "error: cannot identify $long"; $code = [Math]::Max($code, 2); continue }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($long)
    foreach ($process in [System.Diagnostics.Process]::GetProcessesByName($name)) {
      $processId = $process.Id
      if ($processId -eq $PID -or $processId -eq $KeepPid) { continue }
      # PROCESS_TERMINATE | SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION
      $handle = [AgentOpsNative]::OpenProcess(0x00101001, $false, $processId)
      if ($handle -eq [IntPtr]::Zero) {
        $exited = $false; try { $exited = $process.HasExited } catch { $exited = $false }
        if ($exited) { continue }
        Out-Line "error: cannot inspect process $processId"
        $code = [Math]::Max($code, 2)
        continue
      }
      try {
        if ([AgentOpsNative]::WaitForSingleObject($handle, 0) -eq 0) { continue } # already exited
        $image = [AgentOpsNative]::ImagePath($handle)
        if (-not $image) { Out-Line "error: cannot inspect process $processId"; $code = [Math]::Max($code, 2); continue }
        if ([AgentOpsNative]::FileId($image) -ne $id) { continue } # another copy: never touched
        if (-not [AgentOpsNative]::TerminateProcess($handle, 1)) {
          if ([AgentOpsNative]::WaitForSingleObject($handle, 0) -ne 0) {
            Out-Line "error: cannot stop process $processId"
            $code = 1
            continue
          }
        }
        if ([AgentOpsNative]::WaitForSingleObject($handle, [uint32]($TimeoutSeconds * 1000)) -ne 0) {
          Out-Line "error: process $processId did not exit"
          $code = 1
          continue
        }
        $stopped++
        Out-Line "stopped $processId $long"
      } finally {
        [void][AgentOpsNative]::CloseHandle($handle)
      }
    }
  }
  Out-Line "stopped=$stopped"
  return $code
}

# ---------- journal ----------

function Read-Journal([string]$File) {
  $result = @{}
  if (-not (Test-Path -LiteralPath $File -PathType Leaf)) { return $result }
  foreach ($line in [System.IO.File]::ReadAllLines($File)) {
    $at = $line.IndexOf('=')
    if ($at -gt 0) { $result[$line.Substring(0, $at)] = $line.Substring($at + 1) }
  }
  return $result
}

function Write-Journal([string]$File, [hashtable]$Values) {
  $dir = [System.IO.Path]::GetDirectoryName($File)
  if (Find-Link $dir) { Fail 5 "the journal folder is a link" }
  [void][System.IO.Directory]::CreateDirectory($dir)
  $text = (($Values.Keys | Sort-Object | ForEach-Object { "$_=$($Values[$_])" }) -join "`r`n") + "`r`n"
  $tmp = "$File.tmp"
  try {
    $stream = New-Object System.IO.FileStream($tmp, [System.IO.FileMode]::Create, [System.IO.FileAccess]::Write)
    try {
      $bytes = (New-Object System.Text.UTF8Encoding($false)).GetBytes($text)
      $stream.Write($bytes, 0, $bytes.Length)
      $stream.Flush($true)
    } finally { $stream.Dispose() }
    if (Test-Path -LiteralPath $File) { [System.IO.File]::Replace($tmp, $File, [NullString]::Value) } else { [System.IO.File]::Move($tmp, $File) }
  } catch {
    Fail 6 "the journal could not be written: $($_.Exception.Message)"
  }
  $back = Read-Journal $File
  foreach ($key in $Values.Keys) {
    if ($back[$key] -ne [string]$Values[$key]) { Fail 6 "the journal could not be verified" }
  }
}

# A Go self-install: agent-ops.exe with files only the Go package has, and no
# Electron resources. A half-extracted new install never has the Go files.
function Test-GoInstall([string]$Dir) {
  if (-not (Test-Path -LiteralPath (Join-Path $Dir 'agent-ops.exe') -PathType Leaf)) { return $false }
  if (Test-Path -LiteralPath (Join-Path $Dir 'resources')) { return $false }
  foreach ($marker in @('task-sync.mjs', 'NOTICE.md', 'scripts\install.ps1')) {
    if (Test-Path -LiteralPath (Join-Path $Dir $marker) -PathType Leaf) { return $true }
  }
  return $false
}

function Test-NewInstall([string]$Dir) {
  return (Test-Path -LiteralPath (Join-Path $Dir 'agent-ops.exe') -PathType Leaf) -and
    (Test-Path -LiteralPath (Join-Path $Dir 'resources\app.asar') -PathType Leaf)
}

# Renames a folder, retrying for a few seconds while a just-stopped process or
# a scanner still holds a file in it.
function Move-Folder([string]$From, [string]$To) {
  for ($i = 1; ; $i++) {
    try { [System.IO.Directory]::Move($From, $To); return }
    catch { if ($i -ge 20) { throw }; Start-Sleep -Milliseconds 250 }
  }
}

function Get-Free([string]$Base) {
  $candidate = $Base
  $n = 2
  while (Test-Path -LiteralPath $candidate) { $candidate = "$Base-$n"; $n++ }
  return $candidate
}

function Commit-Bootstrap([hashtable]$State) {
  if ($Receipt) {
    Assert-LocalPath $Receipt 'Receipt'
    $dir = [System.IO.Path]::GetDirectoryName($Receipt)
    if (Find-Link $dir) { Fail 5 "the receipt folder is a link" }
    [void][System.IO.Directory]::CreateDirectory($dir)
    [System.IO.File]::WriteAllText($Receipt, "goInstallBackup=$($State['backup'])`r`n", (New-Object System.Text.UTF8Encoding($false)))
  }
  $State['state'] = 'committed'
  Write-Journal $Journal $State
  Out-Line "committed $($State['backup'])"
}

function Restore-Bootstrap([hashtable]$State) {
  $backup = $State['backup']
  if ($backup -and (Test-Path -LiteralPath $backup)) {
    if (Find-Link $Source) { Fail 5 "the install folder is a link" }
    if (Test-Path -LiteralPath $Source) {
      if (Test-GoInstall $Source) { Fail 8 "both the install folder and the backup hold a Go install" }
      $aside = Get-Free "$backup-incomplete-new"
      try { Move-Folder $Source $aside } catch { Fail 8 "the incomplete new install could not be moved aside" }
      Out-Line "kept the incomplete new install at $aside"
    }
    try { Move-Folder $backup $Source } catch { Fail 8 "the earlier version could not be put back; it is kept at $backup" }
    if (-not (Test-GoInstall $Source)) { Fail 8 "the earlier version was put back but cannot be verified" }
    Out-Line "restored $Source"
  }
  $State['state'] = 'restored'
  Write-Journal $Journal $State
  return 0
}

# ---------- actions ----------

switch ($Action) {
  'stop' {
    $targets = @(Split-List $Executable)
    if ($targets.Count -eq 0) { Fail 3 'no executable' }
    exit (Stop-Exact $targets)
  }
  'check-paths' {
    Use-Native
    if ($Actual) {
      Assert-LocalPath $Actual 'Actual'
      if ($Expected) {
        Assert-LocalPath $Expected 'Expected'
        if ((Get-Canonical $Actual) -ne (Get-Canonical $Expected)) {
          Fail 4 "unsupported install folder $Actual"
        }
      }
      $link = Find-Link $Actual
      if ($link) { Fail 5 "link: $link" }
    }
    foreach ($path in @(Split-List $Plain)) {
      Assert-LocalPath $path 'Plain'
      $link = Find-Link $path
      if ($link) { Fail 5 "link: $link" }
    }
    foreach ($path in @(Split-List $Tree)) {
      Assert-LocalPath $path 'Tree'
      $link = Find-Link $path
      if (-not $link) { $link = Find-LinkBelow $path }
      if ($link) { Fail 5 "link: $link" }
    }
    Out-Line 'paths ok'
    exit 0
  }
  'bootstrap-prepare' {
    Use-Native
    foreach ($p in @($Source, $BackupRoot, $Journal)) { Assert-LocalPath $p 'Path' }
    if (-not (Test-GoInstall $Source)) { Out-Line 'none'; exit 0 }
    foreach ($p in @($Source, $BackupRoot, $Journal)) { $link = Find-Link $p; if ($link) { Fail 5 "link: $link" } }
    $stampText = if ($Stamp -match '^[0-9-]+$') { $Stamp } else { (Get-Date).ToString('yyyyMMdd-HHmmss') }
    $backup = Get-Free (Join-Path $BackupRoot "go-install-$stampText")
    $state = @{ state = 'prepared'; source = $Source; backup = $backup; at = (Get-Date).ToString('o') }
    Write-Journal $Journal $state
    Out-Line "prepared $backup"
    $stopCode = Stop-Exact @((Join-Path $Source 'agent-ops.exe'))
    if ($stopCode -ne 0) {
      $state['state'] = 'aborted'
      Write-Journal $Journal $state
      Fail $stopCode 'the earlier version could not be stopped; nothing was changed'
    }
    [void][System.IO.Directory]::CreateDirectory($BackupRoot)
    try {
      Move-Folder $Source $backup
    } catch {
      $state['state'] = 'aborted'
      Write-Journal $Journal $state
      Fail 7 'the earlier version could not be moved; nothing was changed'
    }
    if ((Test-Path -LiteralPath $Source) -or -not (Test-GoInstall $backup)) {
      [void](Restore-Bootstrap $state)
      Fail 7 'the move could not be verified; the earlier version was put back'
    }
    $state['state'] = 'moved'
    Write-Journal $Journal $state
    Out-Line "moved $backup"
    exit 0
  }
  'bootstrap-commit' {
    Use-Native
    $state = Read-Journal $Journal
    if ($state['state'] -ne 'moved' -and $state['state'] -ne 'prepared') { Out-Line 'none'; exit 0 }
    if (-not (Test-NewInstall $Source)) { Fail 8 'the new install is incomplete' }
    Commit-Bootstrap $state
    exit 0
  }
  'bootstrap-restore' {
    Use-Native
    $state = Read-Journal $Journal
    if ($state['state'] -ne 'moved' -and $state['state'] -ne 'prepared') { Out-Line 'none'; exit 0 }
    exit (Restore-Bootstrap $state)
  }
  'bootstrap-recover' {
    Use-Native
    $state = Read-Journal $Journal
    if ($state['state'] -ne 'moved' -and $state['state'] -ne 'prepared') { Out-Line 'none'; exit 0 }
    # Decide from what is on disk: the journal may lag one step behind.
    if (Test-NewInstall $Source) { Commit-Bootstrap $state; exit 0 }
    if ((Test-GoInstall $Source) -and -not ($state['backup'] -and (Test-Path -LiteralPath $state['backup']))) {
      $state['state'] = 'restored'
      Write-Journal $Journal $state
      Out-Line 'not moved'
      exit 0
    }
    exit (Restore-Bootstrap $state)
  }
}
