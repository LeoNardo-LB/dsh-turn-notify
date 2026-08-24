// Windows 代码路径验证工装（Linux/macOS 用 pwsh；Windows 用 powershell 5.1）
//
// 覆盖层：
//   1. 导出的脚本构造器（与插件同源）在真实 PowerShell 下的语法与编码往返
//      （含中日文/弯引号/反斜杠/emoji 与对抗注入字符串；另查声音脚本）
//   2. 插件端到端：
//      - win32：插件真实 execFile('powershell')（真机 5.1 有 WinRT）——
//        成功或“通知平台不可用”（无桌面会话）均算过；类型加载失败为 FAIL
//      - 非 win32：PATH 垫片截获参数证明插件投递格式，真实执行断言
//        精确停在 WinRT 类型加载（pwsh 无 WinRT = 预期边界）
//
// 用法：node tests/windows-pwsh.mjs [powershell/pwsh 路径]
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
const { buildToastScript, buildBalloonScript, buildSetProcessAumidScript, buildSoundScript, encodePs } = plugin
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const arg0 = process.argv[2] ?? process.env.POWERSHELL_BIN ?? ''
let target = arg0
if (target === '') {
  for (const c of ['powershell', 'pwsh']) {
    try { execFileSync(c, ['-NoProfile', '-Command', 'exit 0'], { stdio: 'ignore' }); target = c; break } catch { /* try next */ }
  }
}
if (target === '') {
  console.log('SKIP: 未找到 powershell/pwsh（Windows 脚本验证需要）')
  process.exit(0)
}
console.log('target interpreter:', target)

const work = mkdtempSync(join(tmpdir(), 'dsh-tn-win-'))

/** 语法/往返检查脚本（-File 传参避免二次转义）。 */
const parseCheckPath = join(work, 'check.ps1')
writeFileSync(parseCheckPath, [
  'param([string]$B64)',
  '$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String($B64))',
  '$tokens = $null; $errors = $null',
  '[System.Management.Automation.Language.Parser]::ParseInput($script, [ref]$tokens, [ref]$errors) | Out-Null',
  'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output ("PARSE-ERROR: " + $_.Message) }; exit 1 }',
  'Write-Output "PARSE-OK"',
  'if ($script -match "PARTICLE-TITLE" -and $script.Contains([string][char]0x8BF7)) { Write-Output "ROUNDTRIP-OK" } else { Write-Output "ROUNDTRIP-MISS" }',
].join('\n'))

const check = (b64) => execFileSync(target, ['-NoProfile', '-File', parseCheckPath, b64], { encoding: 'utf8' }).trim()

// ---- 1) 构造器直测：语法 + 编码往返 ----
console.log('--- 1) 构造器：正常 / 对抗 / 声音脚本 ----')
const bNormal = encodePs(buildToastScript('PARTICLE-TITLE 报告“完成”', '请检查 <a> & \'quote\' C:\\path\\x 😊'))
const out1 = check(bNormal)
console.log(out1)
assert.ok(out1.includes('PARSE-OK'), '正常字符串语法零错误')
assert.ok(out1.includes('ROUNDTRIP-OK'), '中日文/引号/反斜杠/emoji 编码往返无损')

// 点击跳转与音源：protocol-launch toast 的 XML 断言（解码 -EncodedCommand 检查）
const launchUrl = 'http://127.0.0.1:3080/#dsh-focus=session-click-test'
// 音源回归锁（v0.2.2-dev.6）：默认 = 系统通知音（无 <audio> 元素，不叠
// SoundPlayer——双音效 bug 的修复反转）；'silent' 仅在自定义 soundFile /
// sound=false 时出现
const decodedClick = Buffer.from(encodePs(buildToastScript('T', 'B', launchUrl)), 'base64').toString('utf16le')
assert.ok(decodedClick.includes('activationType="protocol"'), 'toast XML 应含 protocol 激活类型')
assert.ok(decodedClick.includes('launch="' + launchUrl + '"'), 'toast XML 应含深链 launch 属性')
assert.ok(!decodedClick.includes('<audio'), '默认 toast 不带 <audio> 元素（用系统通知音，SoundPlayer 不得叠加）')
const decodedPlain = Buffer.from(encodePs(buildToastScript('T', 'B')), 'base64').toString('utf16le')
assert.ok(!decodedPlain.includes('activationType'), '无深链时不应有激活属性')
assert.ok(!decodedPlain.includes('<audio'), '默认无深链 toast 同样用系统音')
const decodedSilent = Buffer.from(encodePs(buildToastScript('T', 'B', undefined, 'silent')), 'base64').toString('utf16le')
assert.ok(decodedSilent.includes('<audio silent="true"/>'), "audio='silent' 必须显式静音（自定义 soundFile / sound=false）")
assert.ok(!decodedSilent.includes('activationType'), 'silent 无深链组合合法')

