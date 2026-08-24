# dsh-turn-notify

DSH bundle 插件：**提问到达时 + agent 真正停下等用户输入时发出通知**。
弥补 dsh 0.1.1-rc.2 没有任何原生 turn 提示通道的问题。

跨平台：**Linux**（notify-send + paplay）/ **macOS**（osascript + afplay）/
**Windows**（PowerShell WinRT Toast + SoundPlayer）。三平台均在真内核 CI 上验证。

## 何时通知（goal 判别）

agent 由 running 转 idle 不一定等于"等用户"——goal 自动续跑
（dsh-goal-round-driver）恰恰在 idle 时注入下一轮 <goal_round> 提示
让 agent 重新 running。判别逻辑：

1. 追踪每个会话的 goal 状态（live 事件 goal/changed 的完整 GoalView）。
   **会自动续跑** = phase active 且 activation armed 且轮次未到上限。
2. idle 时若判定会续跑 → 不立即通知，进入 goalQuietMs（默认 3000ms）
   兜底窗口；窗口内重新 running → 取消通知；窗口耗尽仍空闲 → 照常通知
   （判定失误的兜底，通知只是迟到不会丢）。
3. 其余情况——无 goal、goal 完结(complete)/暂停(paused)/受阻(blocked)、
   resume 后 disarmed、轮次到上限——都是真停，**立即通知**。

重启/resume 后的 active goal 一律 disarmed（不自动续跑），与 live 事件
追踪的可见范围一致，无需回放 durable 日志。

## 提问通知（默认关）

真人提问进入会话的瞬间也响一次（提示音 + 桌面通知），内容 = **会话标题
+ 提问文本**，与轮次结束通知通过 `questionBodyTemplate` 默认值
（"提问：{question}"）区分。**默认关闭**：自己刚发的消息无需提醒；
适用场景是从远程设备发消息、想在桌面确认送达，需要时显式开启。

- 只认真人输入（`source.kind === 'user'`）：steering 插话同样触发；
  goal 续跑注入（`'goal'`）、合成上下文（`'plugin'`）不触发。
- 首轮提问时会话标题尚未生成（异步），退回 `fallbackTitle`；恢复的既有
  会话经服务折叠读出真实标题（v0.1.2+），第二次提问起展示真实标题。
- 可用不同音效区分两种事件：`questionSoundFile` 指定提问专用提示音。
- 开启（默认关）：`notifyOnQuestion: true`。

## 轮次结束通知内容（模板化）

| 部位 | 默认 | 来源 |
|---|---|---|
| 标题 | `{title}` → 会话标题 | 三级解析：live `session/title` 追踪 → 宿主 `sessionTitle` 服务日志折叠（覆盖重启后恢复的既有会话——历史标题事件是构造种子、不经事件总线重播，只有折叠读得到）→ fallbackTitle。仅首轮新会话在标题异步生成前会落到 fallback |
| 正文 | `{question}` → 本轮用户提问的前 questionChars 字（默认 80，超出加 …） | user/message；只统计真人输入（source.kind === 'user'）。goal 续跑注入消息 source.kind === 'goal'，不污染提问文本——goal 完结时的通知正文因此正确显示最初的人类请求 |
| 正文兜底 | 未捕获到提问时显示 fallbackMessage | — |

`titleTemplate` / `bodyTemplate` 可自由编排，占位符
`{title}` `{question}` `{sessionId}`。

## 通知通道

| 通道 | 默认 | Linux | macOS | Windows |
|---|---|---|---|---|
| notifySend | 开 | notify-send | osascript | balloon（auto）/ WinRT Toast |
| sound | 开 | paplay | afplay | 系统通知音（默认）/ SoundPlayer |
| bell | 关 | ASCII BEL | ASCII BEL | ASCII BEL |
| command | 关 | /bin/sh -c | /bin/sh -c | cmd /c |

