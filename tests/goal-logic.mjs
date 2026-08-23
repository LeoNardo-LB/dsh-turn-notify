// dsh-turn-notify goal 判别逻辑仿真测试（无外部依赖，可移植）
// 裸 cordis 上下文 + 手工事件序列，验证：
//   A goal 续跑抑制 + 完结即响（标题/提问内容正确）
//   B 兜底——看似续跑但没人来，窗口耗尽后照常通知
//   C disarmed（resume 后）→ 立即通知
//   D 模板渲染（titleTemplate/bodyTemplate 占位符）
//   E 提问通知（v0.1.1）：真人提问进入会话即通知（会话标题+提问）
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

const out = readFileSync(OUT, 'utf8').trim()
const lines = out.split('\n').filter(Boolean)
console.log('=== NOTIFY lines (' + lines.length + ') ===')
for (const l of lines) console.log(l)
console.log('=== 断言 ===')
assert.equal(lines.length, 4, '恰好 4 次通知（A 提问1+完结1 + B 兜底1 + C 1）')
assert.equal(lines[0], 'NOTIFY|Q|Goal 抑制测试|新问|请帮我调研 goal 通知的抑制行为，这是仿真提问|sim-session-1', 'E 提问通知内容（会话标题+提问）')
assert.equal(lines[1], 'NOTIFY|[sim-session-1] Goal 抑制测试|问：请帮我调研 goal 通知的抑制行为，这是仿真提问|sim-session-1', 'A/D 轮次结束通知（模板渲染与内容）')
console.log('ALL-PASS')
