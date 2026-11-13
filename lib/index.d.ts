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
 * 桌面客户端原生通道（desktopNotify=auto，默认）：
 *   dsh 桌面 app 的内嵌页面以 dsh-app:// 协议服务（与 web 页同源注入
 *   本插件 client 半），页面自识别上报 client=desktop:<uuid>（服务端另
 *   以 Electron UA 指纹兜底——桌面 webview 的长轮询经 forwardWebRequest
 *   转发、UA 保留）。桌面在场时通知改走原生：{kind:'notify'} 条目经同
 *   一条 focus-wait 长轮询投递，页面内用 Web Notification API 弹原生通
 *   知（归属桌面 app 本身，同官方更新通知身份）——点击 = OS 激活置前
 *   + sessions.open 定位会话 + POST /turn-notify/clicked（宿主 start
 *   dsh://open 幂等保险置前 + 广播聚焦让浏览器标签页后台同步切）。
 *   展示后页面 POST /turn-notify/notify-ack；desktopNotifyAckMs 内无
 *   ack（webview 断链/插件未加载）→ 平台通道兜底照发，宁重复不丢失。
 *   桌面不在场（或 desktopNotify=off）→ 平台通道，行为与旧版一致。
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
 * 整行替换）→ 旧宿主（≤0.1.5）的 ~/.dsh/settings.yaml 顶层 turn-notify: 段
 * （热生效）。0.1.7+ settings.yaml 已迁移进 profile patch，等价热层 =
 * 用户 patch 的 turn-notify 条目（patchReload: live 原地重载）。
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "turn-notify";
export declare const inject: never[];
export type PlatformChoice = 'auto' | 'linux' | 'macos' | 'windows';
type Platform = 'linux' | 'macos' | 'windows';
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
    linuxClickBackend: 'auto' | 'notify-send' | 'busctl';
    terminalNotifierPath: string;
    windowsClickMode: 'auto' | 'balloon' | 'toast';
    balloonWaitMs: number;
    windowsToastAumid: 'auto' | 'powershell';
    /** 轮询挂起时长与在线判定阈值（毫秒）。 */
    presenceTimeoutMs: number;
    /** 桌面客户端在场时的原生通知通道（webview Web Notification API）。 */
    desktopNotify: 'auto' | 'off';
    /** desktop 原生通知投递后等待页面展示 ack 的超时（毫秒）。 */
    desktopNotifyAckMs: number;
    appName: string;
    expireMs: number;
    titleTemplate: string;
    bodyTemplate: string;
    rootOnly: boolean;
    skipGoalRounds: boolean;
    goalQuietMs: number;
    waitForSubagents: boolean;
    subagentQuietMs: number;
    fallbackTitle: string;
    fallbackMessage: string;
    questionChars: number;
    /** 正文 {reply}：本轮 DSH 回复的前 N 个字符。 */
    replyChars: number;
    /** 启动时注册 AUMID 的 DisplayName + IconUri（归属区小图标）。 */
    windowsAumidIcon: boolean;
    /** 是否额外在正文左侧放 48×48 图标（appLogoOverride）。 */
    inlineIcon: boolean;
    minRunMs: number;
}
export declare const Config: Schema<Config>;
/** 注册 AUMID 的显示名与图标（HKCU，幂等，无需管理员）。 */
export declare function ensureAumidRegistration(): void;
/** 深链 URL：点击通知时打开（客户端插件读 hash 定位会话）。
 * dsh 0.1.7+ 认证墙修复：URL 自动附加探测到的 token（query 在 hash 前）。 */
export declare function deepLinkUrl(config: Config, sessionId: string): string;
/**
 * 判定 notify-send 的 AppArmor profile 是否拦截 GetCapabilities。
 * Ubuntu 25.10+ 的 /etc/apparmor.d/notify-send 把 dbus 白名单限定为
 * GetServerInformation/Notify——libnotify 的 GetCapabilities 被
 * AccessDenied 拒绝，notify-send 误判 "daemon 不支持 actions"，-A 的
 * 点击回调链路无声死亡（通知照常显示，降级警告都没有）。纯函数，
 * 导出供测试。
 */
