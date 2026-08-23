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
    sessions: unknown;
    remote: unknown;
    effect(fn: () => unknown, label?: string): void;
}
export declare const inject: string[];
/** 深链 hash 前缀（与服务端 deepLinkHash 配置一致）。 */
export declare const FOCUS_HASH_PREFIX = "#dsh-focus=";
export declare function apply(ctx: ClientContext): void;
export {};
