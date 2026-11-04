#requires -Version 7
<#
.SYNOPSIS
  rc-dev / alpha-dev 插件测试 profile 的唯一启动入口。

.DESCRIPTION
  profile 只是 ~/.dsh/profiles 里的一层配置，“dsh 版本”由运行时决定：

    rc-dev    → .dsh-runtime\rc    （npm dist-tag `next`，rc 线）
    alpha-dev → .dsh-runtime\alpha （npm dist-tag `alpha`，预览线）

  直接用全局 `dsh --profile rc-dev` 会跑在错的版本上（全局 CLI 是另一条通道），
  所以两个 profile 一律通过这个脚本启动。规矩见 docs/TESTING-PROFILES.md。

  没装运行时会报错并提示先跑 -Update；-Update 会把运行时和 profile 依赖都
  更新到该通道最新版（这也是每次测试前的规定动作）。

.EXAMPLE
  pwsh -File tools\dev-dsh.ps1 rc-dev --no-open --port 0

  用 rc 运行时启动 rc-dev profile（随机端口，不开浏览器）。

.EXAMPLE
  pwsh -File tools\dev-dsh.ps1 rc-dev --dump-config

  只看合成后的配置树，不启动。

.EXAMPLE
  pwsh -File tools\dev-dsh.ps1 alpha-dev -Update

  把 alpha 运行时 + alpha-dev 的插件依赖更新到最新，然后退出。

.EXAMPLE
  pwsh -File tools\dev-dsh.ps1 rc-dev -Plugin add dsh-plugin-billing-card@0.3.1

  余下参数转发给该通道运行时的 `dsh plugin`（安装/卸载/更新只用这条路径）。
#>
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet('rc-dev', 'alpha-dev')]
  [string]$Profile,

  # 先把通道运行时与 profile 依赖更新到最新（测试前的规定动作）
  [switch]$Update,

  # 余下参数转发给 `dsh plugin`，而不是 profile 的 app
  [switch]$Plugin,

  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$Rest = @()
)

$ErrorActionPreference = 'Stop'

$workspace = Split-Path -Parent $PSScriptRoot
$channel = if ($Profile -eq 'rc-dev') { 'rc' } else { 'alpha' }
$tag = if ($channel -eq 'rc') { 'next' } else { 'alpha' }
$runtime = Join-Path $workspace ".dsh-runtime\$channel"
$dshPackage = Join-Path $runtime 'node_modules\@deepseek-ai\dsh\package.json'
$bin = Join-Path $runtime 'node_modules\@deepseek-ai\dsh\lib\bin.js'
$profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile

function Get-RuntimeVersion {
  if (-not (Test-Path $dshPackage)) { return $null }
  (Get-Content -LiteralPath $dshPackage -Raw | ConvertFrom-Json).version
}

if (-not (Test-Path $profileDir)) {
  throw "profile '$Profile' 不存在（$profileDir）。用官方模板重建：`n  npm i -g @deepseek-ai/dsh@$tag --prefix `"$runtime`"`n  `"$runtime\dsh.cmd`" --profile $Profile --from-default-profile web --dump-config`n再按 docs/TESTING-PROFILES.md 写回 cordis.patch.yml 的 lab 供应商配置。"
}

if ($Update) {
  Write-Host "==> 更新 $channel 运行时（@deepseek-ai/dsh@$tag）" -ForegroundColor Cyan
  & npm install -g "@deepseek-ai/dsh@$tag" --prefix $runtime --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { throw "运行时更新失败（npm exit $LASTEXITCODE）" }

  Write-Host "==> 更新 $Profile 的插件依赖到最新" -ForegroundColor Cyan
  # 非交互 shell 里 pnpm 会等 stdin 不退出，用 cmd /c 把 stdin 接到 NUL
  & cmd.exe /c "`"$runtime\dsh.cmd`" plugin --profile $Profile update --latest < NUL"
  if ($LASTEXITCODE -ne 0) { throw "profile 依赖更新失败（dsh plugin exit $LASTEXITCODE）" }
  Write-Host "==> 完成：dsh $(Get-RuntimeVersion)" -ForegroundColor Green
  if ($Rest.Count -eq 0 -and -not $Plugin) { return }
}

$version = Get-RuntimeVersion
if (-not $version) {
  throw "$channel 运行时还没装（$runtime）。先跑：pwsh -File tools\dev-dsh.ps1 $Profile -Update"
}

$arguments = if ($Plugin) { @('plugin', '--profile', $Profile) + $Rest } else { @('--profile', $Profile) + $Rest }

Write-Host "==> $Profile  @  dsh $version ($channel)" -ForegroundColor DarkGray
if ($Plugin) {
  & cmd.exe /c "`"$runtime\dsh.cmd`" $($arguments -join ' ') < NUL"
} else {
  & node $bin @arguments
}
exit $LASTEXITCODE
