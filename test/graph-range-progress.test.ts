// graph byte-range 的 0.19 旁路（2026-10-17 Claude Fable 5.1）：按流读报进度；调度层中止 → 不重申请 downloadUrl、不重试。
import { test, assert, eq } from "./runner.mjs";
import { createGraph, downloadRangeFromUrl } from "../src/providers/graph.ts";
import { CloudNetworkError } from "../src/errors.ts";

const data = Uint8Array.from({ length: 100 }, (_, i) => i);
const streamOf = (parts: Uint8Array[], hangAfter = false): ReadableStream<Uint8Array> => new ReadableStream({
  start(c) { for (const p of parts) c.enqueue(p); if (!hangAfter) c.close(); },
});

test("downloadRangeFromUrl：按流读 → onProgress 报累计字节，字节逐位对；不给 onProgress 行为同前", async () => {
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async () => new Response(streamOf([data.slice(0, 30), data.slice(30, 100)]), { status: 206 });
  try {
    const prog: number[] = [];
    const buf = await downloadRangeFromUrl("https://cdn/x", 0, 100, { onProgress: (n) => prog.push(n) });
    eq(prog.join(","), "30,100", "★累计进度");
    eq([...new Uint8Array(buf)].join(","), [...data].join(","), "字节对");
    const buf2 = await downloadRangeFromUrl("https://cdn/x", 0, 100);
    eq(new Uint8Array(buf2).length, 100, "没要进度：一口读完");
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});

test("downloadItemRange：调度层中止 → CloudNetworkError，且不重申请 downloadUrl（graph item GET 只打一次）", async () => {
  const orig = globalThis.fetch;
  let itemGets = 0;
  (globalThis as { fetch: unknown }).fetch = async (url: string, init?: RequestInit) => {
    if (url.includes("graph.microsoft.com")) { itemGets++; return new Response(JSON.stringify({ id: "I", "@microsoft.graph.downloadUrl": "https://cdn/I" }), { status: 200 }); }
    // CDN：头到了、体永远不来；中止 → 体流出错（真 fetch 的行为）
    let ctl!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(c) { ctl = c; c.enqueue(data.slice(0, 10)); } });
    init?.signal?.addEventListener("abort", () => ctl.error(new DOMException("aborted", "AbortError")), { once: true });
    return new Response(body, { status: 206 });
  };
  try {
    const g = createGraph(() => Promise.resolve("TOKEN"));
    const ctrl = new AbortController();
    const prog: number[] = [];
    const p = g.downloadItemRange("I", 0, 100, { signal: ctrl.signal, onProgress: (n) => prog.push(n) });
    await new Promise((r) => setTimeout(r, 10));
    eq(prog.join(","), "10", "头 10 字节到了");
    ctrl.abort();
    let err: unknown = null;
    try { await p; } catch (e) { err = e; }
    assert(err instanceof CloudNetworkError, `中止 → CloudNetworkError（实得 ${(err as Error)?.name}）`);
    eq(itemGets, 1, "★我们自己中止的不算 downloadUrl 过期：不重申请、不重试");
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});