// AUMID 品牌（v0.2.2-dev.10）：零文件方案——toast 直接以 DSH_AUMID 发出
// （未注册 AUMID 的显示名即字符串本身，显示 dsh）；balloon 经进程显式
// AUMID。早期"开始菜单 dsh.lnk（目标 powershell -WindowStyle Hidden）"
// 的注册方案与 LNK 木马投放器特征一致，被杀软按 HEUR:Trojan/LNK.Agent.b
// 正确地启发式报毒——已彻底移除。无文件回归锁：任何脚本不得包含
// 快捷方式/开始菜单/属性存储写入痕迹。
const DSH_AUMID = 'dsh'
const ALL_SCRIPTS = () => [decodedPlain, decodedClick, branded(), balloonBranded()]
const branded = () => buildToastScript('T', 'B', launchUrl, 'system', DSH_AUMID)
const RAISE = plugin.buildRaiseBrowserScript()
const balloonBranded = () => buildBalloonScript('T', 'B', 's', 'http://x/click', 'http://x/#dsh-focus=s', 300, true, buildSetProcessAumidScript(DSH_AUMID), RAISE)
for (const s of [decodedPlain, decodedClick, branded(), balloonBranded()]) {
  assert.ok(!s.includes('Start Menu'), '无文件回归锁：不得触碰开始菜单（杀软 LNK 启发式误报源）')
  assert.ok(!s.includes('WScript.Shell'), '无文件回归锁：不得创建快捷方式')
  assert.ok(!s.includes('.lnk'), '无文件回归锁：不得引用 .lnk')
  assert.ok(!s.includes('SHGetPropertyStoreFromParsingName'), '无文件回归锁：不得写属性存储')
}
assert.ok(decodedPlain.includes("CreateToastNotifier('{1AC14E77"), '未传 aumid 时默认 PowerShell AUMID（可靠显示兜底）')
assert.ok(branded().includes("CreateToastNotifier('" + DSH_AUMID + "')"), '品牌 toast 直接以自有 AUMID 发出（显示 dsh）')
const out5 = check(encodePs(branded()))
console.log(out5.split('\n')[0])
assert.ok(out5.includes('PARSE-OK'), '品牌 toast 语法零错误')
// balloon：进程 AUMID 设置脚本（提升后的 toast 归属 dsh）
assert.ok(balloonBranded().includes('SetCurrentProcessExplicitAppUserModelID'), 'balloon 设置进程显式 AUMID')
assert.ok(balloonBranded().indexOf('SetCurrentProcessExplicitAppUserModelID') < balloonBranded().indexOf('New-Object System.Windows.Forms.NotifyIcon'), '进程 AUMID 必须在 NotifyIcon 创建前设置')
// 前台拉起（「点了没反应」修复回归锁）：open:false（页面已开原地切换）分支
// 必须把已开浏览器窗口置前——浏览器禁无手势抢前台，没有这步用户看不到反应
const elseAt = balloonBranded().indexOf('} else {', balloonBranded().indexOf('Invoke-RestMethod'))
assert.ok(elseAt > 0, 'open:false 走 else 分支（页面已开时的独立路径）')
assert.ok(balloonBranded().indexOf('SetForegroundWindow') > elseAt, '前台置前在 open:false 分支内')
assert.ok(balloonBranded().includes('UrlAssociations\\http\\UserChoice'), '经注册表读默认浏览器 ProgId')
assert.ok(balloonBranded().includes('ShowWindow($win.MainWindowHandle, 9)'), '最小化窗口先恢复（SW_RESTORE）')
assert.ok(balloonBranded().includes('keybd_event(0x12'), 'ALT 键技巧获取前台权限')
const catchAt = balloonBranded().indexOf('} catch {', elseAt)
const elseBlock = balloonBranded().slice(elseAt, catchAt)
assert.ok(!elseBlock.includes('Start-Process $deepLink'), 'else 分支不得开新标签页（复用语义；catch 网络失败兜底除外）')
const out6 = check(encodePs(balloonBranded()))
assert.ok(out6.includes('PARSE-OK'), '品牌 balloon 脚本（AUMID + 前台拉起 P/Invoke）语法零错误')

