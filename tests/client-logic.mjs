// dsh-turn-notify 浏览器端逻辑测试：直接驱动构建产物 lib/client.js
// （模块表格式），伪造最小 window/document/history/fetch 环境：
//   1. 深链聚焦重试（bug 回归锁）：新开页面会话列表异步晚到，open() 对
//      未列出会话直接抛错——聚焦必须重试到列表到达为止，而不是吞掉一次
//      失败后停在恢复的旧会话上
//   2. 长轮询消费：focus-wait 返回条目 → open(sessionId)；URL 携带
//      client=<uuid> 与 since=<seq>（presence 注册 + 断点续传）
//   3. 深链落地页广播：POST /turn-notify/focus 携带 {sessionId}
// 运行：先 pnpm run build，再 node tests/client-logic.mjs
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const bundle = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'client.js'), 'utf8')

/** 每个用例独立的最小浏览器环境 + 模块表加载。 */
function loadBundle(env) {
  const disposers = []
  let mod = null
  const window = {
    location: { hash: env.hash ?? '', pathname: '/', search: '', protocol: env.protocol ?? 'https:' },
    focus: env.windowFocus ?? (() => {}),
  }
  if (env.Notification !== undefined) window.Notification = env.Notification
  const consoleLines = []
  const captureConsole = {
    log: (...a) => { consoleLines.push(a.map(String).join(' ')) },
  }
  // 假 fetch 先让出一轮事件循环（宏任务）再返回——真实网络至少跨一次
  // 事件循环切换；瞬时返回会让零间隙续接轮询（成功路径不走 setTimeout，
  // 防后台标签页 timer 钳制）在测试里饿死所有定时器。
  const realisticFetch = async (...a) => {
    await new Promise((r) => setTimeout(r, 0))
    return env.fetch(...a)
  }
  const g = {
    window,
    history: { replaceState: env.replaceState ?? (() => {}) },
    document: { title: 'DSH' },
    fetch: realisticFetch,
    setTimeout, clearTimeout,
    BroadcastChannel: undefined,
    console: env.captureConsole ? captureConsole : console,
  }
  g.window.__ModuleLoader__ = {
    load(record) { mod = record.factory(() => { throw new Error('unexpected external require') }) },
  }
  g.globalThis = g
  const keys = Object.keys(g)
  // 以全局身份执行 bundle（bundle 只引用这些全局名）
  const fn = new Function(...keys, bundle)
  fn(...keys.map((k) => g[k]))
  assert.ok(mod !== null && typeof mod.apply === 'function', 'bundle 应导出 apply')
  const opened = []
  const sessions = {
    open(id) {
      if (!env.isListed(id)) throw new Error('sessions.select: unknown session ' + id)
      opened.push(id)
    },
  }
  const ctx = {
    sessions,
    effect(fn2) { disposers.push(fn2); return () => {} },
  }
  mod.apply(ctx)
  return { window, opened, consoleLines, dispose: () => { for (const d of disposers) d() } }
}

// ---- 1) 深链聚焦重试：列表 300ms 后才含目标会话 ----
console.log('--- 1) 深链聚焦：列表未到 → 重试到成功 ---')
{
  let listReady = false
  const { opened, consoleLines, dispose } = loadBundle({
    hash: '#dsh-focus=' + encodeURIComponent('sess-target-1'),
    isListed: (id) => listReady || id === 'sess-home',
    fetch: async (url, opts) => ({ ok: true, json: async () => ({ entries: [] }) }),
    captureConsole: true,
  })
  // 版本日志（v0.2.2-dev.8+）：客户端每行前缀 [turn-notify/client v<版本>]，
  // 版本经 esbuild define 构建期内联（浏览器端读不到 package.json）
  const pkgVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  assert.ok(
    consoleLines.some((l) => l.includes('[turn-notify/client v' + pkgVersion + ']') && l.includes('loaded')),
    '客户端 loaded 行前缀应带版本 ' + pkgVersion + '（实际：' + (consoleLines[0] ?? '(无)') + '）',
  )
  await sleep(100)
  assert.equal(opened.length, 0, '列表未含目标会话时不得提前成功')
  listReady = true
  const ok = await (async () => {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (opened.includes('sess-target-1')) return true
      await sleep(100)
    }
    return false
  })()
  dispose()
  assert.ok(ok, '列表到达后必须在重试内聚焦目标会话（当前 bug：单次失败即吞掉）')
  console.log('DEEP-LINK-RETRY-OK')
}

