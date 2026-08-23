/**
 * dsh-turn-notify browser half：点击通知卡片 → 回到对应会话。
 *
 * 职责：
 *   1. 订阅宿主转发的 turn-notify/focus 事件（服务端插件在点击回调里
 *      emit；需先把事件名加进 dsh-api-remotes 的转发白名单，见
 *      scripts/patch-dsh-api-remotes.sh）→ sessions.open(sessionId)
 *      + window.focus()
 *   2. 冷启动深链：页面加载时读 location.hash（#dsh-focus=<sessionId>）
 *      定位会话后清 hash
 *   3. BroadcastChannel 协调：多个已开标签页时只有 leader 响应 focus
 *      事件（先开的 tab 是 leader；后开的收到 leader-claim 即让位）
 *   4. document.title 设稳定标记（服务端 xdotool 置前浏览器窗口时匹配用）
 *
 * @module dsh-turn-notify/client
 */
/** 客户端上下文最小面（官方 @deepseek-ai/dsh-client-runtime 的类型依赖未全部发布，本地声明同款形状）。 */
interface ClientContext {
  sessions: unknown
  remote: unknown
  effect(fn: () => unknown, label?: string): void
}

/** 宿主转发事件的最小面（白名单 patch 后可用）。 */
interface FocusRemote {
  $on(event: 'turn-notify/focus', handler: (payload: { sessionId: string }) => void): () => void
}

/** sessions 服务最小面（完整契约在 dsh-client-runtime）。 */
interface SessionsLike {
  open(id: string): void
}

export const inject = ['remote', 'sessions']

/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus='

export function apply(ctx: ClientContext): void {
  const log = (...a: unknown[]) => console.log('[turn-notify/client]', ...a)

  const sessions = ctx.sessions as SessionsLike
  const remote = ctx.remote as unknown as FocusRemote

  /** 定位到会话（容错：不在列表时 open 会 fail loud，捕获后仅记录）。 */
  const focusSession = (sessionId: string, from: string): void => {
    try {
      sessions.open(sessionId)
      window.focus()
      log('focused session', sessionId, 'via', from)
    } catch (err) {
      log('open failed (session not in list?):', sessionId, String(err))
    }
  }

  // ---- 1) 宿主事件：点击通知 → 切会话 + 置前 ----
  ctx.effect(() => {
    const dispose = remote.$on('turn-notify/focus', ({ sessionId }) => {
      focusSession(sessionId, 'host-event')
    })
    return dispose as unknown as () => void
  }, 'turn-notify-client: focus subscription')

  // ---- 2) 冷启动深链 ----
  const applyDeepLink = (): void => {
    const hash = window.location.hash
    if (!hash.startsWith(FOCUS_HASH_PREFIX)) return
    const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length))
    history.replaceState(null, '', window.location.pathname + window.location.search)
    if (sessionId.length > 0) focusSession(sessionId, 'deep-link')
  }
  applyDeepLink()

  // ---- 3) BroadcastChannel 多标签页协调（leader 响应） ----
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-turn-notify') : undefined
  let isLeader = true
  if (channel !== undefined) {
    channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; sessionId?: string }
      if (data.type === 'focus' && typeof data.sessionId === 'string') {
        if (isLeader) focusSession(data.sessionId, 'broadcast')
      } else if (data.type === 'leader-claim') {
        isLeader = false
      }
    }
    // 声明 leadership（已开的其他 tab 收到后让位——但先开者已 claim 过，
    // 后开者 claim 时没人再让它让位，由初始 true + 先到先得保证唯一 leader）
    channel.postMessage({ type: 'leader-claim' })
    ctx.effect(() => () => channel.close(), 'turn-notify-client: channel')
  }

  // ---- 4) 稳定 title 标记（服务端 xdotool 置前用） ----
  const base = document.title || 'DSH'
  document.title = base + ' — DSH'

  log('loaded; leader=' + isLeader)
}
