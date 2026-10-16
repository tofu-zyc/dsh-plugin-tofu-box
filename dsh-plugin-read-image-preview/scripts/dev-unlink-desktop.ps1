# 撤掉 dev-link-desktop.ps1 做的 junction，把 npm 安装的那份放回桌面端。
# 只删链接本身（cmd rmdir 对 junction 只摘链接；对真实目录会因为非空而拒绝），
# 想要彻底回到「应用里重新安装 npm 包」的状态，删完在应用的插件管理里重装即可。
$ErrorActionPreference = 'Stop'

$installed = 'C:\Users\Lenovo\.dsh\profiles\desktop\node_modules\dsh-plugin-read-image-preview'
$backups = Get-ChildItem 'C:\Users\Lenovo\.dsh\backups' -Directory -Filter 'read-image-preview-npm-*' -ErrorAction SilentlyContinue

$item = Get-Item -LiteralPath $installed -ErrorAction SilentlyContinue
if ($item -and -not $item.LinkTarget) {
  "已经是真实目录了，无需撤链：$installed"
} elseif ($item) {
  cmd /c rmdir "`"$installed`"" | Out-Null
  if (Test-Path -LiteralPath $installed) { throw "摘链接失败：$installed" }
  "已摘掉链接：$installed"
} else {
  "安装位置本来就不存在：$installed"
}

if ($item -and $backups) {
  foreach ($backup in $backups) {
    "可恢复的 npm 安装备份：$($backup.FullName)"
  }
  if (-not (Test-Path -LiteralPath $installed)) {
    $restore = Read-Host "把 $($backups[0].Name) 放回原位？(y/N)"
    if ($restore -eq 'y') {
      Move-Item -LiteralPath $backups[0].FullName -Destination $installed
      "已恢复：$installed"
    }
  }
}
"重启 dsh 桌面端生效。"
