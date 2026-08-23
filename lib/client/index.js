export const inject = ['sessions', 'remote'];
/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus=';
/** 心跳间隔（毫秒）。服务端新鲜度阈值 presenceTimeoutMs 默认 15s，5s 上报留足余量。 */
const HEARTBEAT_MS = 5000;
export function apply(ctx) {
    const log = (...a) => console.log('[turn-notify/client]', ...a);
    const sessions = ctx.sessions;
    const remote = ctx.remote;
    /** 定位到会话（不在列表时 open 会 fail loud，捕获后仅记录）。 */
    const focusSession = (sessionId, from) => {
        try {
            sessions.open(sessionId);
            window.focus();
            log('focused session', sessionId, 'via', from);
        }
        catch (err) {
            log('open failed (session not in list?):', sessionId, String(err));
        }
    };
    // ---- 1) 宿主转发事件：点击通知 → 已开页面直接切会话 ----
    ctx.effect(() => {
        const dispose = remote.$on('turn-notify/focus', ({ sessionId }) => {
            focusSession(sessionId, 'host-event');
        });
        return dispose;
    }, 'turn-notify-client: focus subscription');
    // ---- 2) 心跳上报（页面开着期间持续；失败静默——端点未部署时退化为纯深链模式） ----
    const beat = () => {
        fetch('/turn-notify/presence', { method: 'POST', keepalive: true }).catch(() => { });
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);
    ctx.effect(() => () => clearInterval(timer), 'turn-notify-client: heartbeat');
    // ---- 3) 深链：本页从通知打开 ----
    const applyDeepLink = () => {
        const hash = window.location.hash;
        if (!hash.startsWith(FOCUS_HASH_PREFIX))
            return;
        const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length));
        history.replaceState(null, '', window.location.pathname + window.location.search);
        if (sessionId.length > 0) {
            focusSession(sessionId, 'deep-link');
            channel?.postMessage({ type: 'focus', sessionId });
        }
    };
    // ---- 4) BroadcastChannel：多标签页同步 ----
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-turn-notify') : undefined;
    let isLeader = true;
    if (channel !== undefined) {
        channel.onmessage = (ev) => {
            const data = ev.data;
            if (data.type === 'leader-claim') {
                isLeader = false;
            }
            else if (data.type === 'focus' && typeof data.sessionId === 'string') {
                if (isLeader)
                    focusSession(data.sessionId, 'broadcast');
            }
        };
        channel.postMessage({ type: 'leader-claim' });
        ctx.effect(() => () => channel.close(), 'turn-notify-client: channel');
    }
    applyDeepLink();
    // ---- 5) 稳定 title 标记 ----
    document.title = (document.title || 'DSH') + ' — DSH';
    log('loaded; leader=' + isLeader);
}
