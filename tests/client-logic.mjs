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
    location: { hash: env.hash ?? '', pathname: '/', search: '' },
    focus: env.windowFocus ?? (() => {}),
  }
  const g = {
    window,
    history: { replaceState: env.replaceState ?? (() => {}) },
    document: { title: 'DSH' },
    fetch: env.fetch,
    setTimeout, clearTimeout,
    BroadcastChannel: undefined,
    console,
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
  return { window, opened, dispose: () => { for (const d of disposers) d() } }
}

// ---- 1) 深链聚焦重试：列表 300ms 后才含目标会话 ----
console.log('--- 1) 深链聚焦：列表未到 → 重试到成功 ---')
{
  let listReady = false
  const { opened, dispose } = loadBundle({
    hash: '#dsh-focus=' + encodeURIComponent('sess-target-1'),
    isListed: (id) => listReady || id === 'sess-home',
    fetch: async (url, opts) => ({ ok: true, json: async () => ({ entries: [] }) }),
  })
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

console.log('ALL-PASS')
// 测试环境显式退出：假 fetch 瞬回会让轮询的 0ms 重排链在断言后继续空转
// （生产端服务端每次挂起 ~pollHoldMs，无此churn；浏览器页面亦无进程退出语义）
process.exit(0)
