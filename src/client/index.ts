/**
 * dsh-turn-notify browser half：点击通知卡片 → 回到对应会话。
 *
 * 统一深链路径（服务端点击回调 = OS 用默认浏览器打开
 * #dsh-focus=<sessionId>；浏览器自带置前/复用窗口行为）：
 *   1. 本页从深链打开（hash 定位会话）→ sessions.open + 清 hash
 *   2. BroadcastChannel：深链页广播 focus → 已开的其他标签页（leader）
 *      同步切到同一会话，保持多标签页一致；后开者非 leader
 *   3. document.title 稳定标记（"— DSH" 后缀）
 *
 * @module dsh-turn-notify/client
 */
/** 客户端上下文最小面（官方 runtime 的类型依赖未全发布，本地同款声明）。 */
interface ClientContext {
  sessions: unknown
  effect(fn: () => unknown, label?: string): void
}

/** sessions 服务最小面（完整契约在 dsh-client-runtime）。 */
interface SessionsLike {
  open(id: string): void
}

export const inject = ['sessions']

/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus='

export function apply(ctx: ClientContext): void {
  const log = (...a: unknown[]) => console.log('[turn-notify/client]', ...a)

  const sessions = ctx.sessions as SessionsLike

  /** 定位到会话（不在列表时 open 会 fail loud，捕获后仅记录）。 */
  const focusSession = (sessionId: string, from: string): void => {
    try {
      sessions.open(sessionId)
      window.focus()
      log('focused session', sessionId, 'via', from)
    } catch (err) {
      log('open failed (session not in list?):', sessionId, String(err))
    }
  }

  // ---- 1) 深链：本页从通知打开 ----
  const applyDeepLink = (): void => {
    const hash = window.location.hash
    if (!hash.startsWith(FOCUS_HASH_PREFIX)) return
    const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length))
    history.replaceState(null, '', window.location.pathname + window.location.search)
    if (sessionId.length > 0) {
      focusSession(sessionId, 'deep-link')
      // 通知其他已开标签页同步（多标签页一致）
      channel?.postMessage({ type: 'focus', sessionId })
    }
  }

  // ---- 2) BroadcastChannel：多标签页同步 ----
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-turn-notify') : undefined
  let isLeader = true
  if (channel !== undefined) {
    channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; sessionId?: string }
      if (data.type === 'leader-claim') {
        isLeader = false
      } else if (data.type === 'focus' && typeof data.sessionId === 'string') {
        // 深链页广播的 focus：已开标签页同步切换（leader 一个就够）
        if (isLeader) focusSession(data.sessionId, 'broadcast')
      }
    }
    channel.postMessage({ type: 'leader-claim' })
    ctx.effect(() => () => channel.close(), 'turn-notify-client: channel')
  }

  applyDeepLink()

  // ---- 3) 稳定 title 标记 ----
  document.title = (document.title || 'DSH') + ' — DSH'

  log('loaded; leader=' + isLeader)
}
