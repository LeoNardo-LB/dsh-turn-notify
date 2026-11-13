/**
 * dsh-turn-notify browser half：聚焦通道消费端。
 *
 * 与服务端插件配套（经本包 webServer 路由）：
 *   1. 长轮询 GET /turn-notify/focus-wait?client=<uuid>&since=<seq>：
 *      页面打开期间持续保持一个挂起请求；点击通知 → 服务端入队 →
 *      挂起请求立即返回 {entries:[{seq,sessionId}]} → 本页切换会话。
 *      该轮询同时就是 presence：服务端据此判定“页面已开”（Linux 点击
 *      复用已开页面；Windows 据此选 balloon 复用路径）。成功续接不走
 *      setTimeout——Chrome 对后台标签页的 timer 钳制（后台 5 分钟后低
 *      至 1 次/分钟）会让点击聚焦迟到最多一分钟，网络响应回调不受钳制。
 *   2. 深链兜底：页面未开时宿主经 OS 深链新开（#dsh-focus=<sessionId>，
 *      Windows toast / macOS terminal-notifier 的点击即此路径），本页读
 *      hash 聚焦会话，并 POST /turn-notify/focus 广播让其它已开标签页
 *      同步切换。
 *   3. 会话列表竞态重试：新开页面的会话列表异步晚到，open() 对未列出
 *      会话直接抛错——聚焦带重试（250ms 间隔、至多 15s），列表到达
 *      即成功；旧实现单次失败即吞掉，导致落地页停在恢复的旧会话上。
 *   4. 桌面原生通知（desktop 半）：dsh 桌面 app 的内嵌页面（dsh-app:
 *      协议）自识别，focus-wait 上报 client=desktop:<uuid>；服务端据此
 *      把 {kind:'notify'} 条目投进长轮询，本页用 Web Notification API
 *      弹原生通知——展示后 POST /turn-notify/notify-ack（服务端超时未
 *      见 ack 走平台通道兜底）；点击 = sessions.open 定位会话 + POST
 *      /turn-notify/clicked（宿主广播聚焦 + dsh://open 幂等置前桌面
 *      窗口）。浏览器页面（http/https）跳过 notify 条目，不双响。
 *
 * @module dsh-turn-notify/client
 */
/** 客户端上下文最小面（官方 runtime 的类型依赖未全发布，本地同款声明）。 */
interface ClientContext {
  sessions: unknown
  effect(fn: () => unknown, label?: string): void
  /** 取可选服务（DSH 0.2.2 起会话切换在 uiWorkspace 上）。 */
  get?(name: string): unknown
}

/** sessions 服务最小面（完整契约在 dsh-client-runtime）。 */
interface SessionsLike {
  /** DSH 0.2.2 起客户端不再提供 open，保留旧版兼容。 */
  open?(id: string): void
}

