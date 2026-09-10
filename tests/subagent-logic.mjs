// dsh-turn-notify 子代理对齐逻辑仿真测试（waitForSubagents，无外部依赖）
//
// 对齐目标 = dsh web 会话列表"进行中"的官方判据
// （dsh-client-ui-workspace sessionStatuses + indexSubagentDescendants）：
//   行状态 ongoing ⇔ 本会话 agent 在跑 OR 任一 origin=subagent 后代在跑
//   （沿 parentSession 链向全部祖先记账；fork 有 parentSession 无 origin，
//    不算 subagent，是顶层会话）
// 通知语义据此对齐：根 idle 时子树仍有 subagent 在跑 → 不通知，
// 全部结束（idle 或销毁）才通知。
//
// 场景：
//   S1 根 idle 时后台 subagent 在跑 → 不通知；最后一个结束 → 通知一次（内容取根会话）
//   S2 两个并发 subagent 先后台后：只在最后一个结束时通知
//   S3 嵌套 subagent（孙辈在跑）同样等待——沿链向根记账
//   S4 竞态兜底 a：subagent 已创建（session/created）、状态未观测 → 窗口内转
//      running 继续等，结束后才通知
//   S4b 竞态兜底 b：创建后永不启动 → 窗口耗尽照常通知（迟到不丢）
//   S5 根重新 running 作废挂起（steering/新提问），子代理随后结束不再触发
//   S6 运行中被销毁（interrupt_agent）同样计入子树静默 → 通知
//   S7 waitForSubagents=false 恢复旧行为：根 idle 即通知
//   S8 fork（有 parentSession 无 origin）= 顶层会话，照常通知
//   S9 与 goal 判别复合：subagent 等待 + goal 续跑静默窗口串联生效
// 运行：先 pnpm run build，再 node tests/subagent-logic.mjs
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../lib/index.js'
import { strict as assert } from 'node:assert'
import { writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const OUT = join(tmpdir(), 'dsh-turn-notify-subagent-sim.out')
rmSync(OUT, { force: true })
writeFileSync(OUT, '')

const notifyLines = () => readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean)

const ctx = new Context()
const config = {
  platform: 'linux',
  notifySend: false,
  sound: false,
  bell: false,
  command: 'echo "NOTIFY|{title}|{question}|{sessionId}" >> ' + OUT,
  notifyCommand: '',
  soundCommand: '',
  notifyOnQuestion: false,
  questionTitleTemplate: 'Q|{title}',
  questionBodyTemplate: '新问|{question}',
  questionSoundFile: '',
  appName: 'dsh',
  expireMs: 4000,
  titleTemplate: '{title}',
  bodyTemplate: '问：{question}',
  rootOnly: true,
  skipGoalRounds: true,
  goalQuietMs: 400,
  waitForSubagents: true,
  subagentQuietMs: 250,
  fallbackTitle: 'DSH',
  fallbackMessage: '回复结束',
  questionChars: 40,
  minRunMs: 0,
  presenceTimeoutMs: 15000,
}
ctx.plugin(plugin, config)
await sleep(150) // 等 apply 注册完监听再发事件

// —— 事件工具：会话对象带官方 header 形态（parentSession/origin） ——
const root = { session: { id: 's-root', header: {} } }
const mkChild = (id, parentSession) => ({ session: { id, header: { parentSession, origin: 'subagent' } } })
const status = (agent, s) => ctx.emit('agent/status', { agent, status: s })
const emitUser = (sess, text) => ctx.emit('session/event', sess, {
  type: 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text }] },
})

