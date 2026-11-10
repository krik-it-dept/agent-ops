# -Version overrides the version (test fixtures). Otherwise a build of the commit tagged
# with VERSION is a release build; any other commit reports VERSION-dev.<commit>, so
# an untagged artifact can never pass for the release. The updater ignores dev builds.
param([string]$OutputDir,[string]$Version)
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent
# Files the in-app update deletes from the runtime folder (package manifest "remove").
# Only program files; JSON data is never removed. Empty until M2 retires scripts.
$removedFiles = @()
$stablePattern = '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'
if (!$Version) {
    $Version = (Get-Content -LiteralPath (Join-Path $repoRoot 'VERSION') -Raw).Trim()
    if ($Version -notmatch $stablePattern) { throw 'VERSION must be a stable vMAJOR.MINOR.PATCH tag.' }
    $tags = @(& git -C $repoRoot tag --points-at HEAD)
    if ($LASTEXITCODE -ne 0) { throw 'Build from the source Git checkout.' }
    if ($tags -notcontains $Version) {
        $Version = $Version + '-dev.' + (& git -C $repoRoot rev-parse --short=12 HEAD).Trim()
    }
}
if ($Version -notmatch '^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-dev\.[0-9a-f]{7,40})?$') { throw 'Version must be vMAJOR.MINOR.PATCH or vMAJOR.MINOR.PATCH-dev.<commit>.' }
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
    # A fresh package directory prevents leftovers from entering a release. The ZIP keeps
    # exactly the v0.2.0 file set: the v0.2.0 updater rejects any other entry, so the
    # manifest is published as a separate asset (docs/in-app-updates.md).
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
    New-PackageZip -Source $packageRoot -Destination $archive
    $hash = (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText($archive + '.sha256', $hash + '  ' + [IO.Path]::GetFileName($archive) + "`n")
    $manifest = Join-Path $OutputDir 'agent-ops-windows-amd64.manifest.json'
    # Windows PowerShell drops empty native arguments, so -remove is passed only when used.
    $manifestArgs = @('run','./cmd/manifest','-dir',$packageRoot,'-version',$Version,'-o',$manifest)
    if ($removedFiles.Count) { $manifestArgs += @('-remove',($removedFiles -join ',')) }
    Invoke-Checked -File $goExecutable -Arguments $manifestArgs
    Write-Output "Built and verified: $executable ($Version)"
    Write-Output "Release: $archive"
    Write-Output "Manifest: $manifest"
} finally { Pop-Location }
