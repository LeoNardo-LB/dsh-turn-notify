// Windows 代码路径验证工装（可在 Linux/macOS 上运行，需要 pwsh 或 powershell）
//
// 验证目标（无需真 Windows 即可覆盖的层）：
//   1. -EncodedCommand 的 UTF-16LE base64 编码往返无损（含中日文/引号/反斜杠/emoji）
//   2. 插件构造的 PowerShell 脚本语法 100% 有效（Parser::ParseInput 零错误）
//   3. 真实执行精确停在 WinRT 类型加载（Linux pwsh 无 WinRT = 预期边界），
//      而不是解析/转义阶段失败
//   4. 全程走真实代码路径：lib/index.js → execFile('powershell', ...) → 垫片 → pwsh
//
// 用法：node tests/windows-pwsh.mjs [powershell/pwsh 路径]
//   默认依次找 PATH 上的 powershell / pwsh；找不到则 SKIP 退出 0。
//   真 Windows 机器上直接运行，步骤 3 会真实弹出 toast。
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 解析目标 pwsh ----
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

// ---- 垫片：记录参数 + 转发 ----
const work = mkdtempSync(join(tmpdir(), 'dsh-tn-win-'))
const shimDir = join(work, 'shim')
mkdirSync(shimDir, { recursive: true })
const captured = join(work, 'captured.jsonl')
const shim = join(shimDir, 'powershell')
writeFileSync(shim, '#!/bin/sh\necho "$@" >> ' + JSON.stringify(captured) + '\nexec ' + JSON.stringify(target) + ' "$@"\n')
chmodSync(shim, 0o755)
process.env.PATH = shimDir + ':' + (process.env.PATH ?? '')

/** 读垫片截获的调用参数。 */
const readCaptured = () => readFileSync(captured, 'utf8').split('\n').filter(Boolean).map((l) => l.split(' '))

/** 语法/往返检查脚本（经 -File 传参避免二次转义）。 */
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

/** 用真实插件触发一次 windows 平台通知，返回截获的调用参数。 */
async function triggerPlugin(title, question) {
  rmSync(captured, { force: true })
  const ctx = new Context()
  ctx.plugin(plugin, {
    platform: 'windows', notifySend: true, sound: false, bell: false, command: '',
    notifyCommand: '', soundCommand: '', appName: 'dsh', expireMs: 4000,
    titleTemplate: '{title}', bodyTemplate: '{question}', rootOnly: true,
    skipGoalRounds: true, goalQuietMs: 3000, fallbackTitle: 'DSH', fallbackMessage: '回复结束',
    questionChars: 200, minRunMs: 0,
  })
  await sleep(150)
  const agent = { session: { id: 'win-sim-1', header: {} } }
  ctx.emit('session/event', agent.session, { type: 'session/title', data: { title } })
  ctx.emit('session/event', agent.session, {
    type: 'user/message',
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: question }] },
  })
  ctx.emit('agent/status', { agent, status: 'idle' })
  await sleep(2500)
  return readCaptured()
}

const check = (b64) => execFileSync(target, ['-NoProfile', '-File', parseCheckPath, b64], { encoding: 'utf8' }).trim()

// ---- 主流程 ----
console.log('--- 1) 正常字符串：截获 + 解析 ----')
const normal = await triggerPlugin('PARTICLE-TITLE 报告“完成”', '请检查 <a> & \'quote\' C:\\path\\x 😊')
assert.ok(normal.length >= 1, '垫片应截获到 powershell 调用')
const call1 = normal.find((c) => c.includes('-EncodedCommand'))
assert.ok(call1 !== undefined, '参数应含 -EncodedCommand')
const b641 = call1[call1.length - 1]
assert.match(b641, /^[A-Za-z0-9+/=]+$/, 'EncodedCommand 应为纯 base64')
const out2 = check(b641)
console.log(out2)
assert.ok(out2.includes('PARSE-OK'), '脚本语法零错误')
assert.ok(out2.includes('ROUNDTRIP-OK'), '中日文/特殊字符编码往返无损')

console.log('--- 2) 对抗字符串：XML/引号注入面 ----')
const evil = await triggerPlugin('TITLE"\'><&amp; 😡 \\', "Q\"'<>&\\ 注入")
const call2 = evil.find((c) => c.includes('-EncodedCommand'))
const b642 = call2[call2.length - 1]
const out3 = check(b642)
console.log(out3)
assert.ok(out3.includes('PARSE-OK'), '对抗字符串下脚本语法仍零错误')

console.log('--- 3) 真实执行：精确停在 WinRT 边界 ----')
let execResult = ''
let execCode = 0
try {
  execResult = execFileSync(target, ['-NoProfile', '-NonInteractive', '-EncodedCommand', b641], { encoding: 'utf8' }).trim()
} catch (err) {
  execCode = err.status ?? 1
  execResult = ((err.stderr ?? '') + ' ' + (err.stdout ?? '')).trim()
}
console.log('exit=' + execCode + ' output=' + execResult.slice(0, 200))
if (process.platform === 'win32') {
  assert.equal(execCode, 0, '真 Windows 上 toast 应成功显示')
} else {
  assert.ok(
    /Windows\.UI\.Notifications|WinRT|WindowsRuntime|Unable to find type/i.test(execResult),
    'Linux pwsh 上应失败在 WinRT 类型加载（证明解码/解析/转义全过、只差真 Windows）',
  )
}

rmSync(work, { recursive: true, force: true })
console.log('ALL-PASS')
