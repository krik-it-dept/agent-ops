$ErrorActionPreference = 'Stop'
function Get-GoExecutable {
    $found = Get-Command go -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $localGo = Join-Path $env:USERPROFILE '.local\go\bin\go.exe'
    if (Test-Path -LiteralPath $localGo) { return $localGo }
    throw 'Go is required. Install the version specified in go.mod or add it to PATH.'
}
# Runs a native tool and fails only on its exit code. Windows PowerShell 5.1 turns
# each stderr line of a redirected native command into a NativeCommandError, which
# 'Stop' makes fatal (for example "go: downloading ..."); stderr is passed through as
# plain text instead, and a non-zero exit code still throws.
function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    $saved = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        & $File @Arguments 2>&1 | ForEach-Object {
            if ($_ -is [System.Management.Automation.ErrorRecord]) { [Console]::Error.WriteLine($(if ($_.TargetObject -is [string]) { $_.TargetObject } else { $_.ToString() })) } else { $_ }
        }
        $code = $LASTEXITCODE
    } finally { $ErrorActionPreference = $saved }
    if ($code -ne 0) { throw "$File failed with exit code $code" }
}
