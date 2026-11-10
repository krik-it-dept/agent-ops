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
# Writes a release ZIP with forward-slash entry names in a fixed order. Compress-Archive
# in Windows PowerShell 5.1 stores backslashes, which every updater rejects as unsafe.
function New-PackageZip {
    param([string]$Source, [string]$Destination)
    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $Source = [IO.Path]::GetFullPath($Source)
    if (Test-Path -LiteralPath $Destination) { Remove-Item -LiteralPath $Destination -Force }
    $files = @(Get-ChildItem -LiteralPath $Source -File -Recurse | ForEach-Object {
        [pscustomobject]@{ Full = $_.FullName; Name = $_.FullName.Substring($Source.Length).TrimStart('\','/').Replace('\','/') }
    } | Sort-Object Name)
    $zip = [IO.Compression.ZipFile]::Open($Destination, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($file in $files) {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, $file.Full, $file.Name, [IO.Compression.CompressionLevel]::Optimal)
        }
    } finally { $zip.Dispose() }
}
