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
