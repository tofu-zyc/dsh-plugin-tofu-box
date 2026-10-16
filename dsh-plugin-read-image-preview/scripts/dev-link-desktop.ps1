# 把桌面端的 read-image-preview 从 npm 安装切成指向本仓库的 junction，改完代码只需重启应用。
# 反向操作见 dev-unlink-desktop.ps1。
$ErrorActionPreference = 'Stop'

$installed = 'C:\Users\Lenovo\.dsh\profiles\desktop\node_modules\dsh-plugin-read-image-preview'
$workspace = Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'dsh-plugin-read-image-preview'
$backup = 'C:\Users\Lenovo\.dsh\backups\read-image-preview-npm-current'

$item = Get-Item -LiteralPath $installed -ErrorAction SilentlyContinue
if ($item -and $item.LinkTarget) {
  "已经是链接了：$($item.LinkTarget)"
  exit 0
}
if ($item) {
  if (Test-Path -LiteralPath $backup) {
    throw "备份目录已存在：$backup（先处理它，避免覆盖）"
  }
  New-Item -ItemType Directory -Path (Split-Path $backup -Parent) -Force | Out-Null
  Move-Item -LiteralPath $installed -Destination $backup
  "npm 安装已挪到备份：$backup"
}
New-Item -ItemType Junction -Path $installed -Target $workspace | Out-Null
"已链接：$installed -> $workspace"
"重启 dsh 桌面端生效。"
