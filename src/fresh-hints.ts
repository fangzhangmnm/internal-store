// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// fresh-hints（深模块，0.17.0）—— 「刚列过的云端帧」当作新鲜度检查的证据。created 2026-10-14 by Claude Fable 5.1
//   起因：消费者打开文档时要 open() 几十个小文件，每个本地有副本的 open 都先 fetchMeta 一趟（freshness gate），
//   可它们全在刚刚 watchFolder 拿到的那一帧云端列表里——同一份 Graph 事实再问一遍，纯浪费。
//   做法：watchFolder 的**完整**云端帧把每个文件的 etag 记进来（带时间）；freshness 在 fetchMeta 之前先看这里。
//   安全边界（红线 §A「每次推都带 If-Match」不动）：
//     · 只在「提示的 etag === 本 tab 已见 base」时采信（= 云端没动 → in-sync，读本地）。提示说云端动了？**不信它**，照常 fetchMeta
//       ——提示可能比我们自己刚推上去的新版还旧（push 不清提示），拿它判「云端动了」会白拉一趟自己的版本。
//     · 有时效（默认 30 s）：过了就当没有。采信窗口内云端真动了 → 和今天 fetchMeta 之后再读本地的 TOCTOU 一样大：
//       下次 push If-Match base → 412 → 冲突面，不静默。
//     · 只看完整帧（complete:true）；掺了快照的 stale 帧绝不喂进来（它可能过时）。
import type { FetchMetaResult } from "./types.ts";

export interface FreshHints {
  /** 记一条（watchFolder 完整云端帧每个文件调一次）。 */
  note(name: string, meta: FetchMetaResult): void;
  /** 取还在时效内的提示；没有 / 过期 → null。不消费（同一帧可供多次 open）。 */
  peek(name: string): FetchMetaResult | null;
  /** 忘掉一条（测试 / 显式失效用）。 */
  forget(name: string): void;
}

export function createFreshHints(opts: { ttlMs?: number; now?: () => number } = {}): FreshHints {
  const ttl = opts.ttlMs ?? 30_000;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, { meta: FetchMetaResult; at: number }>();
  return {
    note(name, meta) { map.set(name, { meta, at: now() }); },
    peek(name) {
      const h = map.get(name);
      if (!h) return null;
      if (now() - h.at > ttl) { map.delete(name); return null; }
      return h.meta;
    },
    forget(name) { map.delete(name); },
  };
}
