/**
 * dsh-turn-notify browser half：点击通知卡片 → 回到对应会话。
 *
 * 统一深链路径（服务端点击回调 = OS 用默认浏览器打开
 * #dsh-focus=<sessionId>；浏览器自带置前/复用窗口行为）：
 *   1. 本页从深链打开（hash 定位会话）→ sessions.open + 清 hash
 *   2. BroadcastChannel：深链页广播 focus → 已开的其他标签页（leader）
 *      同步切到同一会话，保持多标签页一致；后开者非 leader
 *   3. document.title 稳定标记（"— DSH" 后缀）
 *
 * @module dsh-turn-notify/client
 */
/** 客户端上下文最小面（官方 runtime 的类型依赖未全发布，本地同款声明）。 */
interface ClientContext {
    sessions: unknown;
    effect(fn: () => unknown, label?: string): void;
}
export declare const inject: string[];
/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export declare const FOCUS_HASH_PREFIX = "#dsh-focus=";
export declare function apply(ctx: ClientContext): void;
export {};