// ---- 2) 长轮询消费：条目 → open；URL 带 client 与 since ----
console.log('--- 2) 长轮询：条目分发与 URL 参数 ---')
{
  const seenUrls = []
  let releasePoll
  const gate = new Promise((r) => { releasePoll = r })
  const { opened, dispose } = loadBundle({
    hash: '',
    isListed: () => true,
    fetch: async (url, opts) => {
      seenUrls.push({ url: String(url), opts })
      if (String(url).includes('focus-wait')) {
        await gate
        // 遵循真实服务端语义：只返回 seq > since 的条目（首轮 1 条，后续空）
        const m = /since=(\d+)/.exec(String(url))
        const since = m ? Number(m[1]) : 0
        const entries = since < 7 ? [{ seq: 7, sessionId: 'sess-poll-1' }] : []
        return { ok: true, json: async () => ({ entries }) }
      }
      return { ok: true, json: async () => ({ entries: [] }) }
    },
  })
  await sleep(100)
  const wait = seenUrls.find((u) => u.url.includes('/turn-notify/focus-wait'))
  assert.ok(wait !== undefined, '应发起 focus-wait 长轮询')
  assert.match(wait.url, /client=[^&]+/, '长轮询 URL 应带 client=<uuid>（presence 注册）')
  assert.match(wait.url, /since=0\b/, '首轮 since=0')
  releasePoll()
  await sleep(200)
  dispose()
  assert.ok(opened.includes('sess-poll-1'), '轮询条目应触发 open(sessionId)')
  console.log('POLL-DELIVERY-OK')
}

// ---- 3) 深链落地页广播：POST /turn-notify/focus ----
console.log('--- 3) 深链广播 ---')
{
  const posts = []
  const { dispose } = loadBundle({
    hash: '#dsh-focus=' + encodeURIComponent('sess-broadcast-1'),
    isListed: () => true,
    fetch: async (url, opts) => {
      if (String(url).includes('focus') && opts?.method === 'POST') posts.push({ url: String(url), body: opts.body })
      return { ok: true, json: async () => ({ entries: [] }) }
    },
  })
  await sleep(100)
  dispose()
  assert.equal(posts.length, 1, '深链落地应恰好广播一次')
  assert.equal(posts[0].url, '/turn-notify/focus', '广播目标 URL')
  assert.equal(JSON.parse(posts[0].body).sessionId, 'sess-broadcast-1', '广播体应含 sessionId')
  console.log('BROADCAST-OK')
}

// ---- 4) desktop 自识别：dsh-app: 协议 → client=desktop:<uuid> ----
console.log('--- 4) desktop 自识别上报 ---')
{
  const urls = []
  let release
  const gate = new Promise((r) => { release = r })
  const { dispose } = loadBundle({
    hash: '',
    protocol: 'dsh-app:',
    isListed: () => true,
    fetch: async (url) => {
      const s = String(url)
      if (s.includes('focus-wait')) { urls.push(s); await gate; return { ok: true, json: async () => ({ entries: [] }) } }
      return { ok: true, json: async () => ({ entries: [] }) }
    },
  })
  await sleep(100)
  dispose()
  const w = urls[0]
  assert.ok(w !== undefined, '应发起 focus-wait')
  assert.match(w, /client=desktop:[0-9a-f-]+/, '桌面页面 client 参数应带 desktop: 前缀（服务端据此路由原生通知/置前）')
  release()
  console.log('DESKTOP-SELF-ID-OK')
}

