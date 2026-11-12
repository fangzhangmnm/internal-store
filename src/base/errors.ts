// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore / 顶层 export。
// created 2026-08-25 by Claude Fable 5 (claude-fable-5)
//
// CloudNetworkError —— provider 网络层失败的类型化封装（fetch 本身 throw：断网 / DNS / iOS 网络切换）。
//   动机（案卷 20260524 WeebPaint/ai-docs/20260825-cloud-override-adopt-noop-case.md §2）：
//   Safari 对 fetch 网络失败抛裸 `TypeError: Load failed`，一路裸奔到用户 banner，无从辨认也无法 i18n。
//   SW 网关在 spike-11（8fef121）已把 fetch throw 翻成可读日志；这里是页面侧 provider 的同款收口。
//   契约：
//   - `status` 恒 undefined → push.retriable() 视为可重试（与裸 TypeError 行为一致，重试语义不变）。
//   - 只在「fetch 自身 throw」处包装（那里 TypeError 必是网络层）；绝不拿 `e instanceof TypeError`
//     在上层泛判——我们自己代码的 TypeError bug 会被误装成「网络问题」而藏死。
//   - app 侧 ui.reportError 按 `name === "CloudNetworkError"` 换人话文案（i18n 归宿主，库内零文案）。
//   2.3.3（2026-11-12，小黑屋维修线施工单第 1 条；规矩 = 统筹 Claude Fable 5.2，代码 = Claude Opus 5.5）：
//   加两个可选字段，让宿主分得清「问微软的接口断了」还是「文件内容下载不下来」（两台不同的服务器）：
//   - `stage`："graph" = 经 Graph 接口（列文件 / 拿版本号 / 拿下载地址）；"content" = 下载文件内容（整份 / 按范围）。
//     没有 = 老的报错，或别的段（上传会话、复制监控）——宿主照旧走原来那句。
//   - `host`：**只有主机名**。下载地址是带签名的临时地址，拿到就能下载——整条地址、路径、查询串一律不进报错
//     （`test/graph-download-diagnostics.test.ts` 拿带假签名的地址去撞）。
// ── 上游报错原文一个字都不进我们的报错（2.3.5，2026-11-12；统筹 Claude Fable 5.2 重审裁定一推翻 2.3.3 的「找地址再删」，代码 Claude Opus 5.5）──
//   「在别人给的一段话里找地址再删」挡不住没见过的写法（统筹的攻击脚本 14 种里漏 9 种：括号 / 撇号 / 引号 / 尖括号 / 没协议头 / 换行 /
//   错误里再套一层 / 错误对象上另挂地址字段 / 抛的不是 Error）。改成：网络报错的字只由三样拼成——我们自己的固定字样、where 那一串
//   （主机名、文件名、用时）、下面这个固定词表里的类别。原错只用来**归类**（按 name + 几句已知的浏览器原话精确匹配），一个字都不抄；
//   cause 不再挂原错对象，挂一个只带 name（也是固定词表）和类别的替身。
/** 网络层失败的类别（固定词表；认不出 = "other"）。 */
export type NetCategory = "failed-to-fetch" | "load-failed" | "network-error" | "fetch-failed" | "aborted" | "timed-out" | "other";
const KNOWN_NAMES = new Set(["TypeError", "AbortError", "TimeoutError", "NetworkError", "DOMException", "Error"]);
// 已知的浏览器 / 运行时原话（精确相等才算，不做包含匹配）：Chromium / WebKit / Firefox / Node undici。
const KNOWN_PHRASES: Record<string, NetCategory> = {
  "Failed to fetch": "failed-to-fetch",
  "Load failed": "load-failed",
  "NetworkError when attempting to fetch resource.": "network-error",
  "fetch failed": "fetch-failed",
};
const ownString = (e: unknown, key: "name" | "message"): string => {
  if (e == null || (typeof e !== "object" && typeof e !== "function")) return "";
  try { const v = (e as Record<string, unknown>)[key]; return typeof v === "string" ? v : ""; } catch { return ""; }
};
/** 把原错归进固定词表（只读 name / message 做精确比较，不抄任何一段）。 */
export function netCategory(e: unknown): NetCategory {
  const name = ownString(e, "name");
  if (name === "TimeoutError") return "timed-out";
  if (name === "AbortError") return "aborted";
  if (name === "TypeError") return KNOWN_PHRASES[ownString(e, "message")] ?? "other";
  return "other";
}
/** cause 的替身：只带固定词表里的 name 和类别；冻结的普通对象（没有 message、没有 stack、没有别的字段）。 */
export function netCause(e: unknown): { readonly name: string; readonly category: NetCategory } {
  const name = ownString(e, "name");
  return Object.freeze({ name: KNOWN_NAMES.has(name) ? name : "other", category: netCategory(e) });
}

export class CloudNetworkError extends Error {
  override readonly cause?: unknown;
  /** 2.3.3：断在哪一段。"graph" = Graph 接口；"content" = 下载文件内容。没有 = 老的报错 / 别的段（宿主照旧处理）。 */
  readonly stage?: "graph" | "content";
  /** 2.3.3：出事的主机名（只有主机名，绝不带路径和查询串）。 */
  readonly host?: string;
  constructor(message: string, cause?: unknown, info: { stage?: "graph" | "content"; host?: string } = {}) {
    super(message);
    this.name = "CloudNetworkError";
    this.cause = cause;
    if (info.stage) this.stage = info.stage;
    if (info.host) this.host = info.host;
  }
}

// CloudStaleRefError ——「已被别处动过」错误族（2026-08-25 user 拍板，随 id→ref 更名一起收敛；
//   ai-docs/20260825-localfile-knight-store-round.md §4 配套三件之一）。edited by Claude Fable 5 (2026-08-26)
//   语义：拿着一张 ref（行李牌）去操作，云端答 404 = 这张牌**指向的东西已不在原处**——
//   典型场景 = 回收站 list→用户点击的窗口里，别的设备已把该项恢复/清空（预存小洞：旧版只处理 412 不处理 404）。
//   契约：
//   - 不是 bug、不是网络故障——是「别处动过了」的事实 surface；app 收到后应提示刷新列表重查。
//   - 与 CloudConflictError（同一文件版本分叉，412）不同族：这里连对象都没了/换了，无「解决冲突」可言。
//   - path-as-id 的 folder provider 下 ref=path，改名/移动即作废 → 此错误族是消费方唯一该捕的形状
//     （绝不按 provider 类型分支判 404）。
export class CloudStaleRefError extends Error {
  /** 失效的那张 ref。 */
  readonly ref: string;
  override readonly cause?: unknown;
  constructor(ref: string, message?: string, cause?: unknown) {
    super(message ?? `cloud ref no longer valid (moved/removed elsewhere): ${ref}`);
    this.name = "CloudStaleRefError";
    this.ref = ref;
    this.cause = cause;
  }
}
