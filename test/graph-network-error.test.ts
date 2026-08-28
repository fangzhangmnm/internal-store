// graph 网络层失败翻译验收（2026-08-25，案卷 20260825-cloud-override-adopt-noop-case.md §2）。
// created 2026-08-25 by Claude Fable 5 (claude-fable-5)
//   fetch 自身 throw（Safari 报裸 `TypeError: Load failed`）→ 必须翻成 CloudNetworkError：
//   可辨认（app 换 i18n 人话）、status undefined（push.retriable 仍视为可重试，重试语义不变）、cause 保留原错。
import { test, assert, eq } from "./runner.mjs";
import { createGraph } from "../src/providers/graph.ts";
import { CloudNetworkError } from "../src/errors.ts";

test("graph fetch 网络层 throw → CloudNetworkError（name 可辨认 / status undefined / cause 保留）", async () => {
  const { getItemByPath } = createGraph(() => Promise.resolve("TEST-TOKEN"));
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = () => { throw new TypeError("Load failed"); };
  try {
    let err: unknown = null;
    try { await getItemByPath("x.ora"); } catch (e) { err = e; }
    assert(err instanceof CloudNetworkError, "网络层 throw 被翻成 CloudNetworkError");
    eq((err as Error).name, "CloudNetworkError", "name 可辨认（app 侧按 name 换文案）");
    assert((err as { status?: number }).status === undefined, "status undefined → retriable 仍视为可重试");
    assert((err as { cause?: unknown }).cause instanceof TypeError, "原始 TypeError 保留在 cause（诊断可追）");
  } finally {
    (globalThis as { fetch: unknown }).fetch = orig;
  }
});
