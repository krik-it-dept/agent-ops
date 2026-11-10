param([string]$OutputDir,[string]$Version)
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent
if (!$Version) { $Version = (Get-Content -LiteralPath (Join-Path $repoRoot 'VERSION') -Raw).Trim() }
if ($Version -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$') { throw 'VERSION must be a stable vMAJOR.MINOR.PATCH tag.' }
if (!$OutputDir) { $OutputDir = Join-Path $repoRoot 'dist' }
$OutputDir = [IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$goExecutable = Get-GoExecutable
$env:GOTELEMETRY = 'off'
Push-Location $repoRoot
try {
    Invoke-Checked -File $goExecutable -Arguments @('run','./cmd/icon')
    Invoke-Checked -File $goExecutable -Arguments @('run','github.com/akavel/rsrc@v0.10.2','-arch','amd64','-ico','web/icons/app.ico','-o','rsrc_windows_amd64.syso')
    $executable = Join-Path $OutputDir 'agent-ops.exe'
    $commit = (& git rev-parse --short=12 HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Build from the source Git checkout.' }
    Invoke-Checked -File $goExecutable -Arguments @('build','-trimpath','-ldflags',("-s -w -H windowsgui -X main.appVersion=$Version -X main.appCommit=$commit"),'-o',$executable,'.')
    # PowerShell does not capture stdout from a GUI-subsystem executable directly.
    $reported = (& node -e "process.stdout.write(require('node:child_process').execFileSync(process.argv[1],['--version'],{encoding:'utf8',windowsHide:true}))" $executable)
    if ($null -ne $reported) { $reported = $reported.Trim() }
    if ($LASTEXITCODE -ne 0 -or $reported -ne $Version) { throw 'Built executable version mismatch.' }
    Invoke-Checked -File $goExecutable -Arguments @('run','./cmd/icon','--verify-exe',$executable)
    # A fresh package directory prevents leftovers from entering a release.
    $packageRoot = Join-Path $OutputDir ('package-' + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $packageRoot | Out-Null
    Copy-Item -LiteralPath $executable -Destination (Join-Path $packageRoot 'agent-ops.exe')
    foreach ($name in @('tasks-overview.mjs','task-sync.mjs','task-report.mjs','plan-reader.mjs','execution-roles.mjs','execution-reports.mjs','historical-executions.mjs','agent-attribution.mjs','NOTICE.md','INSTALL.md')) {
        Copy-Item -LiteralPath (Join-Path $repoRoot $name) -Destination (Join-Path $packageRoot $name)
    }
    foreach ($directory in @('integrations','skills/task-plan','scripts')) {
        New-Item -ItemType Directory -Force -Path (Join-Path $packageRoot $directory) | Out-Null
    }
    Copy-Item -LiteralPath (Join-Path $repoRoot 'integrations/install-task-reporting.mjs') -Destination (Join-Path $packageRoot 'integrations/install-task-reporting.mjs')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'skills/task-plan/SKILL.md') -Destination (Join-Path $packageRoot 'skills/task-plan/SKILL.md')
    Copy-Item -LiteralPath (Join-Path $repoRoot 'scripts/install.ps1') -Destination (Join-Path $packageRoot 'scripts/install.ps1')
    $archive = Join-Path $OutputDir 'agent-ops-windows-amd64.zip'
    Compress-Archive -LiteralPath @(Get-ChildItem -LiteralPath $packageRoot | ForEach-Object FullName) -DestinationPath $archive -Force
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($archive + '.sha256', $hash + '  ' + [IO.Path]::GetFileName($archive) + "`n")
    Write-Output "Built and verified: $executable"
    Write-Output "Release: $archive"
} finally { Pop-Location }
