// dsh-turn-notify Linux 点击通道逻辑测试：驱动构建产物 lib/index.js 的
// 纯函数（不发通知、不起 monitor、不读 /etc/apparmor.d）：
//   1. appArmorProfileBlocksCaps：Ubuntu 25.10+ notify-send profile 的
//      dbus 白名单（GetServerInformation/Notify）→ 判定 GetCapabilities 必被拦
//   2. parseBusctlMonitorChunk：busctl monitor 消息块 → ActionInvoked /
//      NotificationClosed 结构化结果
//   3. buildBusctlNotifyArgs：Notify 调用 argv（签名 susssasa{sv}i + default action）
//   4. deepLinkUrl：webUrl 已带 token 时原样保留（不触发 journalctl 探测）
// 运行：先 pnpm run build，再 node tests/linux-busctl-logic.mjs
import { strict as assert } from 'node:assert'
import { appArmorProfileBlocksCaps, buildBusctlNotifyArgs, deepLinkUrl, parseBusctlMonitorChunk } from '../lib/index.js'

// ── 1. AppArmor profile 判定 ────────────────────────────────────────────────
// 无 notify-send profile → 不拦
assert.equal(appArmorProfileBlocksCaps('# empty\n'), false)
assert.equal(appArmorProfileBlocksCaps('profile other /usr/bin/other {\n}\n'), false)

// Ubuntu 25.10 风格：白名单只有 GetServerInformation/Notify → 拦
const blocking = [
  '# comment',
  'abi <abi/4.0>',
  'profile notify-send /usr/bin/notify-send {',
  '  include <tunables/global>',
  '  dbus (send)',
  '       bus=session',
  '       path=/org/freedesktop/Notifications',
  '       interface=org.freedesktop.Notifications',
  '       member=Notify,',
  '  dbus (send)',
  '       bus=session',
  '       path=/org/freedesktop/Notifications',
  '       interface=org.freedesktop.Notifications',
  '       member=GetServerInformation,',
  '}',
].join('\n')
assert.equal(appArmorProfileBlocksCaps(blocking), true)

// 白名单含 GetCapabilities → 不拦（老版本 profile）
const permissive = blocking.replace('member=Notify,', 'member=Notify,\n       member=GetCapabilities,')
assert.equal(appArmorProfileBlocksCaps(permissive), false)

// 有 profile 但无 Notifications 相关 dbus 规则 → 不拦
const noRules = 'profile notify-send /usr/bin/notify-send {\n  include <tunables/global>\n}\n'
assert.equal(appArmorProfileBlocksCaps(noRules), false)

// ── 2. busctl monitor 消息块解析 ────────────────────────────────────────────
const invoked = [
  '‣ Type=signal  Sender=org.freedesktop.Notifications  Path=/org/freedesktop/Notifications  Interface=org.freedesktop.Notifications  Member=ActionInvoked',
  '  UINT32 33;',
  '  STRING "default";',
].join('\n')
assert.deepEqual(parseBusctlMonitorChunk(invoked), { member: 'ActionInvoked', id: 33, actionKey: 'default' })

const closed = [
  '‣ Type=signal  Sender=org.freedesktop.Notifications  Member=NotificationClosed',
  '  UINT32 33;',
  '  UINT32 2;',
].join('\n')
assert.deepEqual(parseBusctlMonitorChunk(closed), { member: 'NotificationClosed', id: 33 })

// 非目标信号 / 缺参 → null
assert.equal(parseBusctlMonitorChunk('‣ Type=signal  Member=SomethingElse\n  UINT32 1;'), null)
assert.equal(parseBusctlMonitorChunk('‣ Type=method_call  Member=ActionInvoked'), null)

// ── 3. busctl Notify argv ──────────────────────────────────────────────────
const argv = buildBusctlNotifyArgs('dsh', '标题', '正文')
assert.deepEqual(argv, [
  '--user', 'call',
  'org.freedesktop.Notifications', '/org/freedesktop/Notifications', 'org.freedesktop.Notifications', 'Notify',
  'susssasa{sv}i',
  'dsh', '0', 'dialog-information', '标题', '正文',
  '2', 'default', '打开会话',
  '0',
  '0',
])

// ── 4. 深链 token 保留（webUrl 已带 token 时不做 journalctl 探测） ─────────
const cfg = { webUrl: 'http://127.0.0.1:3080?token=abc123', deepLinkHash: '#dsh-focus=' }
assert.equal(deepLinkUrl(cfg, 'session-1'), 'http://127.0.0.1:3080?token=abc123/#dsh-focus=session-1')

console.log('linux-busctl-logic: 全部通过 ✓')
