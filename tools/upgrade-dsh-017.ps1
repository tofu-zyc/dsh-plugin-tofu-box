# Requires an explicit maintenance window: stopping port 3080 ends active DSH turns.
# Run without -Execute to perform a read-only preflight. Secrets and token URLs stay out of reports.
param(
  [string]$TargetVersion = '0.1.7-rc.1',
  [string]$SourceDir = 'D:\program\dsh-plugins\.dsh-017rc1-test\source',
  [switch]$Execute,
  [int]$DelaySeconds = 15
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$workspace = 'D:\program\dsh-plugins'
$test = Join-Path $workspace '.dsh-017-test'
$productionSource = Join-Path $workspace '.dsh-017-prod\source'
$productionHome = Join-Path $env:USERPROFILE '.dsh'
$profileDir = Join-Path $productionHome 'profiles\web'
$globalPackage = Join-Path $env:APPDATA 'npm\node_modules\@deepseek-ai\dsh'
$oldDeployment = Join-Path $test 'rollback\global-dsh-016'
$oldManifest = Join-Path $test 'rollback\backup-manifest.json'
$reportDir = Join-Path $test 'rollback\maintenance'
$reportPath = Join-Path $reportDir 'outcome.json'
$pluginNames = @('dsh-plugin-computer-use', 'dsh-plugin-image-generation', 'dsh-plugin-mcp-ui', 'dsh-plugin-model-search', 'dsh-plugin-model-tuning', 'dsh-plugin-read-image-preview', 'dsh-plugin-shell-selector', 'dsh-plugin-team-task-route', 'dsh-plugin-title-model')

function VersionOf([string]$path) { (Get-Content (Join-Path $path 'package.json') -Raw | ConvertFrom-Json).version }
function CopyTree([string]$from, [string]$to, [switch]$Mirror) {
  $flags = if ($Mirror) { '/MIR' } else { '/E' }
  & robocopy $from $to $flags /COPY:DAT /DCOPY:DAT /XJ /R:2 /W:1 /NFL /NDL /NP /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed ($LASTEXITCODE): $from -> $to" }
}
# dsh 0.1.7-rc.1 skips a whole profile bundle when one @deepseek-ai/dsh* peer does
# not satisfy the runtime version (stderr only). Fail loudly here instead.
# @see packages/boot/app-boot/src/plugin-compatibility.ts (semver.satisfies with includePrerelease)
function AssertPeerGate([string]$runtimeVersion) {
  $probe = @'
const { createRequire } = require('node:module')
const { readFileSync } = require('node:fs')
const requireFromDsh = createRequire(process.argv[2])
const semver = requireFromDsh('semver')
const runtime = process.argv[3]
const bad = []
for (const manifestPath of process.argv.slice(4)) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
    if (name !== '@deepseek-ai/dsh' && !name.startsWith('@deepseek-ai/dsh-')) continue
    const requirement = ['workspace:^', 'workspace:~', 'workspace:*'].includes(range) ? runtime : range
    if (!semver.satisfies(runtime, requirement, { includePrerelease: true })) {
      bad.push(`${manifest.name}@${manifest.version} ${name}@${range}`)
    }
  }
}
if (bad.length) { console.error(bad.join('\n')); process.exit(1) }
'@
  $probePath = Join-Path $reportDir 'peer-gate.cjs'
  $probe | Set-Content -LiteralPath $probePath -Encoding utf8
  $manifests = $pluginNames | ForEach-Object { Join-Path $productionSource "$_\package.json" }
  & node $probePath (Join-Path $globalPackage 'lib\bin.js') $runtimeVersion @manifests
  if ($LASTEXITCODE) { throw "dsh $runtimeVersion would silently skip the listed plugin bundles (unsatisfied dsh peers); widen the ranges or grant an exemption" }
}
function Listener {
  # Always return [int[]]: Set-StrictMode refuses .Count on a bare scalar, which is what a
  # single listener unrolls to — that exact bug killed the first run after 3080 was already down.
  [int[]]$ids = @(Get-NetTCPConnection -LocalAddress 127.0.0.1 -LocalPort 3080 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
  return ,$ids
}
function ConfirmOldServer {
  $listeners = Listener
  if ($listeners.Count -ne 1) { throw "Expected exactly one production listener on 127.0.0.1:3080; found $($listeners.Count)" }
  $process = Get-CimInstance Win32_Process -Filter "ProcessId=$($listeners[0])"
  if (-not $process -or $process.CommandLine -notmatch '@deepseek-ai[/\\]dsh[/\\]lib[/\\]bin\.js') {
    throw 'Port 3080 does not belong to the expected global DSH process; refusing to stop it'
  }
  [int]$listeners[0]
}
$script:serverStopped = $false
function WaitUntilStopped([int]$id) {
  Stop-Process -Id $id -ErrorAction Stop
  # Flag before anything else: every later failure must roll back, never rethrow with 3080 down.
  $script:serverStopped = $true
  for ($i = 0; $i -lt 40; $i++) {
    if ((Listener).Count -eq 0) { return }
    Start-Sleep -Milliseconds 250
  }
  throw 'Port 3080 did not close after the production process was stopped'
}
# The operator may keep `dsh web` in a terminal that respawns the server. A foreign listener
# re-binding 3080 would race every later step, so refuse rather than fight over the port.
function AssertPortStillOurs([string]$phase) {
  $listeners = Listener
  if ($listeners.Count -eq 0) { return }
  throw "Port 3080 was re-bound by PID $($listeners -join ', ') during $phase. Close the terminal running 'dsh web' and retry; nothing further was changed."
}
function StartServer([string]$label) {
  $env:DSH_HOME = $productionHome
  $node = (Get-Command node -ErrorAction Stop).Source
  $stdout = Join-Path $reportDir "$label.stdout.log"
  $stderr = Join-Path $reportDir "$label.stderr.log"
  $bin = Join-Path $globalPackage 'lib\bin.js'
  $server = Start-Process -FilePath $node -ArgumentList @($bin, 'web', '--profile', 'web', '--port', '3080', '--no-open') -WorkingDirectory $workspace -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  # A first 0.1.7 boot migrates existing V3 session logs before it answers, so allow three minutes.
  for ($i = 0; $i -lt 360; $i++) {
    Start-Sleep -Milliseconds 500
    if ($server.HasExited) { throw "$label server quit during startup (exit $($server.ExitCode)); inspect $stderr" }
    $text = Get-Content $stdout -Raw -ErrorAction SilentlyContinue
    if ($text -match 'http://127\.0\.0\.1:3080/\?token=[^\s]+') {
      $url = $Matches[0]
      # Local HTTP must bypass the system proxy, or a proxied probe never lands.
      $code = (& curl.exe --silent --output NUL --max-time 3 --noproxy '*' -w '%{http_code}' $url) 2>$null
      if ("$code" -eq '200') { return [pscustomobject]@{ ProcessId = $server.Id; Url = $url } }
    }
  }
  throw "$label server did not serve its authenticated 3080 URL within three minutes"
}
function SaveResult([string]$status, [string]$snapshot, [string]$detail, [int]$serverPid = 0, [string]$url = '') {
  $version = try { VersionOf $globalPackage } catch { 'unavailable' }
  [pscustomobject]@{ time = (Get-Date).ToString('o'); status = $status; snapshot = $snapshot; version = $version; serverPid = $serverPid; url = $url; detail = $detail } |
    ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $reportPath -Encoding utf8
}

if ((VersionOf $globalPackage) -ne '0.1.6-alpha.2') { throw 'Global deployment is not the expected 0.1.6-alpha.2; no changes made' }
if ((VersionOf $oldDeployment) -ne '0.1.6-alpha.2' -or !(Test-Path $oldManifest)) { throw '0.1.6 rollback deployment is missing' }
if (!(Test-Path (Join-Path $SourceDir 'dsh-plugin-read-image-preview\package.json'))) { throw "Verified plugin source tree missing under $SourceDir" }
if ((git -C $SourceDir rev-parse --abbrev-ref HEAD) -notmatch 'upgrade/dsh-') { throw "Plugin source $SourceDir is not on an upgrade branch" }
foreach ($name in $pluginNames) { if (!(Test-Path (Join-Path $SourceDir "$name\package.json"))) { throw "Verified plugin absent from $SourceDir`: $name" } }
$originalPid = ConfirmOldServer
if (!$Execute) {
  Write-Output "PREVIEW ONLY: production 0.1.6 PID $originalPid on 3080; target dsh $TargetVersion; $($pluginNames.Count) verified plugins under $SourceDir; rollback package present. Execution will interrupt live sessions."
  return
}
if ($DelaySeconds -lt 0 -or $DelaySeconds -gt 300) { throw 'DelaySeconds must be 0..300' }
New-Item -ItemType Directory -Force -Path $reportDir | Out-Null
# This run survives its own parent (the DSH host on 3080 is stopped mid-flight), so keep a full transcript.
Start-Transcript -Path (Join-Path $reportDir 'transcript.log') -Force | Out-Null
SaveResult 'waiting' '' "Maintenance approved; dsh $TargetVersion cutover starts after the delay"
Start-Sleep -Seconds $DelaySeconds
$originalPid = ConfirmOldServer
$snapshot = Join-Path $test ('rollback\final-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
$upgradedPid = 0
$finalBackedUp = $false
try {
  WaitUntilStopped $originalPid
  CopyTree $productionHome (Join-Path $snapshot 'home-016')
  if (!(Test-Path (Join-Path $snapshot 'home-016\profiles\web\package.json'))) { throw 'Final offline home backup is incomplete' }
  $finalBackedUp = $true
  SaveResult 'backed_up' $snapshot 'Final offline home snapshot is complete'
  AssertPortStillOurs 'the offline backup'
  # Stage the verified sources outside any Git worktree, then compare file by file.
  foreach ($name in $pluginNames) { CopyTree (Join-Path $SourceDir $name) (Join-Path $productionSource $name) -Mirror }
  foreach ($file in Get-ChildItem $SourceDir -Recurse -File | Where-Object { $_.FullName -notmatch '\\node_modules\\' }) {
    $relative = $file.FullName.Substring($SourceDir.Length + 1)
    if ($pluginNames -notcontains $relative.Split('\')[0]) { continue }
    $staged = Join-Path $productionSource $relative
    if (!(Test-Path $staged) -or (Get-FileHash $file.FullName).Hash -ne (Get-FileHash $staged).Hash) { throw "Staged copy differs from the verified source: $relative" }
  }
  $manifestPath = Join-Path $profileDir 'package.json'
  $manifest = Get-Content $manifestPath -Raw | ConvertFrom-Json
  foreach ($name in $pluginNames) { $manifest.dependencies.$name = "link:D:/program/dsh-plugins/.dsh-017-prod/source/$name" }
  $manifest.dsh.profile.bundles = @($manifest.dsh.profile.bundles | Where-Object { $_ -ne '@deepseek-ai/dsh-experimental-agent-team-web-profile' })
  $manifest | ConvertTo-Json -Depth 30 | Set-Content -LiteralPath $manifestPath -Encoding utf8
  $env:CI = 'true'
  & pnpm install --dir $profileDir --no-frozen-lockfile --ignore-scripts
  if ($LASTEXITCODE) { throw "Production profile dependency relink failed: $LASTEXITCODE" }
  foreach ($name in $pluginNames) {
    $link = Get-Item (Join-Path $profileDir "node_modules\$name") -Force
    if ($link.Target -ne (Join-Path $productionSource $name)) { throw "Unexpected production plugin link for $name" }
  }
  & npm install -g "@deepseek-ai/dsh@$TargetVersion" --no-audit --no-fund
  if ($LASTEXITCODE -or (VersionOf $globalPackage) -ne $TargetVersion) { throw "Pinned dsh $TargetVersion global installation failed its version check" }
  foreach ($module in @('dsh-typert-protocol', 'dsh-tools', 'schemastery', 'cordis')) {
    if (!(Test-Path (Join-Path $globalPackage "node_modules\@deepseek-ai\$module\package.json"))) { throw "Global DSH is missing shared plugin module $module" }
  }
  AssertPeerGate $TargetVersion
  $moduleLink = Join-Path $productionSource 'node_modules'
  if (Test-Path $moduleLink) { throw 'Refusing to overwrite existing production plugin module resolution' }
  New-Item -ItemType Junction -Path $moduleLink -Target (Join-Path $globalPackage 'node_modules') | Out-Null
  Remove-Item Env:CI -ErrorAction SilentlyContinue
  $launched = StartServer 'upgraded'
  $upgradedPid = $launched.ProcessId
  $env:DSH_CORPUS_URL = $launched.Url
  $env:DSH_CORPUS_PORT = '3080'
  $env:QA_MODULES = Join-Path $workspace '.dsh-017-test\qa'
  & node (Join-Path $workspace '.dsh-017rc1-test\qa\corpus-smoke.mjs')
  if ($LASTEXITCODE) { throw "Read-only production browser smoke failed: $LASTEXITCODE" }
  Remove-Item Env:DSH_CORPUS_URL, Env:DSH_CORPUS_PORT, Env:QA_MODULES -ErrorAction SilentlyContinue
  SaveResult 'upgraded' $snapshot "dsh $TargetVersion installed; nine verified plugins linked; peer gate, authenticated HTTP and headless settings/image/title/session smoke passed" $upgradedPid $launched.Url
  Write-Output "SUCCESS: DSH $TargetVersion on port 3080; rollback snapshot $snapshot; report $reportPath"
} catch {
  $cause = $_.Exception.Message
  # Nothing was touched until the server went down; only then may recovery restart it.
  if (!$script:serverStopped) { throw }
  if (!$finalBackedUp) {
    try {
      foreach ($id in Listener) { Stop-Process -Id $id -ErrorAction Stop }
      $restored = StartServer 'restored-after-backup-failure'
      SaveResult 'backup_failed_restored' $snapshot "Offline backup failed ($cause); unchanged 0.1.6 is serving again" $restored.ProcessId $restored.Url
    } catch {
      SaveResult 'rollback_needs_attention' $snapshot "Offline backup error: $cause; server restart error: $($_.Exception.Message)"
      throw
    }
    throw "Offline backup failed; original 0.1.6 restarted. Cause: $cause"
  }
  try {
    foreach ($id in Listener) { Stop-Process -Id $id -ErrorAction Stop }
    if (Test-Path $productionHome) { CopyTree $productionHome (Join-Path $snapshot 'failed-upgrade-home') }
    CopyTree $oldDeployment $globalPackage -Mirror
    foreach ($name in @('dsh.cmd', 'dsh.ps1', 'dsh')) {
      $saved = Join-Path $test "rollback\$name"
      if (Test-Path $saved) { Copy-Item -LiteralPath $saved -Destination (Join-Path (Join-Path $env:APPDATA 'npm') $name) -Force }
    }
    $moduleLink = Join-Path $productionSource 'node_modules'
    if (Test-Path $moduleLink) {
      $item = Get-Item $moduleLink -Force
      if (!$item.LinkType -or $item.Target -ne (Join-Path $globalPackage 'node_modules')) { throw 'Unexpected production source node_modules; refusing to remove it' }
      $item.Delete()
    }
    CopyTree (Join-Path $snapshot 'home-016') $productionHome -Mirror
    $env:CI = 'true'
    & pnpm install --dir $profileDir --no-frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE) { throw "0.1.6 profile relink failed: $LASTEXITCODE" }
    if ((VersionOf $globalPackage) -ne '0.1.6-alpha.2') { throw 'Rollback version mismatch' }
    Remove-Item Env:CI -ErrorAction SilentlyContinue
    $restored = StartServer 'restored'
    SaveResult 'rolled_back' $snapshot "Upgrade rejected ($cause); 0.1.6 restored and authenticated HTTP verified" $restored.ProcessId $restored.Url
  } catch {
    SaveResult 'rollback_needs_attention' $snapshot "Upgrade error: $cause; rollback error: $($_.Exception.Message)"
    Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
    throw
  }
  Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
  throw "Upgrade failed; restored 0.1.6 and preserved failed state under $snapshot. Original error: $cause"
}
Stop-Transcript -ErrorAction SilentlyContinue | Out-Null
