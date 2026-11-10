param(
    # The install folder of earlier releases stays the default until the installer
    # moves to %LOCALAPPDATA%\Programs\AgentOps in a later release.
    [string]$RuntimeDir = (Join-Path $env:USERPROFILE '.claude\tools\workboard'),
    [string]$ProfileDir = $env:USERPROFILE,
    # Skip the one-time migration of AI client files (hooks, instruction blocks,
    # old skills) and old run history. -SkipSkills is the name earlier releases used.
    [Alias('SkipSkills')][switch]$SkipMigration,
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
$files = @('agent-ops.exe','tasks-overview.mjs','plan-reader.mjs','task-sync.mjs','task-report.mjs','NOTICE.md','INSTALL.md','integrations/install-task-reporting.mjs')
# Program files of earlier releases that this version no longer uses.
$retired = @('execution-roles.mjs','execution-reports.mjs','historical-executions.mjs','agent-attribution.mjs','skills/task-plan/SKILL.md')
foreach ($name in $files) {
    $sourceFile = Join-Path $packageRoot $name
    if (!(Test-Path -LiteralPath $sourceFile)) { throw "Incomplete release: $name" }
}
function Save-Previous([string]$name) {
    $target = Join-Path $RuntimeDir $name
    if (Test-Path -LiteralPath $target) {
        $saved = Join-Path $backup $name
        New-Item -ItemType Directory -Force -Path (Split-Path $saved -Parent) | Out-Null
        Copy-Item -LiteralPath $target -Destination $saved
    }
}
foreach ($name in $files) {
    $target = Join-Path $RuntimeDir $name
    Save-Previous $name
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath (Join-Path $packageRoot $name) -Destination $target -Force
    # Copy-Item keeps the "downloaded from the internet" mark of a browser-downloaded ZIP, which
    # would make SmartScreen warn on the installed exe and block the scripts. Clear it on the copy.
    try { Unblock-File -LiteralPath $target } catch { Write-Warning "Could not clear the download mark on ${target}: $($_.Exception.Message)" }
}
foreach ($name in $retired) {
    $target = Join-Path $RuntimeDir $name
    if (Test-Path -LiteralPath $target) {
        Save-Previous $name
        Remove-Item -LiteralPath $target -Force
        $folder = Split-Path $target -Parent
        while ($folder -ne $RuntimeDir -and (Test-Path -LiteralPath $folder) -and !(Get-ChildItem -LiteralPath $folder -Force)) {
            Remove-Item -LiteralPath $folder -Force
            $folder = Split-Path $folder -Parent
        }
    }
}
if (!$SkipMigration) {
    # Removes the retired run reporting from this profile's AI clients and deletes old
    # run history, with backups. It installs nothing: the task-plan skill is offered in
    # the app (Settings > Integrations).
    & node (Join-Path $RuntimeDir 'integrations/install-task-reporting.mjs') --home $ProfileDir --runtime-dir $RuntimeDir
    if ($LASTEXITCODE -ne 0) { throw 'Runtime copied, but the migration of earlier releases failed. Backups remain available; no success is claimed.' }
}
Write-Output "Installed: $(Join-Path $RuntimeDir 'agent-ops.exe')"
Write-Output "Previous files, when present: $backup"
Write-Output 'Existing task files, app settings and activity were preserved.'
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
