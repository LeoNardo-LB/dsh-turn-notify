/**
 * dsh-turn-notify — 轮次通知插件（DSH bundle）
 *
 * 两类通知：
 *   A 提问通知（默认关，notifyOnQuestion 开启）：真人提问进入会话时
 *     立即响（内容 = 会话标题 + 提问文本；steering 插话同样触发；
 *     goal 注入/合成上下文不触发）。自己发的消息无需提醒，故默认关——
 *     供远程发送、桌面确认送达的场景 opt-in
 *   B 轮次结束通知：只在 agent 真正停下来等用户输入时响（goal 自动
 *     续跑轮静默）
 * 跨平台桌面通知 + 提示音 + 终端响铃 + 自定义命令。
 *
 * 点击通知卡片 → 回到对应会话：
 *   聚焦通道（本插件经 webServer 服务注册）：GET /turn-notify/focus-wait
 *   长轮询（web 页面打开期间保持一个挂起请求，到达即记为页面在线
 *   presence）+ POST /turn-notify/focus（深链落地页广播聚焦，让其它已开
 *   标签页同步切换）+ POST /turn-notify/click（balloon 点击回调入口：
 *   入队聚焦 + 告知回调方是否需要深链开浏览器）。
 *   Linux notify-send -A / Windows NotifyIcon balloon 都把点击回调进
 *   我们自己的进程：页面在线 → 点击入队，已开页面零浏览器启动、零新
 *   标签页直接切换；离线 → OS 深链新开浏览器（Windows 由 balloon 的
 *   PowerShell 进程 Start-Process，Linux xdg-open）。
 *   Windows balloon（shell 把 BalloonTip 提升为 toast 显示，点击路由回
 *   NotifyIcon——Win10/11 兼容行为）是 windowsClickMode=auto 的默认路径；
 *   'toast' 模式保留 protocol launch（点击=系统用浏览器打开深链，浏览器
 *   已开时平台行为是新开标签页）。macOS terminal-notifier -open 同 toast
 *   模式语义。
 *
 * Windows 音效（单音源原则，默认 = 系统通知音）：
 *   默认（soundFile 留空）用通知自带的系统通知音，不再叠 SoundPlayer；
 *   显式配置 soundFile 时才静音通知 + SoundPlayer 播自定义文件；
 *   sound=false 全静音；notifySend=false（无通知面承载系统音）时
 *   SoundPlayer 退回平台默认 wav。
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
 * 何时通知（子代理对齐，waitForSubagents，默认开）：
 *   dsh web 会话列表"进行中"的官方判据（dsh-client-ui-workspace 的
 *   sessionStatuses + indexSubagentDescendants）：本会话 agent 在跑
 *   OR 任一 origin=subagent 的后代会话在跑（沿 parentSession 链向
 *   全部祖先记账；fork 有 parentSession 但无 origin，不算 subagent）。
 *   本插件对齐该语义：根 agent idle 时子树内仍有 subagent 在跑 →
 *   不通知，等最后一个结束才响（纯事件驱动、无超时——与 web 一致，
 *   后台长跑任务期间 web 也一直显示进行中）。最后一个 subagent
 *   idle / 运行中被销毁（interrupt）都会触发子树静默重评估。
 *   机制层同样对齐 web 的「事件供延迟、拉取供真相」双通道：
 *   - 加载时经宿主 agents 注册表自举基线（判据与 web 的
 *     session.list/summaryFor 完全一致：agents.get(id)?.status ===
 *     'running'；只登记不触发，对齐 web「首次观测只记录」）；
 *   - 每次 settle（唯一不可撤回的决策点）前重读注册表现值修复
 *     事件漂移（对齐 web 重连重拉 session.list 的收敛机制；同步
 *     读、无 web 端"拉取期间事件重放"的交错窗口）。
 *   竞态兜底：subagent 会话已创建（session/created）但状态尚未观测
 *   到（创建→首跑的微小间隙）时进 subagentQuietMs 窗口；窗口内转
 *   running 则继续等待，耗尽仍无动静则照常通知（只会迟到不会丢）。
 *   根重新 running（新提问/steering/goal 续跑）作废全部挂起状态。
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
import { createRequire } from 'node:module'
import Schema from '@deepseek-ai/schemastery'

/** 包版本（启动日志用；读取失败退回 unknown）。 */
const PKG_VERSION: string = (() => {
  try {
    return (createRequire(import.meta.url)('../package.json') as { version?: string }).version ?? 'unknown'
  } catch {
    return 'unknown'
  }
})()

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
  clickToFocus: boolean
  webUrl: string
  deepLinkHash: string
  notifyActivateActions: boolean
  terminalNotifierPath: string
  windowsClickMode: 'auto' | 'balloon' | 'toast'
  balloonWaitMs: number
  windowsToastAumid: 'auto' | 'powershell'
  /** 轮询挂起时长与在线判定阈值（毫秒）。 */
  presenceTimeoutMs: number
  appName: string
  expireMs: number
  titleTemplate: string
  bodyTemplate: string
  rootOnly: boolean
  skipGoalRounds: boolean
  goalQuietMs: number
  waitForSubagents: boolean
  subagentQuietMs: number
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
  soundFile: Schema.string().default('').description('提示音文件路径；留空 = 平台默认（linux freedesktop bell.oga / macos Glass.aiff；windows 用系统通知音，不额外发声）'),
  bell: Schema.boolean().default(false).description('向宿主 stdout 写 ASCII BEL（终端/SSH 场景）'),
  command: Schema.string().default('').description('通知触发时的自定义命令，占位符 {sessionId} {title} {question}；留空关闭'),
  notifyCommand: Schema.string().default('').description('完全接管桌面通知的命令模板（高级；同上占位符）；留空用平台后端'),
  soundCommand: Schema.string().default('').description('完全接管提示音的命令模板（高级；同上占位符）；留空用平台后端'),
  notifyOnQuestion: Schema.boolean().default(false).description('提问到达时也通知（默认关：自己刚发的消息无需提醒。适用场景：从远程设备发消息、在桌面确认送达。内容 = 会话标题 + 提问；steering 插话同样触发，goal 注入/合成上下文不触发）'),
  questionTitleTemplate: Schema.string().default('{title}').description('提问通知标题模板，占位符 {title} {question} {sessionId}'),
  questionBodyTemplate: Schema.string().default('提问：{question}').description('提问通知正文模板，占位符同上'),
  questionSoundFile: Schema.string().default('').description('提问提示音文件；留空 = 与轮次结束共用 soundFile / 平台默认'),
  clickToFocus: Schema.boolean().default(true).description('点击通知卡片回到对应会话：Linux 与 Windows（balloon，页面在线时）复用已开页面、零新标签页；页面离线或 macOS 经 OS 深链打开浏览器直达会话'),
  webUrl: Schema.string().default('http://127.0.0.1:3080').description('点击通知打开的 Web 地址（页面没开时的深链目标 base）'),
  deepLinkHash: Schema.string().default('#dsh-focus=').description('深链 hash 前缀；页面侧客户端插件读取此 hash 定位会话'),
  notifyActivateActions: Schema.boolean().default(true).description('Linux：notify-send 用 -A/--action（点击后回调）；通知守护进程不支持 action 时置 false 退回普通通知'),
  terminalNotifierPath: Schema.string().default('terminal-notifier').description('macOS 点击回调依赖的 terminal-notifier 命令（PATH 名或绝对路径）；不存在时 macOS 通知无点击功能（仍正常显示）'),
  windowsClickMode: Schema.union([
    Schema.const('auto' as const).description('页面在线用 balloon（点击复用已开页面、零新标签页），离线用 toast 深链'),
    Schema.const('balloon' as const).description('恒用 NotifyIcon balloon：点击回调进进程，不经浏览器'),
    Schema.const('toast' as const).description('恒用 WinRT toast protocol launch：点击=系统用浏览器打开深链（自定义提示音需要此模式）'),
  ]).default('auto').description('Windows 点击回调机制（balloon 的系统音不可静音/替换，配置 soundFile 时自动落到 toast）'),
  balloonWaitMs: Schema.number().default(300000).description('Windows balloon 等待点击的时长（毫秒，默认 5 分钟）：进程驻留监听点击；超时退出后通知中心里的卡片成死卡片（点击无效果）。每次通知一个驻留进程，按需调小'),
  windowsToastAumid: Schema.union([
    Schema.const('auto' as const).description('以自有 AUMID 直接发送（零文件），通知归属显示 dsh'),
    Schema.const('powershell' as const).description('恒用系统 PowerShell 的 AUMID（旧行为：通知归属显示 Windows PowerShell）'),
  ]).default('auto').description('Windows toast 的 AppUserModelID（通知归属/品牌显示）'),
  presenceTimeoutMs: Schema.number().default(15000).description('Web 页面在线判定阈值与 focus-wait 挂起时长基准（挂起 = 该值一半，夹在 0.5–10s）：发起通知时辅助选 balloon/toast；点击时刻的在线判定用瞬时真值（当下是否有挂起的长轮询）'),
  appName: Schema.string().default('dsh').description('应用名（linux notify-send -a / 通知归属显示）'),
  expireMs: Schema.number().default(4000).description('桌面通知超时毫秒数（linux -t；macos/win 不支持则忽略）'),
  titleTemplate: Schema.string().default('{title}').description('通知标题模板，占位符 {title} {question} {sessionId}'),
  bodyTemplate: Schema.string().default('{question}').description('通知正文模板，占位符同上'),
  rootOnly: Schema.boolean().default(true).description('只通知根会话（跳过子代理/后台任务）'),
  skipGoalRounds: Schema.boolean().default(true).description('goal 自动续跑的轮次结束不通知；goal 完结/暂停/受阻、真正停下等用户输入时才响'),
  goalQuietMs: Schema.number().default(3000).description('goal 看似会续跑时的兜底等待窗口：期间重新 running 则取消通知，耗尽仍空闲则照常通知'),
  waitForSubagents: Schema.boolean().default(true).description('与 dsh web 会话列表状态对齐：会话树内仍有 subagent 运行时不通知，全部结束才通知（后台长跑任务期间持续静默；子代理中途销毁同样计入静默）'),
  subagentQuietMs: Schema.number().default(500).description('子代理已创建但状态未观测到时的竞态兜底窗口（毫秒）：窗口内转 running 则继续等待，耗尽仍无动静则照常通知（只会迟到不会丢）'),
  fallbackTitle: Schema.string().default('DSH').description('无会话标题时的通知标题兜底'),
  fallbackMessage: Schema.string().default('回复结束（agent 已空闲）').description('未捕获到用户提问时的正文兜底'),
  questionChars: Schema.number().default(80).description('正文 = 本轮用户提问的前 N 个字符；0 = 不含提问、正文退回 fallbackMessage'),
  minRunMs: Schema.number().default(0).description('运行不足该毫秒数的轮次不通知'),
})