- `platform`：auto（默认，按宿主 OS）/ linux / macos / windows 显式指定。
- `notifyCommand` / `soundCommand`：命令模板完全接管对应通道
  （占位符同上；高级用法，如自定义通知客户端）。
- `appName`（默认 dsh）：linux 通知归属应用名。
- `expireMs`（默认 4000）：linux 通知超时；macos/win 不支持则忽略。
- `soundFile`：留空 = 平台默认音——linux freedesktop bell.oga /
  macos Glass.aiff；**windows = 通知自带的系统通知音（单音源，不额外
  发声）**。显式配置文件时 windows 会静音通知、用 SoundPlayer 播该文件
  （此时点击机制自动落到 toast 模式，见 `windowsClickMode`）。
- `notifyOnQuestion`（默认开）+ `questionTitleTemplate` /
  `questionBodyTemplate` / `questionSoundFile`：提问通知开关与
  内容/音效（见上节）。

Windows 实现注记：通知脚本经 PowerShell `-EncodedCommand`
（UTF-16LE base64）投递，规避引号转义问题，零第三方依赖。通知归属
（品牌显示）：`windowsToastAumid: auto`（默认）注册自有 AUMID
（开始菜单 dsh 快捷方式 + System.AppUserModel.ID 属性写入 +
Get-StartApps 校验）→ toast 以 **dsh** 名义显示；注册/校验失败自动
回退系统 PowerShell AUMID（保证通知中心可靠显示）。balloon 卡片的
归属跟随宿主进程显示 Windows PowerShell（脚本宿主无法改名——要品牌
一致可置 `windowsClickMode: 'toast'`）。

Windows 验证状态（Linux pwsh 7.4 + 官方 Parser 三层工装
`tests/windows-pwsh.mjs`，CI 常跑）：编码往返无损（中日文/引号/
反斜杠/emoji）、对抗注入字符串下脚本语法零错误、真实执行精确停在
WinRT 类型加载——即解码/解析/转义全部正确，**仅 toast 的最终显示
仍需真 Windows 真机确认**；如有问题请提 issue。

## 噪音过滤

- rootOnly（默认开）：只通知根会话，子代理/后台任务不响。
- skipGoalRounds（默认开）：goal 自动续跑轮不响（见上）。
  置 false 恢复"每次 idle 都通知"。
- goalQuietMs（默认 3000）：续跑判定兜底窗口。
- minRunMs（默认 0）：运行不足该毫秒数的轮次跳过。

## 配置

三层覆盖（后者胜）：Schema 默认值 → profile 组合层（bundle patch 行 /
profile cordis.patch.yml 里 id: turn-notify 整行替换，需重启）→
`~/.dsh/settings.yaml` 顶层 turn-notify: 段（leaf 级合并，**热生效**）。

```yaml
# ~/.dsh/settings.yaml 追加
turn-notify:
  sound: false
  questionChars: 30
```

## 安装 / 卸载

```bash
# git 安装（推荐）
dsh plugin --profile web add github:LeoNardo-LB/dsh-turn-notify
# 本地路径安装（开发）
dsh plugin --profile web add /path/to/dsh-turn-notify
# 卸载
dsh plugin --profile web remove dsh-turn-notify
```

安装后**重启该 profile 的宿主进程**才加载（bundles 清单是启动时解析的；
settings.yaml 的配置修改则是热生效）。

已实测：dsh 0.1.1-rc.2。三平台 CI（Linux / windows-latest / macos-latest
真内核）：Linux 真机端到端（本地 link: + GitHub git 安装、通知/提示音/
goal 判别/模板）；**macOS 端到端**（CI osascript 通知真实提交通知中心、
afplay 真实播放系统音效）；Windows 至通知平台提交（headless Server 上
止于 Show() 的 RPC 边界，有桌面会话即显示；XmlDocument WinRT 激活已按
真内核 CI 发现修复）。

## 版本与发版

