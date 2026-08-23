/**
 * dsh-turn-notify — 轮次通知插件（DSH bundle）· v0.1.1
 *
 * 两类通知：
 *   A 提问通知：真人提问进入会话时立即响（内容 = 会话标题 + 提问文本；
 *     steering 插话同样触发；goal 注入/合成上下文不触发）
 *   B 轮次结束通知：只在 agent 真正停下来等用户输入时响（goal 自动
 *     续跑轮静默）
 * 跨平台桌面通知 + 提示音 + 终端响铃 + 自定义命令。
 *
 * 平台后端（platform: auto 按宿主 OS 选择，可显式指定）：
 *   linux   notify-send 桌面通知 / paplay 提示音；自定义命令经 /bin/sh -c
 *   macos   osascript 桌面通知 / afplay 提示音；自定义命令经 /bin/sh -c
 *   windows PowerShell + WinRT Toast 桌面通知 / SoundPlayer 提示音；
 *           自定义命令经 cmd /c
 * Windows 通知脚本经 -EncodedCommand（UTF-16LE base64）投递，规避一切
 * 引号转义问题，零第三方依赖；AppUserModelId 借用系统 PowerShell
 * 自身的 AUMID（保证 toast 在 Win10/11 通知中心可靠显示）。
 *
 * 何时通知（goal 判别）：
 *   监听 agent/status 的 running→idle，但 idle 不一定等于"等用户"——
 *   goal 自动续跑（dsh-goal-round-driver）恰恰是在 idle 时注入下一轮
 *   <goal_round> 提示让 agent 重新 running。判别：
 *   1. 追踪每个会话的 goal 状态（live 事件 goal/changed，完整 GoalView）。
 *      "会自动续跑" = phase active 且 activation armed 且轮次未到上限。
 *   2. idle 时若判定会续跑 → 不立即通知，进入 goalQuietMs 兜底窗口；
 *      窗口内重新 running → 取消通知；窗口耗尽仍空闲 → 照常通知
 *      （判定失误的兜底，通知只会迟到不会丢）。
 *   3. 其余情况——无 goal、goal 完结(complete)/暂停(paused)/受阻
 *      (blocked)、disarmed（resume 后等用户说继续）、轮次到上限——
 *      都是真停，立即通知。
 *   注：重启/resume 后的 active goal 一律 disarmed（不自动续跑），
 *   与 live 事件追踪的可见范围一致，无需回放 durable 日志。
 *
 * 通知内容（模板化，占位符 {title} {question} {sessionId}）：
 *   标题 = titleTemplate 渲染（默认 '{title}'：会话标题，首轮可能
 *         未生成，退回 fallbackTitle）
 *   正文 = bodyTemplate 渲染（默认 '{question}'：本轮用户提问的前
 *         questionChars 字，只认真人输入 source.kind === 'user'；
 *         goal 续跑消息 kind === 'goal' 不污染提问文本）
 *
 * 配置覆盖（后者胜）：Schema 默认值 → profile 组合层（id: turn-notify
 * 整行替换，需重启）→ ~/.dsh/settings.yaml 顶层 turn-notify: 段（热生效）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import Schema from '@deepseek-ai/schemastery'

export const name = 'turn-notify'
export const inject = []

export type PlatformChoice = 'auto' | 'linux' | 'macos' | 'windows'
type Platform = 'linux' | 'macos' | 'windows'

export interface Config {
  platform: PlatformChoice
  notifySend: boolean
  sound: boolean
  soundFile: string
  bell: boolean
  command: string
  notifyCommand: string
  soundCommand: string
  notifyOnQuestion: boolean
  questionTitleTemplate: string
  questionBodyTemplate: string
  questionSoundFile: string
  appName: string
  expireMs: number
  titleTemplate: string
  bodyTemplate: string
  rootOnly: boolean
  skipGoalRounds: boolean
  goalQuietMs: number
  fallbackTitle: string
  fallbackMessage: string
  questionChars: number
  minRunMs: number
}

export const Config: Schema<Config> = Schema.object({
  platform: Schema.union([
    Schema.const('auto' as PlatformChoice).description('按宿主 OS 自动选择'),
    Schema.const('linux' as PlatformChoice).description('notify-send + paplay'),
    Schema.const('macos' as PlatformChoice).description('osascript + afplay'),
    Schema.const('windows' as PlatformChoice).description('PowerShell toast + SoundPlayer'),
  ]).default('auto').description('平台后端选择'),
  notifySend: Schema.boolean().default(true).description('桌面通知（按平台后端投递）'),
  sound: Schema.boolean().default(true).description('提示音（按平台后端投递）'),
  soundFile: Schema.string().default('').description('提示音文件路径；留空 = 平台默认（linux freedesktop bell.oga / macos Glass.aiff / windows Windows Notify.wav）'),
  bell: Schema.boolean().default(false).description('向宿主 stdout 写 ASCII BEL（终端/SSH 场景）'),
  command: Schema.string().default('').description('通知触发时的自定义命令，占位符 {sessionId} {title} {question}；留空关闭'),
  notifyCommand: Schema.string().default('').description('完全接管桌面通知的命令模板（高级；同上占位符）；留空用平台后端'),
  soundCommand: Schema.string().default('').description('完全接管提示音的命令模板（高级；同上占位符）；留空用平台后端'),
  notifyOnQuestion: Schema.boolean().default(true).description('真人提问进入会话时也通知（提示音 + 桌面通知，内容 = 会话标题 + 提问；steering 插话同样触发，goal 注入/合成上下文不触发）'),
  questionTitleTemplate: Schema.string().default('{title}').description('提问通知标题模板，占位符 {title} {question} {sessionId}'),
  questionBodyTemplate: Schema.string().default('提问：{question}').description('提问通知正文模板，占位符同上'),
  questionSoundFile: Schema.string().default('').description('提问提示音文件；留空 = 与轮次结束共用 soundFile / 平台默认'),
  appName: Schema.string().default('dsh').description('应用名（linux notify-send -a / 通知归属显示）'),
  expireMs: Schema.number().default(4000).description('桌面通知超时毫秒数（linux -t；macos/win 不支持则忽略）'),
  titleTemplate: Schema.string().default('{title}').description('通知标题模板，占位符 {title} {question} {sessionId}'),
  bodyTemplate: Schema.string().default('{question}').description('通知正文模板，占位符同上'),
  rootOnly: Schema.boolean().default(true).description('只通知根会话（跳过子代理/后台任务）'),
  skipGoalRounds: Schema.boolean().default(true).description('goal 自动续跑的轮次结束不通知；goal 完结/暂停/受阻、真正停下等用户输入时才响'),
  goalQuietMs: Schema.number().default(3000).description('goal 看似会续跑时的兜底等待窗口：期间重新 running 则取消通知，耗尽仍空闲则照常通知'),
  fallbackTitle: Schema.string().default('DSH').description('无会话标题时的通知标题兜底'),
  fallbackMessage: Schema.string().default('回复结束（agent 已空闲）').description('未捕获到用户提问时的正文兜底'),
  questionChars: Schema.number().default(80).description('正文 = 本轮用户提问的前 N 个字符；0 = 不含提问、正文退回 fallbackMessage'),
  minRunMs: Schema.number().default(0).description('运行不足该毫秒数的轮次不通知'),
})

/** 平台默认提示音文件。 */
const DEFAULT_SOUND: Record<Platform, string> = {
  linux: '/usr/share/sounds/freedesktop/stereo/bell.oga',
  macos: '/System/Library/Sounds/Glass.aiff',
  windows: 'C:\\Windows\\Media\\Windows Notify.wav',
}

