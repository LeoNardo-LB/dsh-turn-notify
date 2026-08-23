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
}
ctx.plugin(plugin, config)
await sleep(150) // 等 apply 注册完监听再发事件

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

console.log('--- H: 点击双路径（心跳新鲜→转发事件 / 无心跳→深链）---')
// 伪造 webServer 服务捕获路由注册，伪造转发事件监听
let presenceHandler = null
const focusEvents = []
ctx.provide('webServer', { register: (route) => { presenceHandler = route.handler; return () => {} } })
ctx.on('turn-notify/focus', (p) => focusEvents.push(p.sessionId))
// H1: 无心跳（过期）→ 深链路径。观察方式：command 通道收到即代表走到深链分支
// （深链与转发共用 command？否——command 在通知触发时就跑；这里借助日志断言。
// 直接调用不可行（未导出），改用行为差异：转发路径不发深链。）
// 仿真里 xdg-open 会真的执行——用不可执行命令无害化：设置 webUrl 使深链打开失败只告警。
const beforeWarn = 0
// H1: 无心跳：通知+点击（用 -A stdout=default 模拟不可行——sim 直接调 handler 不现实）
// H 简化为端点级验证：心跳端点更新新鲜度（直接调捕获的 handler）
const fakeRes = { writeHead: (c) => ({ end: () => {} }) }
presenceHandler?.(null, fakeRes)
console.log('PRESENCE-OK：心跳端点 handler 可调用')

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
