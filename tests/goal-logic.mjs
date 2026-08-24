// dsh-turn-notify goal 判别逻辑仿真测试（无外部依赖，可移植）
// 裸 cordis 上下文 + 手工事件序列，验证：
//   A goal 续跑抑制 + 完结即响（标题/提问内容正确）
//   B 兜底——看似续跑但没人来，窗口耗尽后照常通知
//   C disarmed（resume 后）→ 立即通知
//   D 模板渲染（titleTemplate/bodyTemplate 占位符）
//   E 提问通知（v0.1.1）：真人提问进入会话即通知（会话标题+提问）
//   G 子代理（parentSession 有值）不触发任何通知（rootOnly 回归锁）
// 运行：先 pnpm run build，再 node tests/goal-logic.mjs（无需实验 flag）
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { strict as assert } from 'node:assert'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = join(tmpdir(), 'dsh-turn-notify-sim.out')
rmSync(OUT, { force: true })
writeFileSync(OUT, '')

const ctx = new Context()
// 伪造宿主 sessionTitle 服务：模拟恢复会话的日志折叠读（构造种子里的标题
// 不经 session/event 重播，只有服务折叠能读到）
ctx.provide('sessionTitle', { get: (s) => (s.id === 'sim-session-2' ? { title: 'Folded:sim-session-2' } : undefined) })
const config = {
  platform: 'linux',
  notifySend: false,
  sound: false,
  bell: false,
  command: 'echo "NOTIFY|{title}|{question}|{sessionId}" >> ' + OUT,
  notifyCommand: '',
  soundCommand: '',
  notifyOnQuestion: true,
  questionTitleTemplate: 'Q|{title}',
  questionBodyTemplate: '新问|{question}',
  questionSoundFile: '',
  appName: 'dsh',
  expireMs: 4000,
  titleTemplate: '[{sessionId}] {title}',
  bodyTemplate: '问：{question}',
  rootOnly: true,
  skipGoalRounds: true,
  goalQuietMs: 800,
  fallbackTitle: 'DSH',
  fallbackMessage: '回复结束',
  questionChars: 40,
  minRunMs: 0,
  presenceTimeoutMs: 600, // → pollHoldMs=300ms：H2 空轮询挂起时长短且确定
}
// 版本日志（v0.2.2-dev.8+）：每行前缀 [turn-notify v<版本>]——任意一行
// 日志即可识别运行版本。捕获 apply 期间的 loaded 行做断言。
const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const captured = []
const origLog = console.log
console.log = (...a) => { captured.push(a.map(String).join(' ')); origLog(...a) }
ctx.plugin(plugin, config)
// cordis 的 apply 经 fiber 异步执行（探针实测 loaded 行 ~50ms 内打印），
// 捕获窗口必须覆盖等待期——restore 放在 sleep 之后
await sleep(150) // 等 apply 注册完监听再发事件
console.log = origLog
assert.ok(
  captured.some((l) => l.includes('[turn-notify v' + pkgVersion + ']') && l.includes('loaded;')),
  '启动 loaded 行前缀应带插件版本 ' + pkgVersion + '（实际：' + (captured.find((l) => l.includes('loaded')) ?? '(无)') + '）',
)

const agent = { session: { id: 'sim-session-1', header: {} } }
const sess = agent.session
const emitStatus = (status) => ctx.emit('agent/status', { agent, status })
const emitGoal = (operation, goal) => ctx.emit('goal/changed', { agent, change: { operation, goal } })
const emitUser = (text) => ctx.emit('session/event', sess, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

console.log('--- A: goal 续跑抑制 + 完结即响 ---')
// 标题先于提问到达（验证提问通知能展示会话标题；首轮真实场景
// 里标题常在提问后才生成，那时走 fallbackTitle——由 B/C 段覆盖）
ctx.emit('session/event', sess, { type: 'session/title', data: { title: 'Goal 抑制测试' } })
emitUser('请帮我调研 goal 通知的抑制行为，这是仿真提问')
emitGoal('create', { phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 3 })
emitStatus('running')
emitStatus('idle')            // → 应回静默窗口，无 NOTIFY
await sleep(300)
emitStatus('running')          // 续跑到来 → 取消窗口
emitGoal('edit', { phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 3 })
emitStatus('idle')            // 又进窗口
await sleep(300)              // 窗口内没有 running…
emitGoal('complete', { phase: 'complete', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 3 })
emitStatus('idle')            // 完结 → 立即 NOTIFY
await sleep(100)

console.log('--- B: 兜底——看似续跑但没人来，窗口耗尽后照常通知 ---')
emitGoal('edit', { phase: 'active', activation: 'armed', roundsStarted: 2, maxGoalRounds: 3 })
emitStatus('idle')
await sleep(1200)             // > 800ms 兜底 → NOTIFY

console.log('--- C: disarmed（resume 后）→ 立即通知 ---')
emitGoal('edit', { phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 3 })
emitStatus('idle')
await sleep(100)

console.log('--- G: 子代理不通知（rootOnly）---')
const beforeG = readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).length
const childAgent = { session: { id: 'sim-child-1', header: { parentSession: 'sim-session-1' } } }
// 子会话里的用户消息（理论上不会有，防御性验证）与 idle 都不得产生通知
ctx.emit('session/event', childAgent.session, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '子代理内部消息' }] },
})
ctx.emit('agent/status', { agent: childAgent, status: 'running' })
ctx.emit('agent/status', { agent: childAgent, status: 'idle' })
await sleep(100)
const afterG = readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).length
assert.equal(afterG, beforeG, '子代理的轮次结束与提问都不得触发通知')
console.log('SUBAGENT-FILTERED-OK（通知数不变：' + beforeG + ' → ' + afterG + '）')

