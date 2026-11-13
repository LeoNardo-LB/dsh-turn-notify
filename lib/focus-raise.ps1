# dsh-turn-notify: 点击通知后的落点
# 参数（可选）：dshfocus://focus?port=<宿主端口>&session=<会话ID>
#   1) POST /turn-notify/focus → 已开的桌面页面切到目标会话
#   2) 窗口收在托盘时，先让 Electron 自己 show（dsh://open），再只做"抢前台"——
#      直接用 Win32 ShowWindow 拉起，渲染进程不会从 hidden 恢复，窗口会"无响应"。
param([Parameter(Mandatory = $false)][string]$Url = '')

$logFile = Join-Path $env:TEMP 'dsh-focus-raise.log'
function Write-Probe($msg) {
  try {
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 262144) { Remove-Item $logFile -Force }
    "[$(Get-Date -Format 'HH:mm:ss.fff')] $msg" | Add-Content $logFile
  } catch { }
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
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
  [DllImport("user32.dll")] public static extern IntPtr SendMessageTimeout(IntPtr h, uint msg, IntPtr w, IntPtr l, uint flags, uint timeout, out IntPtr res);
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
  public static bool Responds(IntPtr h) {
    IntPtr res;
    return SendMessageTimeout(h, 0, IntPtr.Zero, IntPtr.Zero, 0x0002 | 0x0001, 1200, out res) != IntPtr.Zero;
  }
  /** 挂到当前前台线程再抢前台；调用前窗口应已可见（由 Electron 负责 show）。 */
  public static void Force(IntPtr hwnd) {
    uint pid;
    IntPtr fg = GetForegroundWindow();
    uint fgThread = GetWindowThreadProcessId(fg, out pid);
    uint me = GetCurrentThreadId();
    bool attached = false;
    try {
      if (fgThread != 0 && fgThread != me) attached = AttachThreadInput(me, fgThread, true);
      keybd_event(0x12, 0, 0, UIntPtr.Zero);
      keybd_event(0x12, 0, 2, UIntPtr.Zero);
      BringWindowToTop(hwnd);
      SetForegroundWindow(hwnd);
      SwitchToThisWindow(hwnd, true);
    } finally {
      if (attached) AttachThreadInput(me, fgThread, false);
    }
  }
}
'@

$hwnd = [DshRaise]::Find('DeepSeek Harness')
Write-Probe ('hwnd=' + $hwnd + ' visible=' + $(if ($hwnd -ne [IntPtr]::Zero) { [DshRaise]::IsWindowVisible($hwnd) } else { 'n/a' }))

if ($hwnd -eq [IntPtr]::Zero) {
  Write-Probe 'window not found'
  exit 0
}

# 1) 托盘里的窗口：交给 Electron show（渲染进程才会从 hidden 恢复）
if (-not [DshRaise]::IsWindowVisible($hwnd)) {
  try { Start-Process 'dsh://open' } catch { }
  for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 100
    if ([DshRaise]::IsWindowVisible($hwnd)) { break }
  }
  Write-Probe ('after dsh://open visible=' + [DshRaise]::IsWindowVisible($hwnd))
  # 兜底：Electron 没能 show（少见）才自己显示
  if (-not [DshRaise]::IsWindowVisible($hwnd)) {
    [DshRaise]::ShowWindow($hwnd, 9) | Out-Null
    Start-Sleep -Milliseconds 150
    Write-Probe 'fallback ShowWindow'
  }
}

# 2) 只抢前台，重复到真的成为前台窗口
$ok = $false
for ($i = 0; $i -lt 12; $i++) {
  [DshRaise]::Force($hwnd)
  Start-Sleep -Milliseconds 120
  if ([DshRaise]::GetForegroundWindow() -eq $hwnd) { $ok = $true; break }
}
Write-Probe ('raised ok=' + $ok + ' responds=' + [DshRaise]::Responds($hwnd))
