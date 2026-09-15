# capture.ps1 — virtual-desktop capture for the computer-use plugin.
# Emits ONE line of JSON (the last stdout line).
#   default: saves full-res PNG + downscaled model-frame PNG
#   -Crop 'x,y,w,h' (physical px): saves only the zoom crop
param(
  [Parameter(Mandatory = $true)][string]$OutDir,
  [string]$Prefix = 'screen',
  [int]$MaxDim = 1568,
  [int]$ZoomMaxDim = 2048,
  [string]$Crop = '',
  [int]$Keep = 30
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class DshCap {
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  static bool done = false;
  public static int[] Virtual() {
    if (!done) { SetProcessDpiAwarenessContext((IntPtr)(-4)); done = true; }
    return new int[]{ GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(78), GetSystemMetrics(79) };
  }
}
'@
Add-Type -TypeDefinition $sig

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$stamp = (Get-Date).ToString('yyyyMMdd-HHmmss-fff')
$m = [DshCap]::Virtual()
$x = $m[0]; $y = $m[1]; $W = $m[2]; $H = $m[3]

$bmp = New-Object System.Drawing.Bitmap($W, $H)
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($x, $y, 0, 0, $bmp.Size)
$g.Dispose()

if ($Crop -ne '') {
  $c = $Crop.Split(',') | ForEach-Object { [int]$_ }
  if ($c.Length -ne 4) { throw "Crop must be x,y,w,h" }
  $cx = [Math]::Max(0, $c[0]); $cy = [Math]::Max(0, $c[1])
  $cw = [Math]::Min($c[2], $W - $cx); $ch = [Math]::Min($c[3], $H - $cy)
  if ($cw -lt 2 -or $ch -lt 2) { throw "Crop region degenerate after clipping" }
  $cropBmp = $bmp.Clone((New-Object System.Drawing.Rectangle($cx, $cy, $cw, $ch)), $bmp.PixelFormat)
  $fw = $cw; $fh = $ch
  if ([Math]::Max($cw, $ch) -gt $ZoomMaxDim) {
    $f2 = [double]$ZoomMaxDim / [Math]::Max($cw, $ch)
    $fw = [int][Math]::Round($cw * $f2); $fh = [int][Math]::Round($ch * $f2)
    $rz = New-Object System.Drawing.Bitmap($fw, $fh)
    $gz = [System.Drawing.Graphics]::FromImage($rz)
    $gz.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gz.DrawImage($cropBmp, 0, 0, $fw, $fh)
    $gz.Dispose(); $cropBmp.Dispose(); $cropBmp = $rz
  }
  $cropPath = Join-Path $OutDir ("zoom-$stamp.png")
  $cropBmp.Save($cropPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $cropBmp.Dispose(); $bmp.Dispose()
  [ordered]@{ ok = $true; kind = 'zoom'; x = $x; y = $y; pw = $W; ph = $H
    cx = $cx; cy = $cy; cw = $cw; ch = $ch; fw = $fw; fh = $fh; crop = $cropPath } | ConvertTo-Json -Compress
} else {
  $fullPath = Join-Path $OutDir ("$Prefix-$stamp-full.png")
  $bmp.Save($fullPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $f = [Math]::Min(1.0, [double]$MaxDim / [Math]::Max($W, $H))
  $fw = [int][Math]::Round($W * $f); $fh = [int][Math]::Round($H * $f)
  $smallPath = Join-Path $OutDir ("$Prefix-$stamp.png")
  $dst = New-Object System.Drawing.Bitmap($fw, $fh)
  $g2 = [System.Drawing.Graphics]::FromImage($dst)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $fw, $fh)
  $g2.Dispose()
  $dst.Save($smallPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $dst.Dispose(); $bmp.Dispose()
  [ordered]@{ ok = $true; kind = 'frame'; x = $x; y = $y; pw = $W; ph = $H
    fw = $fw; fh = $fh; full = $fullPath; small = $smallPath } | ConvertTo-Json -Compress
}

Get-ChildItem $OutDir -Filter *.png | Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep | Remove-Item -Force -ErrorAction SilentlyContinue
