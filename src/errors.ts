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
export class CloudNetworkError extends Error {
  override readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "CloudNetworkError";
    this.cause = cause;
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
