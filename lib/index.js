import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
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
    terminalNotifierPath: Schema.string().default('terminal-notifier').description('macOS 点击回调依赖的 terminal-notifier 命令（PATH 名或绝对路径）；不存在时 macOS 通知无点击功能（仍正常显示）'),
    windowsClickMode: Schema.union([
        Schema.const('auto').description('页面在线用 balloon（点击复用已开页面、零新标签页），离线用 toast 深链'),
        Schema.const('balloon').description('恒用 NotifyIcon balloon：点击回调进进程，不经浏览器'),
        Schema.const('toast').description('恒用 WinRT toast protocol launch：点击=系统用浏览器打开深链（自定义提示音需要此模式）'),
    ]).default('auto').description('Windows 点击回调机制（balloon 的系统音不可静音/替换，配置 soundFile 时自动落到 toast）'),
    balloonWaitMs: Schema.number().default(30000).description('Windows balloon 等待点击的时长（毫秒）：进程驻留监听点击，超时退出（通知卡片可能仍在通知中心，其后点击无效果）'),
    presenceTimeoutMs: Schema.number().default(15000).description('Web 页面在线判定阈值（毫秒）：focus-wait 长轮询最近到达时间在阈值内 = 页面已开，Linux 点击走零启动复用；超过视为未开，深链新开浏览器'),
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
/** 按 Unicode 码点安全截前 n 字，超出补省略号。 */
function truncate(s, n) {
    const chars = Array.from(s);
    if (chars.length <= n)
        return s;
    return chars.slice(0, n).join('') + '…';
}
/** 模板渲染：{title} {question} {sessionId} 占位符替换。 */
function render(tpl, vars) {
    return tpl
        .replaceAll('{title}', vars.title)
        .replaceAll('{question}', vars.question)
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
/** 深链 URL：点击通知时打开（客户端插件读 hash 定位会话）。 */
function deepLinkUrl(config, sessionId) {
    const base = config.webUrl.replace(/\/$/, '');
    return base + '/' + config.deepLinkHash + encodeURIComponent(sessionId);
}
/**
 * Windows 可点击 toast XML（protocol launch：点击 = 用默认浏览器打开深链）。
 * audio='system'（默认）不带 <audio> 元素 → toast 播系统通知音（单音源
 * 原则的默认路径）；'silent' 显式静音（自定义 soundFile 由 SoundPlayer
 * 承载，或 sound=false）。
 */
export function buildToastScript(title, body, launchUrl, audio = 'system') {
    const launch = launchUrl === undefined ? '' : ' activationType="protocol" launch="' + xmlEscape(launchUrl) + '"';
    const audioEl = audio === 'silent' ? '<audio silent="true"/>' : '';
    const xml = '<toast' + launch + '><visual><binding template="ToastText02"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(body) + '</text></binding></visual>' + audioEl + '</toast>';
    return [
        '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
        '[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom, ContentType = WindowsRuntime] | Out-Null',
        '$xml = New-Object Windows.Data.Xml.Dom.XmlDocument',
        "$xml.LoadXml(" + psSingle(xml) + ")",
        '$toast = New-Object Windows.UI.Notifications.ToastNotification $xml',
        "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('" + POWERSHELL_AUMID + "').Show($toast)",
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
 * 点击（DoEvents 消息泵），超时静默退出。
 */
export function buildBalloonScript(title, body, sessionId, clickUrl, deepLink, waitSeconds, soundOn) {
    return [
        'Add-Type -AssemblyName System.Windows.Forms',
        'Add-Type -AssemblyName System.Drawing',
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
        '$icon.ShowBalloonTip(' + Math.max(1, Math.min(120, Math.ceil(waitSeconds))) * 1000 + ')',
        '$deadline = (Get-Date).AddSeconds(' + Math.max(1, Math.min(300, Math.ceil(waitSeconds))) + ')',
        'while (-not $script:clicked -and (Get-Date) -lt $deadline) {',
        '  [System.Windows.Forms.Application]::DoEvents()',
        '  Start-Sleep -Milliseconds 120',
        '}',
        '$icon.Visible = $false',
        '$icon.Dispose()',
        'if (-not $script:clicked) { exit 0 }',
        'try {',
        '  $r = Invoke-RestMethod -Method Post -Uri $clickUrl -ContentType \'application/json\' -Body $body -TimeoutSec 5',
        '  if ($r.open -eq $true) { Start-Process $deepLink }',
        '} catch {',
        '  Start-Process $deepLink',
        '}',
        'exit 0',
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
export function apply(ctx, config) {
    const platform = detectPlatform(config.platform);
    const log = (...a) => console.log('[turn-notify]', ...a);
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
    let focusSeq = 0;
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
    /** 页面在线判据：任一 client 的长轮询最近到达时间在阈值内。 */
    const presenceFresh = () => {
        const now = Date.now();
        let fresh = false;
        for (const [client, ts] of presenceSeen) {
            if (now - ts > config.presenceTimeoutMs * 3)
                presenceSeen.delete(client);
            else if (now - ts < config.presenceTimeoutMs)
                fresh = true;
        }
        return fresh;
    };
    ctx.inject(['webServer'], (scope) => {
        const wsCtx = scope;
        const disposeWait = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/focus-wait',
            handler: (req, res) => {
                const url = new URL(req.url ?? '/', 'http://x');
                const client = String(url.searchParams.get('client') ?? '').slice(0, 64);
                const since = Number(url.searchParams.get('since') ?? '0') || 0;
                if (client.length > 0)
                    presenceSeen.set(client, Date.now());
                trimFocusQueue();
                const respond = (entries) => {
                    try {
                        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
                        res.end(JSON.stringify({ entries: entries.map(e => ({ seq: e.seq, sessionId: e.sessionId })) }));
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
        // 调用方 Start-Process 深链）。
        const disposeClick = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/click',
            handler: (req, res) => {
                const chunks = [];
                const r = req;
                const finish = (sessionId) => {
                    const open = !(sessionId.length > 0 && sessionId.length <= 256) || !presenceFresh();
                    if (sessionId.length > 0 && sessionId.length <= 256) {
                        log('balloon click →', sessionId, 'open=' + open);
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
        log('聚焦通道已注册: GET /turn-notify/focus-wait（长轮询 ' + pollHoldMs + 'ms）+ POST /turn-notify/focus + POST /turn-notify/click');
        wsCtx.effect(() => () => {
            disposeWait();
            disposePost();
            disposeClick();
            for (const w of [...focusWaiters])
                w.respond([]);
        }, 'turn-notify: focus routes');
    });
    /**
     * 点击回调（Linux notify-send -A 的进程内回调）：页面在线 → 入队分发
     * 给已开页面（零浏览器启动，不重复开标签页）；离线 → OS 深链打开，
     * 新页面读 hash 定位会话并开始长轮询，后续点击即走复用路径。
     * Windows/macOS 无进程内回调（点击=系统直接用浏览器打开深链 URL）。
     */
    const handleNotificationClick = (sessionId) => {
        if (presenceFresh()) {
            log('notification click → 分发给已开 Web 页面:', sessionId);
            enqueueFocus(sessionId);
            return;
        }
        log('notification click → 无活跃页面，深链打开:', sessionId);
        const opener = platform === 'macos' ? 'open' : platform === 'windows' ? 'cmd' : 'xdg-open';
        const args = platform === 'windows' ? ['/c', 'start', '', deepLinkUrl(config, sessionId)] : [deepLinkUrl(config, sessionId)];
        run(opener, args, (m) => warnOnce('deep-link', m));
    };
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
            // -A（点击 action）隐含 --wait：进程阻塞到卡片关闭/点击，stdout 输出
            // action 名。fire-and-forget 的 execFile 子进程天然承载这个等待；点击
            // → exit 0 + stdout=default → 触发回调。守护进程不支持 action 时
            // notify-send 报错退出，onFail 里降级重发普通通知。
            if (clickable && config.notifyActivateActions) {
                // -A 卡片不传 -t：过期会让用户来不及点；守护进程用自家驻留时长
                const child = execFile('notify-send', ['-a', config.appName, '-A', 'default=打开会话', title, body], { timeout: 0 }, (err, stdout) => {
                    if (err !== null) {
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
            const wantBalloon = clickable && !customSound
                && (config.windowsClickMode === 'balloon'
                    || (config.windowsClickMode === 'auto' && presenceFresh()));
            if (wantBalloon) {
                const base = config.webUrl.replace(/\/$/, '');
                const script = buildBalloonScript(title, body, vars.sessionId, base + '/turn-notify/click', deepLinkUrl(config, vars.sessionId), Math.ceil(config.balloonWaitMs / 1000), config.sound);
                // balloon 进程驻留等点击（至多 balloonWaitMs），execFile 的 10s 通用
                // 超时不够；timeout 0 + unref（与 Linux notify-send -A 同款）。
                const child = execFile('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(script)], { timeout: 0 }, (err) => {
                    if (err !== null) {
                        // balloon 失败（无桌面会话等）→ 降级 toast（无点击深链照发）
                        const launch = clickable ? deepLinkUrl(config, vars.sessionId) : undefined;
                        run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch))], (m) => warnOnce('windows-toast', m));
                    }
                });
                child.unref?.();
            }
            else {
                const launch = clickable ? deepLinkUrl(config, vars.sessionId) : undefined;
                const audio = customSound || !config.sound ? 'silent' : 'system';
                run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch, audio))], (m) => warnOnce('windows-toast', m));
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
        const svc = ctx.get('sessionTitle');
        const folded = svc?.get(session)?.title;
        return typeof folded === 'string' && folded.length > 0 ? folded : undefined;
    };
    /** 该会话的 goal 是否会自动续跑（live goal/changed 维护）。 */
    const goalWillContinue = new Map();
    /** 兜底窗口中的定时器（续跑兜底：窗口耗尽仍未 running 则通知）。 */
    const pendingQuiet = new Map();
    const cancelQuiet = (sessionId) => {
        const t = pendingQuiet.get(sessionId);
        if (t !== undefined) {
            clearTimeout(t);
            pendingQuiet.delete(sessionId);
        }
    };
    // 会话事实追踪：标题快照（latest-wins）+ 最近一条真人提问。
    ctx.on('session/event', (session, event) => {
        const sessionId = String(session.id);
        if (event.type === 'session/title') { // live 快路径；resume 场景由 resolveTitle 的服务折叠兜底
            const data = event.data;
            if (typeof data.title === 'string' && data.title.length > 0) {
                getInfo(sessionId).title = data.title;
            }
        }
        else if (event.type === 'user/message') {
            const data = event.data;
            if (data === null || data.source?.kind !== 'user')
                return;
            const q = extractText(data.content);
            if (q.length === 0)
                return;
            getInfo(sessionId).question = q;
            // 提问通知（v0.1.1）：真人提问进入会话时立即提示——内容 = 会话标题
            // + 提问文本。steering 插话同样触发；goal 续跑（kind 'goal'）与
            // 注入上下文（kind 'plugin'）已被上面的 source 过滤排除。
            if (!config.notifyOnQuestion)
                return;
            if (config.rootOnly && session.header?.parentSession !== undefined)
                return;
            const rawTitle = resolveTitle(session, sessionId) ?? config.fallbackTitle;
            const rawBody = config.questionChars > 0 ? truncate(q, config.questionChars) : config.fallbackMessage;
            const vars = { title: rawTitle, question: rawBody, sessionId };
            const title = render(config.questionTitleTemplate, vars);
            const body = render(config.questionBodyTemplate, vars);
            const finalVars = { title, question: body, sessionId };
            log('user question → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId);
            if (config.notifySend)
                sendDesktop(title, body, finalVars, config.questionSoundFile);
            if (config.sound && !windowsSystemAudioCovers(config.questionSoundFile))
                sendSound(finalVars, config.questionSoundFile);
            if (config.bell)
                process.stdout.write('\x07');
            if (config.command)
                runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m));
        }
    });
    ctx.on('goal/changed', ({ agent, change }) => {
        const sessionId = String(agent.session.id);
        const g = change.goal;
        const willContinue = g !== undefined &&
            g.phase === 'active' &&
            g.activation === 'armed' &&
            g.roundsStarted < g.maxGoalRounds;
        goalWillContinue.set(sessionId, willContinue);
    });
    ctx.on('session/disposed', (session) => {
        const sessionId = String(session.id);
        cancelQuiet(sessionId);
        goalWillContinue.delete(sessionId);
        info.delete(sessionId);
    });
    /** 每个 agent 的 running 起始时刻，用于 minRunMs 过滤。 */
    const runningSince = new Map();
    ctx.on('agent/status', ({ agent, status }) => {
        const session = agent.session;
        const sessionId = String(session.id);
        const isRoot = session.header.parentSession === undefined;
        if (status === 'running') {
            cancelQuiet(sessionId); // 续跑（或其他输入）到来，取消兜底通知
            runningSince.set(sessionId, Date.now());
            return;
        }
        if (status !== 'idle')
            return;
        const started = runningSince.get(sessionId);
        runningSince.delete(sessionId);
        if (config.rootOnly && !isRoot)
            return;
        if (started !== undefined && Date.now() - started < config.minRunMs)
            return;
        const notify = () => {
            // 立即通知路径可能撞上仍在计时的静默窗口定时器：先取消，
            // 否则定时器到点会再 fire 一次（双通知）。
            cancelQuiet(sessionId);
            const s = info.get(sessionId);
            const rawTitle = resolveTitle(session, sessionId) ?? config.fallbackTitle;
            const rawBody = config.questionChars > 0 && s?.question !== undefined && s.question.length > 0
                ? truncate(s.question, config.questionChars)
                : config.fallbackMessage;
            const vars = { title: rawTitle, question: rawBody, sessionId };
            const title = render(config.titleTemplate, vars);
            const body = render(config.bodyTemplate, vars);
            // 命令类通道的占位符注入最终渲染值（与桌面通知显示一致）
            const finalVars = { title, question: body, sessionId };
            log('agent idle → 通知', 'title=' + title, 'question=' + body, 'session=' + sessionId, 'root=' + isRoot);
            if (config.notifySend)
                sendDesktop(title, body, finalVars, '');
            if (config.sound && !windowsSystemAudioCovers(''))
                sendSound(finalVars);
            if (config.bell)
                process.stdout.write('\x07');
            if (config.command)
                runShellCommand(platform, render(config.command, finalVars), (m) => warnOnce('command', m));
        };
        // goal 看似还会自动续跑 → 先不响，进兜底窗口等它重新 running。
        if (config.skipGoalRounds && goalWillContinue.get(sessionId) === true) {
            log('idle 但 goal 将续跑 → 进入 ' + config.goalQuietMs + 'ms 静默窗口', 'session=' + sessionId);
            cancelQuiet(sessionId);
            const t = setTimeout(notify, config.goalQuietMs);
            if (typeof t === 'object' && t !== null && 'unref' in t) {
                ;
                t.unref(); // 不阻止进程退出（一次性任务场景）
            }
            pendingQuiet.set(sessionId, t);
            return;
        }
        notify();
    });
    log('loaded; v' + PKG_VERSION + ' platform=' + (platform ?? 'unknown(' + process.platform + ')'), 'channels:', JSON.stringify({
        notifySend: config.notifySend, sound: config.sound, bell: config.bell,
        command: config.command ? '(custom)' : '(off)', rootOnly: config.rootOnly,
        questionChars: config.questionChars, skipGoalRounds: config.skipGoalRounds,
        goalQuietMs: config.goalQuietMs,
    }));
    ctx.effect(() => () => {
        for (const sessionId of pendingQuiet.keys())
            cancelQuiet(sessionId);
        log('disposed');
    });
}
