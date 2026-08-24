/**
 * dsh-turn-notify browser half：聚焦通道消费端。
 *
 * 与服务端插件配套（经本包 webServer 路由）：
 *   1. 长轮询 GET /turn-notify/focus-wait?client=<uuid>&since=<seq>：
 *      页面打开期间持续保持一个挂起请求；点击通知 → 服务端入队 →
 *      挂起请求立即返回 {entries:[{seq,sessionId}]} → 本页切换会话。
 *      该轮询同时就是 presence：服务端据此判定“页面已开”，Linux 上
 *      点击复用已开页面、零浏览器启动。
 *   2. 深链兜底：页面未开时宿主经 OS 深链新开（#dsh-focus=<sessionId>，
 *      Windows toast / macOS terminal-notifier 的点击即此路径），本页读
 *      hash 聚焦会话，并 POST /turn-notify/focus 广播让其它已开标签页
 *      同步切换。
 *   3. 会话列表竞态重试：新开页面的会话列表异步晚到，open() 对未列出
 *      会话直接抛错——聚焦带重试（250ms 间隔、至多 15s），列表到达
 *      即成功；旧实现单次失败即吞掉，导致落地页停在恢复的旧会话上。
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

/** 构建期注入的插件版本（scripts/build-client.mjs define；缺省 unknown）。 */
declare const __TN_VERSION__: string | undefined

/** 版本字符串（tsc 直跑等未注入场景退回 unknown）。 */
const TN_VERSION: string = typeof __TN_VERSION__ === 'string' ? __TN_VERSION__ : 'unknown'

/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export const FOCUS_HASH_PREFIX = '#dsh-focus='

/** 会话列表竞态重试参数：间隔与总预算（约 15s）。 */
const RETRY_MS = 250
const RETRY_MAX = 60

/** 轮询失败（断连/服务重启）后的退避。 */
const POLL_ERROR_BACKOFF_MS = 2000

export function apply(ctx: ClientContext): void {
  // 每行前缀带版本（与宿主端一致，调试时任意一行可识别版本）
  const log = (...a: unknown[]) => console.log('[turn-notify/client v' + TN_VERSION + ']', ...a)

  const sessions = ctx.sessions as SessionsLike
  let stopped = false

  /** 定位到会话；列表未列出时按 RETRY_MS 重试（新开页面列表竞态）。 */
  const focusSession = (sessionId: string, from: string): void => {
    let attempts = 0
    const attempt = (): void => {
      if (stopped) return
      try {
        sessions.open(sessionId)
        window.focus()
        log('focused session', sessionId, 'via', from)
      } catch (err) {
        // 会话列表尚未到达（新开页面）：open 对未列出会话抛错，重试到列表到达
        if (++attempts < RETRY_MAX) {
          setTimeout(attempt, RETRY_MS)
        } else {
          log('open failed after retries (session unknown):', sessionId, String(err))
        }
      }
    }
    attempt()
  }

  // ---- 1) 长轮询：点击聚焦 + presence ----
  let lastSeq = 0
  const clientId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
  const pollTimer: ReturnType<typeof setTimeout>[] = []
  const poll = async (): Promise<void> => {
    if (stopped) return
    let ok = false
    try {
      const res = await fetch('/turn-notify/focus-wait?client=' + clientId + '&since=' + lastSeq)
      if (res.ok) {
        ok = true
        const data = await res.json().catch(() => null) as { entries?: { seq?: unknown; sessionId?: unknown }[] } | null
        if (data !== null && Array.isArray(data.entries)) {
          for (const e of data.entries) {
            // 去重守卫：只消费比本地进度新的条目（服务端已按 since 过滤，
            // 此处防中间层/旧响应重放导致重复聚焦）
            if (typeof e.seq !== 'number' || e.seq <= lastSeq) continue
            lastSeq = e.seq
            if (typeof e.sessionId === 'string' && e.sessionId.length > 0) focusSession(e.sessionId, 'focus-wait')
          }
        }
      }
    } catch {
      /* 连接中断/服务重启：退避后重试 */
    }
    if (stopped) return
    // 成功续接不经过 setTimeout：Chrome 对后台标签页的 timer 有钳制
    // （普通 1s、后台 5 分钟后密集钳制至 1 次/分钟）——点击条目若在轮询
    // 间隙入队，要等被钳制的 timer 才能取到，迟到最多一分钟（dsh 页在后
    // 台恰是最需要通知的场景）。网络响应回调不受钳制，同步直启零间隙；
    // 服务端每次挂起 ~pollHoldMs，无热循环。
    if (ok) {
      void poll()
      return
    }
    const timer = setTimeout(poll, POLL_ERROR_BACKOFF_MS)
    pollTimer.push(timer)
  }
  void poll()
  ctx.effect(() => () => {
    stopped = true
    for (const t of pollTimer) clearTimeout(t)
  }, 'turn-notify-client: focus poll')

  // ---- 2) 深链：本页从通知打开 → 聚焦 + 广播其它已开标签页 ----
  const hash = window.location.hash
  if (typeof hash === 'string' && hash.startsWith(FOCUS_HASH_PREFIX)) {
    const sessionId = decodeURIComponent(hash.slice(FOCUS_HASH_PREFIX.length))
    history.replaceState(null, '', window.location.pathname + window.location.search)
    if (sessionId.length > 0) {
      focusSession(sessionId, 'deep-link')
      fetch('/turn-notify/focus', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {}) // 广播失败不影响本页聚焦
    }
  }

  // ---- 3) 稳定标题标记：Windows 点击链路据此定位含 dsh 标签页的浏览器窗口 ----
  // 置前脚本在多个浏览器窗口中优先选择标题含 " — DSH" 的那个（即 dsh
  // 标签页为活动标签页的窗口）；标记追加一次，SPA 改标题可能覆盖，无碍。
  if (!(document.title || '').includes(' — DSH')) {
    document.title = (document.title || 'DSH') + ' — DSH'
  }

  log('loaded; client=' + clientId)
}