/**
 * 平台默认提示音文件。windows 项仅在 notifySend=false（无通知面承载
 * 系统音）时使用；通知开着时 windows 默认音就是通知自带的系统通知音。
 */
const DEFAULT_SOUND: Record<Platform, string> = {
  linux: '/usr/share/sounds/freedesktop/stereo/bell.oga',
  macos: '/System/Library/Sounds/Glass.aiff',
  windows: 'C:\\Windows\\Media\\Windows Notify.wav',
}

/** Windows toast 借用的系统 PowerShell AUMID（保证通知中心可靠显示）。 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'

/**
 * 自有 AUMID：toast 归属直接显示该字符串（'dsh'），零注册零文件。
 * 早期方案在开始菜单创建 dsh.lnk（目标 powershell -WindowStyle Hidden），
 * 该模式与 LNK 木马投放器特征一致，被杀软按 HEUR:Trojan/LNK.Agent.b
 * 正确地启发式报毒并删除——已彻底移除快捷方式路线；未注册 AUMID 的
 * 显示名即 AUMID 字符串本身，故取短名 dsh。
 */
const DSH_AUMID = 'dsh'

/** 宿主 sessionTitle 服务的最小读取面（可选服务，未挂载时 ctx.get 返回 undefined）。 */
interface TitleServiceLike {
  get(session: unknown): { title?: unknown } | undefined
}

/** 事件载荷里会话对象的最小形态（跨 dsh 版本按运行时字段收窄）。 */
interface SessionLike {
  id?: unknown
  header?: { parentSession?: unknown; origin?: unknown }
}