export declare function appArmorProfileBlocksCaps(profileText: string): boolean;
/**
 * 解析 busctl monitor 输出的一个消息块（busctl monitor 每条消息 = 头行
 * `‣ Type=signal … Member=Xxx` + 缩进参数行）。只关心两个信号：
 *   ActionInvoked (id u, action_key s) —— 用户点击通知的 default action
 *   NotificationClosed (id u, reason u) —— 通知关闭，清理挂起映射
 * 纯函数，导出供测试。
 */
export declare function parseBusctlMonitorChunk(chunk: string): {
    member: string;
    id: number;
    actionKey?: string;
} | null;
/**
 * busctl call 发送可点击通知的完整 argv（签名 susssasa{sv}i）。
 * actions 传 ['default', '打开会话']：default 是规范保留名（点击通知体
 * 触发），daemon 侧显示为可点击卡片。expire 0 = daemon 默认驻留（与
 * notify-send -A 不传 -t 同款语义）。纯函数，导出供测试。
 */
export declare function buildBusctlNotifyArgs(appName: string, title: string, body: string): string[];
/**
 * Windows 可点击 toast XML（protocol launch：点击 = 用默认浏览器打开深链）。
 * audio='system'（默认）不带 <audio> 元素 → toast 播系统通知音（单音源
 * 原则的默认路径）；'silent' 显式静音（自定义 soundFile 由 SoundPlayer
 * 承载，或 sound=false）。归属 AUMID 直接决定显示名：默认 POWERSHELL_AUMID，
 * 传 DSH_AUMID 则显示 dsh（未注册 AUMID 的显示名即字符串本身，零文件）。
 */
export declare function buildToastScript(title: string, body: string, launchUrl?: string, audio?: 'system' | 'silent', aumid?: string, iconUrl?: string): string;
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
export declare function buildBalloonScript(title: string, body: string, sessionId: string, clickUrl: string, deepLink: string, waitSeconds: number, soundOn: boolean, aumidSetup?: string, raiseScript?: string): string;
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
export declare function buildRaiseBrowserScript(): string;
/** Windows 提示音脚本（导出供测试验证）。 */
export declare function buildSoundScript(file: string): string;
/** -EncodedCommand 编码（UTF-16LE base64）。 */
export declare function encodePs(script: string): string;
/**
 * desktop 客户端判定（纯函数，导出供测试）：页面自识别（client 参数带
 * desktop: 前缀——client.js 检测 dsh-app: 协议后自动添加）为主，服务端
 * UA 指纹兜底（桌面 webview 的长轮询经 forwardWebRequest 转发、UA 保留
 * Electron 标记；覆盖 client.js 未加载/旧版本页面自识别缺席的场景）。
 */
export declare function isDesktopClient(clientParam: string, userAgent: string): boolean;
/**
 * 通知通道路由（纯函数，导出供测试）：desktop 原生通道仅在 notifySend
 * 开（通知面存在）、desktopNotify=auto 且桌面在场（desktop 类型长轮询
 * 挂起中或 presence 新鲜）时启用；其余走平台通道（notifySend=false 时
 * 两边都不发——无通知面语义）。
 */
export declare function chooseNotifyChannel(opts: {
    notifySend: boolean;
    desktopNotify: 'auto' | 'off';
    desktopPresent: boolean;
}): 'desktop' | 'platform' | 'none';
/**
 * 原生通知静音判定（纯函数，导出供测试）：sound=false 全静音；显式
 * soundFile → 通知静音、由宿主平台通道播该文件（单音源原则，与
 * Windows toast 的音源决策一致）；默认 → 通知自带系统音。
 */
export declare function nativeNotifySilent(opts: {
    sound: boolean;
    explicitSoundFile: string;
}): boolean;
/** 桌面客户端置前的协议激活 argv（纯函数，导出供测试；未知平台无动作）。 */
export declare function buildDesktopFocusArgs(platform: Platform | undefined): [string, string[]] | undefined;
export declare function apply(ctx: Context, config: Config): void;
export {};
