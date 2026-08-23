// macOS 点击跳转端到端校验（需真机：GUI 会话 + terminal-notifier + 辅助功能授权）
//
// 链路：terminal-notifier 发带 -open 深链的通知 → 本脚本用 System Events
// 辅助功能 API 自动 AXPress 通知卡片 → macOS 打开深链 → 本地微型 HTTP
// 监听器收到该请求 = 点击跳转链路完整 PASS。若自动点击找不到卡片
// （banner 已消失/AX 路径随版本变化），10 秒内可手动点，同样有效。
//
// 前置（一次性）：
//   brew install terminal-notifier
//   系统设置 → 隐私与安全性 → 辅助功能 → 勾选运行本脚本的终端 App
// 运行：node tests/macos-click.mjs
import { createServer } from 'node:http'
import { execFile, execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

if (process.platform !== 'darwin') {
  console.log('SKIP: 非 darwin（本校验需真 macOS GUI 会话；CI runner 无 NotificationCenter，已证实不可用）')
  process.exit(0)
}

// ---- 0) 前置检查 ----
try {
  execFileSync0('terminal-notifier', ['-help'])
} catch {
  console.log('SKIP: 未安装 terminal-notifier（brew install terminal-notifier）')
  process.exit(0)
}
const axProbe = await osa('tell application "System Events" to get name of first process')
if (/osascript is not allowed|assistive|access/i.test(axProbe)) {
  console.log('FAIL-PREP: 辅助功能未授权——系统设置 → 隐私与安全性 → 辅助功能，勾选你的终端 App 后重试')
  process.exit(1)
}

// ---- 1) 本地监听器（深链落点） ----
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

// ---- 2) 发通知（-wait：被激活/关闭才退出） ----
const tn = spawn('terminal-notifier', [
  '-title', 'dsh-turn-notify 点击验证 ' + MARK,
  '-message', '脚本会自动点击这张卡片（10 秒内手动点也行）',
  '-open', deepLink,
  '-group', MARK,
  '-wait',
], { stdio: 'ignore' })
let tnCode = null
tn.on('exit', (c) => { tnCode = c })

// ---- 3) 自动点击循环（AXPress，best-effort） ----
console.log('尝试自动点击通知卡片…')
let pressed = false
for (let i = 0; i < 12 && hit === '' && tnCode === null; i++) {
  const r = await osa(axClickAppleScript(MARK))
  if (r.startsWith('PRESSED')) { pressed = true; console.log('AX 自动点击成功: ' + r); break }
  if (r === 'ENUMERATE-FAILED') { console.log('AX 枚举失败（辅助功能授权范围不足？）—— 请手动点击'); break }
  await sleep(800)
}
if (!pressed && hit === '') console.log('未自动找到卡片（banner 可能已收进通知中心）——10 秒内请手动点击')

// ---- 4) 判定 ----
const deadline = Date.now() + 10000
while (hit === '' && Date.now() < deadline) await sleep(300)
server.close()
console.log('terminal-notifier exit=' + tnCode + '（0=被激活）')
if (hit.includes('#dsh-focus=session-click-' + MARK)) {
  console.log('CLICK-VERIFY-PASS：通知卡片点击 → 深链被打开 → 监听器收到 ' + hit)
  process.exit(0)
}
console.log('CLICK-VERIFY-FAIL：未收到深链请求（hit=' + (hit || '(none)') + '；auto-pressed=' + pressed + '）')
process.exit(1)

// ---------- helpers ----------
function execFileSync0(cmd, args) {
  execFileSync(cmd, args, { stdio: 'ignore', timeout: 10000 })
}
function osa(script) {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: 15000 }, (err, stdout, stderr) => {
      resolve(err ? 'ERR: ' + String(err.message) + ' ' + String(stderr).slice(0, 120) : String(stdout).trim())
    })
  })
}
function axClickAppleScript(mark) {
  return 'tell application "System Events"' + String.fromCharCode(10) +
    '  tell process "Notification Center"' + String.fromCharCode(10) +
    '    set els to {}' + String.fromCharCode(10) +
    '    try' + String.fromCharCode(10) +
    '      set els to entire contents' + String.fromCharCode(10) +
    '    on error' + String.fromCharCode(10) +
    '      return "ENUMERATE-FAILED"' + String.fromCharCode(10) +
    '    end try' + String.fromCharCode(10) +
    '    repeat with el in els' + String.fromCharCode(10) +
    '      try' + String.fromCharCode(10) +
    '        set d to ((description of el) as text) & " " & ((value of el) as text) & " " & ((name of el) as text)' + String.fromCharCode(10) +
    '        if d contains "' + mark + '" then' + String.fromCharCode(10) +
    '          perform action "AXPress" of el' + String.fromCharCode(10) +
    '          return "PRESSED"' + String.fromCharCode(10) +
    '        end if' + String.fromCharCode(10) +
    '      end try' + String.fromCharCode(10) +
    '    end repeat' + String.fromCharCode(10) +
    '    return "NOT-FOUND"' + String.fromCharCode(10) +
    '  end tell' + String.fromCharCode(10) +
    'end tell'
}
