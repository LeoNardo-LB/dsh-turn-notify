# dsh-turn-notify: 点击通知后的落点（由 dshfocus:// 协议调用）
# 参数是 toast 的 launch URL：dshfocus://focus?port=<宿主端口>&session=<会话ID>
# 1) POST /turn-notify/focus 让已开的桌面页面切到目标会话（客户端用 uiWorkspace.openSession）
# 2) user32 置前（Electron 自己的 focusPrimaryWindow 抢不到前台）
param([Parameter(Mandatory = $false)][string]$Url = '')

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

$port = ''
$session = ''
try {
  $q = Get-Query $Url
  $port = [string]$q['port']
  $session = [string]$q['session']
} catch { }

# 1) 让页面切会话（只接受本机回环端口与会话 ID 形态；curl 避免 Invoke-* 在 NonInteractive 下弹提示）
if ($port -match '^[0-9]{1,5}$' -and $session -match '^[A-Za-z0-9_-]{1,80}$') {
  try {
    $body = '{"sessionId":"' + $session + '"}'
    & curl.exe -s -o NUL --max-time 3 -X POST -H 'content-type: application/json' -d $body ('http://127.0.0.1:' + $port + '/turn-notify/focus') | Out-Null
  } catch { }
}

# 2) 置前
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class DshFocusRaise {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
}
'@
$w = @(Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }) | Select-Object -First 1
if ($w -ne $null) {
  [DshFocusRaise]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
  [DshFocusRaise]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
  [DshFocusRaise]::ShowWindow($w.MainWindowHandle, 9) | Out-Null
  [DshFocusRaise]::SetForegroundWindow($w.MainWindowHandle) | Out-Null
  [DshFocusRaise]::SwitchToThisWindow($w.MainWindowHandle, $true)
} else {
  try { Start-Process 'dsh://open' } catch { }
}
