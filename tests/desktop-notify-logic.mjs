// dsh-turn-notify 桌面原生通知路由测试（无外部依赖，平台自适应）
//
// 覆盖（design：v0.2.2-dev.16 桌面端原生通知与点击聚焦）：
//   D0 纯函数：isDesktopClient（client 前缀 + Electron UA 兜底）、
//      chooseNotifyChannel、nativeNotifySilent、buildDesktopFocusArgs
//   D1 desktop 在场：{kind:'notify'} 条目经 focus-wait 投递（title/body/
//      silent/sessionId 正确），展示 ack 后平台通道不兜底
//   D2 ack 超时：未回 ack → desktopNotifyAckMs 后平台通道照发（宁重复不丢失）
//   D3 桌面不在场（仅浏览器 waiter）：直接平台通道，浏览器 waiter 不收 notify 条目
//   D4 UA 兜底：client 无前缀但 UA 含 Electron → 仍判 desktop 并投递
//   D5 clicked 回执：广播聚焦（浏览器 waiter 收到 focus 条目）+ 协议激活
//   D6 desktopNotify=off：desktop waiter 在场也走平台通道
//
// 平台自适应：宿主 Windows 用 windows 平台配置（cmd /c 承载 notifyCommand
// 兜底可观测），其余用 linux（/bin/sh）——与旧测试硬编码 platform:'linux'
// 不同，本文件必须在本机 Windows 与 CI 三平台都可跑。
// 运行：先 pnpm run build，再 node tests/desktop-notify-logic.mjs
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { strict as assert } from 'node:assert'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const IS_WIN = process.platform === 'win32'

