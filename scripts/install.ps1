param(
    [string]$RuntimeDir = (Join-Path $env:USERPROFILE '.claude\tools\workboard'),
    [string]$ProfileDir = $env:USERPROFILE,
    [switch]$SkipSkills,
    # Install without starting the app (isolated installs, smoke tests and scripted setups).
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot -Parent
$RuntimeDir = [IO.Path]::GetFullPath($RuntimeDir)
$sourceExe = Join-Path $packageRoot 'agent-ops.exe'
if (!(Test-Path -LiteralPath $sourceExe)) { throw 'Run this installer from an extracted release package.' }
if ($RuntimeDir -eq [IO.Path]::GetFullPath($packageRoot)) { throw 'Choose a runtime directory separate from the extracted package.' }
if (!(Get-Command node -ErrorAction SilentlyContinue)) { throw 'Node.js 24 is required before installing Agent Ops.' }
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$backup = Join-Path $RuntimeDir ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
$files = @('agent-ops.exe','tasks-overview.mjs','task-sync.mjs','task-report.mjs','plan-reader.mjs','execution-roles.mjs','execution-reports.mjs','historical-executions.mjs','agent-attribution.mjs','NOTICE.md','INSTALL.md','integrations/install-task-reporting.mjs','skills/task-plan/SKILL.md')
foreach ($name in $files) {
    $sourceFile = Join-Path $packageRoot $name
    if (!(Test-Path -LiteralPath $sourceFile)) { throw "Incomplete release: $name" }
}
foreach ($name in $files) {
    $target = Join-Path $RuntimeDir $name
    if (Test-Path -LiteralPath $target) {
        $saved = Join-Path $backup $name
        New-Item -ItemType Directory -Force -Path (Split-Path $saved -Parent) | Out-Null
        Copy-Item -LiteralPath $target -Destination $saved
    }
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination $target -Force
    # Copy-Item keeps the "downloaded from the internet" mark of a browser-downloaded ZIP, which
    # would make SmartScreen warn on the installed exe and block the scripts. Clear it on the copy.
    try { Unblock-File -LiteralPath $target } catch { Write-Warning "Could not clear the download mark on ${target}: $($_.Exception.Message)" }
}
if (!$SkipSkills) {
    & node (Join-Path $RuntimeDir 'integrations/install-task-reporting.mjs') --home $ProfileDir --runtime-dir $RuntimeDir
    if ($LASTEXITCODE -ne 0) { throw 'Runtime copied, but skill installation failed. Backups remain available; no success is claimed.' }
}
Write-Output "Installed: $(Join-Path $RuntimeDir 'agent-ops.exe')"
Write-Output "Previous files, when present: $backup"
Write-Output 'Existing task files, execution registries, app preferences and activity were preserved.'
$installedExe = Join-Path $RuntimeDir 'agent-ops.exe'
if ($NoLaunch) {
    Write-Output "Not launched (-NoLaunch). Start it with: Start-Process `"$installedExe`""
} else {
    try {
        $started = Start-Process -FilePath $installedExe -PassThru
        Write-Output "Started Agent Ops (process $($started.Id)). Add your project folders in the setup window."
    } catch {
        Write-Warning "Installed, but could not start Agent Ops: $($_.Exception.Message)"
        Write-Output "Start it with: Start-Process `"$installedExe`""
    }
}