console.log('--- H: 聚焦通道（focus-wait 长轮询 + focus 广播入队）---')
// 伪造 webServer 服务捕获两条路由的 handler，在 HTTP 语义层驱动：
//   H1 GET focus-wait 挂起期间 POST focus → 挂起请求被唤醒并带回条目
//   H2 GET focus-wait 无新条目 → 挂起至 pollHoldMs 后空返回（config.presenceTimeoutMs=600 → hold=300ms）
const routes = new Map()
ctx.provide('webServer', { register: (route) => { routes.set(route.path, route.handler); return () => routes.delete(route.path) } })
await sleep(50)
const waitHandler = routes.get('/turn-notify/focus-wait')
const postHandler = routes.get('/turn-notify/focus')
assert.ok(typeof waitHandler === 'function', 'focus-wait 路由应已注册')
assert.ok(typeof postHandler === 'function', 'focus 路由应已注册')

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
// H1: 挂起 → 唤醒
const h1 = makeRes()
let h1result = null
const h1p = Promise.resolve(waitHandler({ url: '/turn-notify/focus-wait?client=t1&since=0' }, h1.res)).then(() => h1.done).then((r) => { h1result = r })
await sleep(120)
assert.equal(h1result, null, '无新条目时 focus-wait 必须挂起（长轮询），不得立即返回')
const bodyChunks = []
const bodyEmitter = {
  on(ev, fn) { if (ev === 'data') bodyChunks.push(fn); if (ev === 'end') this._end = fn; if (ev === 'error') this._err = fn; return this },
  _end: null, _err: null, _dataFns: null,
}
// 直接以 data/end 事件回放 JSON body（模拟 http 流）
const postRes = makeRes()
const postP = Promise.resolve(postHandler(bodyEmitter, postRes.res))
await sleep(0)
for (const fn of bodyChunks) fn(Buffer.from(JSON.stringify({ sessionId: 'sim-focus-1' })))
bodyEmitter._end()
await postP
await postRes.done
assert.equal(postRes.res.code, 204, 'POST focus 应回 204')
await h1p
assert.ok(h1result !== null && h1result.code === 200, '唤醒后 focus-wait 应回 200')
const payload = JSON.parse(h1result.body)
assert.equal(payload.entries.length, 1, '唤醒应带回恰好 1 条聚焦条目')
assert.equal(payload.entries[0].sessionId, 'sim-focus-1', '聚焦条目应含正确 sessionId')
assert.ok(typeof payload.entries[0].seq === 'number' && payload.entries[0].seq > 0, '条目应带递增 seq')
console.log('FOCUS-WAKE-OK：挂起被 POST 唤醒并带回条目')
// H2: 无新条目 → 挂起至超时空返回（keepAlive 保事件循环：hold 定时器是 unref 的，
// 真实进程有 http server 常驻、测试进程需要自持）
const keepAlive = setInterval(() => {}, 1000)
const h2 = makeRes()
const h2p = Promise.resolve(waitHandler({ url: '/turn-notify/focus-wait?client=t1&since=' + payload.entries[0].seq }, h2.res)).then(() => h2.done)
const t0 = Date.now()
const h2result = await Promise.race([h2p, sleep(5000).then(() => { throw new Error('focus-wait 空轮询超时未返回') })])
clearInterval(keepAlive)
assert.ok(Date.now() - t0 >= 400, '空轮询应挂起至少 pollHoldMs-余量（实际 ' + (Date.now() - t0) + 'ms）')
assert.equal(h2result.code, 200, '超时空返回也是 200')
assert.equal(JSON.parse(h2result.body).entries.length, 0, '空返回应无条目')
console.log('FOCUS-HOLD-OK：空轮询挂起 ' + (Date.now() - t0) + 'ms 后空返回')

