import { execFile, execFileSync, spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import Schema from '@deepseek-ai/schemastery';
/** 包版本（启动日志用；读取失败退回 unknown）。 */
const PKG_VERSION = (() => {
    try {
        return createRequire(import.meta.url)('../package.json').version ?? 'unknown';
    }
    catch {
        return 'unknown';
    }
})();
export const name = 'turn-notify';
export const inject = [];
export const Config = Schema.object({
    platform: Schema.union([
        Schema.const('auto').description('按宿主 OS 自动选择'),
        Schema.const('linux').description('notify-send + paplay'),
        Schema.const('macos').description('osascript + afplay'),
        Schema.const('windows').description('PowerShell toast + SoundPlayer'),
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
    linuxClickBackend: Schema.union([
        Schema.const('auto').description('检测到 notify-send 被 AppArmor 限制（Ubuntu 25.10+ 拦 GetCapabilities 使 -A 回调失效）时自动改用 busctl 直发 + ActionInvoked 信号监听'),
        Schema.const('notify-send').description('恒用 notify-send -A（传统路径）'),
        Schema.const('busctl').description('恒用 busctl 直发（systemd 标配、unconfined，绕开 notify-send 的 AppArmor 拦截）'),
    ]).default('auto').description('Linux 点击回调后端'),
    terminalNotifierPath: Schema.string().default('terminal-notifier').description('macOS 点击回调依赖的 terminal-notifier 命令（PATH 名或绝对路径）；不存在时 macOS 通知无点击功能（仍正常显示）'),
    windowsClickMode: Schema.union([
        Schema.const('auto').description('页面在线用 balloon（点击复用已开页面、零新标签页），离线用 toast 深链'),
        Schema.const('balloon').description('恒用 NotifyIcon balloon：点击回调进进程，不经浏览器'),
        Schema.const('toast').description('恒用 WinRT toast protocol launch：点击=系统用浏览器打开深链（自定义提示音需要此模式）'),
    ]).default('auto').description('Windows 点击回调机制（balloon 的系统音不可静音/替换，配置 soundFile 时自动落到 toast）'),
    balloonWaitMs: Schema.number().default(300000).description('Windows balloon 等待点击的时长（毫秒，默认 5 分钟）：进程驻留监听点击；超时退出后通知中心里的卡片成死卡片（点击无效果）。每次通知一个驻留进程，按需调小'),
    windowsToastAumid: Schema.union([
        Schema.const('auto').description('以自有 AUMID 直接发送（零文件），通知归属显示 dsh'),
        Schema.const('powershell').description('恒用系统 PowerShell 的 AUMID（旧行为：通知归属显示 Windows PowerShell）'),
    ]).default('auto').description('Windows toast 的 AppUserModelID（通知归属/品牌显示）'),
    presenceTimeoutMs: Schema.number().default(15000).description('Web 页面在线判定阈值与 focus-wait 挂起时长基准（挂起 = 该值一半，夹在 0.5–10s）：发起通知时辅助选 balloon/toast；点击时刻的在线判定用瞬时真值（当下是否有挂起的长轮询）'),
    desktopNotify: Schema.union([
        Schema.const('auto').description('桌面客户端在场时改走 webview 原生通知（Web Notification API，归属桌面 app；点击置前 + 直达会话），ack 超时自动回退平台通道'),
        Schema.const('off').description('恒用平台通道（PowerShell/notify-send/osascript），桌面在场也不切换'),
    ]).default('auto').description('桌面客户端在场时的原生通知通道'),
    desktopNotifyAckMs: Schema.number().default(1500).description('desktop 原生通知投递后等待页面展示 ack 的超时（毫秒）：超时未见 ack（webview 断链/插件未加载）则平台通道兜底照发（宁重复不丢失）'),
    appName: Schema.string().default('dsh').description('应用名（linux notify-send -a / 通知归属显示）'),
    expireMs: Schema.number().default(4000).description('桌面通知超时毫秒数（linux -t；macos/win 不支持则忽略）'),
    titleTemplate: Schema.string().default('{title}').description('通知标题模板，占位符 {title} {question} {sessionId}'),
    bodyTemplate: Schema.string().default('{reply}').description('通知正文模板，占位符 {title} {question} {reply} {sessionId}；默认 = 本轮 DSH 回复的前 replyChars 字'),
    rootOnly: Schema.boolean().default(true).description('只通知根会话（跳过子代理/后台任务）'),
    skipGoalRounds: Schema.boolean().default(true).description('goal 自动续跑的轮次结束不通知；goal 完结/暂停/受阻、真正停下等用户输入时才响'),
    goalQuietMs: Schema.number().default(3000).description('goal 看似会续跑时的兜底等待窗口：期间重新 running 则取消通知，耗尽仍空闲则照常通知'),
    waitForSubagents: Schema.boolean().default(true).description('与 dsh web 会话列表状态对齐：会话树内仍有 subagent 运行时不通知，全部结束才通知（后台长跑任务期间持续静默；子代理中途销毁同样计入静默）'),
    subagentQuietMs: Schema.number().default(500).description('子代理已创建但状态未观测到时的竞态兜底窗口（毫秒）：窗口内转 running 则继续等待，耗尽仍无动静则照常通知（只会迟到不会丢）'),
    fallbackTitle: Schema.string().default('DSH').description('无会话标题时的通知标题兜底'),
    fallbackMessage: Schema.string().default('回复结束（agent 已空闲）').description('未捕获到用户提问时的正文兜底'),
    questionChars: Schema.number().default(80).description('{question} = 本轮用户提问的前 N 个字符；0 = 不含提问'),
    replyChars: Schema.number().default(160).description('{reply} = 本轮 DSH 回复正文的前 N 个字符（默认 160）；0 = 不含回复，正文退回 {question} → fallbackMessage'),
    windowsAumidIcon: Schema.boolean().default(true).description('启动时注册 HKCU\\Software\\Classes\\AppUserModelId（DisplayName + IconUri），让 toast 顶部应用名左侧显示 DSH 小图标；关掉则不写注册表'),
    inlineIcon: Schema.boolean().default(false).description('是否额外在正文左侧放 48×48 的 DSH 图标（appLogoOverride）。默认关：只用归属区小图标，正文通栏'),
    minRunMs: Schema.number().default(0).description('运行不足该毫秒数的轮次不通知'),
});
/**
 * 平台默认提示音文件。windows 项仅在 notifySend=false（无通知面承载
 * 系统音）时使用；通知开着时 windows 默认音就是通知自带的系统通知音。
 */
const DEFAULT_SOUND = {
    linux: '/usr/share/sounds/freedesktop/stereo/bell.oga',
    macos: '/System/Library/Sounds/Glass.aiff',
    windows: 'C:\\Windows\\Media\\Windows Notify.wav',
};
/** Windows toast 借用的系统 PowerShell AUMID（保证通知中心可靠显示）。 */
const POWERSHELL_AUMID = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe';
/**
 * 自有 AUMID + 显示名。Win11 的 toast 顶部“归属区”（应用名 + 16px 小图标）
 * 由 shell 绘制、XML 改不了：应用名取 HKCU\Software\Classes\AppUserModelId
 * 下的 DisplayName，左侧小图标取 IconUri；而正文里的 48px 大图是
 * appLogoOverride（另一回事）。注册必须发生在该 AUMID 第一次发通知之前——
 * shell 会缓存首次见到的归属信息，之后再写注册表不会补图标。
 * 早期快捷方式方案（dsh.lnk）被杀软按 LNK 木马启发式误报，已彻底移除。
 */
const DSH_AUMID = 'DeepSeek.Harness';
const DSH_DISPLAY_NAME = 'DeepSeek Harness';
/** toast 图标：随包携带，退化到安装目录 resources/icon.png（toast 要求 < 200 KB）。 */
const TOAST_ICON_PATH = (() => {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [join(here, 'assets', 'icon.png'), join(dirname(process.execPath), 'resources', 'icon.png')];
    for (const candidate of candidates) {
        try {
            if (existsSync(candidate))
                return candidate;
        }
        catch { /* 路径不可用：继续下一个候选 */ }
    }
    return '';
})();
/** 同一图标的 file:// URL（toast 内联图片需要 URI 形式）。 */
/** 点击原生通知后的置前脚本（user32 ALT 技巧；Electron 自己的 focus 抢不到前台）。 */
const FOCUS_RAISE_SCRIPT = (() => {
    try {
        const candidate = join(dirname(fileURLToPath(import.meta.url)), 'focus-raise.ps1');
        return existsSync(candidate) ? candidate : '';
    }
    catch {
        return '';
    }
})();
const TOAST_ICON = (() => {
    try {
        return TOAST_ICON_PATH === '' ? '' : pathToFileURL(TOAST_ICON_PATH).href;
    }
    catch {
        return '';
    }
})();
/** 注册 AUMID 的显示名与图标（HKCU，幂等，无需管理员）。 */
export function ensureAumidRegistration() {
    if (process.platform !== 'win32' || TOAST_ICON_PATH === '')
        return;
    const key = 'HKCU\\Software\\Classes\\AppUserModelId\\' + DSH_AUMID;
    try {
        execFileSync('reg', ['add', key, '/v', 'DisplayName', '/t', 'REG_SZ', '/d', DSH_DISPLAY_NAME, '/f'], { stdio: 'ignore', timeout: 5000 });
        execFileSync('reg', ['add', key, '/v', 'IconUri', '/t', 'REG_SZ', '/d', TOAST_ICON_PATH, '/f'], { stdio: 'ignore', timeout: 5000 });
    }
    catch { /* 注册失败不影响通知，只是归属区没有小图标 */ }
}
/** dshfocus:// 协议 scheme：点击 toast 时由系统直接调起置前脚本。 */
const FOCUS_PROTOCOL_SCHEME = 'dshfocus';
/**
 * 注册 dshfocus:// 协议（HKCU，幂等，无需管理员）。
 *
 * 为什么必须走协议：Electron 原生通知的 click 只会回到渲染进程的 Notification
 * 对象；从「通知中心」点卡片时激活走 COM 激活器 → 新进程 → 单实例锁失败即退出，
 * 点击payload 丢失，页面永远收不到。改由 Windows 直接按协议调起置前脚本，
 * 横幅点击与通知中心点击才是同一条路。
 */
export function ensureFocusProtocolRegistration() {
    if (process.platform !== 'win32' || FOCUS_RAISE_SCRIPT === '')
        return false;
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const root = 'HKCU\\Software\\Classes\\' + FOCUS_PROTOCOL_SCHEME;
    const command = '"' + powershell + '" -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + FOCUS_RAISE_SCRIPT + '" "%1"';
    try {
        execFileSync('reg', ['add', root, '/ve', '/t', 'REG_SZ', '/d', 'URL:DSH Focus Protocol', '/f'], { stdio: 'ignore', timeout: 5000 });
        execFileSync('reg', ['add', root, '/v', 'URL Protocol', '/t', 'REG_SZ', '/d', '', '/f'], { stdio: 'ignore', timeout: 5000 });
        execFileSync('reg', ['add', root + '\\shell\\open\\command', '/ve', '/t', 'REG_SZ', '/d', command, '/f'], { stdio: 'ignore', timeout: 5000 });
        return true;
    }
    catch {
        return false;
    }
}
/** 是否运行在 Desktop 壳（Electron）：桌面端一律用 WinRT toast，不挂 NotifyIcon 托盘图标。 */
const DESKTOP_HOST = process.platform === 'win32' && typeof process.versions.electron === 'string';
/** 桌面客户端置前深链：桌面壳注册 dsh:// 协议，open-url 仅认 dsh://open（聚焦主窗口，无会话路由）。 */
const DESKTOP_FOCUS_URL = 'dsh://open';
/** Electron webview 的 UA 指纹（桌面 webview 长轮询经 forwardWebRequest 转发后 user-agent 保留）。 */
const ELECTRON_UA_RE = /Electron\/|dsh-desktop\//i;
/** 从 user/message 的 content 块里拼接纯文本（只认 type === 'text'）。 */
function extractText(content) {
    if (!Array.isArray(content))
        return '';
    let out = '';
    for (const block of content) {
        if (block !== null && typeof block === 'object') {
            const b = block;
            if (b.type === 'text' && typeof b.text === 'string')
                out += b.text;
        }
    }
    // 折叠换行与连续空白，通知正文保持单行
    return out.replace(/\s+/g, ' ').trim();
}
/** 回复正文去掉 markdown 标记（代码块整体略去），保持通知里单行可读。 */
function cleanReplyText(s) {
    const fence = String.fromCharCode(96, 96, 96);
    const tick = String.fromCharCode(96);
    const withoutFence = s.split(fence).filter((_, i) => i % 2 === 0).join(' ');
    return withoutFence
        .split(tick).join('')
        .replace(/\*\*([^*]+)\*\*/g, '$1')
        .replace(/^#{1,6}\s*/gm, '')
        .replace(/^[-*+>]\s+/gm, '')
        .replace(/\s+/g, ' ')
        .trim();
}
/** 按 Unicode 码点安全截前 n 字，超出补省略号。 */
function truncate(s, n) {
    const chars = Array.from(s);
    if (chars.length <= n)
        return s;
    return chars.slice(0, n).join('') + '…';
}
/** 模板渲染：{title} {question} {reply} {sessionId} 占位符替换。 */
function render(tpl, vars) {
    return tpl
        .replaceAll('{title}', vars.title)
        .replaceAll('{question}', vars.question)
        .replaceAll('{reply}', vars.reply ?? '')
        .replaceAll('{sessionId}', vars.sessionId);
}
/** fire-and-forget 子进程：失败只经 onFail 上报，永不抛出。 */
function run(cmd, args, onFail) {
    execFile(cmd, args, { timeout: 10_000 }, (err) => {
        if (err)
            onFail(err.message ?? String(err));
    });
}
/** AppleScript 字符串字面量（osascript -e 用）。 */
function appleString(s) {
    return '"' + s.replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"';
}
/**
 * dsh 0.1.7+ web 认证 token（惰性探测一次，进程内缓存）。
 * 来源：journalctl 里 dsh web 启动时打印的 URL（`dsh web: http://…?token=…`）。
 * 深链不带 token 会被认证墙 401 挡成 "authentication required" 文本页，
 * hash 无人消费——点击通知直达会话的能力就此丢失。webUrl 已带 token
 * 或探测失败（非 systemd 环境）时返回空串，深链退回旧行为（依赖浏览器
 * 已有认证 cookie）。
 */
let cachedWebToken = null;
function detectWebToken() {
    if (cachedWebToken !== null)
        return cachedWebToken;
    cachedWebToken = '';
    try {
        // 只读最近输出、只认 dsh web: 打印行，避免大范围日志扫描
        const out = execFileSync('journalctl', ['--user', '-n', '200', '--output', 'cat', '--no-pager'], { timeout: 3000, encoding: 'utf8' });
        const m = [...out.matchAll(/dsh web: (https?:\/\/\S+token=([A-Za-z0-9_-]+))/g)];
        if (m.length > 0)
            cachedWebToken = m[m.length - 1][2];
    }
    catch { /* journalctl 不可用/超时：深链退回无 token 行为 */ }
    return cachedWebToken;
}
/** 深链 URL：点击通知时打开（客户端插件读 hash 定位会话）。
 * dsh 0.1.7+ 认证墙修复：URL 自动附加探测到的 token（query 在 hash 前）。 */
export function deepLinkUrl(config, sessionId) {
    const base = config.webUrl.replace(/\/$/, '');
    const hasToken = /[?&]token=/.test(config.webUrl);
    const token = hasToken ? '' : detectWebToken();
    const query = token === '' ? '' : '?token=' + token;
    return base + '/' + query + config.deepLinkHash + encodeURIComponent(sessionId);
}
/**
 * 判定 notify-send 的 AppArmor profile 是否拦截 GetCapabilities。
 * Ubuntu 25.10+ 的 /etc/apparmor.d/notify-send 把 dbus 白名单限定为
 * GetServerInformation/Notify——libnotify 的 GetCapabilities 被
 * AccessDenied 拒绝，notify-send 误判 "daemon 不支持 actions"，-A 的
 * 点击回调链路无声死亡（通知照常显示，降级警告都没有）。纯函数，
 * 导出供测试。
 */
export function appArmorProfileBlocksCaps(profileText) {
    if (!/profile\s+notify-send\b/.test(profileText))
        return false;
    const dbusRules = profileText.match(/dbus\s*\(send\)([\s\S]*?)(?=\n\s*\n|dbus\s*\(|include|\}|$)/g) ?? [];
    const relevant = dbusRules.filter(r => /org\.freedesktop\.Notifications/.test(r) && /member=/.test(r));
    if (relevant.length === 0)
        return false;
    // 白名单规则存在且不含 GetCapabilities → caps 必被拒
    return relevant.every(r => !/GetCapabilities/.test(r));
}
/**
 * 解析 busctl monitor 输出的一个消息块（busctl monitor 每条消息 = 头行
 * `‣ Type=signal … Member=Xxx` + 缩进参数行）。只关心两个信号：
 *   ActionInvoked (id u, action_key s) —— 用户点击通知的 default action
 *   NotificationClosed (id u, reason u) —— 通知关闭，清理挂起映射
 * 纯函数，导出供测试。
 */
export function parseBusctlMonitorChunk(chunk) {
    const memberMatch = chunk.match(/Member=(ActionInvoked|NotificationClosed)/);
    if (memberMatch === null)
        return null;
    const member = memberMatch[1];
    // busctl monitor 的参数行是大写类型标注：`UINT32 34;` / `STRING "default";`
    const idMatch = chunk.match(/UINT32\s+(\d+)/);
    if (idMatch === null)
        return null;
    const id = Number(idMatch[1]);
    if (member === 'ActionInvoked') {
        const keyMatch = chunk.match(/STRING\s+"([^"]*)"/);
        return { member, id, actionKey: keyMatch !== null ? keyMatch[1] : undefined };
    }
    return { member, id };
}
/**
 * busctl call 发送可点击通知的完整 argv（签名 susssasa{sv}i）。
 * actions 传 ['default', '打开会话']：default 是规范保留名（点击通知体
 * 触发），daemon 侧显示为可点击卡片。expire 0 = daemon 默认驻留（与
 * notify-send -A 不传 -t 同款语义）。纯函数，导出供测试。
 */
export function buildBusctlNotifyArgs(appName, title, body) {
    return [
        '--user', 'call',
        'org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify',
        'susssasa{sv}i',
        appName, '0', 'dialog-information', title, body,
        '2', 'default', '打开会话',
        '0',
        '0',
    ];
}
/**
 * Windows 可点击 toast XML（protocol launch：点击 = 用默认浏览器打开深链）。
 * audio='system'（默认）不带 <audio> 元素 → toast 播系统通知音（单音源
 * 原则的默认路径）；'silent' 显式静音（自定义 soundFile 由 SoundPlayer
 * 承载，或 sound=false）。归属 AUMID 直接决定显示名：默认 POWERSHELL_AUMID，
 * 传 DSH_AUMID 则显示 dsh（未注册 AUMID 的显示名即字符串本身，零文件）。
 */
export function buildToastScript(title, body, launchUrl, audio = 'system', aumid = POWERSHELL_AUMID, iconUrl = '') {
    const launch = launchUrl === undefined ? '' : ' activationType="protocol" launch="' + xmlEscape(launchUrl) + '"';
    const audioEl = audio === 'silent' ? '<audio silent="true"/>' : '';
    // 归属区小图标由 AUMID 注册提供；appLogoOverride 是正文左侧那张 48px 图，默认不传。
    const icon = iconUrl === '' ? '' : '<image placement="appLogoOverride" hint-crop="circle" src="' + xmlEscape(iconUrl) + '"/>';
    const xml = '<toast' + launch + '><visual><binding template="ToastGeneric"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(body) + '</text>' + icon + '</binding></visual>' + audioEl + '</toast>';
    return [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
        "$xml.LoadXml(" + psSingle(xml) + ")",
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + aumid + "').Show($toast)",
    ].join('\n');
}
/**
 * 设置当前 PowerShell 进程显式 AUMID 的脚本（导出供测试解析验证）。
 * balloon 经 shell 提升为 toast 后归属取自进程 AUMID——设置后显示 dsh。
 * 一个 P/Invoke，不创建任何文件、不写注册表、无快捷方式（早期快捷方式
 * 方案被杀软按 LNK 木马启发式报毒，已移除）。
 */
export function buildSetProcessAumidScript(aumid) {
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
    ].join('\n');
}
/** macOS 通知 AppleScript（导出供测试在真实 osascript 下验证）。 */
export function buildMacNotifyScript(title, body) {
    return 'display notification ' + appleString(body) + ' with title ' + appleString(title);
}
/**
 * Windows NotifyIcon balloon 通知脚本（导出供测试在真实 PowerShell 下验证）。
 * shell 把 BalloonTip 提升为 toast 显示；点击路由回 NotifyIcon（Win10/11
 * 兼容行为）→ POST clickUrl {sessionId} → 响应 {open:true}（无在线页面）
 * 或网络失败时 Start-Process 深链兜底。进程驻留至多 waitSeconds 等
 * 点击（DoEvents 消息泵），超时静默退出。默认 5 分钟（通知中心里的
 * 卡片在进程退出后成为死卡片——点击无效果，故驻留要长）。
 */
export function buildBalloonScript(title, body, sessionId, clickUrl, deepLink, waitSeconds, soundOn, aumidSetup = '', raiseScript = '') {
    const secs = Math.max(1, Math.min(3600, Math.ceil(waitSeconds)));
    const tipMs = Math.min(60000, secs * 1000);
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
    ].join('\n');
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
export function buildRaiseBrowserScript() {
    const csharp = [
        'using System;',
        'using System.Runtime.InteropServices;',
        'public static class DshTnRaise {',
        '  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);',
        '  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);',
        '  [DllImport("user32.dll")] public static extern void SwitchToThisWindow(IntPtr hWnd, bool altTab);',
        '  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);',
        '}',
    ].join('\n');
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
    ].join('\n');
}
/** XML 文本节点转义（Windows toast 模板用）。 */
function xmlEscape(s) {
    return s
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;')
        .replaceAll("'", '&apos;');
}
/** PowerShell 单引号字面量（'' 转义内嵌单引号）。 */
function psSingle(s) {
    return "'" + s.replaceAll("'", "''") + "'";
}
/** Windows 提示音脚本（导出供测试验证）。 */
export function buildSoundScript(file) {
    return '(New-Object Media.SoundPlayer ' + psSingle(file) + ').PlaySync()';
}
/** -EncodedCommand 编码（UTF-16LE base64）。 */
export function encodePs(script) {
    return Buffer.from(script, 'utf16le').toString('base64');
}
function detectPlatform(choice) {
    if (choice === 'linux' || choice === 'macos' || choice === 'windows')
        return choice;
    if (process.platform === 'linux')
        return 'linux';
    if (process.platform === 'darwin')
        return 'macos';
    if (process.platform === 'win32')
        return 'windows';
    return undefined;
}
/** 在平台 shell 里执行命令模板。 */
function runShellCommand(platform, cmd, onFail) {
    const shell = platform === 'windows' ? 'cmd' : '/bin/sh';
    const flag = platform === 'windows' ? '/c' : '-c';
    run(shell, [flag, cmd], onFail);
}
/**
 * desktop 客户端判定（纯函数，导出供测试）：页面自识别（client 参数带
 * desktop: 前缀——client.js 检测 dsh-app: 协议后自动添加）为主，服务端
 * UA 指纹兜底（桌面 webview 的长轮询经 forwardWebRequest 转发、UA 保留
 * Electron 标记；覆盖 client.js 未加载/旧版本页面自识别缺席的场景）。
 */
export function isDesktopClient(clientParam, userAgent) {
    return clientParam.startsWith('desktop:') || ELECTRON_UA_RE.test(userAgent);
}
/**
 * 通知通道路由（纯函数，导出供测试）：desktop 原生通道仅在 notifySend
 * 开（通知面存在）、desktopNotify=auto 且桌面在场（desktop 类型长轮询
 * 挂起中或 presence 新鲜）时启用；其余走平台通道（notifySend=false 时
 * 两边都不发——无通知面语义）。
 */
export function chooseNotifyChannel(opts) {
    if (!opts.notifySend)
        return 'none';
    if (opts.desktopNotify === 'auto' && opts.desktopPresent)
        return 'desktop';
    return 'platform';
}
/**
 * 原生通知静音判定（纯函数，导出供测试）：sound=false 全静音；显式
 * soundFile → 通知静音、由宿主平台通道播该文件（单音源原则，与
 * Windows toast 的音源决策一致）；默认 → 通知自带系统音。
 */
export function nativeNotifySilent(opts) {
    return !opts.sound || opts.explicitSoundFile !== '';
}
/** 桌面客户端置前的协议激活 argv（纯函数，导出供测试；未知平台无动作）。 */
export function buildDesktopFocusArgs(platform) {
    if (platform === 'macos')
        return ['open', [DESKTOP_FOCUS_URL]];
    if (platform === 'windows')
        return ['cmd', ['/c', 'start', '', DESKTOP_FOCUS_URL]];
    if (platform === 'linux')
        return ['xdg-open', [DESKTOP_FOCUS_URL]];
    return undefined;
}
export function apply(ctx, config) {
    const platform = detectPlatform(config.platform);
    if (platform === 'windows' && config.windowsAumidIcon)
        ensureAumidRegistration();
    /** Windows 桌面端：注册 dshfocus:// 后通知点击走协议（横幅/通知中心一致）。 */
    const focusProtocolReady = platform === 'windows' && DESKTOP_HOST ? ensureFocusProtocolRegistration() : false;
    /**
     * 宿主实际监听的 origin（webServer 绑定后填充）。Desktop 壳以 --port 0 启动，
     * 配置默认的 127.0.0.1:3080 跟它无关——点击回调打错端口就会静默落进
     * “开浏览器”分支。
     */
    let runtimeOrigin = '';
    const clickBaseUrl = () => (runtimeOrigin !== '' ? runtimeOrigin : config.webUrl).replace(/\/$/, '');
    /** 深链：宿主真实 origin + 认证 token 优先（浏览器打开也不撞认证墙）。 */
    const linkFor = (sessionId) => {
        if (runtimeOrigin === '')
            return deepLinkUrl(config, sessionId);
        let base = runtimeOrigin;
        try {
            const connection = ctx.get?.('connection');
            if (connection?.authenticatedUrl !== undefined)
                base = connection.authenticatedUrl(runtimeOrigin);
        }
        catch { /* token 不可得：退回裸 origin（浏览器已登录时靠 cookie） */ }
        return base + config.deepLinkHash + encodeURIComponent(sessionId);
    };
    /**
     * toast 的点击目标：dshfocus://focus/<port>/<sessionId>（路径形式，不含 &，
     * 任何 shell 都不会截断）。桌面端没注册协议时返回 undefined。
     */
    const focusProtocolUrl = (sessionId) => {
        if (!focusProtocolReady || runtimeOrigin === '')
            return undefined;
        let port = '';
        try {
            port = new URL(runtimeOrigin).port;
        }
        catch {
            port = '';
        }
        if (port === '' || sessionId === '')
            return undefined;
        return FOCUS_PROTOCOL_SCHEME + '://focus/' + port + '/' + sessionId;
    };
    let protocolProbed = false;
    let protocolRegistered = false;
    /** dsh:// 协议是否已注册（Electron 壳首次启动写入 HKCU）。 */
    const desktopProtocol = () => {
        if (protocolProbed)
            return protocolRegistered;
        protocolProbed = true;
        try {
            execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\dsh\\shell\\open\\command'], { stdio: 'ignore', timeout: 3000 });
            protocolRegistered = true;
        }
        catch {
            protocolRegistered = false;
        }
        return protocolRegistered;
    };
    // 每行前缀带版本：调试时任意一行日志即可识别运行版本（含用户回报）
    const log = (...a) => console.log('[turn-notify v' + PKG_VERSION + ']', ...a);
    const failedOnce = new Set();
    const warnOnce = (channel, msg) => {
        if (failedOnce.has(channel))
            return;
        failedOnce.add(channel);
        log('channel "' + channel + '" failed (只警告一次):', msg);
    };
    const focusQueue = [];
    const focusWaiters = new Set();
    const presenceSeen = new Map();
    // Date.now() 基数：跨宿主重启单调。从 0 计数会在重启后归零，而被未
    // 刷新的旧页面（客户端记着旧 lastSeq）在服务端过滤与客户端去重两处
    // 当作重复条目吞掉——重装插件后不刷新页面时点击被无声丢弃。
    let focusSeq = Date.now();
    const pollHoldMs = Math.max(500, Math.min(10_000, Math.floor(config.presenceTimeoutMs / 2)));
    const FOCUS_TTL_MS = 60_000;
    const FOCUS_QUEUE_MAX = 32;
    const trimFocusQueue = () => {
        const now = Date.now();
        while (focusQueue.length > 0 && (focusQueue[0].ts < now - FOCUS_TTL_MS || focusQueue.length > FOCUS_QUEUE_MAX)) {
            focusQueue.shift();
        }
    };
    const enqueueFocus = (sessionId) => {
        trimFocusQueue();
        focusQueue.push({ seq: ++focusSeq, sessionId, ts: Date.now() });
        const waiters = [...focusWaiters];
        focusWaiters.clear();
        for (const w of waiters)
            w.respond(focusQueue.filter(e => e.seq > w.since));
    };
    const pendingNotifyAcks = new Map();
    const enqueueNotifyEntry = (title, body, sessionId, silent, fallback) => {
        if (!desktopLikelyPresent())
            return false;
        trimFocusQueue();
        const seq = ++focusSeq;
        focusQueue.push({ seq, sessionId, ts: Date.now(), kind: 'notify', title, body, silent });
        const waiters = [...focusWaiters];
        focusWaiters.clear();
        for (const w of waiters)
            w.respond(focusQueue.filter(e => e.seq > w.since));
        const timer = setTimeout(() => {
            pendingNotifyAcks.delete(seq);
            log('desktop 通知 ack 超时 → 平台通道兜底', 'session=' + sessionId);
            fallback();
        }, config.desktopNotifyAckMs);
        if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
            ;
            timer.unref();
        }
        pendingNotifyAcks.set(seq, { timer, fallback, sessionId });
        return true;
    };
    /** 桌面客户端点击原生通知后的宿主侧置前：dsh://open 协议激活 → 单实例 → 聚焦主窗口（幂等，OS 激活已置前时无感）。 */
    const launchDesktopFocus = () => {
        // Windows：优先跑独立脚本（user32 ALT 技巧置前）——dsh://open 的单实例
        // 转发在 Windows 前台锁下拿不到焦点；脚本缺失才退回协议激活。
        if (platform === 'windows' && FOCUS_RAISE_SCRIPT !== '') {
            run('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', FOCUS_RAISE_SCRIPT, 'dshfocus://focus'], () => {
                const target = buildDesktopFocusArgs(platform);
                if (target !== undefined)
                    run(target[0], target[1], (m) => warnOnce('desktop-focus', m));
            });
            return;
        }
        const target = buildDesktopFocusArgs(platform);
        if (target === undefined)
            return;
        run(target[0], target[1], (m) => warnOnce('desktop-focus', m));
    };
    /** 页面在线判据：任一 client 的长轮询最近到达时间在阈值内。 */
    const presenceFresh = () => {
        const now = Date.now();
        let fresh = false;
        for (const [client, p] of presenceSeen) {
            if (now - p.ts > config.presenceTimeoutMs * 3)
                presenceSeen.delete(client);
            else if (now - p.ts < config.presenceTimeoutMs)
                fresh = true;
        }
        return fresh;
    };
    /** 桌面 webview 在场：瞬时（desktop 类型长轮询挂起中）优先，presence 时间窗兜底（语义对齐 presenceLikelyOnline）。 */
    const desktopLikelyPresent = () => {
        for (const w of focusWaiters) {
            if (w.desktop)
                return true;
        }
        const now = Date.now();
        for (const p of presenceSeen.values()) {
            if (p.desktop && now - p.ts < config.presenceTimeoutMs)
                return true;
        }
        return false;
    };
    ctx.inject(['webServer'], (scope) => {
        const wsCtx = scope;
        try {
            runtimeOrigin = wsCtx.webServer.getOrigin?.() ?? '';
        }
        catch { /* 监听未就绪：保持配置兜底 */ }
        const disposeWait = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/focus-wait',
            handler: (req, res) => {
                const url = new URL(req.url ?? '/', 'http://x');
                const client = String(url.searchParams.get('client') ?? '').slice(0, 72);
                const since = Number(url.searchParams.get('since') ?? '0') || 0;
                // desktop 判定：页面自识别前缀为主，UA 指纹兜底（转发保留 UA）
                const headers = req.headers;
                const ua = typeof headers?.['user-agent'] === 'string' ? headers['user-agent'] : '';
                const desktop = isDesktopClient(client, ua);
                if (client.length > 0)
                    presenceSeen.set(client, { ts: Date.now(), desktop });
                trimFocusQueue();
                const respond = (entries) => {
                    try {
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ entries: entries.map(e => e.kind === 'notify'
                                ? { seq: e.seq, kind: 'notify', sessionId: e.sessionId, title: e.title ?? '', body: e.body ?? '', silent: e.silent === true }
                                : { seq: e.seq, sessionId: e.sessionId }) }));
                    }
                    catch { /* 客户端已断开：挂起响应作废 */ }
                };
                const pending = focusQueue.filter(e => e.seq > since);
                if (pending.length > 0) {
                    respond(pending);
                    return;
                }
                const timer = setTimeout(() => {
                    focusWaiters.delete(waiter);
                    waiter.respond([]);
                }, pollHoldMs);
                if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
                    ;
                    timer.unref();
                }
                const waiter = {
                    since,
                    desktop,
                    respond: (entries) => {
                        clearTimeout(timer);
                        respond(entries);
                    },
                };
                focusWaiters.add(waiter);
            },
        });
        const disposePost = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/focus',
            handler: (req, res) => {
                const chunks = [];
                const r = req;
                const finish = (sessionId) => {
                    if (sessionId.length > 0 && sessionId.length <= 256) {
                        log('focus 广播 →', sessionId);
                        enqueueFocus(sessionId);
                    }
                    try {
                        res.writeHead(204).end();
                    }
                    catch { /* 客户端已断开 */ }
                };
                if (typeof r.on !== 'function') {
                    finish('');
                    return;
                }
                let size = 0;
                r.on('data', (d) => {
                    size += (d ?? Buffer.alloc(0)).length;
                    if (size <= 1_000_000)
                        chunks.push(d ?? Buffer.alloc(0));
                });
                r.on('end', () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        finish(typeof body.sessionId === 'string' ? body.sessionId : '');
                    }
                    catch {
                        finish('');
                    }
                });
                r.on('error', () => finish(''));
            },
        });
        // balloon 点击回调入口：入队聚焦 + 告知回调方是否需要深链开浏览器
        // （页面在线 → {open:false}，已开页面原地切换；离线 → {open:true}，
        // 调用方 Start-Process 深链）。在线判定用瞬时真值（当下是否有挂起的
        // focus-wait 请求）：时间窗推断（presenceFresh）在页面刚关闭时会误判
        // 在线 → open:false → 点击无任何效果。
        const disposeClick = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/click',
            handler: (req, res) => {
                const chunks = [];
                const r = req;
                const finish = (sessionId) => {
                    const valid = sessionId.length > 0 && sessionId.length <= 256;
                    const open = !valid || focusWaiters.size === 0;
                    if (valid) {
                        log('balloon click →', sessionId, 'open=' + open, 'waiters=' + focusWaiters.size);
                        enqueueFocus(sessionId);
                    }
                    try {
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ open }));
                    }
                    catch { /* 客户端已断开 */ }
                };
                if (typeof r.on !== 'function') {
                    finish('');
                    return;
                }
                let size = 0;
                r.on('data', (d) => {
                    size += (d ?? Buffer.alloc(0)).length;
                    if (size <= 1_000_000)
                        chunks.push(d ?? Buffer.alloc(0));
                });
                r.on('end', () => {
                    try {
                        const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        finish(typeof body.sessionId === 'string' ? body.sessionId : '');
                    }
                    catch {
                        finish('');
                    }
                });
                r.on('error', () => finish(''));
            },
        });
        // 以下两个路由共用的 JSON 体读取（上限 1MB；异常/缺席一律回 null）
        const readJsonBody = (req, cb) => {
            const chunks = [];
            const r = req;
            if (typeof r.on !== 'function') {
                cb(null);
                return;
            }
            let size = 0;
            r.on('data', (d) => {
                size += (d ?? Buffer.alloc(0)).length;
                if (size <= 1_000_000)
                    chunks.push(d ?? Buffer.alloc(0));
            });
            r.on('end', () => {
                try {
                    cb(JSON.parse(Buffer.concat(chunks).toString('utf8')));
                }
                catch {
                    cb(null);
                }
            });
            r.on('error', () => cb(null));
        };
        // desktop 原生通知的展示 ack：页面在 Web Notification 弹出后回执；
        // 未按期到达 → enqueueNotifyEntry 的超时兜底走平台通道（宁重复不丢失）
        const disposeNotifyAck = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/notify-ack',
            handler: (req, res) => {
                readJsonBody(req, (body) => {
                    const seq = body?.seq;
                    if (typeof seq === 'number' && Number.isInteger(seq)) {
                        const pending = pendingNotifyAcks.get(seq);
                        if (pending !== undefined) {
                            clearTimeout(pending.timer);
                            pendingNotifyAcks.delete(seq);
                            log('desktop 通知 ack →', 'seq=' + seq, 'session=' + pending.sessionId);
                        }
                    }
                    try {
                        res.writeHead(204).end();
                    }
                    catch { /* 客户端已断开 */ }
                });
            },
        });
        // desktop 原生通知点击回执：页面已 sessions.open 切会话；宿主补两件
        // 事——广播聚焦（浏览器标签页后台同步切到目标会话）+ dsh://open
        // 协议激活把桌面窗口幂等置前（OS 激活未生效时的保险丝）
        const disposeClicked = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/clicked',
            handler: (req, res) => {
                readJsonBody(req, (body) => {
                    const sessionId = body?.sessionId;
                    if (typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 256) {
                        log('desktop 原生通知点击 → 广播聚焦 + 置前', 'session=' + sessionId);
                        enqueueFocus(sessionId);
                    }
                    launchDesktopFocus();
                    try {
                        res.writeHead(204).end();
                    }
                    catch { /* 客户端已断开 */ }
                });
            },
        });
        log('聚焦通道已注册: GET /turn-notify/focus-wait（长轮询 ' + pollHoldMs + 'ms）+ POST /turn-notify/focus + POST /turn-notify/click + POST /turn-notify/notify-ack + POST /turn-notify/clicked');
        wsCtx.effect(() => () => {
            disposeWait();
            disposePost();
            disposeClick();
            disposeNotifyAck();
            disposeClicked();
            for (const [, p] of pendingNotifyAcks)
                clearTimeout(p.timer);
            pendingNotifyAcks.clear();
            for (const w of [...focusWaiters])
                w.respond([]);
        }, 'turn-notify: focus routes');
    });
    /**
     * 发起通知时的在线预判（选 balloon/toast 用）：瞬时真值（挂起中的
     * 长轮询）优先；时间窗兜底覆盖页面恰好处于两轮询间隙的抖动——否则
     * 会无谓地降级到 toast 深链模式（点击必开新标签页）。
     */
    const presenceLikelyOnline = () => focusWaiters.size > 0 || presenceFresh();
    /**
     * 点击回调（Linux notify-send -A 的进程内回调）：页面在线 → 入队分发
     * 给已开页面（零浏览器启动，不重复开标签页）；离线 → OS 深链打开，
     * 新页面读 hash 定位会话并开始长轮询，后续点击即走复用路径。
     * Windows balloon 点击经 /turn-notify/click 端点（同样语义）；
     * macOS 无进程内回调（点击=系统直接用浏览器打开深链 URL）。
     */
    const handleNotificationClick = (sessionId) => {
        if (focusWaiters.size > 0) {
            log('notification click → 分发给已开 Web 页面:', sessionId);
            enqueueFocus(sessionId);
            return;
        }
        log('notification click → 无活跃页面，深链打开:', sessionId);
        const opener = platform === 'macos' ? 'open' : platform === 'windows' ? 'cmd' : 'xdg-open';
        const args = platform === 'windows' ? ['/c', 'start', '', deepLinkUrl(config, sessionId)] : [deepLinkUrl(config, sessionId)];
        run(opener, args, (m) => warnOnce('deep-link', m));
    };
    const pendingClicks = new Map();
    const PENDING_TTL_MS = 15 * 60_000;
    const PENDING_MAX = 64;
    /** 登记点击映射；GNOME 50 的 daemon 过期不发 NotificationClosed，靠 TTL+上限清理防泄漏。 */
    const rememberClick = (id, sessionId) => {
        const now = Date.now();
        for (const [k, v] of pendingClicks) {
            if (now - v.ts > PENDING_TTL_MS)
                pendingClicks.delete(k);
        }
        while (pendingClicks.size >= PENDING_MAX) {
            const oldest = pendingClicks.keys().next().value;
            if (oldest === undefined)
                break;
            pendingClicks.delete(oldest);
        }
        pendingClicks.set(id, { sessionId, ts: now });
    };
    /** Linux 点击后端是否已切到 busctl（静态探测或运行时切换置位）。 */
    let linuxUseBusctl = false;
    const linuxBackendChoice = config.linuxClickBackend;
    if (platform === 'linux' && linuxBackendChoice === 'busctl')
        linuxUseBusctl = true;
    if (platform === 'linux' && linuxBackendChoice === 'auto') {
        // 静态探测：Ubuntu 25.10+ 的 enforce profile 拦 GetCapabilities，
        // notify-send -A 必死；命中即直接走 busctl，省掉首条通知的无效尝试。
        try {
            const profilePath = '/etc/apparmor.d/notify-send';
            if (existsSync(profilePath) && appArmorProfileBlocksCaps(readFileSync(profilePath, 'utf8'))) {
                linuxUseBusctl = true;
                log('检测到 notify-send 的 AppArmor 限制（GetCapabilities 被拦）→ 点击通道用 busctl 直发');
            }
        }
        catch { /* 读不到按未限制处理，运行时兜底仍会切换 */ }
    }
    /**
     * 常驻 busctl monitor：监听 ActionInvoked（点击 default action）与
     * NotificationClosed（清理映射防泄漏）。子进程崩溃自动重启（退避上限
     * 30s）；插件卸载时终止。
     */
    let monitorProc;
    let monitorStopped = false;
    let monitorBackoffMs = 1000;
    let monitorBuf = '';
    const BUSCTL_MONITOR_ARGS = [
        '--user', 'monitor',
        '--match', "type='signal',interface='org.freedesktop.Notifications',member='ActionInvoked'",
        '--match', "type='signal',interface='org.freedesktop.Notifications',member='NotificationClosed'",
    ];
    const handleMonitorBlock = (p) => {
        const parsed = parseBusctlMonitorChunk(p);
        if (parsed === null)
            return;
        if (parsed.member === 'NotificationClosed') {
            pendingClicks.delete(parsed.id);
            return;
        }
        // ActionInvoked：只认我们自己发出且尚未消费的通知
        if (parsed.actionKey !== 'default')
            return;
        const pending = pendingClicks.get(parsed.id);
        if (pending === undefined)
            return;
        pendingClicks.delete(parsed.id);
        handleNotificationClick(pending.sessionId);
    };
    const feedMonitorChunk = (text) => {
        monitorBuf += text;
        // busctl monitor 每条消息以 ‣ 头行开始、以 MESSAGE 块的 }; 收尾。
        // 只按 ‣ 分割会把流末尾的最后一条（无后续 ‣ 触发切分）永远留在
        // 缓冲——ActionInvoked 恰恰常是最后一条。完整块（含 };）立即解析。
        const parts = monitorBuf.split(/^‣/m);
        monitorBuf = parts.pop() ?? '';
        for (const p of parts)
            handleMonitorBlock(p);
        if (/\}\s*;\s*$/.test(monitorBuf)) {
            const complete = monitorBuf;
            monitorBuf = '';
            handleMonitorBlock(complete);
        }
    };
    const startBusctlMonitor = () => {
        if (monitorStopped || monitorProc !== undefined || platform !== 'linux')
            return;
        try {
            const proc = spawn('busctl', BUSCTL_MONITOR_ARGS, { stdio: ['ignore', 'pipe', 'ignore'] });
            monitorProc = proc;
            proc.stdout.setEncoding('utf8');
            proc.stdout.on('data', (d) => feedMonitorChunk(d));
            // 不阻止宿主进程退出（一次性任务/测试场景）；monitor 随进程生命周期终结
            proc.unref?.();
            proc.stdout.unref?.();
            proc.on('exit', () => {
                monitorProc = undefined;
                if (monitorStopped || !linuxUseBusctl)
                    return;
                // 崩溃重启（指数退避，上限 30s；重启后 pendingClicks 仍有效——
                // 通知还开着就还能点，只是错过信号的窗口内点击丢失，可接受）
                const wait = monitorBackoffMs;
                monitorBackoffMs = Math.min(30_000, monitorBackoffMs * 2);
                const t = setTimeout(() => { startBusctlMonitor(); }, wait);
                if (typeof t === 'object' && t !== null && 'unref' in t)
                    t.unref();
            });
            proc.on('error', () => {
                monitorProc = undefined;
                warnOnce('busctl-monitor', 'busctl monitor 启动失败（通知显示不受影响，点击回调不可用）');
            });
            monitorBackoffMs = 1000;
        }
        catch {
            warnOnce('busctl-monitor', 'busctl monitor spawn 异常');
        }
    };
    if (linuxUseBusctl)
        startBusctlMonitor();
    ctx.effect(() => () => {
        monitorStopped = true;
        monitorProc?.kill();
        monitorProc = undefined;
    }, 'turn-notify: busctl monitor');
    /**
     * fire-and-forget 桌面通知（按平台分发；notifyCommand 可完全接管）。
     * soundFileOverride 与 sendSound 同源（提问用 questionSoundFile）：Windows
     * 据它决定音源——显式文件 → toast 静音 + SoundPlayer；留空 → 系统通知音。
     */
    const sendDesktop = (title, body, vars, soundFileOverride = '') => {
        const clickable = config.clickToFocus && config.notifySend;
        if (config.notifyCommand) {
            runShellCommand(platform, render(config.notifyCommand, vars), (m) => warnOnce('notify-command', m));
            return;
        }
        if (platform === 'linux') {
            // 点击回调后端决策：
            //   busctl（优先，auto 模式下 AppArmor 拦截时自动启用）——
            //     Ubuntu 25.10+ 给 /usr/bin/notify-send 加了 enforce profile，dbus
            //     白名单只有 GetServerInformation/Notify：libnotify 的
            //     GetCapabilities 被 AccessDenied 拒绝 → notify-send 误判 "daemon
            //     不支持 actions" → -A 回调无声死亡（通知照常显示但点击无效）。
            //     busctl 是 systemd 标配且 unconfined：busctl call 直发 Notify
            //     （actions 完整送达），busctl monitor 常驻监听 ActionInvoked
            //     信号驱动点击回调。
            //   notify-send -A（传统路径）—— -A 隐含 --wait，进程阻塞到点击，
            //     stdout 输出 action 名；未被 AppArmor 限制的系统继续用它。
            if (clickable && config.notifyActivateActions && linuxUseBusctl) {
                execFile('busctl', buildBusctlNotifyArgs(config.appName, title, body), { timeout: 10_000 }, (err, stdout) => {
                    if (err !== null) {
                        // busctl 不可用（非 systemd 环境）→ 降级 notify-send 传统路径
                        warnOnce('busctl', err.message ?? String(err));
                        run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m));
                        return;
                    }
                    // stdout 形如 "u 33"：解析 daemon 分配的通知 id，挂到点击映射
                    const idMatch = String(stdout).match(/u\s+(\d+)/);
                    if (idMatch !== null)
                        rememberClick(Number(idMatch[1]), vars.sessionId);
                });
            }
            else if (clickable && config.notifyActivateActions) {
                // -A（点击 action）隐含 --wait：进程阻塞到卡片关闭/点击，stdout 输出
                // action 名。fire-and-forget 的 execFile 子进程天然承载这个等待；点击
                // → exit 0 + stdout=default → 触发回调。守护进程不支持 action 时
                // notify-send 报错退出，onFail 里降级重发普通通知。
                // -A 卡片不传 -t：过期会让用户来不及点；守护进程用自家驻留时长
                const child = execFile('notify-send', ['-a', config.appName, '-A', 'default=打开会话', title, body], { timeout: 0 }, (err, stdout, stderr) => {
                    if (err !== null) {
                        if (/not supported/i.test(String(stderr)) && linuxBackendChoice === 'auto') {
                            // AppArmor 拦截 / daemon 真不支持 actions 的同款症状：运行时
                            // 自动切换 busctl 通道并重发本条（点击能力即刻恢复）。
                            linuxUseBusctl = true;
                            startBusctlMonitor();
                            log('notify-send -A 不可用 → 运行时切换 busctl 点击通道');
                            execFile('busctl', buildBusctlNotifyArgs(config.appName, title, body), { timeout: 10_000 }, (err2, stdout2) => {
                                if (err2 !== null) {
                                    run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m));
                                    return;
                                }
                                const idMatch = String(stdout2).match(/u\s+(\d+)/);
                                if (idMatch !== null)
                                    rememberClick(Number(idMatch[1]), vars.sessionId);
                            });
                            return;
                        }
                        // 守护进程不支持 action（常见于部分 DE）——降级为普通通知
                        run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m));
                        return;
                    }
                    if (String(stdout).trim() === 'default')
                        handleNotificationClick(vars.sessionId);
                });
                child.unref?.();
            }
            else {
                run('notify-send', ['-a', config.appName, '-t', String(config.expireMs), title, body], (m) => warnOnce('notify-send', m));
            }
        }
        else if (platform === 'macos') {
            // 点击回调优先 terminal-notifier（-open 点击打开深链）；没有则纯展示
            if (clickable) {
                execFile(config.terminalNotifierPath, ['-title', config.appName, '-message', body, '-subtitle', title, '-open', deepLinkUrl(config, vars.sessionId), '-activate', 'com.apple.Safari', '-group', vars.sessionId], { timeout: 0 }, (err) => {
                    if (err !== null)
                        run('osascript', ['-e', buildMacNotifyScript(title, body)], (m) => warnOnce('osascript', m));
                }).unref?.();
            }
            else {
                run('osascript', ['-e', buildMacNotifyScript(title, body)], (m) => warnOnce('osascript', m));
            }
        }
        else if (platform === 'windows') {
            // 音源决策：显式 soundFile → toast 静音 + SoundPlayer 承载；留空 →
            // toast 系统通知音（不再叠 SoundPlayer）；sound=false → 全静音。
            const explicitFile = soundFileOverride !== '' ? soundFileOverride : config.soundFile;
            const customSound = config.sound && explicitFile !== '';
            // 点击机制：balloon（进程内回调，复用已开页面）优先；自定义音或
            // 显式 toast 模式或页面离线时用 protocol launch（点击=系统开浏览器）。
            // 桌面端宿主（Electron 壳）一律走 WinRT toast：balloon 虽然能原地切会话，
            // 但代价是每条通知挂一个托盘图标 + 常驻 PowerShell；桌面端用 dsh:// 把点击
            // 交给应用本身，归属区也由 AUMID 注册提供图标。
            const wantBalloon = clickable && !customSound
                && (config.windowsClickMode === 'balloon'
                    || (!DESKTOP_HOST && config.windowsClickMode === 'auto' && presenceLikelyOnline()));
            // 归属品牌（零文件）：toast 直接以 DSH_AUMID 发出（显示名 = 'dsh'）；
            // balloon 经进程 AUMID 设置。windowsToastAumid=powershell 时全部回退。
            const branded = config.windowsToastAumid === 'auto';
            const toastAumid = branded ? DSH_AUMID : POWERSHELL_AUMID;
            const aumidSetup = branded ? buildSetProcessAumidScript(DSH_AUMID) : '';
            if (wantBalloon) {
                const base = clickBaseUrl();
                const script = buildBalloonScript(title, body, vars.sessionId, base + '/turn-notify/click', linkFor(vars.sessionId), Math.ceil(config.balloonWaitMs / 1000), config.sound, aumidSetup);
                // balloon 进程驻留等点击（至多 balloonWaitMs，默认 5 分钟），execFile
                // 的 10s 通用超时不够；timeout 0 + unref（与 Linux notify-send -A 同款）。
                const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(script)], { timeout: 0 }, (err) => {
                    if (err !== null) {
                        // balloon 失败（无桌面会话等）→ 降级 toast（无点击深链照发）
                        const launch = !clickable ? undefined : DESKTOP_HOST ? (focusProtocolUrl(vars.sessionId) ?? (desktopProtocol() ? DESKTOP_FOCUS_URL : undefined)) : linkFor(vars.sessionId);
                        run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch, 'system', toastAumid, config.inlineIcon ? TOAST_ICON : ''))], (m) => warnOnce('windows-toast', m));
                    }
                });
                child.unref?.();
            }
            else {
                // 桌面端：点击经 dsh:// 交回桌面端（归属区小图标由 AUMID 注册提供）；
                // 协议没注册就不挂点击——绝不把点击重新交回浏览器。
                const launch = !clickable
                    ? undefined
                    : DESKTOP_HOST
                        ? focusProtocolUrl(vars.sessionId) ?? (desktopProtocol() ? DESKTOP_FOCUS_URL : undefined)
                        : linkFor(vars.sessionId);
                const audio = customSound || !config.sound ? 'silent' : 'system';
                run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch, audio, toastAumid, config.inlineIcon ? TOAST_ICON : ''))], (m) => warnOnce('windows-toast', m));
            }
        }
        else {
            warnOnce('platform', '未知平台（process.platform=' + process.platform + '），只有 bell/command 通道可用');
        }
    };
    /** fire-and-forget 提示音（按平台分发；soundCommand 可完全接管）。 */
    const sendSound = (vars, fileOverride = '') => {
        if (config.soundCommand) {
            runShellCommand(platform, render(config.soundCommand, vars), (m) => warnOnce('sound-command', m));
            return;
        }
        const file = fileOverride !== '' ? fileOverride : config.soundFile !== '' ? config.soundFile : platform !== undefined ? DEFAULT_SOUND[platform] : '';
        if (file === '' || !existsSync(file)) {
            warnOnce('sound', '提示音文件不存在: ' + (file === '' ? '(无平台默认)' : file));
            return;
        }
        if (platform === 'linux') {
            run('paplay', [file], (m) => warnOnce('paplay', m));
        }
        else if (platform === 'macos') {
            run('afplay', [file], (m) => warnOnce('afplay', m));
        }
        else if (platform === 'windows') {
            run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildSoundScript(file))], (m) => warnOnce('windows-sound', m));
        }
    };
    /**
     * Windows 单音源判定：通知面已带系统通知音（notifySend 开、sound 开、
     * 无显式 soundFile/override）时跳过 SoundPlayer，避免双音效。
     */
    const windowsSystemAudioCovers = (override) => platform === 'windows' && config.notifySend && config.sound
        && (override !== '' ? override : config.soundFile) === '';
    /**
     * 通知面投递总入口（轮次结束 + 提问共用）：desktop 原生通道优先
     * （desktopNotify=auto 且桌面在场）——经长轮询投递 {kind:'notify'}
     * 条目 + ack 计时，超时/不在场走平台通道 sendDesktop（行为与旧版
     * 一致）。soundFileOverride 语义不变（提问用 questionSoundFile）。
     */
    const deliverDesktopNotify = (title, body, vars, soundFileOverride = '') => {
        if (!config.notifySend)
            return;
        if (chooseNotifyChannel({ notifySend: config.notifySend, desktopNotify: focusProtocolReady ? 'off' : config.desktopNotify, desktopPresent: desktopLikelyPresent() }) === 'desktop') {
            const explicitFile = soundFileOverride !== '' ? soundFileOverride : config.soundFile;
            const silent = nativeNotifySilent({ sound: config.sound, explicitSoundFile: explicitFile });
            log('desktop 原生通知投递', 'session=' + vars.sessionId, 'silent=' + silent);
            const armed = enqueueNotifyEntry(title, body, vars.sessionId, silent, () => {
                sendDesktop(title, body, vars, soundFileOverride);
            });
            if (armed)
                return;
        }
        sendDesktop(title, body, vars, soundFileOverride);
    };
    const info = new Map();
    const getInfo = (id) => {
        let v = info.get(id);
        if (v === undefined) {
            v = {};
            info.set(id, v);
        }
        return v;
    };
    /**
     * 解析会话标题（三级回退）：live 追踪 → 宿主 sessionTitle 服务折叠 → undefined。
     * 服务折叠覆盖 resume 场景：重启后既有会话的历史标题事件是构造种子，
     * 不会经 session/event 重播（live 追踪看不到），但日志折叠读得到。
     */
    const resolveTitle = (session, sessionId) => {
        const live = info.get(sessionId)?.title;
        if (live !== undefined && live.length > 0)
            return live;
        if (session === undefined || session === null)
            return undefined;
        const svc = ctx.get('sessionTitle');
        const folded = svc?.get(session)?.title;
        return typeof folded === 'string' && folded.length > 0 ? folded : undefined;
    };
    /** 该会话的 goal 是否会自动续跑（live goal/changed 维护）。 */
    const goalWillContinue = new Map();
    /** 兜底窗口中的定时器（续跑兜底：窗口耗尽仍未 running 则通知）。 */
    const pendingQuiet = new Map();
    /** 每个 agent 的 running 起始时刻，用于 minRunMs 过滤。 */
    const runningSince = new Map();
    const cancelQuiet = (sessionId) => {
        const t = pendingQuiet.get(sessionId);
        if (t !== undefined) {
            clearTimeout(t);
            pendingQuiet.delete(sessionId);
        }
    };
    const lineage = new Map();
    /** 当前 running 的全部会话（含 subagent；agent/status 维护）。 */
    const runningSessions = new Set();
    /** 根 idle 后正在等子树静默的会话（事件驱动挂起，无定时器）。 */
    const waitingQuiesce = new Set();
    /** 创建→running 竞态兜底窗口的定时器。 */
    const pendingSubagentQuiet = new Map();
    const registerLineage = (session) => {
        if (session === null || typeof session !== 'object')
            return;
        const s = session;
        if (s.id === undefined)
            return;
        const id = String(s.id);
        const entry = lineage.get(id) ?? { subagent: false, statusSeen: false };
        if (s.header?.parentSession !== undefined)
            entry.parent = String(s.header.parentSession);
        if (s.header?.origin === 'subagent')
            entry.subagent = true;
        lineage.set(id, entry);
    };
    /** 官方"根"判据：header.origin !== 'subagent'（fork 也是顶层会话）。 */
    const isRootSession = (session) => {
        if (session === null || typeof session !== 'object')
            return true;
        return session.header?.origin !== 'subagent';
    };
    /** 从 sessionId 沿 parentSession 链向上的全部祖先（近→远，含顶层根；循环安全）。 */
    const ancestorsOf = (sessionId) => {
        const out = [];
        const seen = new Set([sessionId]);
        let cur = lineage.get(sessionId);
        while (cur !== undefined && cur.subagent && cur.parent !== undefined && !seen.has(cur.parent)) {
            seen.add(cur.parent);
            out.push(cur.parent);
            cur = lineage.get(cur.parent);
        }
        return out;
    };
    /** sessionId 的全部 subagent 后代（任意深度；与 web 记账方向一致：由后代向祖先归属）。 */
    const descendantsOf = (sessionId) => {
        const out = [];
        for (const [id, entry] of lineage) {
            if (!entry.subagent)
                continue;
            if (ancestorsOf(id).includes(sessionId))
                out.push(id);
        }
        return out;
    };
    const cancelSubagentQuiet = (sessionId) => {
        const t = pendingSubagentQuiet.get(sessionId);
        if (t !== undefined) {
            clearTimeout(t);
            pendingSubagentQuiet.delete(sessionId);
        }
    };
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
    const registrySync = (mode) => {
        try {
            const registry = ctx.get('agents');
            if (typeof registry?.list !== 'function')
                return false;
            const live = new Set();
            for (const agent of registry.list()) {
                const session = agent?.session;
                if (session === null || typeof session !== 'object' || session.id === undefined)
                    continue;
                registerLineage(session);
                const key = String(session.id);
                live.add(key);
                getInfo(key).session = session;
                const entry = lineage.get(key);
                if (agent.status === 'running') {
                    runningSessions.add(key);
                    if (entry !== undefined)
                        entry.statusSeen = true;
                }
                else {
                    // idle：repair 只修复已观测会话的运行位；baseline 额外登记
                    // 首次观测（mid-life 会话不会再来首个 status 事件）
                    if (entry !== undefined && entry.statusSeen)
                        runningSessions.delete(key);
                    if (mode === 'baseline' && entry !== undefined)
                        entry.statusSeen = true;
                }
            }
            // 注册表缺席且从未观测的 subagent：agent 已不在（从未驱动即销毁/
            // 已收尾），该会话不会再跑——视同已观测且不再运行
            for (const [key, entry] of lineage) {
                if (entry.subagent && !live.has(key) && !entry.statusSeen) {
                    entry.statusSeen = true;
                    runningSessions.delete(key);
                }
            }
            return true;
        }
        catch {
            return false;
        }
    };
    // 现场自举（web 冷启动 session.list 的对应物）：只登记、不触发通知
    if (registrySync('baseline')) {
        const running = [...runningSessions].length;
        log('现场自举: live agents=' + lineage.size, 'running=' + running);
    }
    /** 真正发出一次轮次结束通知（全部静默判定通过后唯一的出口）。 */
    const notifyNow = (sessionId) => {
        // 立即通知路径可能撞上仍在计时的静默窗口定时器：先取消，
        // 否则定时器到点会再 fire 一次（双通知）。
        cancelQuiet(sessionId);
        cancelSubagentQuiet(sessionId);
        waitingQuiesce.delete(sessionId);
        const s = info.get(sessionId);
        const rawTitle = resolveTitle(s?.session, sessionId) ?? config.fallbackTitle;
        const question = config.questionChars > 0 && s?.question !== undefined && s.question.length > 0
            ? truncate(s.question, config.questionChars)
            : '';
        // 正文默认展示本轮 DSH 回复（{reply}）；没捕获到回复才退回提问。
        const reply = config.replyChars > 0 && s?.reply !== undefined && s.reply.length > 0
            ? truncate(s.reply, config.replyChars)
            : '';
        const rawBody = reply !== '' ? reply : question !== '' ? question : config.fallbackMessage;
        const vars = { title: rawTitle, question, reply, sessionId };
        const title = render(config.titleTemplate, vars);
        const rendered = render(config.bodyTemplate, vars).trim();
        const body = rendered === '' ? rawBody : rendered;
        // 命令类通道的占位符注入最终渲染值（与桌面通知显示一致）
        const finalVars = { title, question: body, sessionId };
        log('agent idle → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId);
        deliverDesktopNotify(title, body, finalVars, '');
        if (config.sound && !windowsSystemAudioCovers(''))
            sendSound(finalVars);
        if (config.bell)
            process.stdout.write('\x07');
        if (config.command)
            runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m));
    };
    /**
     * 一次轮次的最终通知决策（根 idle、子树静默触发、竞态窗口到期共用）：
     * 权威重读 → 子代理对齐门 → goal 判别门 → 通知。这是通知唯一的
     * 出口，也是唯一不可撤回的动作——决策前先以注册表现值修复事件
     * 漂移（web 的「拉取供真相」机制落在决策点的形态）。
     * @param skipUnseenWindow 竞态窗口到期重入时为 true——不再因"状态未
     *        观测"二次开窗（否则永不启动的子代理会让窗口无限自续）。
     */
    const settle = (sessionId, skipUnseenWindow = false) => {
        cancelQuiet(sessionId);
        cancelSubagentQuiet(sessionId);
        registrySync('repair');
        if (config.waitForSubagents) {
            const descendants = descendantsOf(sessionId);
            const running = descendants.filter(id => runningSessions.has(id));
            if (running.length > 0) {
                waitingQuiesce.add(sessionId);
                log('idle 但 subagent 仍在跑 → 等待子树静默', 'session=' + sessionId, 'running=' + running.length);
                return;
            }
            if (!skipUnseenWindow && descendants.some(id => !lineage.get(id)?.statusSeen)) {
                waitingQuiesce.add(sessionId);
                log('idle 但 subagent 状态未观测 → 竞态兜底窗口 ' + config.subagentQuietMs + 'ms', 'session=' + sessionId);
                const t = setTimeout(() => {
                    pendingSubagentQuiet.delete(sessionId);
                    settle(sessionId, true);
                }, config.subagentQuietMs);
                if (typeof t === 'object' && t !== null && 'unref' in t) {
                    ;
                    t.unref();
                }
                pendingSubagentQuiet.set(sessionId, t);
                return;
            }
        }
        waitingQuiesce.delete(sessionId);
        // goal 看似还会自动续跑 → 先不响，进兜底窗口等它重新 running。
        if (config.skipGoalRounds && goalWillContinue.get(sessionId) === true) {
            log('idle 但 goal 将续跑 → 进入 ' + config.goalQuietMs + 'ms 静默窗口', 'session=' + sessionId);
            const t = setTimeout(() => notifyNow(sessionId), config.goalQuietMs);
            if (typeof t === 'object' && t !== null && 'unref' in t) {
                ;
                t.unref(); // 不阻止进程退出（一次性任务场景）
            }
            pendingQuiet.set(sessionId, t);
            return;
        }
        notifyNow(sessionId);
    };
    // 会话事实追踪：标题快照（latest-wins）+ 最近一条真人提问。
    ctx.on('session/event', (session, event) => {
        const sessionId = String(session.id);
        registerLineage(session);
        getInfo(sessionId).session = session;
        if (event.type === 'session/title') { // live 快路径；resume 场景由 resolveTitle 的服务折叠兜底
            const data = event.data;
            if (typeof data.title === 'string' && data.title.length > 0) {
                getInfo(sessionId).title = data.title;
            }
        }
        else if (event.type === 'assistant/message') {
            // 本轮最后一条 DSH 回复（latest-wins）：{reply} 用它。
            const data = event.data;
            const text = cleanReplyText(extractText(data?.message?.content));
            if (text.length > 0)
                getInfo(sessionId).reply = text;
        }
        else if (event.type === 'user/message') {
            const data = event.data;
            if (data === null || data.source?.kind !== 'user')
                return;
            const q = extractText(data.content);
            if (q.length === 0)
                return;
            getInfo(sessionId).question = q;
            // 新一轮提问开始：上一轮的回复作废，避免本轮没有 assistant 消息时发旧回复。
            getInfo(sessionId).reply = '';
            // 提问通知（v0.1.1）：真人提问进入会话时立即提示——内容 = 会话标题
            // + 提问文本。steering 插话同样触发；goal 续跑（kind 'goal'）与
            // 注入上下文（kind 'plugin'）已被上面的 source 过滤排除。
            if (!config.notifyOnQuestion)
                return;
            // 官方"根"判据按 origin（fork 有 parentSession 但同样是顶层会话）
            if (config.rootOnly && !isRootSession(session))
                return;
            const rawTitle = resolveTitle(session, sessionId) ?? config.fallbackTitle;
            const rawBody = config.questionChars > 0 ? truncate(q, config.questionChars) : config.fallbackMessage;
            const vars = { title: rawTitle, question: rawBody, sessionId };
            const title = render(config.questionTitleTemplate, vars);
            const body = render(config.questionBodyTemplate, vars);
            const finalVars = { title, question: body, sessionId };
            log('user question → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId);
            deliverDesktopNotify(title, body, finalVars, config.questionSoundFile);
            if (config.sound && !windowsSystemAudioCovers(config.questionSoundFile))
                sendSound(finalVars, config.questionSoundFile);
            if (config.bell)
                process.stdout.write('\x07');
            if (config.command)
                runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m));
        }
    });
    ctx.on('goal/changed', ({ agent, change }) => {
        registerLineage(agent.session);
        const sessionId = String(agent.session.id);
        const g = change.goal;
        const willContinue = g !== undefined &&
            g.phase === 'active' &&
            g.activation === 'armed' &&
            g.roundsStarted < g.maxGoalRounds;
        goalWillContinue.set(sessionId, willContinue);
    });
    // 会话创建即登记血缘：subagent 创建（session/created）到首个
    // agent/status(running) 之间存在微小间隙——根在此间隙内 idle 时，
    // 血缘已在、状态未观测，settle 据此进竞态兜底窗口（而非漏判早响）。
    ctx.on('session/created', (session) => {
        registerLineage(session);
    });
    ctx.on('session/disposed', (session) => {
        const sessionId = String(session.id);
        // 先解析祖先链（lineage 即将收缩/摘除）
        const ancestors = ancestorsOf(sessionId);
        cancelQuiet(sessionId);
        cancelSubagentQuiet(sessionId);
        waitingQuiesce.delete(sessionId);
        runningSessions.delete(sessionId);
        goalWillContinue.delete(sessionId);
        info.delete(sessionId);
        runningSince.delete(sessionId);
        // 与 web 一致：subagent 会话销毁后列表行仍在（running 归 false、
        // 血缘保留——孙辈照旧向根记账，见 api-session-controller 的
        // durable-subagent status 变异），只清运行位；非 subagent（根/fork）
        // 整行消失，血缘随之摘除。
        if (session.header?.origin === 'subagent') {
            const entry = lineage.get(sessionId);
            if (entry !== undefined)
                entry.statusSeen = true; // 已销毁视同不再运行
        }
        else {
            lineage.delete(sessionId);
        }
        // 运行中被销毁（interrupt_agent 等）同样可能让祖先子树静默
        for (const anc of ancestors) {
            if (waitingQuiesce.has(anc) && !runningSessions.has(anc))
                settle(anc);
        }
    });
    ctx.on('agent/status', ({ agent, status }) => {
        const session = agent.session;
        const sessionId = String(session.id);
        registerLineage(session);
        const entry = lineage.get(sessionId);
        if (entry !== undefined)
            entry.statusSeen = true;
        getInfo(sessionId).session = session;
        if (status === 'running') {
            cancelQuiet(sessionId); // 续跑（或其他输入）到来，取消兜底通知
            cancelSubagentQuiet(sessionId);
            waitingQuiesce.delete(sessionId); // 新轮开始，上一轮的挂起通知作废
            runningSessions.add(sessionId);
            runningSince.set(sessionId, Date.now());
            return;
        }
        if (status !== 'idle')
            return;
        runningSessions.delete(sessionId);
        // 该 idle 可能释放等待子树静默的祖先（rootOnly=true 时祖先只会是
        // 根会话；rootOnly=false 时中间 subagent 也可能是通知主体）。
        for (const anc of ancestorsOf(sessionId)) {
            if (waitingQuiesce.has(anc) && !runningSessions.has(anc))
                settle(anc);
        }
        // 本会话作为通知主体：根会话（origin !== 'subagent'，fork 属于顶层），
        // 或 rootOnly=false 时的任意会话（保持旧语义）。
        if (config.rootOnly && !isRootSession(session))
            return;
        const started = runningSince.get(sessionId);
        runningSince.delete(sessionId);
        if (started !== undefined && Date.now() - started < config.minRunMs)
            return;
        settle(sessionId);
    });
    log('loaded; platform=' + (platform ?? 'unknown(' + process.platform + ')'), 'channels:', JSON.stringify({
        notifySend: config.notifySend, sound: config.sound, bell: config.bell,
        command: config.command ? '(custom)' : '(off)', rootOnly: config.rootOnly,
        questionChars: config.questionChars, skipGoalRounds: config.skipGoalRounds,
        goalQuietMs: config.goalQuietMs, waitForSubagents: config.waitForSubagents,
        subagentQuietMs: config.subagentQuietMs, desktopNotify: config.desktopNotify,
        desktopNotifyAckMs: config.desktopNotifyAckMs,
    }));
    ctx.effect(() => () => {
        for (const sessionId of pendingQuiet.keys())
            cancelQuiet(sessionId);
        for (const sessionId of pendingSubagentQuiet.keys())
            cancelSubagentQuiet(sessionId);
        log('disposed');
    });
}
