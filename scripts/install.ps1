param(
    # Low-level ZIP copy path. Use agent-ops.exe --install for desktop registrations.
    [string]$RuntimeDir = (Join-Path $env:LOCALAPPDATA 'Programs\AgentOps'),
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
New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
$backup = Join-Path $RuntimeDir ('backups\' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N'))
# Node.js is not required: the plan collector runs inside agent-ops.exe. The two
# .mjs stubs only answer task-sync/task-report commands that sessions of earlier
# releases run with Node.
$files = @('agent-ops.exe','task-sync.mjs','task-report.mjs','NOTICE.md','INSTALL.md')
# Program files of earlier releases that this version no longer uses.
$retired = @('execution-roles.mjs','execution-reports.mjs','historical-executions.mjs','agent-attribution.mjs','skills/task-plan/SKILL.md','tasks-overview.mjs','plan-reader.mjs','integrations/install-task-reporting.mjs')
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
# An isolated -RuntimeDir with the default profile must not touch the real AI client
# files or run history (the app enforces the same rule); it needs an explicit -ProfileDir.
$defaultRuntime = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Programs\AgentOps'))
if (!$SkipMigration -and $RuntimeDir -ne $defaultRuntime -and !$PSBoundParameters.ContainsKey('ProfileDir')) {
    Write-Output 'Migration skipped: an isolated -RuntimeDir needs an explicit -ProfileDir (a temporary profile folder). No AI client file or run history was touched.'
    $SkipMigration = $true
}
if (!$SkipMigration) {
    # Removes the retired run reporting from this profile's AI clients and deletes old
    # run history, with backups. It installs nothing: the task-plan skill is offered in
    # the app (Settings > Integrations). agent-ops.exe is a GUI program, so it is
    # started and awaited explicitly and its JSON result is read from a file.
    $quote = { param([string]$value) '"' + ($value -replace '(\*)$', '$1$1') + '"' }
    $migrationArgs = @('--migrate', '--profile-dir', (& $quote ([IO.Path]::GetFullPath($ProfileDir))), '--runtime-dir', (& $quote $RuntimeDir)) -join ' '
    $migrationOut = Join-Path $backup 'migration-output.json'
    New-Item -ItemType Directory -Force -Path $backup | Out-Null
    $migration = Start-Process -FilePath (Join-Path $RuntimeDir 'agent-ops.exe') -ArgumentList $migrationArgs -Wait -PassThru -WindowStyle Hidden -RedirectStandardOutput $migrationOut
    if (Test-Path -LiteralPath $migrationOut) { Get-Content -LiteralPath $migrationOut -Raw | Write-Output }
    if ($migration.ExitCode -ne 0) { throw 'Runtime copied, but the migration of earlier releases failed. Backups remain available; no success is claimed.' }
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