// ---- 5) desktop notify 条目 → Web Notification + 展示 ack + 点击聚焦/回执 ----
console.log('--- 5) notify 条目 → 原生通知 + ack + clicked ---')
{
  const instances = []
  const posts = []
  class FakeNotification {
    static permission = 'granted'
    static requestPermission = async () => 'granted'
    constructor(title, options) {
      this.title = title
      this.options = options
      this.listeners = new Map()
      instances.push(this)
    }
    addEventListener(ev, fn) {
      if (!this.listeners.has(ev)) this.listeners.set(ev, [])
      this.listeners.get(ev).push(fn)
    }
    close() {}
  }
  const fire = (n, ev) => { for (const fn of n.listeners.get(ev) ?? []) fn() }
  let served = false
  const { opened, dispose } = loadBundle({
    hash: '',
    protocol: 'dsh-app:',
    isListed: () => true,
    Notification: FakeNotification,
    fetch: async (url, opts) => {
      if (opts?.method === 'POST') { posts.push({ url: String(url), body: opts.body }); return { ok: true, json: async () => ({}) } }
      // 首轮投 1 条 notify 条目，之后空
      const entries = served ? [] : [{ seq: 99001, kind: 'notify', sessionId: 'sess-native-1', title: '原生标题', body: '原生正文', silent: true }]
      served = true
      return { ok: true, json: async () => ({ entries }) }
    },
  })
  await sleep(150)
  assert.equal(instances.length, 1, '应恰好构造 1 个原生 Notification')
  assert.equal(instances[0].title, '原生标题')
  assert.equal(instances[0].options.body, '原生正文')
  assert.equal(instances[0].options.silent, true, '服务端下发的静音位应透传')
  fire(instances[0], 'show')
  await sleep(50)
  const ackPost = posts.find((p) => p.url.includes('/turn-notify/notify-ack'))
  assert.ok(ackPost !== undefined, '展示后应 POST notify-ack')
  assert.equal(JSON.parse(ackPost.body).seq, 99001, 'ack 体应带条目 seq')
  fire(instances[0], 'click')
  await sleep(50)
  assert.ok(opened.includes('sess-native-1'), '点击应 open 目标会话')
  const clickPost = posts.find((p) => p.url.includes('/turn-notify/clicked'))
  assert.ok(clickPost !== undefined, '点击应 POST clicked（宿主广播聚焦 + dsh://open 置前）')
  dispose()
  console.log('NATIVE-NOTIFY-OK')
}

// ---- 6) 浏览器页面跳过 notify 条目（不双响）；focus 条目照常 ----
console.log('--- 6) 浏览器跳过 notify 条目 ---')
{
  const instances = []
  class FakeNotification {
    static permission = 'granted'
    constructor() { instances.push(this) }
    addEventListener() {}
    close() {}
  }
  let phase = 0
  const { opened, dispose } = loadBundle({
    hash: '',
    protocol: 'https:',
    isListed: () => true,
    Notification: FakeNotification,
    fetch: async () => {
      // 首轮 notify 条目，次轮 focus 条目，之后空
      const entries = phase === 0
        ? [{ seq: 99001, kind: 'notify', sessionId: 'sess-should-not-open', title: 'T', body: 'B', silent: true }]
        : phase === 1 ? [{ seq: 99002, sessionId: 'sess-focus-1' }] : []
      phase++
      return { ok: true, json: async () => ({ entries }) }
    },
  })
  await sleep(200)
  dispose()
  assert.equal(instances.length, 0, '浏览器页面不得构造原生通知（其通知由宿主平台通道负责）')
  assert.ok(!opened.includes('sess-should-not-open'), 'notify 条目不得触发 open')
  assert.ok(opened.includes('sess-focus-1'), 'focus 条目照常触发 open（回归）')
  console.log('BROWSER-SKIP-NOTIFY-OK')
}

console.log('ALL-PASS')
// 测试环境显式退出：假 fetch 瞬回会让轮询的 0ms 重排链在断言后继续空转
// （生产端服务端每次挂起 ~pollHoldMs，无此churn；浏览器页面亦无进程退出语义）
process.exit(0)
