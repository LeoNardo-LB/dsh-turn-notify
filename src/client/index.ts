/**
 * dsh-turn-notify browser half：点击通知卡片 → 回到对应会话（复用优先）。
 *
 * 双路径配合服务端：
 *   1. 心跳：页面打开期间定期 POST /turn-notify/presence（服务端插件注册
 *      的端点）。宿主点击通知时心跳新鲜 = 页面已开 → 经转发事件
 *      turn-notify/focus 直达本页（零浏览器启动、不重复开标签页）。
 *   2. 深链兜底：页面未开时宿主经 OS 深链新开（#dsh-focus=<sessionId>），
 *      本页读 hash 定位会话后清 hash，并开始心跳供后续点击复用。
 *   3. BroadcastChannel：深链页广播 focus → 已开标签页（leader）同步切换。
 *   4. document.title 稳定标记（"— DSH" 后缀）。
 *
 * @module dsh-turn-notify/client
 */
/** 客户端上下文最小面（官方 runtime 的类型依赖未全发布，本地同款声明）。 */
interface ClientContext {
  sessions: unknown
  remote: unknown
  effect(fn: () => unknown, label?: string): void
}

/** sessions 服务最小面（完整契约在 dsh-client-runtime）。 */
interface SessionsLike {
  open(id: string): void
}

/** 宿主转发事件面（转发帧无运行时白名单校验，事件名分发）。 */
interface FocusRemote {
  $on(event: 'turn-notify/focus', handler: (payload: { sessionId: string }) => void): () => void
}

export const inject = ['sessions', 'remote']

/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus='

/** 心跳间隔（毫秒）。服务端新鲜度阈值 presenceTimeoutMs 默认 15s，5s 上报留足余量。 */
const HEARTBEAT_MS = 5000

export function apply(ctx: ClientContext): void {
  const log = (...a: unknown[]) => console.log('[turn-notify/client]', ...a)

  const sessions = ctx.sessions as SessionsLike
  const remote = ctx.remote as unknown as FocusRemote

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

  // ---- 1) 宿主转发事件：点击通知 → 已开页面直接切会话 ----
  ctx.effect(() => {
    const dispose = remote.$on('turn-notify/focus', ({ sessionId }) => {
      focusSession(sessionId, 'host-event')
    })
    return dispose as unknown as () => void
  }, 'turn-notify-client: focus subscription')

  // ---- 2) 心跳上报（页面开着期间持续；失败静默——端点未部署时退化为纯深链模式） ----
  const beat = (): void => {
    fetch('/turn-notify/presence', { method: 'POST', keepalive: true }).catch(() => {})
  }
  beat()
  const timer = setInterval(beat, HEARTBEAT_MS)
  ctx.effect(() => () => clearInterval(timer), 'turn-notify-client: heartbeat')

  // ---- 3) 深链：本页从通知打开 ----
  const applyDeepLink = (): void => {
    const hash = window.location.hash
    if (!hash.startsWith(FOCUS_HASH_PREFIX)) return
    const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length))
    history.replaceState(null, '', window.location.pathname + window.location.search)
    if (sessionId.length > 0) {
      focusSession(sessionId, 'deep-link')
      channel?.postMessage({ type: 'focus', sessionId })
    }
  }

  // ---- 4) BroadcastChannel：多标签页同步 ----
  const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('dsh-turn-notify') : undefined
  let isLeader = true
  if (channel !== undefined) {
    channel.onmessage = (ev: MessageEvent) => {
      const data = ev.data as { type?: string; sessionId?: string }
      if (data.type === 'leader-claim') {
        isLeader = false
      } else if (data.type === 'focus' && typeof data.sessionId === 'string') {
        if (isLeader) focusSession(data.sessionId, 'broadcast')
      }
    }
    channel.postMessage({ type: 'leader-claim' })
    ctx.effect(() => () => channel.close(), 'turn-notify-client: channel')
  }

  applyDeepLink()

  // ---- 5) 稳定 title 标记 ----
  document.title = (document.title || 'DSH') + ' — DSH'

  log('loaded; leader=' + isLeader)
}
