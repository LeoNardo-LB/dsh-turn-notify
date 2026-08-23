# dsh-turn-notify

DSH bundle 插件：**agent 真正停下等用户输入时发出通知**。
弥补 dsh 0.1.1-rc.2 没有任何原生 turn 结束提示通道的问题。

跨平台：**Linux**（notify-send + paplay）/ **macOS**（osascript + afplay）/
**Windows**（PowerShell WinRT Toast + SoundPlayer）。

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

## 通知内容（模板化）

| 部位 | 默认 | 来源 |
|---|---|---|
| 标题 | `{title}` → 会话标题 | session/title latest-wins 快照；首轮可能未生成（标题异步生成），退回 fallbackTitle（默认 "DSH"） |
| 正文 | `{question}` → 本轮用户提问的前 questionChars 字（默认 80，超出加 …） | user/message；只统计真人输入（source.kind === 'user'）。goal 续跑注入消息 source.kind === 'goal'，不污染提问文本——goal 完结时的通知正文因此正确显示最初的人类请求 |
| 正文兜底 | 未捕获到提问时显示 fallbackMessage | — |

`titleTemplate` / `bodyTemplate` 可自由编排，占位符
`{title}` `{question}` `{sessionId}`。

## 通知通道

| 通道 | 默认 | Linux | macOS | Windows |
|---|---|---|---|---|
| notifySend | 开 | notify-send | osascript | PowerShell WinRT Toast |
| sound | 开 | paplay | afplay | PowerShell SoundPlayer |
| bell | 关 | ASCII BEL | ASCII BEL | ASCII BEL |
| command | 关 | /bin/sh -c | /bin/sh -c | cmd /c |

- `platform`：auto（默认，按宿主 OS）/ linux / macos / windows 显式指定。
- `notifyCommand` / `soundCommand`：命令模板完全接管对应通道
  （占位符同上；高级用法，如自定义通知客户端）。
- `appName`（默认 dsh）：linux 通知归属应用名。
- `expireMs`（默认 4000）：linux 通知超时；macos/win 不支持则忽略。
- `soundFile`：留空 = 平台默认（linux freedesktop bell.oga /
  macos Glass.aiff / windows Windows Notify.wav）。

Windows 实现注记：通知脚本经 PowerShell `-EncodedCommand`
（UTF-16LE base64）投递，规避引号转义问题，零第三方依赖；
AppUserModelId 借用系统 PowerShell 自身 AUMID 保证通知中心可靠显示。
**Windows 路径按 Win10/11 官方 Toast API 实现，尚未真机验证**
（开发环境无 Windows）；如有问题请提 issue。

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

已实测：dsh 0.1.1-rc.2（Linux 真机：本地 link: 安装 + GitHub git 安装
真实装载、通知/提示音/goal 判别/模板；macOS/Windows 后端按官方 API 实现，
Windows 待真机验证）。

## 开发

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
- 首轮回复时标题常未生成（异步），退回 fallbackTitle；第二轮起为真实标题。
- 插件加载前已发生的事件不回放（live 追踪）——与 goal 判别语义一致
  （重启后的 goal 一律 disarmed，本就该立即通知）。
- goal/changed 不含 turn 结束原因；如需区分 completed/aborted/error
  要另听 session/event 的 turn/end。
- pre-release 的 dsh 对事件面无兼容承诺；事件名/形状变更需跟进适配。

## License

MIT
