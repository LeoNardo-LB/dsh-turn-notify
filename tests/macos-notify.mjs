// macOS 代码路径验证工装
//
// 覆盖层：
//   1. 导出的 AppleScript 构造器（与插件同源）文本级断言——任意平台可跑
//      （引号/反斜杠转义正确性）
//   2. darwin 真跑：osascript 真实执行通知脚本（runner 有 GUI 会话则
//      成功；无用户会话报 user interaction is not allowed / -1743 也算
//      预期边界）；AppleScript 语法错误（-2739 等）为 FAIL
//   3. darwin 真跑：afplay 播放系统默认音效文件（无音频设备时边界通过）
//
// 用法：node tests/macos-notify.mjs（非 darwin 只跑第 1 步）
import * as plugin from '../lib/index.js'
const { buildMacNotifyScript } = plugin
import { strict as assert } from 'node:assert'
import { execFileSync } from 'node:child_process'

// ---- 1) 构造器文本断言（任意平台） ----
console.log('--- 1) AppleScript 构造器转义 ----')
const normal = buildMacNotifyScript('标题“完成”', '请检查 \'引号\' 与 C:\\path')
assert.ok(normal.startsWith('display notification "') && normal.includes(' with title "'), '标准结构')
assert.ok(!/""/.test(normal.replace(/\\"/g, '')), '无未转义双引号塌缩')

const evilTitle = 'END" ' + String.fromCharCode(92) + '" inject'
const evil = buildMacNotifyScript(evilTitle, 'BODY"' + String.fromCharCode(92))
// 反斜杠与双引号必须被 AppleScript 转义：字符串字面量不能被提前关闭
const bodyLiteral = normal.slice('display notification '.length)
assert.ok(!bodyLiteral.includes('" '.replace('"', '""')), 'sanity')
assert.ok(evil.includes(String.fromCharCode(92, 92) + String.fromCharCode(92, 34)), '反斜杠+引号成对转义')
console.log('ESCAPE-OK')

if (process.platform !== 'darwin') {
  console.log('SKIP: 非 darwin，osascript/afplay 真跑需 macOS（CI macos-latest 覆盖）')
  console.log('ALL-PASS')
  process.exit(0)
}

// ---- 2) osascript 真跑 ----
console.log('--- 2) osascript 真实执行 ----')
let code = 0
let out = ''
try {
  out = execFileSync('osascript', ['-e', buildMacNotifyScript('dsh-turn-notify CI', '通知脚本验证 🔔')], { encoding: 'utf8', timeout: 15000 }).trim()
} catch (err) {
  code = err.status ?? 1
  out = ((err.stderr ?? '') + ' ' + (err.stdout ?? '')).trim()
}
console.log('exit=' + code + ' out=' + out.slice(0, 160))
if (code === 0) {
  console.log('OSA-EXEC-OK：通知已提交通知中心')
} else {
  assert.ok(
    /user interaction|not allowed|-1743|assistant|用户交互/i.test(out),
    '失败必须是无用户会话边界，而非语法/转义问题',
  )
  console.log('OSA-BOUNDARY-OK：语法全过，仅无交互会话（headless 预期）')
}

// ---- 3) afplay 真跑 ----
console.log('--- 3) afplay 系统音效 ----')
import { existsSync } from 'node:fs'
const wav = '/System/Library/Sounds/Glass.aiff'
assert.ok(existsSync(wav), 'macOS runner 应有 ' + wav)
let scode = 0
let sout = ''
try {
  sout = execFileSync('afplay', [wav], { encoding: 'utf8', timeout: 20000 }).trim()
} catch (err) {
  scode = err.status ?? 1
  sout = ((err.stderr ?? '') + ' ' + (err.stdout ?? '')).trim()
}
console.log('exit=' + scode + ' out=' + sout.slice(0, 160))
if (scode !== 0) {
  assert.ok(/audio|device|sound|CoreAudio/i.test(sout), '失败必须是音频设备边界')
  console.log('AFPLAY-BOUNDARY-OK：无音频设备（headless 预期）')
} else {
  console.log('AFPLAY-EXEC-OK')
}

// ---- 4) terminal-notifier 冒烟（点击跳转的 macOS 通道；未安装则 SKIP） ----
console.log('--- 4) terminal-notifier 点击通道 ----')
try {
  execFileSync('terminal-notifier', ['-title', 'dsh-turn-notify CI', '-message', 'terminal-notifier argv 验证', '-open', 'http://127.0.0.1:3080/#dsh-focus=ci-test', '-group', 'dsh-tn-ci'], { timeout: 15000 })
  console.log('TN-EXEC-OK：terminal-notifier 接受完整 argv（-open 深链已注册）')
} catch (err) {
  const detail = String(err.stderr ?? '') + ' ' + String(err.stdout ?? '') + ' | ' + String(err.message ?? err)
  if (/ENOENT|not found/i.test(detail)) {
    console.log('SKIP: terminal-notifier 未安装（macOS 点击跳转需要它：brew install terminal-notifier）')
  } else if (/no running NotificationCenter instance|Unable to post a notification/i.test(detail)) {
    // argv 已被完全接受并走到提交阶段；失败只是 CI runner 用户没有
    // 运行中的通知中心实例（GUI 会话不随 runner 用户启动）——环境边界
    console.log('TN-BOUNDARY-OK：argv 完整接受，仅无通知中心实例（headless runner 预期）')
  } else {
    assert.fail('terminal-notifier argv 被拒绝: ' + detail.slice(0, 400))
  }
}

console.log('ALL-PASS')