/** 每个 session 的标题 + 最近一条真人提问 + 最近一次会话对象（标题解析用）。 */
interface SessionInfo {
  title?: string
  question?: string
  /** 最近一次在事件里见到的会话对象；settle 延迟通知时 resolveTitle 用。 */
  session?: SessionLike
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

/** 深链 URL：点击通知时打开（客户端插件读 hash 定位会话）。 */
function deepLinkUrl(config: Config, sessionId: string): string {
  const base = config.webUrl.replace(/\/$/, '')
  return base + '/' + config.deepLinkHash + encodeURIComponent(sessionId)
}

/**
 * Windows 可点击 toast XML（protocol launch：点击 = 用默认浏览器打开深链）。
 * audio='system'（默认）不带 <audio> 元素 → toast 播系统通知音（单音源
 * 原则的默认路径）；'silent' 显式静音（自定义 soundFile 由 SoundPlayer
 * 承载，或 sound=false）。归属 AUMID 直接决定显示名：默认 POWERSHELL_AUMID，
 * 传 DSH_AUMID 则显示 dsh（未注册 AUMID 的显示名即字符串本身，零文件）。
 */
export function buildToastScript(title: string, body: string, launchUrl?: string, audio: 'system' | 'silent' = 'system', aumid = POWERSHELL_AUMID): string {
  const launch = launchUrl === undefined ? '' : ' activationType="protocol" launch="' + xmlEscape(launchUrl) + '"'
  const audioEl = audio === 'silent' ? '<audio silent="true"/>' : ''
  const xml = '<toast' + launch + '><visual><binding template="ToastText02"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(body) + '</text></binding></visual>' + audioEl + '</toast>'
  return [
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
    '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
    "$xml.LoadXml(" + psSingle(xml) + ")",
    '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + aumid + "').Show($toast)",
  ].join('\n')
}

/**
 * 设置当前 PowerShell 进程显式 AUMID 的脚本（导出供测试解析验证）。
 * balloon 经 shell 提升为 toast 后归属取自进程 AUMID——设置后显示 dsh。
 * 一个 P/Invoke，不创建任何文件、不写注册表、无快捷方式（早期快捷方式
 * 方案被杀软按 LNK 木马启发式报毒，已移除）。
 */
export function buildSetProcessAumidScript(aumid: string): string {
  return [
    'try {',
    "  Add-Type -TypeDefinition @'",
    'using System;',
    'using System.Runtime.InteropServices;',
    '[DllImport("shell32.dll", PreserveSig = false)]',
    'public static class DshTnAumid {',
    '  [DllImport("shell32.dll", PreserveSig = false)]',
    '  public static extern void SetCurrentProcessExplicitAppUserModelID(',
    '    [MarshalAs(UnmanagedType.LPWStr)] string appUserModelId);',
    '}',
    "'@",
    "  [DshTnAumid]::SetCurrentProcessExplicitAppUserModelID('" + aumid + "')",
    '} catch { }',
  ].join('\n')
}

/** macOS 通知 AppleScript（导出供测试在真实 osascript 下验证）。 */
export function buildMacNotifyScript(title: string, body: string): string {
  return 'display notification ' + appleString(body) + ' with title ' + appleString(title)
}

/**
 * Windows NotifyIcon balloon 通知脚本（导出供测试在真实 PowerShell 下验证）。
 * shell 把 BalloonTip 提升为 toast 显示；点击路由回 NotifyIcon（Win10/11
 * 兼容行为）→ POST clickUrl {sessionId} → 响应 {open:true}（无在线页面）
 * 或网络失败时 Start-Process 深链兜底。进程驻留至多 waitSeconds 等
 * 点击（DoEvents 消息泵），超时静默退出。默认 5 分钟（通知中心里的
 * 卡片在进程退出后成为死卡片——点击无效果，故驻留要长）。
 */
export function buildBalloonScript(title: string, body: string, sessionId: string, clickUrl: string, deepLink: string, waitSeconds: number, soundOn: boolean, aumidSetup = '', raiseScript = ''): string {
  const secs = Math.max(1, Math.min(3600, Math.ceil(waitSeconds)))
  const tipMs = Math.min(60000, secs * 1000)
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    'Add-Type -AssemblyName System.Drawing',
    // 进程 AUMID setup（buildSetProcessAumidScript 产物）：balloon 提升
    // 为 toast 后归属取自进程 AUMID——设置后显示 dsh。一个 P/Invoke，
    // 不创建任何文件（快捷方式方案已因杀软 LNK 启发式误报移除）。
    ...aumidSetup.split('\n').filter(l => l.length > 0),
    '$clickUrl = ' + psSingle(clickUrl),
    '$deepLink = ' + psSingle(deepLink),
    '$body = ' + psSingle('{"sessionId":' + JSON.stringify(sessionId) + '}'),
    '$icon = New-Object System.Windows.Forms.NotifyIcon',
    '$icon.Icon = [System.Drawing.SystemIcons]::Information',
    '$tip = ' + psSingle(title),
    'if ($tip.Length -gt 63) { $tip = $tip.Substring(0, 63) }',
    '$icon.Text = $tip',
    '$icon.Visible = $true',
    '$icon.BalloonTipTitle = ' + psSingle(title),
    '$icon.BalloonTipText = ' + psSingle(body),
    '$icon.BalloonTipIcon = [System.Windows.Forms.ToolTipIcon]::' + (soundOn ? 'Info' : 'None'),
    '$script:clicked = $false',
    '$icon.Add_BalloonTipClicked({ $script:clicked = $true })',
    '$icon.ShowBalloonTip(' + tipMs + ')',
    '$deadline = (Get-Date).AddSeconds(' + secs + ')',
    'while (-not $script:clicked -and (Get-Date) -lt $deadline) {',
    '  [System.Windows.Forms.Application]::DoEvents()',
    '  Start-Sleep -Milliseconds 120',
    '}',
    '$icon.Visible = $false',
    '$icon.Dispose()',
    'if (-not $script:clicked) { exit 0 }',
    'try {',
    '  $r = Invoke-RestMethod -Method Post -Uri $clickUrl -ContentType \'application/json\' -Body $body -TimeoutSec 5',
    '  if ($r.open -eq $true) {',
    '    Start-Process $deepLink',
    '  } else {',
    // open:false = 已开页面原地切换——但浏览器禁止无手势抢前台，用户
    // 看不到任何反应；raiseScript 把已有浏览器窗口拉到前台（best-effort）
    ...raiseScript.split('\n').filter(l => l.length > 0),
    '  }',
    '} catch {',
    '  Start-Process $deepLink',
    '}',
    'exit 0',
  ].join('\n')
}

/**
 * 把已开的默认浏览器窗口拉到前台的脚本（导出供测试解析验证）。
 * 页面内 sessions.open 已切换会话，但浏览器禁止无手势的 window.focus()
 * 抢前台——用户看到"点了没反应"。此脚本由 balloon 点击进程执行（有点
 * 击语境）：注册表读默认浏览器 ProgId（注意 PS 单引号串里路径必须是
 * 单反斜杠——早期版本生成出双反斜杠，注册表读取静默失败、品牌窗口
 * 选择退化为盲选，真机踩坑）→ 多窗口时优先选择标题含 " — DSH" 的
 * 窗口（客户端标记；dsh 标签页为活动标签的窗口）→ ShowWindow 恢复
 * 最小化 + ALT 键技巧获得前台权限 + SetForegroundWindow 置前。
 * best-effort：失败不抛（页面切换已完成，用户手动切到浏览器即就绪）。
 */