console.log('--- S1: 后台 subagent 在跑 → 等它结束才通知 ---')
ctx.emit('session/event', root.session, { type: 'session/title', data: { title: 'S1 主会话' } })
emitUser(root.session, '帮我后台调研一下')
const child1 = mkChild('s-child-1', 's-root')
ctx.emit('session/created', child1.session)
status(child1, 'running')
status(root, 'running')
status(root, 'idle') // 子代理在跑 → 不得通知
await sleep(120)
assert.equal(notifyLines().length, 0, 'S1: 根 idle 但 subagent 在跑 → 不得通知')
status(child1, 'idle') // 子树静默 → 通知
await sleep(120)
assert.equal(notifyLines().length, 1, 'S1: 最后一个 subagent 结束 → 恰好 1 次通知')
assert.equal(notifyLines()[0], 'NOTIFY|S1 主会话|问：帮我后台调研一下|s-root', 'S1: 通知内容取根会话（标题+提问），与子代理无关')

console.log('--- S2: 两个并发 subagent，只在最后一个结束时通知 ---')
const child2a = mkChild('s-c2a', 's-root')
const child2b = mkChild('s-c2b', 's-root')
emitUser(root.session, '并发两路任务')
status(child2a, 'running')
status(child2b, 'running')
status(root, 'running')
status(root, 'idle')
await sleep(80)
status(child2a, 'idle') // 还剩 b → 不通知
await sleep(80)
assert.equal(notifyLines().length, 1, 'S2: 第一个 subagent 结束不得通知')
status(child2b, 'idle') // 全静默 → 通知
await sleep(80)
assert.equal(notifyLines().length, 2, 'S2: 最后一个结束 → 1 次通知')

console.log('--- S3: 嵌套 subagent（孙辈在跑）沿链向根记账 ---')
const child3 = mkChild('s-c3', 's-root')
const grand3 = mkChild('s-g3', 's-c3')
status(child3, 'running')
status(grand3, 'running')
status(root, 'running')
status(root, 'idle')
status(child3, 'idle') // 孙辈仍在跑 → 不通知
await sleep(80)
assert.equal(notifyLines().length, 2, 'S3: 孙辈在跑 → 不通知')
status(grand3, 'idle') // 子树全静默 → 通知
await sleep(80)
assert.equal(notifyLines().length, 3, 'S3: 孙辈结束 → 通知')

console.log('--- S4: 竞态兜底 a：已创建未观测 → 窗口内转 running 继续等 ---')
const child4 = mkChild('s-c4', 's-root')
emitUser(root.session, '竞态场景 a')
ctx.emit('session/created', child4.session) // 创建了，但还没跑（状态未观测）
status(root, 'running')
status(root, 'idle') // 后代状态未观测 → 兜底窗口（250ms）
await sleep(80)
assert.equal(notifyLines().length, 3, 'S4a: 兜底窗口内不得通知')
status(child4, 'running') // 窗口内转 running → 继续等（事件驱动）
await sleep(300) // 兜底窗口到期：重评估时 subagent 在跑 → 继续挂起
assert.equal(notifyLines().length, 3, 'S4a: 窗口到期但 subagent 在跑 → 仍不通知')
status(child4, 'idle')
await sleep(80)
assert.equal(notifyLines().length, 4, 'S4a: 子代理结束 → 通知')

console.log('--- S4b: 竞态兜底 b：创建后永不启动 → 窗口耗尽照常通知 ---')
const child4b = mkChild('s-c4b', 's-root')
ctx.emit('session/created', child4b.session)
status(root, 'running')
status(root, 'idle')
await sleep(80)
assert.equal(notifyLines().length, 4, 'S4b: 窗口内不得通知')
await sleep(300) // > 250ms 兜底窗口耗尽
assert.equal(notifyLines().length, 5, 'S4b: 窗口耗尽 → 照常通知（迟到不丢）')
// 真实宿主里从未驱动的子会话会被工具侧 handle.dispose() 销毁——
// session/disposed 后该后代不再触发竞态窗口（否则每轮 idle 都白等）
ctx.emit('session/disposed', child4b.session)

console.log('--- S5: 根重新 running 作废挂起 ---')
const child5 = mkChild('s-c5', 's-root')
status(child5, 'running')
status(root, 'running')
status(root, 'idle') // 挂起等子树静默
status(root, 'running') // 用户 steering / 新提问 → 挂起作废
status(child5, 'idle') // 旧轮的子代理结束 → 不得触发已作废的通知
await sleep(80)
assert.equal(notifyLines().length, 5, 'S5: 作废后的子代理结束不得通知')
status(root, 'idle') // 新轮结束、子树已静默 → 通知
await sleep(80)
assert.equal(notifyLines().length, 6, 'S5: 新轮结束 → 通知')

