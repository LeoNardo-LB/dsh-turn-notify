import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import Schema from '@deepseek-ai/schemastery';
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
    soundFile: Schema.string().default('').description('提示音文件路径；留空 = 平台默认（linux freedesktop bell.oga / macos Glass.aiff / windows Windows Notify.wav）'),
    bell: Schema.boolean().default(false).description('向宿主 stdout 写 ASCII BEL（终端/SSH 场景）'),
    command: Schema.string().default('').description('通知触发时的自定义命令，占位符 {sessionId} {title} {question}；留空关闭'),
    notifyCommand: Schema.string().default('').description('完全接管桌面通知的命令模板（高级；同上占位符）；留空用平台后端'),
    soundCommand: Schema.string().default('').description('完全接管提示音的命令模板（高级；同上占位符）；留空用平台后端'),
    notifyOnQuestion: Schema.boolean().default(false).description('提问到达时也通知（默认关：自己刚发的消息无需提醒。适用场景：从远程设备发消息、在桌面确认送达。内容 = 会话标题 + 提问；steering 插话同样触发，goal 注入/合成上下文不触发）'),
    questionTitleTemplate: Schema.string().default('{title}').description('提问通知标题模板，占位符 {title} {question} {sessionId}'),
    questionBodyTemplate: Schema.string().default('提问：{question}').description('提问通知正文模板，占位符同上'),
    questionSoundFile: Schema.string().default('').description('提问提示音文件；留空 = 与轮次结束共用 soundFile / 平台默认'),
    clickToFocus: Schema.boolean().default(true).description('点击通知卡片回到对应会话：页面开着则切换并尝试置前，没开则打开浏览器深链（Linux notify-send -A / Windows toast protocol launch / macOS terminal-notifier -open）'),
    webUrl: Schema.string().default('http://127.0.0.1:3080').description('点击通知打开的 Web 地址（页面没开时的深链目标 base）'),
    deepLinkHash: Schema.string().default('#dsh-focus=').description('深链 hash 前缀；页面侧客户端插件读取此 hash 定位会话'),
    notifyActivateActions: Schema.boolean().default(true).description('Linux：notify-send 用 -A/--action（点击后回调）；通知守护进程不支持 action 时置 false 退回普通通知'),
    terminalNotifierPath: Schema.string().default('terminal-notifier').description('macOS 点击回调依赖的 terminal-notifier 命令（PATH 名或绝对路径）；不存在时 macOS 通知无点击功能（仍正常显示）'),
    presenceTimeoutMs: Schema.number().default(15000).description('Web 页面心跳新鲜度阈值（毫秒）：点击时心跳新鲜 = 页面已开，走事件转发复用页面（零浏览器启动）；超过阈值视为未开，深链新开浏览器'),
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
/** 平台默认提示音文件。 */
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
/** Windows 可点击 toast XML（protocol launch：点击 = 用默认浏览器打开深链）。 */
export function buildToastScript(title, body, launchUrl) {
    const launch = launchUrl === undefined ? '' : ' activationType="protocol" launch="' + xmlEscape(launchUrl) + '"';
    const xml = '<toast' + launch + '><visual><binding template="ToastText02"><text id="1">' + xmlEscape(title) + '</text><text id="2">' + xmlEscape(body) + '</text></binding></visual></toast>';
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
    /**
     * 转发白名单运行时注入：apiproxy 以 live 引用读取
     * API_REMOTE_FORWARDED_EVENTS（每次客户端订阅 events.mux 时 map），
     * push 即对后续连接生效，无需改宿主文件。该包因上游未全发布不能作
     * 静态依赖，动态 import（先常规解析，再从宿主入口 resolve 兜底）。
     */
    let forwardingReady = false;
    const setupForwarding = async () => {
        if (forwardingReady)
            return;
        const EVENT = 'turn-notify/focus';
        const probe = async (spec) => {
            try {
                const mod = (await import(spec));
                return Array.isArray(mod.API_REMOTE_FORWARDED_EVENTS) ? mod.API_REMOTE_FORWARDED_EVENTS : undefined;
            }
            catch {
                return undefined;
            }
        };
        let arr = await probe('@deepseek-ai/dsh-api-remotes');
        if (arr === undefined) {
            // 兜底：从宿主入口（dsh bin）解析——插件进程内 argv[1] 即宿主
            try {
                const { createRequire } = await import('node:module');
                const hostRequire = createRequire(process.argv[1] ?? process.execPath);
                const resolved = hostRequire.resolve('@deepseek-ai/dsh-api-remotes');
                arr = await probe('file://' + resolved);
            }
            catch { /* 保持 undefined */ }
        }
        if (arr === undefined) {
            warnOnce('forwarding', 'dsh-api-remotes 不可解析：转发事件不可用，点击将始终走深链（会开新标签页）');
            return;
        }
        if (!arr.includes(EVENT))
            arr.push(EVENT);
        forwardingReady = true;
        log('转发白名单已注入: ' + EVENT + '（后续 Web 连接可接收）');
    };
    void setupForwarding();
    /** Web 页面心跳：POST /turn-notify/presence（页面开着期间客户端插件定期上报）。 */
    let presenceLastSeen = 0;
    ctx.inject(['webServer'], (scope) => {
        const wsCtx = scope;
        const dispose = wsCtx.webServer.register({
            kind: 'exact',
            path: '/turn-notify/presence',
            handler: (_req, res) => {
                presenceLastSeen = Date.now();
                res.writeHead(204).end();
            },
        });
        log('心跳端点已注册: POST /turn-notify/presence');
        wsCtx.effect(() => dispose, 'turn-notify: presence route');
    });
    /**
     * 点击回调双路径：心跳新鲜（页面已开）→ 转发事件直达已开页面切会话，
     * 零浏览器启动（不重复开标签页）；过期（页面未开）→ OS 深链打开，
     * 新页面读 hash 定位会话并开始心跳，后续点击即走复用路径。
     */
    const handleNotificationClick = (sessionId) => {
        if (forwardingReady && Date.now() - presenceLastSeen < config.presenceTimeoutMs) {
            log('notification click → 转发给已开 Web 页面:', sessionId);
            ctx.emit('turn-notify/focus', { sessionId });
            return;
        }
        log('notification click → 无活跃页面，深链打开:', sessionId);
        const opener = platform === 'macos' ? 'open' : platform === 'windows' ? 'cmd' : 'xdg-open';
        const args = platform === 'windows' ? ['/c', 'start', '', deepLinkUrl(config, sessionId)] : [deepLinkUrl(config, sessionId)];
        run(opener, args, (m) => warnOnce('deep-link', m));
    };
    /** fire-and-forget 桌面通知（按平台分发；notifyCommand 可完全接管）。 */
    const sendDesktop = (title, body, vars) => {
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
            // protocol launch：点击 = 系统用默认浏览器打开深链 URL（toast 标准能力）
            const launch = clickable ? deepLinkUrl(config, vars.sessionId) : undefined;
            run('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodePs(buildToastScript(title, body, launch))], (m) => warnOnce('windows-toast', m));
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
                sendDesktop(title, body, finalVars);
            if (config.sound)
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
                sendDesktop(title, body, finalVars);
            if (config.sound)
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
    log('loaded; v0.2.1 platform=' + (platform ?? 'unknown(' + process.platform + ')'), 'channels:', JSON.stringify({
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