/** Windows toast 借用的系统 PowerShell AUMID（保证通知中心可靠显示）。 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/** 宿主 sessionTitle 服务的最小读取面（可选服务，未挂载时 ctx.get 返回 undefined）。 */
interface TitleServiceLike {
  get(session: unknown): { title?: unknown } | undefined
}

/** 每个 session 的标题 + 最近一条真人提问。 */
interface SessionInfo {
  title?: string
  question?: string
}

/**
 * live goal/changed 的最小结构（GoalView 子集 + clear tombstone）。
 * 'goal/changed' 的类型声明在宿主侧 @deepseek-ai/dsh-goal（其类型依赖
 * 未全部发布到 registry，本包不引入）；此处按运行时字段收窄。
 */
interface GoalChangedPayload {
  agent: { session: { id: unknown } }
  change: {
    operation: string
    goal?: {
      phase: string
      activation: string
      roundsStarted: number
      maxGoalRounds: number
    }
  }
}

/** 定向收窄：宿主侧 ambient 事件不在本包类型程序内。 */
type OnGoalChanged = (name: 'goal/changed', listener: (payload: GoalChangedPayload) => void) => unknown

/** 从 user/message 的 content 块里拼接纯文本（只认 type === 'text'）。 */
function extractText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  let out = ''
  for (const block of content) {
    if (block !== null && typeof block === 'object') {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
    }
  }
  // 折叠换行与连续空白，通知正文保持单行
  return out.replace(/\s+/g, ' ').trim()
}

