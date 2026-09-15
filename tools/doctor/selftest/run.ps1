# doctor self-test: runs doctor.mjs against fake-dsh in three scenarios.
# Requires node on PATH. Cleans up .doctor-selftest/ (gitignored) afterwards.
param([string[]]$Scenarios = @('named', 'mystery', 'mystery-stack'))
$ErrorActionPreference = 'Stop'
$doctorDir = Split-Path -Parent $PSScriptRoot           # tools/doctor
$repoRoot  = Split-Path -Parent (Split-Path -Parent $doctorDir)
$home2     = Join-Path $repoRoot '.doctor-selftest'
$prof      = Join-Path $home2 'profiles\web'
$fake      = Join-Path $PSScriptRoot 'fake-dsh.cmd'

foreach ($s in $Scenarios) {
  Write-Host "===== scenario: $s =====" -ForegroundColor Cyan
  if (Test-Path $home2) { Remove-Item $home2 -Recurse -Force }
  New-Item -ItemType Directory -Path $prof -Force | Out-Null
  @'
{
  "name": "selftest-profile",
  "dependencies": {
    "bad-plugin": "git+https://example.invalid/bad.git",
    "bad2-plugin": "git+https://example.invalid/bad2.git",
    "good-plugin": "git+https://example.invalid/good.git"
  }
}
'@ | Set-Content -Path (Join-Path $prof 'package.json') -Encoding utf8

  $env:DSH_HOME = $home2
  $env:SELFTEST_STATE = Join-Path $home2 'counter.txt'
  $env:FAKE_SCENARIO = $s
  node (Join-Path $doctorDir 'doctor.mjs') --profile web --dsh $fake --yes --alive 3 --probe 2
  if ($LASTEXITCODE -ne 0) {
    Write-Host "scenario '$s' FAILED (exit $LASTEXITCODE)" -ForegroundColor Red
    exit 1
  }
  Write-Host "scenario '$s' OK" -ForegroundColor Green
}
Remove-Item $home2 -Recurse -Force -ErrorAction SilentlyContinue
Write-Host 'all scenarios passed' -ForegroundColor Green