// H3: balloon 点击回调端点 POST /turn-notify/click
const clickHandler = routes.get('/turn-notify/click')
assert.ok(typeof clickHandler === 'function', 'click 路由应已注册')
const postJson = (handler, obj) => {
  const { res, done } = makeRes()
  const chunks = []
  let endFn = null
  let errFn = null
  const emitter = { on(ev, fn) { if (ev === 'data') chunks.push(fn); if (ev === 'end') endFn = fn; if (ev === 'error') errFn = fn; return this } }
  const p = Promise.resolve(handler(emitter, res))
  return (async () => {
    await sleep(0)
    for (const fn of chunks) fn(Buffer.from(JSON.stringify(obj)))
    if (endFn) endFn()
    await p
    return await done
  })()
}
// 在线判定为瞬时真值（当下是否有挂起的 focus-wait）——与时间窗无关
const click1 = await postJson(clickHandler, { sessionId: 'sim-click-1' })
assert.equal(click1.code, 200, 'click 应回 200')
assert.equal(JSON.parse(click1.body).open, true, '无挂起 wait 时 open=true（调用方需深链开浏览器）')
// 挂起 wait（页面在线）→ open:false 且入队（wait 立即唤醒带回条目）
// since 用当前已入队最大 seq（H1 的 1 + click1 的 2）：既无待取条目可挂起，
// 唤醒过滤（seq > since）也能带回 click 的新条目
const keepAlive3 = setInterval(() => {}, 1000)
const h3 = makeRes()
void Promise.resolve(waitHandler({ url: '/turn-notify/focus-wait?client=t2&since=2' }, h3.res)).then(() => h3.done)
await sleep(150)
const click2 = await postJson(clickHandler, { sessionId: 'sim-click-2' })
assert.equal(JSON.parse(click2.body).open, false, '页面在线（挂起 wait）时 open=false（已开页面原地切换，零新标签页）')
const h3result = await Promise.race([h3.done, sleep(3000).then(() => null)])
clearInterval(keepAlive3)
assert.ok(h3result !== null, 'click 入队应唤醒挂起的 wait')
const clickEntries = JSON.parse(h3result.body).entries
assert.ok(clickEntries.some((e) => e.sessionId === 'sim-click-2'), '唤醒条目应含 click 的会话')
// 回归锁（#1 真机反馈）：页面刚关闭（presence 时间窗内仍“新鲜”，但已无
// 挂起 wait）→ 必须 open:true——旧的时间窗判定在此误判 open:false，
// 导致点击无任何效果（既不开浏览器、页面也不存在）
const clickStale = await postJson(clickHandler, { sessionId: 'sim-click-stale' })
assert.equal(JSON.parse(clickStale.body).open, true, 'presence 新鲜但无挂起 wait → open:true（瞬时真值，防死点击）')
// 非法 body → open:true 兜底
const click3 = await postJson(clickHandler, {})
assert.equal(JSON.parse(click3.body).open, true, '非法 body open=true 兜底（调用方开深链）')
console.log('CLICK-ROUTE-OK：在线 open=false 入队唤醒 / 离线 open=true / 非法兜底')

console.log('--- F: 恢复会话标题读穿（服务折叠兜底）---')
const agent2 = { session: { id: 'sim-session-2', header: {} } }
const sess2 = agent2.session
// 不发任何 session/title 事件（模拟恢复：标题只在历史种子里）
ctx.emit('session/event', sess2, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二个会话提问' }] },
})
ctx.emit('agent/status', { agent: agent2, status: 'idle' })
await sleep(100)

const out = readFileSync(OUT, 'utf8').trim()
const lines = out.split('\n').filter(Boolean)
console.log('=== NOTIFY lines (' + lines.length + ') ===')
for (const l of lines) console.log(l)
console.log('=== 断言 ===')
assert.equal(lines.length, 6, '恰好 6 次通知（A 提问1+完结1 + B 兜底1 + C 1 + F 提问1+完结1）')
assert.equal(lines[0], 'NOTIFY|Q|Goal 抑制测试|新问|请帮我调研 goal 通知的抑制行为，这是仿真提问|sim-session-1', 'E 提问通知内容（会话标题+提问）')
assert.equal(lines[1], 'NOTIFY|[sim-session-1] Goal 抑制测试|问：请帮我调研 goal 通知的抑制行为，这是仿真提问|sim-session-1', 'A/D 轮次结束通知（模板渲染与内容）')
assert.equal(lines[4], 'NOTIFY|Q|Folded:sim-session-2|新问|第二个会话提问|sim-session-2', 'F 提问通知标题来自服务折叠（恢复会话）')
assert.equal(lines[5], 'NOTIFY|[sim-session-2] Folded:sim-session-2|问：第二个会话提问|sim-session-2', 'F 轮次结束通知标题来自服务折叠')
console.log('ALL-PASS')
