/**
 * dsh-turn-notify — 轮次结束通知插件（DSH bundle）· v0.1.0
 *
 * 只在 agent 真正停下来等用户输入时通知（goal 自动续跑轮静默），
 * 跨平台桌面通知 + 提示音 + 终端响铃 + 自定义命令。
 *
 * 平台后端（platform: auto 按宿主 OS 选择，可显式指定）：
 *   linux   notify-send 桌面通知 / paplay 提示音；自定义命令经 /bin/sh -c
 *   macos   osascript 桌面通知 / afplay 提示音；自定义命令经 /bin/sh -c
 *   windows PowerShell + WinRT Toast 桌面通知 / SoundPlayer 提示音；
 *           自定义命令经 cmd /c
 * Windows 通知脚本经 -EncodedCommand（UTF-16LE base64）投递，规避一切
 * 引号转义问题，零第三方依赖；AppUserModelId 借用系统 PowerShell
 * 自身的 AUMID（保证 toast 在 Win10/11 通知中心可靠显示）。
 *
 * 何时通知（goal 判别）：
 *   监听 agent/status 的 running→idle，但 idle 不一定等于"等用户"——
 *   goal 自动续跑（dsh-goal-round-driver）恰恰是在 idle 时注入下一轮
 *   <goal_round> 提示让 agent 重新 running。判别：
 *   1. 追踪每个会话的 goal 状态（live 事件 goal/changed，完整 GoalView）。
 *      "会自动续跑" = phase active 且 activation armed 且轮次未到上限。
 *   2. idle 时若判定会续跑 → 不立即通知，进入 goalQuietMs 兜底窗口；
 *      窗口内重新 running → 取消通知；窗口耗尽仍空闲 → 照常通知
 *      （判定失误的兜底，通知只会迟到不会丢）。
 *   3. 其余情况——无 goal、goal 完结(complete)/暂停(paused)/受阻
 *      (blocked)、disarmed（resume 后等用户说继续）、轮次到上限——
 *      都是真停，立即通知。
 *   注：重启/resume 后的 active goal 一律 disarmed（不自动续跑），
 *   与 live 事件追踪的可见范围一致，无需回放 durable 日志。
 *
 * 通知内容（模板化，占位符 {title} {question} {sessionId}）：
 *   标题 = titleTemplate 渲染（默认 '{title}'：会话标题，首轮可能
 *         未生成，退回 fallbackTitle）
 *   正文 = bodyTemplate 渲染（默认 '{question}'：本轮用户提问的前
 *         questionChars 字，只认真人输入 source.kind === 'user'；
 *         goal 续跑消息 kind === 'goal' 不污染提问文本）
 *
 * 配置覆盖（后者胜）：Schema 默认值 → profile 组合层（id: turn-notify
 * 整行替换，需重启）→ ~/.dsh/settings.yaml 顶层 turn-notify: 段（热生效）。
 */
import type { Context } from '@deepseek-ai/cordis';
import Schema from '@deepseek-ai/schemastery';
export declare const name = "turn-notify";
export declare const inject: never[];
export type PlatformChoice = 'auto' | 'linux' | 'macos' | 'windows';
export interface Config {
    platform: PlatformChoice;
    notifySend: boolean;
    sound: boolean;
    soundFile: string;
    bell: boolean;
    command: string;
    notifyCommand: string;
    soundCommand: string;
    appName: string;
    expireMs: number;
    titleTemplate: string;
    bodyTemplate: string;
    rootOnly: boolean;
    skipGoalRounds: boolean;
    goalQuietMs: number;
    fallbackTitle: string;
    fallbackMessage: string;
    questionChars: number;
    minRunMs: number;
}
export declare const Config: Schema<Config>;
export declare function apply(ctx: Context, config: Config): void;
