export const inject = ['sessions'];
/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus=';
/** 会话列表竞态重试参数：间隔与总预算（约 15s）。 */
const RETRY_MS = 250;
const RETRY_MAX = 60;
/** 轮询失败（断连/服务重启）后的退避。 */
const POLL_ERROR_BACKOFF_MS = 2000;
export function apply(ctx) {
    const log = (...a) => console.log('[turn-notify/client]', ...a);
    const sessions = ctx.sessions;
    let stopped = false;
    /** 定位到会话；列表未列出时按 RETRY_MS 重试（新开页面列表竞态）。 */
    const focusSession = (sessionId, from) => {
        let attempts = 0;
        const attempt = () => {
            if (stopped)
                return;
            try {
                sessions.open(sessionId);
                window.focus();
                log('focused session', sessionId, 'via', from);
            }
            catch (err) {
                // 会话列表尚未到达（新开页面）：open 对未列出会话抛错，重试到列表到达
                if (++attempts < RETRY_MAX) {
                    setTimeout(attempt, RETRY_MS);
                }
                else {
                    log('open failed after retries (session unknown):', sessionId, String(err));
                }
            }
        };
        attempt();
    };
    // ---- 1) 长轮询：点击聚焦 + presence ----
    let lastSeq = 0;
    const clientId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    const pollTimer = [];
    const poll = async () => {
        if (stopped)
            return;
        let ok = false;
        try {
            const res = await fetch('/turn-notify/focus-wait?client=' + clientId + '&since=' + lastSeq);
            if (res.ok) {
                ok = true;
                const data = await res.json().catch(() => null);
                if (data !== null && Array.isArray(data.entries)) {
                    for (const e of data.entries) {
                        // 去重守卫：只消费比本地进度新的条目（服务端已按 since 过滤，
                        // 此处防中间层/旧响应重放导致重复聚焦）
                        if (typeof e.seq !== 'number' || e.seq <= lastSeq)
                            continue;
                        lastSeq = e.seq;
                        if (typeof e.sessionId === 'string' && e.sessionId.length > 0)
                            focusSession(e.sessionId, 'focus-wait');
                    }
                }
            }
        }
        catch {
            /* 连接中断/服务重启：退避后重试 */
        }
        if (stopped)
            return;
        const timer = setTimeout(poll, ok ? 0 : POLL_ERROR_BACKOFF_MS);
        pollTimer.push(timer);
    };
    void poll();
    ctx.effect(() => () => {
        stopped = true;
        for (const t of pollTimer)
            clearTimeout(t);
    }, 'turn-notify-client: focus poll');
    // ---- 2) 深链：本页从通知打开 → 聚焦 + 广播其它已开标签页 ----
    const hash = window.location.hash;
    if (typeof hash === 'string' && hash.startsWith(FOCUS_HASH_PREFIX)) {
        const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length));
        history.replaceState(null, '', window.location.pathname + window.location.search);
        if (sessionId.length > 0) {
            focusSession(sessionId, 'deep-link');
            fetch('/turn-notify/focus', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ sessionId }),
            }).catch(() => { }); // 广播失败不影响本页聚焦
        }
    }
    log('loaded; client=' + clientId);
}