console.log('--- S6: 运行中销毁（interrupt_agent）计入子树静默 ---')
const child6 = mkChild('s-c6', 's-root')
status(child6, 'running')
status(root, 'running')
status(root, 'idle')
await sleep(50)
ctx.emit('session/disposed', child6.session) // 销毁仍在跑的子代理
await sleep(80)
assert.equal(notifyLines().length, 7, 'S6: 运行中销毁 → 子树静默 → 通知')

console.log('--- S8: fork（有 parentSession 无 origin）= 顶层会话，照常通知 ---')
const forked = { session: { id: 's-fork', header: { parentSession: 's-root' } } } // 无 origin → fork 血缘
status(forked, 'running')
status(forked, 'idle')
await sleep(80)
assert.equal(notifyLines().length, 8, 'S8: fork 会话是顶层会话（官方判据看 origin）→ 通知')

console.log('--- S9: 与 goal 判别复合：subagent 等待 → goal 静默窗口串联 ---')
emitUser(root.session, '复合场景提问')
ctx.emit('goal/changed', { agent: root, change: { operation: 'create', goal: { phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 3 } } })
const child9 = mkChild('s-c9', 's-root')
status(child9, 'running')
status(root, 'running')
status(root, 'idle') // subagent 在跑 + goal armed → 先等子树
await sleep(80)
assert.equal(notifyLines().length, 8, 'S9: subagent 在跑 → 不通知')
status(child9, 'idle') // 子树静默 → goal 判别：将续跑 → 静默窗口（400ms）
await sleep(120)
assert.equal(notifyLines().length, 8, 'S9: goal 静默窗口内不得通知')
await sleep(450) // 窗口耗尽、无人续跑 → 照常通知
assert.equal(notifyLines().length, 9, 'S9: 窗口耗尽 → 通知')

console.log('--- S12: goal 完结轮 + 子树未静默 → 等最后一个 agent，且完结即响（无窗口） ---')
// goal 在最终轮内完结（update_goal complete 先于 turn 结束落账）；
// 该轮结束时后台 subagent 仍在跑 → 继续等；子树静默后 goal 门判
// 「已完结」→ 立即通知（不再进续跑静默窗口）
emitUser(root.session, '完结轮后台任务')
ctx.emit('goal/changed', { agent: root, change: { operation: 'create', goal: { phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 3 } } })
const child12 = mkChild('s-c12', 's-root')
status(child12, 'running')
status(root, 'running')
ctx.emit('goal/changed', { agent: root, change: { operation: 'edit', goal: { phase: 'complete', activation: 'disarmed', roundsStarted: 1, maxGoalRounds: 3 } } })
status(root, 'idle') // goal 已完结但子树在跑 → 不得通知
await sleep(80)
assert.equal(notifyLines().length, 9, 'S12: goal 完结但 subagent 在跑 → 不通知')
status(child12, 'idle') // 子树静默 → goal 已完结 → 立即通知
await sleep(100) // < goalQuietMs(400)：若误进续跑窗口此时尚不会响
assert.equal(notifyLines().length, 10, 'S12: 子树静默 + goal 完结 → 立即通知（不进续跑窗口）')

console.log('--- S7: waitForSubagents=false 恢复旧行为（独立 Context） ---')
const OUT2 = join(tmpdir(), 'dsh-turn-notify-subagent-sim2.out')
rmSync(OUT2, { force: true })
writeFileSync(OUT2, '')
const ctx2 = new Context()
ctx2.plugin(plugin, { ...config, command: 'echo "NOTIFY|{title}|{question}|{sessionId}" >> ' + OUT2, waitForSubagents: false })
await sleep(150)
const root2 = { session: { id: 's-root2', header: {} } }
const child7 = mkChild('s-c7', 's-root2')
status2(child7, 'running')
status2(root2, 'running')
status2(root2, 'idle') // 旧行为：不等子树，立即通知
await sleep(100)
assert.equal(readFileSync(OUT2, 'utf8').trim().split('\n').filter(Boolean).length, 1, 'S7: 关闭对齐 → 根 idle 即通知')
function status2(agent, s) { ctx2.emit('agent/status', { agent, status: s }) }

