// Windows 通知卡片展示冒烟 —— 最小触发脚本（不依赖本仓库任何代码）
//
// 用法（在 Windows 的 PowerShell 或 CMD 里）：
//   node windows-notify-smoke.js [标题] [正文]
// 示例：
//   node windows-notify-smoke.js "DSH" "回复结束，点击我"
//
// 前置：Windows 10/11 + Node.js（powershell 是系统自带的 5.1，零依赖）
// 验证点：右下角弹出通知卡片即成功；本脚本不做点击链路（那是 windows-click.mjs 的职责）
const { execFile } = require('node:child_process')

const title = process.argv[2] ?? 'DSH 通知冒烟'
const body = process.argv[3] ?? '如果你看到这张卡片，Windows toast 通道工作正常'

if (process.platform !== 'win32') {
  console.log('SKIP: 本脚本只在 Windows 上投递（当前 ' + process.platform + '）')
  process.exit(0)
}

// 与 dsh-turn-notify 插件完全同源的 toast 构造（含两个 WinRT 类型激活行）
const xmlEscape = (s) => s
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&apos;')
const psSingle = (s) => "'" + s.replaceAll("'", "''") + "'"
const AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

const xml = '<toast><visual><binding template="ToastText02"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(body) + '</text></binding></visual></toast>'
const script = [
  '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
  '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
  '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
  '$xml.LoadXml(' + psSingle(xml) + ')',
  '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
  "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + AUMID + "').Show($toast)",
].join('\n')

const encoded = Buffer.from(script, 'utf16le').toString('base64')
execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], (err, stdout, stderr) => {
  if (err) {
    console.log('FAIL: powershell 退出码 ' + err.code)
    console.log(String(stderr).slice(0, 500))
    process.exit(1)
  }
  console.log('SENT: toast 已投递——看屏幕右下角（收进通知中心的话按 Win+N）')
})
