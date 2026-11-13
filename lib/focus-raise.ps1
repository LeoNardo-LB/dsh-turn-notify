# dsh-turn-notify: 点击通知后的落点
# 参数（可选）：dshfocus://focus?port=<宿主端口>&session=<会话ID>
#   1) POST /turn-notify/focus → 已开的桌面页面切到目标会话
#   2) 按标题找 DSH 主窗口（隐藏/托盘同样能找到），AttachThreadInput + user32 抢前台
param([Parameter(Mandatory = $false)][string]$Url = '')

$logFile = Join-Path $env:TEMP 'dsh-focus-raise.log'
function Write-Probe($msg) {
  try { "[$(Get-Date -Format 'HH:mm:ss.fff')] $msg" | Add-Content $logFile } catch { }
}
Write-Probe ('start url=' + $Url)

function Get-Query($u) {
  $q = @{}
  if ([string]::IsNullOrEmpty($u)) { return $q }
  $i = $u.IndexOf('?')
  if ($i -lt 0) { return $q }
  $tail = $u.Substring($i + 1)
  $h = $tail.IndexOf('#')
  if ($h -ge 0) { $tail = $tail.Substring(0, $h) }
  foreach ($pair in $tail.Split('&')) {
    if ([string]::IsNullOrWhiteSpace($pair)) { continue }
    $kv = $pair.Split('=', 2)
    $k = [uri]::UnescapeDataString($kv[0])
    $v = if ($kv.Length -gt 1) { [uri]::UnescapeDataString($kv[1]) } else { '' }
    $q[$k] = $v
  }
  return $q
}

try {
  $q = Get-Query $Url
  $port = [string]$q['port']
  $session = [string]$q['session']
  if ($port -match '^[0-9]{1,5}$' -and $session -match '^[A-Za-z0-9_-]{1,80}$') {
    $body = '{"sessionId":"' + $session + '"}'
    & curl.exe -s -o NUL --max-time 3 -X POST -H 'content-type: application/json' -d $body ('http://127.0.0.1:' + $port + '/turn-notify/focus') | Out-Null
    Write-Probe 'focus posted'
  }
} catch { }

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DshRaise {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr h, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr h, IntPtr after, int x, int y, int cx, int cy, uint flags);
  public static IntPtr Find(string needle) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, l) => {
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().IndexOf(needle, StringComparison.OrdinalIgnoreCase) >= 0) { found = h; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  /** AttachThreadInput 到当前前台线程后再抢前台——绕过前台锁最可靠的做法。 */
  public static void Force(IntPtr hwnd) {
    ShowWindow(hwnd, 9);
    uint pid;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    bool attached = fgThread != 0 && AttachThreadInput(me, fgThread, true);
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    SetWindowPos(hwnd, new IntPtr(-1), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    SwitchToThisWindow(hwnd, true);
    SetWindowPos(hwnd, new IntPtr(-2), 0, 0, 0, 0, 0x0001 | 0x0002 | 0x0040);
    if (attached) AttachThreadInput(me, fgThread, false);
  }
}
'@

$hwnd = [DshRaise]::Find('DeepSeek Harness')
Write-Probe ('hwnd=' + $hwnd)
if ($hwnd -ne [IntPtr]::Zero) {
  [DshRaise]::Force($hwnd)
  $ok = $false
  for ($i = 0; $i -lt 12; $i++) {
    Start-Sleep -Milliseconds 120
    if ([DshRaise]::GetForegroundWindow() -eq $hwnd) { $ok = $true; break }
    [DshRaise]::Force($hwnd)
  }
  Write-Probe ('raised ok=' + $ok)
} else {
  Write-Probe 'window not found'
}