三阶段状态机：**开发版 `X.Y.Z-dev.n` → 测试版 `X.Y.Z-beta` → 正式版
`X.Y.Z`**，递进必须走完全程（dev/beta 均为预览版；正式版与它的
dev/beta 同号）。所有升版经 `scripts/version.sh dev|beta|stable` 完成，
非法跳转直接报错；`--push` 一并推送提交与标签。完整规则与状态机图见
[docs/VERSIONING.md](docs/VERSIONING.md)。

## 开发

## 点击通知 → 回到会话（聚焦通道）

目标：**页面已开则复用（Linux 零浏览器启动），落地必达正确会话**。

聚焦通道（本插件经 webServer 服务的 register API 注册，不改任何宿主文件；
替代 dev.4 的转发白名单注入——那条路解析不到 dsh-api-remotes 的同一
模块实例，在所有平台都从未生效过）：

- **GET `/turn-notify/focus-wait?client=<uuid>&since=<seq>` 长轮询**：
  web 客户端插件在页面打开期间持续保持一个挂起请求（默认挂 7.5s、
  空返回后立即续接）。点击 → 服务端入队 → 挂起请求**立即**返回
  `{entries:[{seq,sessionId}]}` → 页面 `sessions.open` 切换会话。
  该轮询同时就是 presence：到达即记为“页面已开”。
- **POST `/turn-notify/focus`**：深链落地页广播聚焦（让其它已开标签页
  同步切换）。
- **POST `/turn-notify/click`**：balloon 点击回调入口（Windows）——
  入队聚焦 + 响应 `{open}`：页面在线 `false`（已开页面原地切换，
  零新标签页）；离线 `true`（回调进程 Start-Process 深链开浏览器）。
  **在线判定 = 瞬时真值**（当下是否有挂起的 focus-wait 请求），不用
  时间窗推断——页面刚关闭时时间窗会误判在线 → `open:false` → 点击
  无任何效果（真机反馈过的死点击）。

平台点击路径：

- **Linux**（`notify-send -A` 进程内回调）：页面在线（挂起长轮询）→
  入队分发已开页面，**零浏览器启动、不重复开标签页**；离线 →
  xdg-open 深链新开浏览器。
- **Windows**（`windowsClickMode: auto`，默认）：页面在线 → **NotifyIcon
  balloon**（shell 提升为 toast 显示，点击路由回 NotifyIcon——Win10/11
  兼容行为，真机已验证可路由）→ POST click 端点 → 已开页面原地切换，
  **零新标签页**；页面离线 → WinRT toast protocol launch，点击 =
  系统用浏览器打开深链。`balloon` 恒用 balloon；`toast` 恒用
  protocol launch（配置自定义 soundFile 时自动落到 toast——balloon 的
  系统音不可静音/替换）。
- **macOS**：terminal-notifier `-open` 的点击 = 系统直接用浏览器打开
  深链 URL（无进程回调）。落地页读 `#dsh-focus=<sessionId>` 聚焦正确
  会话（带会话列表竞态重试：新页列表异步晚到，`open` 对未列出会话
  抛错，250ms 重试至列表到达、至多 15s），并 POST 广播让其它标签页
  同步切换（Windows toast 模式的落地页同此）。

Windows 音效（单音源原则，默认 = 系统通知音）：默认（soundFile 留空）
用通知自带的系统通知音，不再叠 SoundPlayer；显式配置 soundFile 时才
静音通知 + SoundPlayer 播自定义文件；`sound: false` 全静音（balloon
尽力用无图标模式，toast 精确 `<audio silent="true"/>`）。

点击跳转的真机校验工具（CI 无法覆盖最后一环——runner 无桌面通知环境）：

- **macOS**：`node tests/macos-click.mjs` —— 自动发带 `-open` 深链的 terminal-notifier 通知，
  用辅助功能 API 自动点击卡片，本地监听器接住深链请求即 PASS（前置：brew 装
  terminal-notifier + 终端获得辅助功能授权；也可 10 秒内手动点）。