console.log('--- S10: 现场自举 + 决策点权威重读（对齐 web 基线拉取/重连重拉） ---')
// web 冷启动经 session.list 拿 running 基线（判据 agents.get(id)?.status
// === 'running'）；插件（重）加载时从 agents 注册表自举同一判据，且每次
// settle（唯一不可撤回的决策点）前重读注册表现值修复事件漂移。
// 假注册表是动态的：状态字段随事件推进（模拟一致的宿主真相）
const OUT3 = join(tmpdir(), 'dsh-turn-notify-subagent-sim3.out')
rmSync(OUT3, { force: true })
writeFileSync(OUT3, '')
const ctx3 = new Context()
const root10 = { session: { id: 's-root10', header: {} } }
const child10 = mkChild('s-c10', 's-root10')
const reg10 = {
  root: { session: root10.session, status: 'running' },
  child: { session: child10.session, status: 'running' },
}
const agents10 = [reg10.root, reg10.child]
ctx3.provide('agents', { list: () => agents10 })
ctx3.plugin(plugin, { ...config, command: 'echo "NOTIFY|{title}|{question}|{sessionId}" >> ' + OUT3 })
await sleep(150)
ctx3.emit('session/event', root10.session, { type: 'session/title', data: { title: 'S10 重载' } })
const status3 = (agent, s) => { ctx3.emit('agent/status', { agent, status: s }) }
// 宿主真相先于事件落地（真实宿主 status 字段与 emit 同 tick），假注册表
// 必须同样「先改状态后发事件」，否则决策点重读会读到陈旧 running
const status3c = (reg, agent, s) => { reg.status = s; status3(agent, s) }
status3c(reg10.root, root10, 'idle') // 自举已登记 running 子代理 → 不得通知
await sleep(100)
assert.equal(readFileSync(OUT3, 'utf8').trim().split('\n').filter(Boolean).length, 0, 'S10: 重载后子树存续中 → 不通知')
status3c(reg10.child, child10, 'idle') // 子树静默 → 通知
await sleep(100)
assert.equal(readFileSync(OUT3, 'utf8').trim().split('\n').filter(Boolean).length, 1, 'S10: 子树静默 → 通知')

console.log('--- S11: 决策点漂移修复（事件漏收 idle，注册表重读治愈） ---')
// child11 的 idle 事件被漏收（模拟事件漂移）：挂起等待不会被该事件释放，
// 但下一轮 settle 前的权威重读把运行位修复为注册表现值 → 通知不卡死
const child11 = mkChild('s-c11', 's-root10')
const reg11 = { session: child11.session, status: 'running' }
agents10.push(reg11)
status3c(reg11, child11, 'running')
status3c(reg10.root, root10, 'running')
status3c(reg10.root, root10, 'idle')
await sleep(80)
assert.equal(readFileSync(OUT3, 'utf8').trim().split('\n').filter(Boolean).length, 1, 'S11: 挂起等待中（漂移未愈，事件未到）→ 不通知')
reg11.status = 'idle' // 宿主真相已 idle，但不发事件（漏收）
status3c(reg10.root, root10, 'running') // 用户发起新一轮 → 旧挂起作废
status3c(reg10.root, root10, 'idle') // 新轮结束 → settle 前权威重读治愈漂移 → 通知
await sleep(80)
assert.equal(readFileSync(OUT3, 'utf8').trim().split('\n').filter(Boolean).length, 2, 'S11: 决策点重读修复漂移 → 新轮结束通知不卡死')

console.log('=== 全部子代理对齐用例通过（NOTIFY 总数 ' + notifyLines().length + '）===')
console.log('ALL-PASS')