console.log('--- D0: 纯函数 ---')
assert.equal(plugin.isDesktopClient('desktop:abc', ''), true, 'desktop: 前缀应判 desktop')
assert.equal(plugin.isDesktopClient('abc', 'Mozilla/5.0 (X11) Electron/37.2.6 Chrome/140 Safari/537.36'), true, 'Electron UA 应判 desktop（兜底）')
assert.equal(plugin.isDesktopClient('abc', 'Mozilla/5.0 dsh-desktop/0.2.1 Chrome/140'), true, 'dsh-desktop UA 应判 desktop（兜底）')
assert.equal(plugin.isDesktopClient('abc', 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36'), false, '普通浏览器 UA 不判 desktop')
assert.equal(plugin.isDesktopClient('', 'Mozilla/5.0 Chrome/140'), false, '空 client + 普通 UA 不判 desktop')
assert.equal(plugin.chooseNotifyChannel({ notifySend: true, desktopNotify: 'auto', desktopPresent: true }), 'desktop')
assert.equal(plugin.chooseNotifyChannel({ notifySend: true, desktopNotify: 'auto', desktopPresent: false }), 'platform')
assert.equal(plugin.chooseNotifyChannel({ notifySend: true, desktopNotify: 'off', desktopPresent: true }), 'platform')
assert.equal(plugin.chooseNotifyChannel({ notifySend: false, desktopNotify: 'auto', desktopPresent: true }), 'none', 'notifySend=false 无通知面，两通道都不发')
assert.equal(plugin.nativeNotifySilent({ sound: true, explicitSoundFile: '' }), false, '默认音 → 原生通知带系统音')
assert.equal(plugin.nativeNotifySilent({ sound: false, explicitSoundFile: '' }), true, 'sound=false → 静音')
assert.equal(plugin.nativeNotifySilent({ sound: true, explicitSoundFile: 'C:/x.wav' }), true, '显式音源文件 → 通知静音（宿主另行播文件）')
assert.deepEqual(plugin.buildDesktopFocusArgs('windows'), ['cmd', ['/c', 'start', '', 'dsh://open']])
assert.deepEqual(plugin.buildDesktopFocusArgs('macos'), ['open', ['dsh://open']])
assert.deepEqual(plugin.buildDesktopFocusArgs('linux'), ['xdg-open', ['dsh://open']])
assert.equal(plugin.buildDesktopFocusArgs(undefined), undefined, '未知平台无置前动作')
console.log('PURE-FNS-OK')

/** 独立仿真实例：裸 cordis 上下文 + 伪 webServer（捕获路由 handler）+ 平台通道兜底可观测（notifyCommand 写文件）。 */
let simSeq = 0
async function loadSim(overrides = {}) {
  const id = ++simSeq
  const OUT = join(tmpdir(), 'dsh-turn-notify-desktop-sim-' + id + '.out')
  rmSync(OUT, { force: true })
  writeFileSync(OUT, '')
  const routes = new Map()
  const ctx = new Context()
  ctx.provide('webServer', { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
  const config = {
    platform: IS_WIN ? 'windows' : 'linux',
    notifySend: true,
    sound: false,
    bell: false,
    command: '',
    // 可观测兜底信号：经 runShellCommand（cmd /c 或 /bin/sh -c）执行——
    // 不用引号/竖线（cmd /c 的参数引号剥离会弄坏嵌套引号；路径无空格无需引号）
    notifyCommand: 'echo FALLBACK:{sessionId}>>' + OUT,
    soundCommand: '',
    notifyOnQuestion: false,
    questionTitleTemplate: '{title}',
    questionBodyTemplate: '提问：{question}',
    questionSoundFile: '',
    clickToFocus: true,
    webUrl: 'http://127.0.0.1:3080',
    deepLinkHash: '#dsh-focus=',
    notifyActivateActions: true,
    linuxClickBackend: 'notify-send',
    terminalNotifierPath: 'terminal-notifier',
    windowsClickMode: 'auto',
    balloonWaitMs: 300000,
    windowsToastAumid: 'auto',
    presenceTimeoutMs: 6000,
    appName: 'dsh',
    expireMs: 4000,
    titleTemplate: '{title}',
    bodyTemplate: '问：{question}',
    rootOnly: true,
    skipGoalRounds: true,
    goalQuietMs: 200,
    waitForSubagents: true,
    subagentQuietMs: 100,
    fallbackTitle: 'DSH',
    fallbackMessage: '回复结束',
    questionChars: 40,
    minRunMs: 0,
    desktopNotify: 'auto',
    desktopNotifyAckMs: 400,
    ...overrides,
  }
  ctx.plugin(plugin, config)
  await sleep(150) // 等 apply 经 fiber 注册完监听与路由
  const agent = { session: { id: 'desk-sim-' + id, header: {} } }
  const sess = agent.session
  const fireTurn = (title, question) => {
    ctx.emit('session/event', sess, { type: 'session/title', data: { title } })
    ctx.emit('session/event', sess, { type: 'user/message', data: { source: { kind: 'user' }, content: [{ type: 'text', text: question }] } })
    ctx.emit('agent/status', { agent, status: 'running' })
    ctx.emit('agent/status', { agent, status: 'idle' })
  }
  const makeRes = () => {
    let resolve
    const done = new Promise((r) => { resolve = r })
    const res = {
      code: 0, body: '',
      writeHead(c) { res.code = c; return res },
      end(b) { res.body = String(b ?? ''); resolve(res); return res },
    }
    return { res, done }
  }
  /** 打开一个 focus-wait 长轮询；返回挂起句柄（被唤醒时 resolve）。 */
  const openWaiter = (client, since, headers = {}) => {
    const { res, done } = makeRes()
    const handler = routes.get('/turn-notify/focus-wait')
    assert.ok(typeof handler === 'function', 'focus-wait 路由应已注册')
    void Promise.resolve(handler({ url: '/turn-notify/focus-wait?client=' + client + '&since=' + since, headers }, res)).catch(() => {})
    return { res, done }
  }
  const postJson = async (path, obj) => {
    const handler = routes.get(path)
    assert.ok(typeof handler === 'function', path + ' 路由应已注册')
    const { res, done } = makeRes()
    const chunks = []
    let endFn = null
    let errFn = null
    const emitter = { on(ev, fn) { if (ev === 'data') chunks.push(fn); if (ev === 'end') endFn = fn; if (ev === 'error') errFn = fn; return this } }
    void Promise.resolve(handler(emitter, res)).catch(() => {})
    await sleep(0)
    for (const fn of chunks) fn(Buffer.from(JSON.stringify(obj)))
    endFn?.()
    return await done
  }
  const outLines = () => readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)
  return { routes, fireTurn, openWaiter, postJson, outLines, OUT }
}

const entriesOf = (res) => JSON.parse(res.body || '{"entries":[]}').entries ?? []

console.log('--- D1: desktop 在场 → notify 条目投递 + ack 抑制兜底 ---')
{
  const sim = await loadSim()
  const w = sim.openWaiter('desktop:d1', 0)
  await sleep(80)
  sim.fireTurn('桌面通知标题一', '第一个桌面通知问题')
  const r = await Promise.race([w.done, sleep(3000).then(() => null)])
  assert.ok(r !== null && r.code === 200, 'desktop waiter 应被 notify 条目唤醒')
  const entries = entriesOf(r)
  assert.equal(entries.length, 1, '应恰好投递 1 条 notify 条目')
  const e = entries[0]
  assert.equal(e.kind, 'notify')
  assert.equal(e.sessionId, 'desk-sim-1')
  assert.equal(e.title, '桌面通知标题一')
  assert.equal(e.body, '问：第一个桌面通知问题')
  assert.equal(e.silent, true, 'sound=false → 原生通知静音（配置如此）')
  assert.ok(typeof e.seq === 'number' && e.seq > 0)
  // 展示 ack → 抑制平台兜底
  const ackRes = await sim.postJson('/turn-notify/notify-ack', { seq: e.seq })
  assert.equal(ackRes.code, 204, 'notify-ack 应回 204')
  await sleep(1400) // > 3×desktopNotifyAckMs
  assert.equal(sim.outLines().length, 0, 'ack 已回，平台通道不得兜底（不得双发）')
  // 同一 seq 重复 ack 幂等无害
  await sim.postJson('/turn-notify/notify-ack', { seq: e.seq })
  console.log('DESKTOP-DELIVER-ACK-OK')
  console.log('--- D2: ack 超时 → 平台通道兜底 ---')
  const lastSeq = e.seq
  const w2 = sim.openWaiter('desktop:d1', lastSeq)
  await sleep(80)
  sim.fireTurn('桌面通知标题二', '第二个问题不回 ack')
  const r2 = await Promise.race([w2.done, sleep(3000).then(() => null)])
  assert.ok(r2 !== null, '第二个 notify 条目也应投给 desktop waiter')
  const e2 = entriesOf(r2)[0]
  assert.equal(e2.kind, 'notify')
  assert.equal(e2.title, '桌面通知标题二')
  // 不 ack → desktopNotifyAckMs(400ms) 后兜底；execFile 异步，轮询等 OUT
  let fallbackSeen = false
  for (let i = 0; i < 40; i++) {
    if (sim.outLines().some((l) => l.includes('desk-sim-1'))) { fallbackSeen = true; break }
    await sleep(100)
  }
  assert.ok(fallbackSeen, 'ack 超时后平台通道必须兜底（宁重复不丢失）')
  assert.ok(sim.outLines().length >= 1, '兜底 notifyCommand 应至少执行一次')
  console.log('ACK-TIMEOUT-FALLBACK-OK')
}

console.log('--- D3: 桌面不在场（仅浏览器）→ 直接平台通道 ---')
{
  const sim = await loadSim()
  const w = sim.openWaiter('browser-b1', 0, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/140.0 Safari/537.36' })
  await sleep(80)
  sim.fireTurn('浏览器场景标题', '只有浏览器页面在线')
  let platformSeen = false
  for (let i = 0; i < 30; i++) {
    if (sim.outLines().length > 0) { platformSeen = true; break }
    await sleep(100)
  }
  assert.ok(platformSeen, '桌面不在场应立即走平台通道')
  // 浏览器 waiter 不得被 notify 条目唤醒（条目只投 desktop；本轮没有 desktop）
  const woke = await Promise.race([w.done.then(() => true), sleep(250).then(() => false)])
  assert.equal(woke, false, '浏览器 waiter 不应收到 notify 条目')
  console.log('BROWSER-ONLY-PLATFORM-OK')
}

console.log('--- D4: UA 兜底（client 无前缀 + Electron UA）---')
{
  const sim = await loadSim()
  const w = sim.openWaiter('plain-uuid-1', 0, { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Electron/37.2.6 Chrome/140.0.0.0 Safari/537.36' })
  await sleep(80)
  sim.fireTurn('UA 兜底标题', '无前缀但 UA 是 Electron')
  const r = await Promise.race([w.done, sleep(3000).then(() => null)])
  assert.ok(r !== null, 'Electron UA 的 waiter 应按 desktop 投递收到 notify 条目')
  const e = entriesOf(r)[0]
  assert.equal(e.kind, 'notify')
  assert.equal(e.title, 'UA 兜底标题')
  await sim.postJson('/turn-notify/notify-ack', { seq: e.seq })
  console.log('UA-FALLBACK-OK')
}

console.log('--- D5: clicked 回执 → 广播聚焦 + 协议激活 ---')
{
  const sim = await loadSim()
  const w = sim.openWaiter('browser-b2', 0)
  await sleep(80)
  const clicked = await sim.postJson('/turn-notify/clicked', { sessionId: 'desk-click-target' })
  assert.equal(clicked.code, 204, 'clicked 应回 204')
  const r = await Promise.race([w.done, sleep(2000).then(() => null)])
  assert.ok(r !== null, 'clicked 应广播聚焦唤醒浏览器 waiter')
  const entries = entriesOf(r)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].sessionId, 'desk-click-target')
  assert.equal(entries[0].kind, undefined, '聚焦条目不带 kind（老客户端兼容形态）')
  console.log('CLICKED-BROADCAST-OK（协议激活 spawn 已按平台执行，失败仅 warnOnce）')
}

console.log('--- D6: desktopNotify=off → 桌面在场也走平台通道 ---')
{
  const sim = await loadSim({ desktopNotify: 'off' })
  const w = sim.openWaiter('desktop:off1', 0)
  await sleep(80)
  sim.fireTurn('off 模式标题', '桌面在场但配置 off')
  let platformSeen = false
  for (let i = 0; i < 30; i++) {
    if (sim.outLines().length > 0) { platformSeen = true; break }
    await sleep(100)
  }
  assert.ok(platformSeen, 'off 模式必须走平台通道')
  const woke = await Promise.race([w.done.then(() => true), sleep(250).then(() => false)])
  assert.equal(woke, false, 'off 模式不得投递 notify 条目')
  console.log('OFF-MODE-PLATFORM-OK')
}

console.log('ALL-PASS')
// 显式退出：unref 定时器 + 伪 http 流回放不需要挂着进程
process.exit(0)