/** 按 Unicode 码点安全截前 n 字，超出补省略号。 */
function truncate(s: string, n: number): string {
  const chars = Array.from(s)
  if (chars.length <= n) return s
  return chars.slice(0, n).join('') + '…'
}

/** 模板渲染：{title} {question} {sessionId} 占位符替换。 */
function render(tpl: string, vars: { title: string; question: string; sessionId: string }): string {
  return tpl
    .replaceAll('{title}', vars.title)
    .replaceAll('{question}', vars.question)
    .replaceAll('{sessionId}', vars.sessionId)
}

/** fire-and-forget 子进程：失败只经 onFail 上报，永不抛出。 */
function run(cmd: string, args: string[], onFail: (msg: string) => void): void {
  execFile(cmd, args, { timeout: 10_000 }, (err) => {
    if (err) onFail(err.message ?? String(err))
  })
}

/** AppleScript 字符串字面量（osascript -e 用）。 */
function appleString(s: string): string {
  return '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
}

/** XML 文本节点转义（Windows toast 模板用）。 */
function xmlEscape(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/** PowerShell 单引号字面量（'' 转义内嵌单引号）。 */
function psSingle(s: string): string {
  return "'" + s.replaceAll("'", "''") + "'"
}

/** Windows toast 显示脚本（导出供测试在真实 PowerShell 下直接验证）。 */
export function buildToastScript(title: string, body: string): string {
  const xml = '<toast><visual><binding template="ToastText02"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(body) + '</text></binding></visual></toast>'
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    "$xml.LoadXml(" + psSingle(xml) + ")",
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + POWERSHELL_AUMID + "').Show($toast)",
  ].join('\n')
}

/** Windows 提示音脚本（导出供测试验证）。 */
export function buildSoundScript(file: string): string {
  return '(New-Object Media.SoundPlayer ' + psSingle(file) + ').PlaySync()'
}

