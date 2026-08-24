/**
 * dsh-turn-notify — 轮次通知插件（DSH bundle）· v0.2.0
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
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "turn-notify";
export declare const inject: never[];
export type PlatformChoice = 'auto' | 'linux' | 'macos' | 'windows';
export interface Config {
    platform: PlatformChoice;
    notifySend: boolean;
    sound: boolean;
    soundFile: string;
    bell: boolean;
    command: string;
    notifyCommand: string;
    soundCommand: string;
    notifyOnQuestion: boolean;
    questionTitleTemplate: string;
    questionBodyTemplate: string;
    questionSoundFile: string;
    clickToFocus: boolean;
    webUrl: string;
    deepLinkHash: string;
    notifyActivateActions: boolean;
    terminalNotifierPath: string;
    windowsClickMode: 'auto' | 'balloon' | 'toast';
    balloonWaitMs: number;
    windowsToastAumid: 'auto' | 'powershell';
    presenceTimeoutMs: number;
    appName: string;
    expireMs: number;
    titleTemplate: string;
    bodyTemplate: string;
    rootOnly: boolean;
    skipGoalRounds: boolean;
    goalQuietMs: number;
    fallbackTitle: string;
    fallbackMessage: string;
    questionChars: number;
    minRunMs: number;
}
export declare const Config: Schema<Config>;
/**
 * Windows 可点击 toast XML（protocol launch：点击 = 用默认浏览器打开深链）。
 * audio='system'（默认）不带 <audio> 元素 → toast 播系统通知音（单音源
 * 原则的默认路径）；'silent' 显式静音（自定义 soundFile 由 SoundPlayer
 * 承载，或 sound=false）。归属 AUMID 直接决定显示名：默认 POWERSHELL_AUMID，
 * 传 DSH_AUMID 则显示 dsh（未注册 AUMID 的显示名即字符串本身，零文件）。
 */
export declare function buildToastScript(title: string, body: string, launchUrl?: string, audio?: 'system' | 'silent', aumid?: string): string;
/**
 * 设置当前 PowerShell 进程显式 AUMID 的脚本（导出供测试解析验证）。
 * balloon 经 shell 提升为 toast 后归属取自进程 AUMID——设置后显示 dsh。
 * 一个 P/Invoke，不创建任何文件、不写注册表、无快捷方式（早期快捷方式
 * 方案被杀软按 LNK 木马启发式报毒，已移除）。
 */
export declare function buildSetProcessAumidScript(aumid: string): string;
/** macOS 通知 AppleScript（导出供测试在真实 osascript 下验证）。 */
export declare function buildMacNotifyScript(title: string, body: string): string;
/**
 * Windows NotifyIcon balloon 通知脚本（导出供测试在真实 PowerShell 下验证）。
 * shell 把 BalloonTip 提升为 toast 显示；点击路由回 NotifyIcon（Win10/11
 * 兼容行为）→ POST clickUrl {sessionId} → 响应 {open:true}（无在线页面）
 * 或网络失败时 Start-Process 深链兜底。进程驻留至多 waitSeconds 等
 * 点击（DoEvents 消息泵），超时静默退出。默认 5 分钟（通知中心里的
 * 卡片在进程退出后成为死卡片——点击无效果，故驻留要长）。
 */
export declare function buildBalloonScript(title: string, body: string, sessionId: string, clickUrl: string, deepLink: string, waitSeconds: number, soundOn: boolean, aumidSetup?: string): string;
/** Windows 提示音脚本（导出供测试验证）。 */
export declare function buildSoundScript(file: string): string;
/** -EncodedCommand 编码（UTF-16LE base64）。 */
export declare function encodePs(script: string): string;
export declare function apply(ctx: Context, config: Config): void;