const bEvil = encodePs(buildToastScript('TITLE"\'><&amp; 😡 \\', "Q\"'<>&\\ 注入"))
const out2 = check(bEvil)
console.log(out2.split('\n')[0])
assert.ok(out2.includes('PARSE-OK'), '对抗注入字符串语法零错误')

const winWav = 'C:' + String.fromCharCode(92) + 'Windows' + String.fromCharCode(92) + 'Media' + String.fromCharCode(92) + 'Windows Notify.wav'
const out3 = check(encodePs(buildSoundScript(winWav)))
console.log(out3.split('\n')[0])
assert.ok(out3.includes('PARSE-OK'), '声音脚本语法零错误')

// balloon 脚本（Windows 点击复用路径）：真实 PowerShell 语法解析 + 关键内容
const balloon = buildBalloonScript(
  'PARTICLE-TITLE 报告“完成”', '请检查 <a> & \'quote\' C:\\path\\x 😊',
  'win-sess-1', 'http://127.0.0.1:3080/turn-notify/click',
  'http://127.0.0.1:3080/#dsh-focus=win-sess-1', 30, true,
)
assert.ok(balloon.includes('NotifyIcon'), 'balloon 脚本用 NotifyIcon')
assert.ok(balloon.includes('Add_BalloonTipClicked'), 'balloon 脚本注册点击回调')
assert.ok(balloon.includes("$clickUrl = 'http://127.0.0.1:3080/turn-notify/click'"), 'balloon 脚本携带 click 端点 URL')
assert.ok(balloon.includes('Invoke-RestMethod -Method Post -Uri $clickUrl'), 'balloon 点击 POST 到 click 端点')
assert.ok(balloon.includes('"sessionId":"win-sess-1"'), 'click POST 体携带 sessionId')
assert.ok(balloon.includes("Start-Process $deepLink"), '离线兜底 Start-Process 深链')
assert.ok(balloon.includes('ToolTipIcon]::Info'), 'sound=true 用 Info（系统音）')
const out4 = check(encodePs(balloon))
console.log(out4.split('\n')[0])
assert.ok(out4.includes('PARSE-OK'), 'balloon 脚本语法零错误')
assert.ok(out4.includes('ROUNDTRIP-OK'), 'balloon 标题中日文/引号/emoji 编码往返无损')
const balloonMuted = buildBalloonScript('T', 'B', 's', 'http://x/click', 'http://x/#dsh-focus=s', 30, false)
assert.ok(balloonMuted.includes('ToolTipIcon]::None'), 'sound=false balloon 用 None（尽力静音）')
// balloon 寿命（#1 真机反馈回归锁）：驻留时长 5 分钟档，上限 1 小时；
// 通知中心卡片在进程退出后是死卡片，驻留必须远超旧默认 30s
const balloonLong = buildBalloonScript('T', 'B', 's', 'http://x/click', 'http://x/#dsh-focus=s', 300, true)
assert.ok(balloonLong.includes('AddSeconds(300)'), '5 分钟驻留')
assert.ok(balloonLong.includes('ShowBalloonTip(60000)'), 'BalloonTip 显示毫秒封顶 60s（系统上限）')
const balloonHuge = buildBalloonScript('T', 'B', 's', 'http://x/click', 'http://x/#dsh-focus=s', 99999, true)
assert.ok(balloonHuge.includes('AddSeconds(3600)'), '驻留上限 1 小时（防滥用封顶）')

