// Windows 点击跳转端到端校验（在真 Windows 桌面会话运行）
//
// 链路：用插件导出的 buildToastScript 构造带 protocol-launch 深链的 toast
// → powershell 投递 → 点击卡片（默认人工点；--auto 尝试 UIA 自动点击，
// 会移动鼠标）→ Windows 用默认浏览器打开深链 → 本地监听器收到请求 = PASS。
//
// 前置：Node 22+（无需其他依赖；toast 走系统 PowerShell 5.1）
// 运行：node tests/windows-click.mjs [--auto]
import { createServer } from 'node:http'
import { execFile } from 'node:child_process'
import * as plugin from '../lib/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const AUTO = process.argv.includes('--auto')

if (process.platform !== 'win32') {
  console.log('SKIP: 非 win32（请在真 Windows 桌面会话运行；CI 的 headless Server 无通知平台，已证实只能到提交边界）')
  process.exit(0)
}

// ---- 1) 本地监听器 ----
const MARK = 'TNCLICK-' + Math.random().toString(36).slice(2, 8)
let hit = ''
const server = createServer((req, res) => {
  hit = req.url ?? ''
  res.writeHead(200, { 'content-type': 'text/plain' })
  res.end('dsh-turn-notify click-verify OK')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port
const deepLink = 'http://127.0.0.1:' + port + '/#dsh-focus=session-click-' + MARK
console.log('listener on :' + port + '  deep link: ' + deepLink)

// ---- 2) 投递 toast（与插件同源构造器） ----
const script = plugin.buildToastScript('dsh-turn-notify 点击验证 ' + MARK, '点击这张卡片完成校验', deepLink)
const encoded = Buffer.from(script, 'utf16le').toString('base64')
execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], (err) => {
  if (err) console.log('toast 进程报错（显示可能仍成功）: ' + String(err.message).slice(0, 200))
})
console.log('toast 已投递——请点击屏幕右上角的通知卡片')

// ---- 3) 可选：UIA 自动点击 ----
if (AUTO) {
  console.log('--auto：尝试 UIA 自动点击（会移动鼠标）…')
  const uia = [
    'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms',
    '$deadline = (Get-Date).AddSeconds(12)',
    'while ((Get-Date) -lt $deadline) {',
    '  $root = [System.Windows.Automation.AutomationElement]::RootElement',
    '  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, "Windows.UI.Core.CoreWindow")',
    '  foreach ($w in $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)) {',
    '    if ($w.Current.Name -like "*' + MARK + '*") {',
    '      $r = $w.Current.BoundingRectangle',
    '      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point((($r.Left + $r.Right) / 2), (($r.Top + $r.Bottom) / 2))',
    '      $me = Add-Type -MemberDefinition "[DllImport(\"user32.dll\")] public static extern void mouse_event(int f,int x,int y,int d,int i);" -Name U -Namespace W -PassThru',
    '      $me::mouse_event(2, 0, 0, 0, 0); Start-Sleep -Milliseconds 60; $me::mouse_event(4, 0, 0, 0, 0)',
    '      Write-Output "UIA-CLICKED"; exit 0',
    '    }',
    '  }',
    '  Start-Sleep -Milliseconds 700',
    '}',
    'Write-Output "UIA-NOT-FOUND"',
  ].join(String.fromCharCode(10))
  const enc2 = Buffer.from(uia, 'utf16le').toString('base64')
  execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', enc2], { timeout: 20000 }, (err, stdout) => {
    console.log(String(stdout).trim() || (err ? 'UIA 尝试失败（可手动点）: ' + String(err.message).slice(0, 120) : ''))
  })
}

// ---- 4) 判定（60 秒窗口，等人点） ----
const deadline = Date.now() + 60000
while (hit === '' && Date.now() < deadline) await sleep(500)
server.close()
if (hit.includes('#dsh-focus=session-click-' + MARK)) {
  console.log('CLICK-VERIFY-PASS：点击卡片 → 默认浏览器打开深链 → 监听器收到 ' + hit)
  process.exit(0)
}
console.log('CLICK-VERIFY-FAIL：60 秒内未收到深链请求（hit=' + (hit || '(none)') + '）')
process.exit(1)
