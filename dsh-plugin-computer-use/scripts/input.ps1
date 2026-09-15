# input.ps1 — SendInput synthesis for the computer-use plugin.
# All coordinates are PHYSICAL virtual-desktop pixels.
# Actions: pos | move | click | down | up | drag | scroll | type | keydown | keyup | chord
param(
  [Parameter(Mandatory = $true)][string]$Action,
  [int]$X = -1,
  [int]$Y = -1,
  [int]$X2 = -1,
  [int]$Y2 = -1,
  [string]$Button = 'left',
  [int]$Clicks = 1,
  [string]$Direction = 'down',
  [int]$Amount = 3,
  [string]$Text = '',
  [int[]]$Vk = @(),
  [int]$Repeat = 1
)
$ErrorActionPreference = 'Stop'

$sig = @'
using System;
using System.Runtime.InteropServices;
public static class DshInput {
  [DllImport("user32.dll")] static extern uint SendInput(uint n, INPUT[] p, int cbSize);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int n);
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr c);
  [DllImport("user32.dll")] static extern bool GetCursorPos(out P p);
  [StructLayout(LayoutKind.Sequential)] public struct P { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
  }
  [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION u; }
  const uint MOUSE = 0, KEYBOARD = 1;
  const uint MOVE = 0x0001, LDOWN = 0x0002, LUP = 0x0004, RDOWN = 0x0008, RUP = 0x0010,
             MDOWN = 0x0020, MUP = 0x0040, WHEEL = 0x0800, HWHEEL = 0x0100,
             ABSOLUTE = 0x8000, VIRTUALDESK = 0x4000;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;
  static bool aware = false;
  static void EnsureAware() { if (!aware) { SetProcessDpiAwarenessContext((IntPtr)(-4)); aware = true; } }
  static INPUT MoveInput(int x, int y) {
    int vx = GetSystemMetrics(76), vy = GetSystemMetrics(77);
    int vw = GetSystemMetrics(78), vh = GetSystemMetrics(79);
    INPUT inp = new INPUT(); inp.type = MOUSE;
    inp.u.mi.dx = (int)Math.Round((x - vx) * 65535.0 / (vw - 1));
    inp.u.mi.dy = (int)Math.Round((y - vy) * 65535.0 / (vh - 1));
    inp.u.mi.dwFlags = MOVE | ABSOLUTE | VIRTUALDESK;
    return inp;
  }
  public static string Pos() {
    EnsureAware();
    P p; GetCursorPos(out p);
    return p.X + "," + p.Y;
  }
  public static string Move(int x, int y) {
    EnsureAware();
    INPUT[] one = new INPUT[] { MoveInput(x, y) };
    GetCursorPos(out P after);
    return "sent=" + SendInput(1, one, Marshal.SizeOf(typeof(INPUT))) + " at=" + after.X + "," + after.Y;
  }
  static uint BtnDown(string b) { return b == "right" ? RDOWN : (b == "middle" ? MDOWN : LDOWN); }
  static uint BtnUp(string b) { return b == "right" ? RUP : (b == "middle" ? MUP : LUP); }
  static INPUT Btn(string b, bool down) {
    INPUT i = new INPUT(); i.type = MOUSE; i.u.mi.dwFlags = down ? BtnDown(b) : BtnUp(b);
    return i;
  }
  public static string Click(string b, int clicks) {
    EnsureAware();
    uint n = 0;
    int cb = Marshal.SizeOf(typeof(INPUT));
    for (int i = 0; i < clicks; i++) {
      n += SendInput(1, new INPUT[] { Btn(b, true) }, cb);
      n += SendInput(1, new INPUT[] { Btn(b, false) }, cb);
    }
    return "sent=" + n;
  }
  public static string Hold(string b, bool down) {
    EnsureAware();
    return "sent=" + SendInput(1, new INPUT[] { Btn(b, down) }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static string Scroll(string dir, int amount) {
    EnsureAware();
    INPUT i = new INPUT(); i.type = MOUSE;
    if (dir == "left") { i.u.mi.dwFlags = HWHEEL; i.u.mi.mouseData = (uint)(unchecked((int)(-amount * 120))); }
    else if (dir == "right") { i.u.mi.dwFlags = HWHEEL; i.u.mi.mouseData = (uint)(amount * 120); }
    else if (dir == "up") { i.u.mi.dwFlags = WHEEL; i.u.mi.mouseData = (uint)(amount * 120); }
    else { i.u.mi.dwFlags = WHEEL; i.u.mi.mouseData = (uint)(unchecked((int)(-amount * 120))); }
    return "sent=" + SendInput(1, new INPUT[] { i }, Marshal.SizeOf(typeof(INPUT)));
  }
  public static string Type(string s) {
    EnsureAware();
    uint n = 0;
    int cb = Marshal.SizeOf(typeof(INPUT));
    string text = s.Replace("\n", "\r\n");
    foreach (char c in text) {
      INPUT d = new INPUT(); d.type = KEYBOARD; d.u.ki.wScan = c; d.u.ki.dwFlags = UNICODE;
      INPUT u = new INPUT(); u.type = KEYBOARD; u.u.ki.wScan = c; u.u.ki.dwFlags = UNICODE | KEYUP;
      n += SendInput(2, new INPUT[] { d, u }, cb);
    }
    return "sent=" + n;
  }
  public static string Key(ushort[] vks, bool down) {
    EnsureAware();
    uint n = 0;
    int cb = Marshal.SizeOf(typeof(INPUT));
    foreach (ushort vk in vks) {
      INPUT i = new INPUT(); i.type = KEYBOARD; i.u.ki.wVk = vk; i.u.ki.dwFlags = down ? 0u : KEYUP;
      n += SendInput(1, new INPUT[] { i }, cb);
    }
    return "sent=" + n;
  }
}
'@
Add-Type -TypeDefinition $sig

switch ($Action) {
  'pos' { [DshInput]::Pos() }
  'move' { [DshInput]::Move($X, $Y) }
  'click' {
    if ($Vk.Count -gt 0) { [DshInput]::Key([ushort[]]$Vk, $true) | Out-Null }
    $r = [DshInput]::Click($Button, $Clicks)
    if ($Vk.Count -gt 0) { $rev = @($Vk); [array]::Reverse($rev); [DshInput]::Key([ushort[]]$rev, $false) | Out-Null }
    $r
  }
  'down' { [DshInput]::Hold($Button, $true) }
  'up'   { [DshInput]::Hold($Button, $false) }
  'drag' {
    [DshInput]::Move($X, $Y) | Out-Null
    Start-Sleep -Milliseconds 30
    [DshInput]::Hold('left', $true) | Out-Null
    Start-Sleep -Milliseconds 60
    [DshInput]::Move($X2, $Y2) | Out-Null
    Start-Sleep -Milliseconds 60
    [DshInput]::Hold('left', $false) | Out-Null
    "dragged ($X,$Y)->($X2,$Y2) at=" + [DshInput]::Pos()
  }
  'scroll' {
    if ($Vk.Count -gt 0) { [DshInput]::Key([ushort[]]$Vk, $true) | Out-Null }
    $r = [DshInput]::Scroll($Direction, $Amount)
    if ($Vk.Count -gt 0) { $rev = @($Vk); [array]::Reverse($rev); [DshInput]::Key([ushort[]]$rev, $false) | Out-Null }
    $r
  }
  'type' { [DshInput]::Type($Text) }
  'keydown' { [DshInput]::Key([ushort[]]$Vk, $true) }
  'keyup'   { [DshInput]::Key([ushort[]]$Vk, $false) }
  'chord' {
    if ($Vk.Count -lt 1) { throw "chord needs at least one VK" }
    for ($i = 0; $i -lt $Repeat; $i++) {
      [DshInput]::Key([ushort[]]$Vk, $true) | Out-Null
      Start-Sleep -Milliseconds 30
      $rev = @($Vk); [array]::Reverse($rev)
      [DshInput]::Key([ushort[]]$rev, $false) | Out-Null
      if ($Repeat -gt 1) { Start-Sleep -Milliseconds 30 }
    }
    "chord x$Repeat sent"
  }
  default { throw "unknown action $Action" }
}