- **Windows 快速冒烟**（不想 clone 仓库时）：单文件 `tests/windows-notify-smoke.cjs`，
  零依赖（Node + 系统 PowerShell 5.1），`node windows-notify-smoke.js [标题] [正文]`——
  只验证卡片显示，不测点击。
- **Windows**：`node tests/windows-click.mjs [--auto]` —— 投递与插件同源的
  protocol-launch toast，点击（默认人工，`--auto` 尝试 UIA 自动点击会动鼠标）后
  默认浏览器打开深链，监听器收到即 PASS。

验证矩阵：`node tests/goal-logic.mjs`（goal 判别仿真 + 聚焦通道路由级
验证：长轮询挂起/唤醒、balloon click 端点 open 语义，任意平台）、
`node tests/client-logic.mjs`（浏览器端逻辑：深链聚焦重试 / 长轮询消费 /
广播——直接驱动构建产物）、`node tests/windows-pwsh.mjs [powershell/pwsh]`
（Windows 路径：toast 音源断言 + balloon 脚本解析/编码往返/关键内容）、
`node tests/macos-notify.mjs`（macOS 路径）；CI 三平台常跑。

包入口是编译产物 `lib/index.js`（Node 拒绝对 node_modules 下的 .ts 做
类型剥离，真实安装必须携带 JS；产物随仓库提交，git 安装即装即用、
无需 prepare 构建脚本）。

```bash
pnpm install          # 安装依赖（typescript / @types/node / cordis）
pnpm run build        # tsc 编译 src/ → lib/（提交前跑）
pnpm test             # goal 判别逻辑仿真测试
```

## 已知边界

- 桌面通知/提示音失败（如无 DBUS、无声卡）只警告一次并静默降级。
- 通道子进程 fire-and-forget（10s 超时），永不阻塞 agent loop。
- 首轮回复时标题常未生成（异步），退回 fallbackTitle；重启后恢复的既有
  会话标题经 sessionTitle 服务折叠读出（v0.1.2+），不再是兜底值。
- 提问文本为 live 追踪（不回放历史）；goal 判别不回放——与语义一致
  （重启后的 goal 一律 disarmed，本就该立即通知）。
- goal/changed 不含 turn 结束原因；如需区分 completed/aborted/error
  要另听 session/event 的 turn/end。
- pre-release 的 dsh 对事件面无兼容承诺；事件名/形状变更需跟进适配。
- 长轮询时序边界：页面开着但轮询刚中断（如系统睡眠唤醒瞬间）会被判为
  未开 → Linux/Windows(balloon) 深链新开一个标签页（同样定位到目标
  会话，之后恢复复用路径）。
- **Windows balloon 点击路由待真机验证**（shell 对 BalloonTip 的
  toast 提升与点击回传是 Win10/11 兼容行为）；不可靠时置
  `windowsClickMode: 'toast'` 退回 protocol launch——此时浏览器已开
  则点击必然新开一个标签页（浏览器打开 URL 的平台行为）。
- balloon 进程驻留 `balloonWaitMs`（默认 5 分钟，上限 1 小时，每次通知
  一个驻留 PowerShell 进程）；超时后通知中心里的残留卡片是死卡片
  （点击无效果）。balloon 的系统音不可静音/替换（要自定义音效请配
  soundFile，自动落 toast 模式）；balloon 归属显示 Windows PowerShell
  （见 `windowsToastAumid` 注记）。
- **macOS 浏览器已开时，点击通知必然新开一个标签页**（terminal-notifier
  点击=系统用浏览器打开深链，无进程回调）；落地页聚焦正确会话、其它
  已开标签页同步切换。Linux/Windows(balloon) 不受此限。
- 复用路径切换会话后不强制置前浏览器窗口（浏览器禁止无手势的前台抢占）;
  balloon/notify-send 点击本身在多数桌面环境会带出浏览器，个别情况需
  手动切到浏览器。
- 多标签页同源都会收到聚焦条目并切换（有意的收敛语义：无论最后看哪个
  标签页，都在正确会话上）。

## License

MIT
