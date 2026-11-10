param([switch]$VulnerabilityScan)
. (Join-Path $PSScriptRoot 'common.ps1')
$repoRoot = Split-Path $PSScriptRoot -Parent
$goExecutable = Get-GoExecutable
$env:GOTELEMETRY = 'off'
Push-Location $repoRoot
try {
    Invoke-Checked -File $goExecutable -Arguments @('mod','verify')
    Invoke-Checked -File $goExecutable -Arguments @('test','./...','-count=1')
    Invoke-Checked -File $goExecutable -Arguments @('vet','./...')
    $syntaxFiles = @(Get-ChildItem -File -Filter '*.mjs') + @(Get-ChildItem -Path scripts,integrations -File -Recurse -Filter '*.mjs')
    foreach ($scriptFile in $syntaxFiles) {
        Invoke-Checked -File 'node' -Arguments @('--check',$scriptFile.FullName)
    }
    $testFiles = @(Get-ChildItem -File -Filter '*_test.mjs' | Sort-Object Name | ForEach-Object FullName)
    Invoke-Checked -File 'node' -Arguments (@('--test') + $testFiles)
    if ($VulnerabilityScan) {
        Invoke-Checked -File $goExecutable -Arguments @('run','golang.org/x/vuln/cmd/govulncheck@v1.9.0','./...')
    }
} finally { Pop-Location }