/** uiWorkspace 服务最小面（DSH 0.2.2 的会话切换入口）。 */
interface UiWorkspaceLike {
  openSession(id: string): void
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

/** 桌面 app 内嵌页面判定：桌面壳以 dsh-app:// 协议服务前端（preload 另暴露 __DSH_LOCALE__）；浏览器页面是 http(s)。 */
const isDesktopPage = (): boolean =>
  window.location.protocol === 'dsh-app:' || '__DSH_LOCALE__' in window

/** Web Notification API 句柄（经 window 引用取，不引入新的自由全局名；测试可经 window 注入伪造）。 */
type NativeNotificationCtor = (new (title: string, options?: { body?: string; silent?: boolean }) => {
  addEventListener(ev: string, fn: () => void): void
  close(): void
}) & {
  permission?: string
  requestPermission?: () => Promise<string>
}
const NativeNotification: NativeNotificationCtor | undefined = (window as unknown as { Notification?: NativeNotificationCtor }).Notification

export function apply(ctx: ClientContext): void {
  // 每行前缀带版本（与宿主端一致，调试时任意一行可识别版本）
  const log = (...a: unknown[]) => console.log('[turn-notify/client v' + TN_VERSION + ']', ...a)

  const sessions = ctx.sessions as SessionsLike
  /**
   * 切到指定会话：DSH 0.2.2 是 uiWorkspace.openSession(id)（旧版才有
   * sessions.open）。两者都试，避免版本差异下静默失败。
   */
  const openSession = (sessionId: string): void => {
    const ui = typeof ctx.get === 'function' ? (ctx.get('uiWorkspace') as UiWorkspaceLike | undefined) : undefined
    if (ui !== undefined && ui !== null && typeof ui.openSession === 'function') {
      ui.openSession(sessionId)
      return
    }
    if (sessions !== undefined && sessions !== null && typeof sessions.open === 'function') {
      sessions.open(sessionId)
      return
    }
    throw new Error('no session-open API (uiWorkspace.openSession / sessions.open)')
  }
  let stopped = false

  /** 定位到会话；列表未列出时按 RETRY_MS 重试（新开页面列表竞态）。 */
  const focusSession = (sessionId: string, from: string): void => {
    let attempts = 0
    const attempt = (): void => {
      if (stopped) return
      try {
        openSession(sessionId)
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

  /** desktop 原生通知（{kind:'notify'} 条目）：弹出 + 展示 ack + 点击聚焦/置前回执。 */
  const showNativeNotify = (e: { seq: number; title?: unknown; body?: unknown; sessionId?: unknown; silent?: unknown }): void => {
    if (NativeNotification === undefined) {
      log('Notification API 不可用，跳过原生通知 seq=' + e.seq + '（服务端超时后平台通道兜底）')
      return
    }
    const fire = (): void => {
      if (NativeNotification === undefined || NativeNotification.permission !== 'granted') {
        log('通知权限未授予，跳过原生通知 seq=' + e.seq + '（服务端超时后平台通道兜底）')
        return
      }
      const title = typeof e.title === 'string' && e.title.length > 0 ? e.title : 'DSH'
      const body = typeof e.body === 'string' ? e.body : ''
      let notification: InstanceType<NativeNotificationCtor>
      try {
        notification = new NativeNotification(title, { body, silent: e.silent === true })
      } catch (err) {
        log('Notification 构造失败:', String(err))
        return
      }
      const ack = (): void => {
        fetch('/turn-notify/notify-ack', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ seq: e.seq }),
        }).catch(() => {})
      }
      // 展示回执以 show 事件为准；个别平台事件缺失时短定时器兜底
      //（ack 端点幂等，重复到达无害）
      notification.addEventListener('show', ack)
      setTimeout(ack, 400)
      notification.addEventListener('click', () => {
        if (typeof e.sessionId === 'string' && e.sessionId.length > 0) focusSession(e.sessionId, 'native-notify')
        window.focus()
        fetch('/turn-notify/clicked', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }).catch(() => {})
      })
    }
    if (NativeNotification.permission === 'granted') {
      fire()
    } else if (typeof NativeNotification.requestPermission === 'function') {
      // Electron 桌面壳的权限检查器对非 media 权限一律放行；保险起见
      // 显式请求一次（浏览器路径不走本函数）
      NativeNotification.requestPermission().then((p) => {
        if (p === 'granted') fire()
      }).catch(() => {})
    }
  }

  // ---- 1) 长轮询：点击聚焦 + presence ----
  let lastSeq = 0
  // desktop 页面上报 client=desktop:<uuid>（服务端据此路由原生通知/置前）
  const clientKind = isDesktopPage() ? 'desktop:' : ''
  const clientId = typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2)
  const pollTimer: ReturnType<typeof setTimeout>[] = []
  const poll = async (): Promise<void> => {
    if (stopped) return
    let ok = false
    try {
      const res = await fetch('/turn-notify/focus-wait?client=' + clientKind + clientId + '&since=' + lastSeq)
      if (res.ok) {
        ok = true
        const data = await res.json().catch(() => null) as { entries?: { seq?: unknown; sessionId?: unknown; kind?: unknown; title?: unknown; body?: unknown; silent?: unknown }[] } | null
        if (data !== null && Array.isArray(data.entries)) {
          for (const e of data.entries) {
            // 去重守卫：只消费比本地进度新的条目（服务端已按 since 过滤，
            // 此处防中间层/旧响应重放导致重复聚焦）
            if (typeof e.seq !== 'number' || e.seq <= lastSeq) continue
            lastSeq = e.seq
            if (e.kind === 'notify') {
              // desktop 原生通知条目：仅桌面页面渲染（浏览器页面的通知
              // 由宿主平台通道负责，跳过避免双响）
              if (clientKind !== '') showNativeNotify(e as { seq: number; title?: unknown; body?: unknown; sessionId?: unknown; silent?: unknown })
              continue
            }
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

  log('loaded; client=' + clientKind + clientId)
}
