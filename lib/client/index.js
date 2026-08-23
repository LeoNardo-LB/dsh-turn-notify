export const inject = ['sessions'];
/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus=';
export function apply(ctx) {
    const log = (...a) => console.log('[turn-notify/client]', ...a);
    const sessions = ctx.sessions;
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
    // ---- 1) 深链：本页从通知打开 ----
    const applyDeepLink = () => {
        const hash = window.location.hash;
        if (!hash.startsWith(FOCUS_HASH_PREFIX))
            return;
        const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length));
        history.replaceState(null, '', window.location.pathname + window.location.search);
        if (sessionId.length > 0) {
            focusSession(sessionId, 'deep-link');
            // 通知其他已开标签页同步（多标签页一致）
            channel?.postMessage({ type: 'focus', sessionId });
        }
    };
    // ---- 2) BroadcastChannel：多标签页同步 ----
    const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-turn-notify') : undefined;
    let isLeader = true;
    if (channel !== undefined) {
        channel.onmessage = (ev) => {
            const data = ev.data;
            if (data.type === 'leader-claim') {
                isLeader = false;
            }
            else if (data.type === 'focus' && typeof data.sessionId === 'string') {
                // 深链页广播的 focus：已开标签页同步切换（leader 一个就够）
                if (isLeader)
                    focusSession(data.sessionId, 'broadcast');
            }
        };
        channel.postMessage({ type: 'leader-claim' });
        ctx.effect(() => () => channel.close(), 'turn-notify-client: channel');
    }
    applyDeepLink();
    // ---- 3) 稳定 title 标记 ----
    document.title = (document.title || 'DSH') + ' — DSH';
    log('loaded; leader=' + isLeader);
}