/** 触发真实插件（平台 windows）发出一次 toast。 */
async function triggerPlugin() {
  const ctx = new Context()
  ctx.plugin(plugin, {
    platform: 'windows', notifySend: true, sound: false, bell: false, command: '',
    notifyCommand: '', soundCommand: '', notifyOnQuestion: false,
    questionTitleTemplate: '{title}', questionBodyTemplate: '提问：{question}', questionSoundFile: '',
    appName: 'dsh', expireMs: 4000,
    titleTemplate: 'PARTICLE-TITLE 报告“完成”', bodyTemplate: '{question}', rootOnly: true,
    skipGoalRounds: true, goalQuietMs: 3000, fallbackTitle: 'DSH', fallbackMessage: '回复结束',
    questionChars: 200, minRunMs: 0,
    balloonWaitMs: 3000, // CI 真机分支防 5 分钟驻留（无人点击， ballooning 进程按 3s 退出）
  })
  await sleep(150)
  const agent = { session: { id: 'win-sim-1', header: {} } }
  ctx.emit('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: '请检查 <a> & \'quote\' C:\\path\\x 😊' }] },
  })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await sleep(4000)
}

if (process.platform === 'win32') {
  // ---- 2a) 真 Windows：插件真实调用 powershell（5.1，有 WinRT）----
  console.log('--- 2) 真 Windows 执行 ----')
  const lines = []
  const origLog = console.log
  console.log = (...a) => { lines.push(a.map(String).join(' ')); origLog(...a) }
  await triggerPlugin()
  console.log = origLog
  const fail = lines.find((l) => l.includes('windows-toast" failed'))
  if (fail === undefined) {
    console.log('TOAST-EXEC-OK：powershell 命令成功返回（toast 已提交给通知平台）')
  } else {
    const msg = fail.slice(0, 400)
    console.log('windows-toast failure:', msg)
    assert.ok(!/Unable to find type|Cannot find type/i.test(msg), '真 Windows/5.1 上 WinRT 类型必须能加载')
    assert.ok(
      /notification platform|0x803E|0x80010105|RPC_E_SERVERFAULT|Exception calling|unavailable|没有交互|通知平台/i.test(msg),
      '失败必须是“无桌面会话的通知平台不可用”，而非脚本/转义问题',
    )
    console.log('TOAST-BOUNDARY-OK：类型加载与 XML 全过，仅无桌面会话无法显示（CI headless 预期）')
  }
} else {
  // ---- 2b) Linux/macOS：垫片截获插件参数 + 直跑构造器产物断言边界 ----
  console.log('--- 2) 垫片端到端 + WinRT 边界 ----')
  const shimDir = join(work, 'shim')
  mkdirSync(shimDir, { recursive: true })
  const captured = join(work, 'captured.jsonl')
  const shim = join(shimDir, 'powershell')
  writeFileSync(shim, '#!/bin/sh\necho "$@" >> ' + JSON.stringify(captured) + '\nexec ' + JSON.stringify(target) + ' "$@"\n')
  chmodSync(shim, 0o755)
  process.env.PATH = shimDir + ':' + (process.env.PATH ?? '')
  await triggerPlugin()
  const calls = readFileSync(captured, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '))
  assert.ok(calls.length >= 1, '垫片应截获到 powershell 调用')
  const call = calls.find((c) => c.includes('-EncodedCommand'))
  assert.ok(call !== undefined, '参数应含 -EncodedCommand')
  const b64 = call[call.length - 1]
  assert.match(b64, /^[A-Za-z0-9+/=]+$/, 'EncodedCommand 应为纯 base64')
  console.log('插件投递格式正确（垫片截获）')

  let execResult = ''
  let execCode = 0
  try {
    execResult = execFileSync(target, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], { encoding: 'utf8' }).trim()
  } catch (err) {
    execCode = err.status ?? 1
    execResult = ((err.stderr ?? '') + ' ' + (err.stdout ?? '')).trim()
  }
  console.log('exit=' + execCode + ' output=' + execResult.slice(0, 160))
  assert.ok(
    /Windows\.UI\.Notifications|WinRT|WindowsRuntime|Unable to find type/i.test(execResult),
    '非 Windows pwsh 应精确停在 WinRT 类型加载（解码/解析/转义全过）',
  )
  console.log('WINRT-BOUNDARY-OK')
}

rmSync(work, { recursive: true, force: true })
console.log('ALL-PASS')