export function buildRaiseBrowserScript(): string {
  const csharp = [
    'using System;',
    'using System.Runtime.InteropServices;',
    'public static class DshTnRaise {',
    '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
    '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
    '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);',
    '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
    '}',
  ].join('\n')
  return [
    'try {',
    "  $progId = ''",
    '  try {',
    "    $progId = [string](Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\http\\UserChoice' -ErrorAction SilentlyContinue).ProgId",
    '  } catch { }',
    "  $preferred = ''",
    "  if ($progId -like 'ChromeHTML*') { $preferred = 'chrome' }",
    "  elseif ($progId -like 'MSEdgeHTM*') { $preferred = 'msedge' }",
    "  elseif ($progId -like 'FirefoxURL*') { $preferred = 'firefox' }",
    "  $names = @('chrome','msedge','firefox','brave','opera','vivaldi','360se','360chrome','qqbrowser')",
    "  if ($preferred -ne '' -and $preferred -notin $names) { $names = @($preferred) + $names }",
    '  $cands = @(Get-Process -Name $names -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })',
    "  if ($cands.Count -eq 0 -and $preferred -ne '') {",
    '    $cands = @(Get-Process -Name $preferred -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })',
    '  }',
    // 多窗口：优先 dsh 标签页为活动标签的窗口（标题含客户端标记 " — DSH"）
    "  $win = @($cands | Where-Object { $_.MainWindowTitle -like '*DSH*' }) | Select-Object -First 1",
    '  if ($win -eq $null) { $win = $cands | Select-Object -First 1 }',
    '  if ($win -ne $null) {',
    "    Add-Type -TypeDefinition @'",
    csharp,
    "'@",
    '    [DshTnRaise]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)',
    '    [DshTnRaise]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
    '    [DshTnRaise]::ShowWindow($win.MainWindowHandle, 9) | Out-Null',
    '    [DshTnRaise]::SetForegroundWindow($win.MainWindowHandle) | Out-Null',
    '    [DshTnRaise]::SwitchToThisWindow($win.MainWindowHandle, $true)',
    '  }',
    '} catch { }',
  ].join('\n')
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
  // 每行前缀带版本：调试时任意一行日志即可识别运行版本（含用户回报）
  const log = (...a: unknown[]) => console.log('[turn-notify v' + PKG_VERSION + ']', ...a)
  const failedOnce = new Set<string>()
  const warnOnce = (channel: string, msg: string) => {
    if (failedOnce.has(channel)) return
    failedOnce.add(channel)
    log('channel "' + channel + '" failed (只警告一次):', msg)
  }

  /**
   * 聚焦通道（经 webServer 服务注册，web 客户端插件消费）：
   *   GET  /turn-notify/focus-wait?client=<id>&since=<seq> —— 长轮询。有
   *        未消费点击立即返回；否则挂起至多 pollHoldMs 后空返回。每次
   *        到达即刷新该 client 的 presence（Linux 复用路径的“页面已开”
   *        判据；替代 v0.2.2-dev.4 的转发白名单注入——那条路在所有平台
   *        都解析不到 dsh-api-remotes 的同一模块实例，从未生效过）。
   *   POST /turn-notify/focus —— 深链落地页广播聚焦：入队分发给所有长
   *        轮询页面（其它已开标签页同步切换）。
   */
  interface FocusEntry { seq: number; sessionId: string; ts: number }
  interface FocusWaiter { since: number; respond: (entries: FocusEntry[]) => void }
  const focusQueue: FocusEntry[] = []
  const focusWaiters = new Set<FocusWaiter>()
  const presenceSeen = new Map<string, number>()
  // Date.now() 基数：跨宿主重启单调。从 0 计数会在重启后归零，而被未
  // 刷新的旧页面（客户端记着旧 lastSeq）在服务端过滤与客户端去重两处
  // 当作重复条目吞掉——重装插件后不刷新页面时点击被无声丢弃。
  let focusSeq = Date.now()
  const pollHoldMs = Math.max(500, Math.min(10_000, Math.floor(config.presenceTimeoutMs / 2)))
  const FOCUS_TTL_MS = 60_000
  const FOCUS_QUEUE_MAX = 32

  const trimFocusQueue = (): void => {
    const now = Date.now()
    while (focusQueue.length > 0 && (focusQueue[0].ts < now - FOCUS_TTL_MS || focusQueue.length > FOCUS_QUEUE_MAX)) {
      focusQueue.shift()
    }
  }

  const enqueueFocus = (sessionId: string): void => {
    trimFocusQueue()
    focusQueue.push({ seq: ++focusSeq, sessionId, ts: Date.now() })
    const waiters = [...focusWaiters]
    focusWaiters.clear()
    for (const w of waiters) w.respond(focusQueue.filter(e => e.seq > w.since))
  }

  /** 页面在线判据：任一 client 的长轮询最近到达时间在阈值内。 */
  const presenceFresh = (): boolean => {
    const now = Date.now()
    let fresh = false
    for (const [client, ts] of presenceSeen) {
      if (now - ts > config.presenceTimeoutMs * 3) presenceSeen.delete(client)
      else if (now - ts < config.presenceTimeoutMs) fresh = true
    }
    return fresh
  }

  interface FocusRes {
    writeHead(code: number, headers?: Record<string, string>): FocusRes
    end(body?: unknown): void
  }
  interface WebServerLike {
    register(route: { kind: 'exact' | 'prefix'; path: string; handler: (req: unknown, res: FocusRes) => void }): () => void
  }
  ctx.inject(['webServer'], (scope) => {
    const wsCtx = scope as Context & { webServer: WebServerLike }
    const disposeWait = wsCtx.webServer.register({
      kind: 'exact',
      path: '/turn-notify/focus-wait',
      handler: (req, res) => {
        const url = new URL((req as { url?: string }).url ?? '/', 'http://x')
        const client = String(url.searchParams.get('client') ?? '').slice(0, 64)
        const since = Number(url.searchParams.get('since') ?? '0') || 0
        if (client.length > 0) presenceSeen.set(client, Date.now())
        trimFocusQueue()
        const respond = (entries: FocusEntry[]): void => {
          try {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ entries: entries.map(e => ({ seq: e.seq, sessionId: e.sessionId })) }))
          } catch { /* 客户端已断开：挂起响应作废 */ }
        }
        const pending = focusQueue.filter(e => e.seq > since)
        if (pending.length > 0) {
          respond(pending)
          return
        }
        const timer = setTimeout(() => {
          focusWaiters.delete(waiter)
          waiter.respond([])
        }, pollHoldMs)
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
          ;(timer as { unref(): void }).unref()
        }
        const waiter: FocusWaiter = {
          since,
          respond: (entries) => {
            clearTimeout(timer)
            respond(entries)
          },
        }
        focusWaiters.add(waiter)
      },
    })
    const disposePost = wsCtx.webServer.register({
      kind: 'exact',
      path: '/turn-notify/focus',
      handler: (req, res) => {
        const chunks: Buffer[] = []
        const r = req as { on?: (ev: string, fn: (d?: Buffer) => void) => unknown }
        const finish = (sessionId: string): void => {
          if (sessionId.length > 0 && sessionId.length <= 256) {
            log('focus 广播 →', sessionId)
            enqueueFocus(sessionId)
          }
          try {
            res.writeHead(204).end()
          } catch { /* 客户端已断开 */ }
        }
        if (typeof r.on !== 'function') {
          finish('')
          return
        }
        let size = 0
        r.on('data', (d) => {
          size += (d ?? Buffer.alloc(0)).length
          if (size <= 1_000_000) chunks.push(d ?? Buffer.alloc(0))
        })
        r.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sessionId?: unknown }
            finish(typeof body.sessionId === 'string' ? body.sessionId : '')
          } catch {
            finish('')
          }
        })
        r.on('error', () => finish(''))
      },
    })
    // balloon 点击回调入口：入队聚焦 + 告知回调方是否需要深链开浏览器
    // （页面在线 → {open:false}，已开页面原地切换；离线 → {open:true}，
    // 调用方 Start-Process 深链）。在线判定用瞬时真值（当下是否有挂起的
    // focus-wait 请求）：时间窗推断（presenceFresh）在页面刚关闭时会误判
    // 在线 → open:false → 点击无任何效果。
    const disposeClick = wsCtx.webServer.register({
      kind: 'exact',
      path: '/turn-notify/click',
      handler: (req, res) => {
        const chunks: Buffer[] = []
        const r = req as { on?: (ev: string, fn: (d?: Buffer) => void) => unknown }
        const finish = (sessionId: string): void => {
          const valid = sessionId.length > 0 && sessionId.length <= 256
          const open = !valid || focusWaiters.size === 0
          if (valid) {
            log('balloon click →', sessionId, 'open=' + open, 'waiters=' + focusWaiters.size)
            enqueueFocus(sessionId)
          }
          try {
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
            res.end(JSON.stringify({ open }))
          } catch { /* 客户端已断开 */ }
        }
        if (typeof r.on !== 'function') {
          finish('')
          return
        }
        let size = 0
        r.on('data', (d) => {
          size += (d ?? Buffer.alloc(0)).length
          if (size <= 1_000_000) chunks.push(d ?? Buffer.alloc(0))
        })
        r.on('end', () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { sessionId?: unknown }
            finish(typeof body.sessionId === 'string' ? body.sessionId : '')
          } catch {
            finish('')
          }
        })
        r.on('error', () => finish(''))
      },
    })
    log('聚焦通道已注册: GET /turn-notify/focus-wait（长轮询 ' + pollHoldMs + 'ms）+ POST /turn-notify/focus + POST /turn-notify/click')
    wsCtx.effect(() => () => {
      disposeWait()
      disposePost()
      disposeClick()
      for (const w of [...focusWaiters]) w.respond([])
    }, 'turn-notify: focus routes')
  })

  /**
   * 发起通知时的在线预判（选 balloon/toast 用）：瞬时真值（挂起中的
   * 长轮询）优先；时间窗兜底覆盖页面恰好处于两轮询间隙的抖动——否则
   * 会无谓地降级到 toast 深链模式（点击必开新标签页）。
   */
  const presenceLikelyOnline = (): boolean => focusWaiters.size > 0 || presenceFresh()

  /**
   * 点击回调（Linux notify-send -A 的进程内回调）：页面在线 → 入队分发
   * 给已开页面（零浏览器启动，不重复开标签页）；离线 → OS 深链打开，
   * 新页面读 hash 定位会话并开始长轮询，后续点击即走复用路径。
   * Windows balloon 点击经 /turn-notify/click 端点（同样语义）；
   * macOS 无进程内回调（点击=系统直接用浏览器打开深链 URL）。
   */
  const handleNotificationClick = (sessionId: string): void => {
    if (focusWaiters.size > 0) {
      log('notification click → 分发给已开 Web 页面:', sessionId)
      enqueueFocus(sessionId)
      return
    }
    log('notification click → 无活跃页面，深链打开:', sessionId)
    const opener = platform === 'macos' ? 'open' : platform === 'windows' ? 'cmd' : 'xdg-open'
    const args = platform === 'windows' ? ['/c', 'start', '', deepLinkUrl(config, sessionId)] : [deepLinkUrl(config, sessionId)]
    run(opener, args, (m) => warnOnce('deep-link', m))
  }

  /**
   * fire-and-forget 桌面通知（按平台分发；notifyCommand 可完全接管）。
   * soundFileOverride 与 sendSound 同源（提问用 questionSoundFile）：Windows
   * 据它决定音源——显式文件 → toast 静音 + SoundPlayer；留空 → 系统通知音。
   */
  const sendDesktop = (title: string, body: string, vars: { title: string; question: string; sessionId: string }, soundFileOverride = ''): void => {
    const clickable = config.clickToFocus && config.notifySend
    if (config.notifyCommand) {
      runShellCommand(platform, render(config.notifyCommand, vars), (m) => warnOnce('notify-command', m))
      return
    }
    if (platform === 'linux') {
      // -A（点击 action）隐含 --wait：进程阻塞到卡片关闭/点击，stdout 输出
      // action 名。fire-and-forget 的 execFile 子进程天然承载这个等待；点击
      // → exit 0 + stdout=default → 触发回调。守护进程不支持 action 时
      // notify-send 报错退出，onFail 里降级重发普通通知。
      if (clickable && config.notifyActivateActions) {
        // -A 卡片不传 -t：过期会让用户来不及点；守护进程用自家驻留时长
        const child = execFile('notify-send', ['-a', config.appName, '-A', 'default=打开会话', title, body], { timeout: 0 }, (err, stdout) => {
          if (err !== null) {
            // 守护进程不支持 action（常见于部分 DE）——降级为普通通知
            run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m))
            return
          }
          if (String(stdout).trim() === 'default') handleNotificationClick(vars.sessionId)
        })
        child.unref?.()
      } else {
        run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m))
      }
    } else if (platform === 'macos') {
      // 点击回调优先 terminal-notifier（-open 点击打开深链）；没有则纯展示
      if (clickable) {
        execFile(config.terminalNotifierPath, ['-title', config.appName, '-message', body, '-subtitle', title, '-open', deepLinkUrl(config, vars.sessionId), '-activate', 'com.apple.Safari', '-group', vars.sessionId], { timeout: 0 }, (err) => {
          if (err !== null) run('osascript', ['-e', buildMacNotifyScript(title, body)], (m) => warnOnce('osascript', m))
        }).unref?.()
      } else {
        run('osascript', ['-e', buildMacNotifyScript(title, body)], (m) => warnOnce('osascript', m))
      }
    } else if (platform === 'windows') {
      // 音源决策：显式 soundFile → toast 静音 + SoundPlayer 承载；留空 →
      // toast 系统通知音（不再叠 SoundPlayer）；sound=false → 全静音。
      const explicitFile = soundFileOverride !== '' ? soundFileOverride : config.soundFile
      const customSound = config.sound && explicitFile !== ''
      // 点击机制：balloon（进程内回调，复用已开页面）优先；自定义音或
      // 显式 toast 模式或页面离线时用 protocol launch（点击=系统开浏览器）。
      const wantBalloon = clickable && !customSound
        && (config.windowsClickMode === 'balloon'
          || (config.windowsClickMode === 'auto' && presenceLikelyOnline()))
      // 归属品牌（零文件）：toast 直接以 DSH_AUMID 发出（显示名 = 'dsh'）；
      // balloon 经进程 AUMID 设置。windowsToastAumid=powershell 时全部回退。
      const branded = config.windowsToastAumid === 'auto'
      const toastAumid = branded ? DSH_AUMID : POWERSHELL_AUMID
      const aumidSetup = branded ? buildSetProcessAumidScript(DSH_AUMID) : ''
      if (wantBalloon) {
        const base = config.webUrl.replace(/\/$/, '')
        const script = buildBalloonScript(title, body, vars.sessionId, base + '/turn-notify/click', deepLinkUrl(config, vars.sessionId), Math.ceil(config.balloonWaitMs / 1000), config.sound, aumidSetup)
        // balloon 进程驻留等点击（至多 balloonWaitMs，默认 5 分钟），execFile
        // 的 10s 通用超时不够；timeout 0 + unref（与 Linux notify-send -A 同款）。
        const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(script)], { timeout: 0 }, (err) => {
          if (err !== null) {
            // balloon 失败（无桌面会话等）→ 降级 toast（无点击深链照发）
            const launch = clickable ? deepLinkUrl(config, vars.sessionId) : undefined
            run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch, 'system', toastAumid))], (m) => warnOnce('windows-toast', m))
          }
        })
        child.unref?.()
      } else {
        const launch = clickable ? deepLinkUrl(config, vars.sessionId) : undefined
        const audio = customSound || !config.sound ? 'silent' : 'system'
        run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch, audio, toastAumid))], (m) => warnOnce('windows-toast', m))
      }
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

  /**
   * Windows 单音源判定：通知面已带系统通知音（notifySend 开、sound 开、
   * 无显式 soundFile/override）时跳过 SoundPlayer，避免双音效。
   */
  const windowsSystemAudioCovers = (override: string): boolean =>
    platform === 'windows' && config.notifySend && config.sound
    && (override !== '' ? override : config.soundFile) === ''

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
    if (session === undefined || session === null) return undefined
    const svc = (ctx as unknown as { get(name: string): unknown }).get('sessionTitle') as TitleServiceLike | undefined
    const folded = svc?.get(session)?.title
    return typeof folded === 'string' && folded.length > 0 ? folded : undefined
  }

  /** 该会话的 goal 是否会自动续跑（live goal/changed 维护）。 */
  const goalWillContinue = new Map<string, boolean>()
  /** 兜底窗口中的定时器（续跑兜底：窗口耗尽仍未 running 则通知）。 */
  const pendingQuiet = new Map<string, ReturnType<typeof setTimeout>>()
  /** 每个 agent 的 running 起始时刻，用于 minRunMs 过滤。 */
  const runningSince = new Map<string, number>()

  const cancelQuiet = (sessionId: string): void => {
    const t = pendingQuiet.get(sessionId)
    if (t !== undefined) {
      clearTimeout(t)
      pendingQuiet.delete(sessionId)
    }
  }

  /**
   * 会话血缘（对齐 dsh web 判据）：web 会话列表"进行中"= 本会话 agent
   * 在跑 OR 任一 origin=subagent 后代在跑（indexSubagentDescendants 沿
   * parentSession 链向全部祖先记账）。fork 有 parentSession 但无 origin，
   * 是顶层会话、不算 subagent 后代——官方语义以 origin 为准，不用
   * parentSession 判根（老版本插件用它判根，把 fork 误当子代理静默）。
   */
  interface LineageInfo {
    /** 直接父会话 id（subagent 与 fork 都有；仅 subagent 参与记账）。 */
    parent?: string
    /** header.origin === 'subagent'（dsh-subagent childSessionMeta 盖章）。 */
    subagent: boolean
    /** 是否已观测过该会话的 agent/status（未观测 = 创建→首跑的间隙）。 */
    statusSeen: boolean
  }
  const lineage = new Map<string, LineageInfo>()
  /** 当前 running 的全部会话（含 subagent；agent/status 维护）。 */
  const runningSessions = new Set<string>()
  /** 根 idle 后正在等子树静默的会话（事件驱动挂起，无定时器）。 */
  const waitingQuiesce = new Set<string>()
  /** 创建→running 竞态兜底窗口的定时器。 */
  const pendingSubagentQuiet = new Map<string, ReturnType<typeof setTimeout>>()

  const registerLineage = (session: unknown): void => {
    if (session === null || typeof session !== 'object') return
    const s = session as SessionLike
    if (s.id === undefined) return
    const id = String(s.id)
    const entry = lineage.get(id) ?? { subagent: false, statusSeen: false }
    if (s.header?.parentSession !== undefined) entry.parent = String(s.header.parentSession)
    if (s.header?.origin === 'subagent') entry.subagent = true
    lineage.set(id, entry)
  }

  /** 官方"根"判据：header.origin !== 'subagent'（fork 也是顶层会话）。 */
  const isRootSession = (session: unknown): boolean => {
    if (session === null || typeof session !== 'object') return true
    return (session as SessionLike).header?.origin !== 'subagent'
  }

  /** 从 sessionId 沿 parentSession 链向上的全部祖先（近→远，含顶层根；循环安全）。 */
  const ancestorsOf = (sessionId: string): string[] => {
    const out: string[] = []
    const seen = new Set<string>([sessionId])
    let cur = lineage.get(sessionId)
    while (cur !== undefined && cur.subagent && cur.parent !== undefined && !seen.has(cur.parent)) {
      seen.add(cur.parent)
      out.push(cur.parent)
      cur = lineage.get(cur.parent)
    }
    return out
  }

  /** sessionId 的全部 subagent 后代（任意深度；与 web 记账方向一致：由后代向祖先归属）。 */
  const descendantsOf = (sessionId: string): string[] => {
    const out: string[] = []
    for (const [id, entry] of lineage) {
      if (!entry.subagent) continue
      if (ancestorsOf(id).includes(sessionId)) out.push(id)
    }
    return out
  }

  const cancelSubagentQuiet = (sessionId: string): void => {
    const t = pendingSubagentQuiet.get(sessionId)
    if (t !== undefined) {
      clearTimeout(t)
      pendingSubagentQuiet.delete(sessionId)
    }
  }

  /**
   * 注册表同步（机制对齐 web 的「事件供延迟、拉取供真相」双通道）：
   * web 端 session.list 基线 + api-session/status 事件 + 重连重拉三件套
   * 修复事件漂移；本插件以宿主 agents 注册表（同一判据
   * agents.get(id)?.status === 'running'）实现对应机制：
   *   baseline —— 插件（重）加载时：记录 running 位与血缘，只登记不
   *               触发任何通知（对齐 web「首次观测只记录，加载时已
   *               idle 的会话不挂提醒」）。
   *   repair   —— 每次 settle（唯一不可撤回的决策点）前：以注册表现值
   *               修复事件漏收的 running/idle 漂移（运行位以拉取为真相），
   *               但不把未观测过的会话标成 seen——「已创建待首跑」的
   *               微间隙仍留给竞态兜底窗口（对齐 web 的边沿判别只认
   *               事件、基线不挂提醒的分工）。
   * 注册表缺席的 subagent 视同不再运行（agent 不在即不会再跑，durable
   * 行语义）；服务缺席（旧宿主）时返回 false，退化为纯 live 事件追踪。
   */
  const registrySync = (mode: 'baseline' | 'repair'): boolean => {
    try {
      const registry = (ctx as unknown as { get(name: string): unknown }).get('agents') as
        | { list?: () => Array<{ session?: unknown; status?: unknown }> }
        | undefined
      if (typeof registry?.list !== 'function') return false
      const live = new Set<string>()
      for (const agent of registry.list()) {
        const session = agent?.session
        if (session === null || typeof session !== 'object' || (session as SessionLike).id === undefined) continue
        registerLineage(session)
        const key = String((session as SessionLike).id)
        live.add(key)
        getInfo(key).session = session as SessionLike
        const entry = lineage.get(key)
        if (agent.status === 'running') {
          runningSessions.add(key)
          if (entry !== undefined) entry.statusSeen = true
        } else {
          // idle：repair 只修复已观测会话的运行位；baseline 额外登记
          // 首次观测（mid-life 会话不会再来首个 status 事件）
          if (entry !== undefined && entry.statusSeen) runningSessions.delete(key)
          if (mode === 'baseline' && entry !== undefined) entry.statusSeen = true
        }
      }
      // 注册表缺席且从未观测的 subagent：agent 已不在（从未驱动即销毁/
      // 已收尾），该会话不会再跑——视同已观测且不再运行
      for (const [key, entry] of lineage) {
        if (entry.subagent && !live.has(key) && !entry.statusSeen) {
          entry.statusSeen = true
          runningSessions.delete(key)
        }
      }
      return true
    } catch {
      return false
    }
  }

  // 现场自举（web 冷启动 session.list 的对应物）：只登记、不触发通知
  if (registrySync('baseline')) {
    const running = [...runningSessions].length
    log('现场自举: live agents=' + lineage.size, 'running=' + running)
  }

  /** 真正发出一次轮次结束通知（全部静默判定通过后唯一的出口）。 */
  const notifyNow = (sessionId: string): void => {
    // 立即通知路径可能撞上仍在计时的静默窗口定时器：先取消，
    // 否则定时器到点会再 fire 一次（双通知）。
    cancelQuiet(sessionId)
    cancelSubagentQuiet(sessionId)
    waitingQuiesce.delete(sessionId)
    const s = info.get(sessionId)
    const rawTitle = resolveTitle(s?.session, sessionId) ?? config.fallbackTitle
    const rawBody =
      config.questionChars > 0 && s?.question !== undefined && s.question.length > 0
        ? truncate(s.question, config.questionChars)
        : config.fallbackMessage
    const vars = { title: rawTitle, question: rawBody, sessionId }
    const title = render(config.titleTemplate, vars)
    const body = render(config.bodyTemplate, vars)
    // 命令类通道的占位符注入最终渲染值（与桌面通知显示一致）
    const finalVars = { title, question: body, sessionId }

    log('agent idle → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId)

    if (config.notifySend) sendDesktop(title, body, finalVars, '')
    if (config.sound && !windowsSystemAudioCovers('')) sendSound(finalVars)
    if (config.bell) process.stdout.write('\x07')
    if (config.command) runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m))
  }

  /**
   * 一次轮次的最终通知决策（根 idle、子树静默触发、竞态窗口到期共用）：
   * 权威重读 → 子代理对齐门 → goal 判别门 → 通知。这是通知唯一的
   * 出口，也是唯一不可撤回的动作——决策前先以注册表现值修复事件
   * 漂移（web 的「拉取供真相」机制落在决策点的形态）。
   * @param skipUnseenWindow 竞态窗口到期重入时为 true——不再因"状态未
   *        观测"二次开窗（否则永不启动的子代理会让窗口无限自续）。
   */
  const settle = (sessionId: string, skipUnseenWindow = false): void => {
    cancelQuiet(sessionId)
    cancelSubagentQuiet(sessionId)
    registrySync('repair')
    if (config.waitForSubagents) {
      const descendants = descendantsOf(sessionId)
      const running = descendants.filter(id => runningSessions.has(id))
      if (running.length > 0) {
        waitingQuiesce.add(sessionId)
        log('idle 但 subagent 仍在跑 → 等待子树静默', 'session=' + sessionId, 'running=' + running.length)
        return
      }
      if (!skipUnseenWindow && descendants.some(id => !lineage.get(id)?.statusSeen)) {
        waitingQuiesce.add(sessionId)
        log('idle 但 subagent 状态未观测 → 竞态兜底窗口 ' + config.subagentQuietMs + 'ms', 'session=' + sessionId)
        const t = setTimeout(() => {
          pendingSubagentQuiet.delete(sessionId)
          settle(sessionId, true)
        }, config.subagentQuietMs)
        if (typeof t === 'object' && t !== null && 'unref' in t) {
          ;(t as { unref(): void }).unref()
        }
        pendingSubagentQuiet.set(sessionId, t)
        return
      }
    }
    waitingQuiesce.delete(sessionId)
    // goal 看似还会自动续跑 → 先不响，进兜底窗口等它重新 running。
    if (config.skipGoalRounds && goalWillContinue.get(sessionId) === true) {
      log('idle 但 goal 将续跑 → 进入 ' + config.goalQuietMs + 'ms 静默窗口', 'session=' + sessionId)
      const t = setTimeout(() => notifyNow(sessionId), config.goalQuietMs)
      if (typeof t === 'object' && t !== null && 'unref' in t) {
        ;(t as { unref(): void }).unref() // 不阻止进程退出（一次性任务场景）
      }
      pendingQuiet.set(sessionId, t)
      return
    }
    notifyNow(sessionId)
  }

  // 会话事实追踪：标题快照（latest-wins）+ 最近一条真人提问。
  ctx.on('session/event', (session: SessionLike, event: { type: string; data: unknown }) => {
    const sessionId = String(session.id)
    registerLineage(session)
    getInfo(sessionId).session = session
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
      // 官方"根"判据按 origin（fork 有 parentSession 但同样是顶层会话）
      if (config.rootOnly && !isRootSession(session)) return
      const rawTitle = resolveTitle(session, sessionId) ?? config.fallbackTitle
      const rawBody = config.questionChars > 0 ? truncate(q, config.questionChars) : config.fallbackMessage
      const vars = { title: rawTitle, question: rawBody, sessionId }
      const title = render(config.questionTitleTemplate, vars)
      const body = render(config.questionBodyTemplate, vars)
      const finalVars = { title, question: body, sessionId }
      log('user question → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId)
      if (config.notifySend) sendDesktop(title, body, finalVars, config.questionSoundFile)
      if (config.sound && !windowsSystemAudioCovers(config.questionSoundFile)) sendSound(finalVars, config.questionSoundFile)
      if (config.bell) process.stdout.write('\x07')
      if (config.command) runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m))
    }
  })

  // goal 状态追踪：判定 idle 是"等用户"还是"马上续跑"。
  ;(ctx.on as OnGoalChanged)('goal/changed', ({ agent, change }) => {
    registerLineage(agent.session)
    const sessionId = String(agent.session.id)
    const g = change.goal
    const willContinue =
      g !== undefined &&
      g.phase === 'active' &&
      g.activation === 'armed' &&
      g.roundsStarted < g.maxGoalRounds
    goalWillContinue.set(sessionId, willContinue)
  })

  // 会话创建即登记血缘：subagent 创建（session/created）到首个
  // agent/status(running) 之间存在微小间隙——根在此间隙内 idle 时，
  // 血缘已在、状态未观测，settle 据此进竞态兜底窗口（而非漏判早响）。
  ctx.on('session/created', (session: SessionLike) => {
    registerLineage(session)
  })

  ctx.on('session/disposed', (session: SessionLike) => {
    const sessionId = String(session.id)
    // 先解析祖先链（lineage 即将收缩/摘除）
    const ancestors = ancestorsOf(sessionId)
    cancelQuiet(sessionId)
    cancelSubagentQuiet(sessionId)
    waitingQuiesce.delete(sessionId)
    runningSessions.delete(sessionId)
    goalWillContinue.delete(sessionId)
    info.delete(sessionId)
    runningSince.delete(sessionId)
    // 与 web 一致：subagent 会话销毁后列表行仍在（running 归 false、
    // 血缘保留——孙辈照旧向根记账，见 api-session-controller 的
    // durable-subagent status 变异），只清运行位；非 subagent（根/fork）
    // 整行消失，血缘随之摘除。
    if (session.header?.origin === 'subagent') {
      const entry = lineage.get(sessionId)
      if (entry !== undefined) entry.statusSeen = true // 已销毁视同不再运行
    } else {
      lineage.delete(sessionId)
    }
    // 运行中被销毁（interrupt_agent 等）同样可能让祖先子树静默
    for (const anc of ancestors) {
      if (waitingQuiesce.has(anc) && !runningSessions.has(anc)) settle(anc)
    }
  })

  ctx.on('agent/status', ({ agent, status }: { agent: Agent; status: 'idle' | 'running' }) => {
    const session = agent.session
    const sessionId = String(session.id)
    registerLineage(session)
    const entry = lineage.get(sessionId)
    if (entry !== undefined) entry.statusSeen = true
    getInfo(sessionId).session = session as unknown as SessionLike

    if (status === 'running') {
      cancelQuiet(sessionId) // 续跑（或其他输入）到来，取消兜底通知
      cancelSubagentQuiet(sessionId)
      waitingQuiesce.delete(sessionId) // 新轮开始，上一轮的挂起通知作废
      runningSessions.add(sessionId)
      runningSince.set(sessionId, Date.now())
      return
    }
    if (status !== 'idle') return
    runningSessions.delete(sessionId)

    // 该 idle 可能释放等待子树静默的祖先（rootOnly=true 时祖先只会是
    // 根会话；rootOnly=false 时中间 subagent 也可能是通知主体）。
    for (const anc of ancestorsOf(sessionId)) {
      if (waitingQuiesce.has(anc) && !runningSessions.has(anc)) settle(anc)
    }

    // 本会话作为通知主体：根会话（origin !== 'subagent'，fork 属于顶层），
    // 或 rootOnly=false 时的任意会话（保持旧语义）。
    if (config.rootOnly && !isRootSession(session)) return
    const started = runningSince.get(sessionId)
    runningSince.delete(sessionId)
    if (started !== undefined && Date.now() - started < config.minRunMs) return
    settle(sessionId)
  })

  log('loaded; platform=' + (platform ?? 'unknown(' + process.platform + ')'), 'channels:', JSON.stringify({
    notifySend: config.notifySend, sound: config.sound, bell: config.bell,
    command: config.command ? '(custom)' : '(off)', rootOnly: config.rootOnly,
    questionChars: config.questionChars, skipGoalRounds: config.skipGoalRounds,
    goalQuietMs: config.goalQuietMs, waitForSubagents: config.waitForSubagents,
    subagentQuietMs: config.subagentQuietMs,
  }))

  ctx.effect(() => () => {
    for (const sessionId of pendingQuiet.keys()) cancelQuiet(sessionId)
    for (const sessionId of pendingSubagentQuiet.keys()) cancelSubagentQuiet(sessionId)
    log('disposed')
  })
}
