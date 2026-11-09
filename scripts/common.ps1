$ErrorActionPreference = 'Stop'
function Get-GoExecutable {
    $found = Get-Command go -ErrorAction SilentlyContinue
    if ($found) { return $found.Source }
    $localGo = Join-Path $env:USERPROFILE '.local\go\bin\go.exe'
    if (Test-Path -LiteralPath $localGo) { return $localGo }
    throw 'Go is required. Install the version specified in go.mod or add it to PATH.'
}
function Invoke-Checked {
    param([string]$File, [string[]]$Arguments)
    & $File @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$File failed with exit code $LASTEXITCODE" }
}
