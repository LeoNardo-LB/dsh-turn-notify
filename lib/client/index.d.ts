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