/** -EncodedCommand 编码（UTF-16LE base64）。 */
export function encodePs(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function detectPlatform(choice: PlatformChoice): Platform | undefined {
  if (choice === 'linux' || choice === 'macos' || choice === 'windows') return choice
  if (process.platform === 'linux') return 'linux'
  if (process.platform === 'darwin') return 'macos'
  if (process.platform === 'win32') return 'windows'
  return undefined
}

/** 在平台 shell 里执行命令模板。 */
function runShellCommand(platform: Platform | undefined, cmd: string, onFail: (m: string) => void): void {
  const shell = platform === 'windows' ? 'cmd' : '/bin/sh'
  const flag = platform === 'windows' ? '/c' : '-c'
  run(shell, [flag, cmd], onFail)
}

export function apply(ctx: Context, config: Config) {
  const platform = detectPlatform(config.platform)
  const log = (...a: unknown[]) => console.log('[turn-notify]', ...a)
  const failedOnce = new Set<string>()
  const warnOnce = (channel: string, msg: string) => {
    if (failedOnce.has(channel)) return
    failedOnce.add(channel)
    log('channel "' + channel + '" failed (只警告一次):', msg)
  }

  /** fire-and-forget 桌面通知（按平台分发；notifyCommand 可完全接管）。 */
  const sendDesktop = (title: string, body: string, vars: { title: string; question: string; sessionId: string }): void => {
    if (config.notifyCommand) {
      runShellCommand(platform, render(config.notifyCommand, vars), (m) => warnOnce('notify-command', m))
      return
    }
    if (platform === 'linux') {
      run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m))
    } else if (platform === 'macos') {
      const script = 'display notification ' + appleString(body) + ' with title ' + appleString(title)
      run('osascript', ['-e', script], (m) => warnOnce('osascript', m))
    } else if (platform === 'windows') {
      run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body))], (m) => warnOnce('windows-toast', m))
    } else {
      warnOnce('platform', '未知平台（process.platform=' + process.platform + '），只有 bell/command 通道可用')
    }
  }

  /** fire-and-forget 提示音（按平台分发；soundCommand 可完全接管）。 */
  const sendSound = (vars: { title: string; question: string; sessionId: string }, fileOverride = ''): void => {
    if (config.soundCommand) {
      runShellCommand(platform, render(config.soundCommand, vars), (m) => warnOnce('sound-command', m))
      return
    }
    const file = fileOverride !== '' ? fileOverride : config.soundFile !== '' ? config.soundFile : platform !== undefined ? DEFAULT_SOUND[platform] : ''
    if (file === '' || !existsSync(file)) {
      warnOnce('sound', '提示音文件不存在: ' + (file === '' ? '(无平台默认)' : file))
      return
    }
    if (platform === 'linux') {
      run('paplay', [file], (m) => warnOnce('paplay', m))
    } else if (platform === 'macos') {
      run('afplay', [file], (m) => warnOnce('afplay', m))
    } else if (platform === 'windows') {
      run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildSoundScript(file))], (m) => warnOnce('windows-sound', m))
    }
  }

  const info = new Map<string, SessionInfo>()
  const getInfo = (id: string): SessionInfo => {
    let v = info.get(id)
    if (v === undefined) {
      v = {}
      info.set(id, v)
    }
    return v
  }

  /**
   * 解析会话标题（三级回退）：live 追踪 → 宿主 sessionTitle 服务折叠 → undefined。
   * 服务折叠覆盖 resume 场景：重启后既有会话的历史标题事件是构造种子，
   * 不会经 session/event 重播（live 追踪看不到），但日志折叠读得到。
   */
  const resolveTitle = (session: unknown, sessionId: string): string | undefined => {
    const live = info.get(sessionId)?.title
    if (live !== undefined && live.length > 0) return live
    const svc = (ctx as unknown as { get(name: string): unknown }).get('sessionTitle') as TitleServiceLike | undefined
    const folded = svc?.get(session)?.title
    return typeof folded === 'string' && folded.length > 0 ? folded : undefined
  }

  /** 该会话的 goal 是否会自动续跑（live goal/changed 维护）。 */
  const goalWillContinue = new Map<string, boolean>()
  /** 兜底窗口中的定时器（续跑兜底：窗口耗尽仍未 running 则通知）。 */
  const pendingQuiet = new Map<string, ReturnType<typeof setTimeout>>()

  const cancelQuiet = (sessionId: string): void => {
    const t = pendingQuiet.get(sessionId)
    if (t !== undefined) {
      clearTimeout(t)
      pendingQuiet.delete(sessionId)
    }
  }

  // 会话事实追踪：标题快照（latest-wins）+ 最近一条真人提问。
  ctx.on('session/event', (session: { id: unknown; header?: { parentSession?: unknown } }, event: { type: string; data: unknown }) => {
    const sessionId = String(session.id)
    if (event.type === 'session/title') { // live 快路径；resume 场景由 resolveTitle 的服务折叠兜底
      const data = event.data as { title?: unknown }
      if (typeof data.title === 'string' && data.title.length > 0) {
        getInfo(sessionId).title = data.title
      }
    } else if (event.type === 'user/message') {
      const data = event.data as { source?: { kind?: unknown }; content?: unknown }
      if (data === null || data.source?.kind !== 'user') return
      const q = extractText(data.content)
      if (q.length === 0) return
      getInfo(sessionId).question = q
      // 提问通知（v0.1.1）：真人提问进入会话时立即提示——内容 = 会话标题
      // + 提问文本。steering 插话同样触发；goal 续跑（kind 'goal'）与
      // 注入上下文（kind 'plugin'）已被上面的 source 过滤排除。
      if (!config.notifyOnQuestion) return
      if (config.rootOnly && session.header?.parentSession !== undefined) return
      const rawTitle = resolveTitle(session, sessionId) ?? config.fallbackTitle
      const rawBody = config.questionChars > 0 ? truncate(q, config.questionChars) : config.fallbackMessage
      const vars = { title: rawTitle, question: rawBody, sessionId }
      const title = render(config.questionTitleTemplate, vars)
      const body = render(config.questionBodyTemplate, vars)
      const finalVars = { title, question: body, sessionId }
      log('user question → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId)
      if (config.notifySend) sendDesktop(title, body, finalVars)
      if (config.sound) sendSound(finalVars, config.questionSoundFile)
      if (config.bell) process.stdout.write('\x07')
      if (config.command) runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m))
    }
  })

  // goal 状态追踪：判定 idle 是"等用户"还是"马上续跑"。
  ;(ctx.on as OnGoalChanged)('goal/changed', ({ agent, change }) => {
    const sessionId = String(agent.session.id)
    const g = change.goal
    const willContinue =
      g !== undefined &&
      g.phase === 'active' &&
      g.activation === 'armed' &&
      g.roundsStarted < g.maxGoalRounds
    goalWillContinue.set(sessionId, willContinue)
  })

  ctx.on('session/disposed', (session: { id: unknown }) => {
    const sessionId = String(session.id)
    cancelQuiet(sessionId)
    goalWillContinue.delete(sessionId)
    info.delete(sessionId)
  })

  /** 每个 agent 的 running 起始时刻，用于 minRunMs 过滤。 */
  const runningSince = new Map<string, number>()

  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: 'idle' | 'running' }) => {
    const session = agent.session
    const sessionId = String(session.id)
    const isRoot = session.header.parentSession === undefined

    if (status === 'running') {
      cancelQuiet(sessionId) // 续跑（或其他输入）到来，取消兜底通知
      runningSince.set(sessionId, Date.now())
      return
    }
    if (status !== 'idle') return

    const started = runningSince.get(sessionId)
    runningSince.delete(sessionId)
    if (config.rootOnly && !isRoot) return
    if (started !== undefined && Date.now() - started < config.minRunMs) return

    const notify = (): void => {
      // 立即通知路径可能撞上仍在计时的静默窗口定时器：先取消，
      // 否则定时器到点会再 fire 一次（双通知）。
      cancelQuiet(sessionId)
      const s = info.get(sessionId)
      const rawTitle = resolveTitle(session, sessionId) ?? config.fallbackTitle
      const rawBody =
        config.questionChars > 0 && s?.question !== undefined && s.question.length > 0
          ? truncate(s.question, config.questionChars)
          : config.fallbackMessage
      const vars = { title: rawTitle, question: rawBody, sessionId }
      const title = render(config.titleTemplate, vars)
      const body = render(config.bodyTemplate, vars)
      // 命令类通道的占位符注入最终渲染值（与桌面通知显示一致）
      const finalVars = { title, question: body, sessionId }

      log('agent idle → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId, 'root=' + isRoot)

      if (config.notifySend) sendDesktop(title, body, finalVars)
      if (config.sound) sendSound(finalVars)
      if (config.bell) process.stdout.write('\x07')
      if (config.command) runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m))
    }

    // goal 看似还会自动续跑 → 先不响，进兜底窗口等它重新 running。
    if (config.skipGoalRounds && goalWillContinue.get(sessionId) === true) {
      log('idle 但 goal 将续跑 → 进入 ' + config.goalQuietMs + 'ms 静默窗口', 'session=' + sessionId)
      cancelQuiet(sessionId)
      const t = setTimeout(notify, config.goalQuietMs)
      if (typeof t === 'object' && t !== null && 'unref' in t) {
        ;(t as { unref(): void }).unref() // 不阻止进程退出（一次性任务场景）
      }
      pendingQuiet.set(sessionId, t)
      return
    }

    notify()
  })

  log('loaded; v0.1.1 platform=' + (platform ?? 'unknown(' + process.platform + ')'), 'channels:', JSON.stringify({
    notifySend: config.notifySend, sound: config.sound, bell: config.bell,
    command: config.command ? '(custom)' : '(off)', rootOnly: config.rootOnly,
    questionChars: config.questionChars, skipGoalRounds: config.skipGoalRounds,
    goalQuietMs: config.goalQuietMs,
  }))

  ctx.effect(() => () => {
    for (const sessionId of pendingQuiet.keys()) cancelQuiet(sessionId)
    log('disposed')
  })
}
