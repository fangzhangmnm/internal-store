// 0.17.1 分块上传：单块失败接着传（nextExpectedRanges）、提交前核 eTag、请求超时 —— created 2026-10-15 by Claude Fable 5.1
//   起因：KudsRocket iPad 一次网络抖动整份重传；锁屏后 fetch 永远挂着；分块上传 If-Match 只在开会话时核（分析报告 §4 窗口）。
import { test, assert, eq } from "./runner.mjs";
import { createGraph } from "../src/base/providers/graph.ts";
import { CloudNetworkError } from "../src/base/errors.ts";

const MiB = 1024 * 1024;
const bytes = (n: number) => new Blob([new Uint8Array(n)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SESS = "https://up.example/session/1";
const ITEM = "/me/drive/special/approot:/x.crumb";

function harness(opts: { statusEtag?: string | null; failPutOnce?: number }) {
  const calls: string[] = [];
  let putFailed = false;
  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, ""), method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "POST" && url.includes("createUploadSession")) return json({ uploadUrl: SESS });
    if (method === "GET" && url.startsWith(ITEM)) return opts.statusEtag === null ? new Response("", { status: 404 }) : json({ id: "i1", name: "x.crumb", size: 12 * MiB, eTag: opts.statusEtag ?? "base" });
    if (method === "GET" && url === SESS) return json({ nextExpectedRanges: [`${5 * MiB}-`] });
    if (method === "DELETE" && url === SESS) return new Response("", { status: 204 });
    if (method === "PUT" && url === SESS) {
      const range = (init!.headers as Record<string, string>)["Content-Range"];
      if (opts.failPutOnce != null && range.startsWith(`bytes ${opts.failPutOnce}-`) && !putFailed) { putFailed = true; throw new TypeError("Load failed"); }
      const last = range.endsWith(`/${12 * MiB}`) && range.includes(`-${12 * MiB - 1}/`);
      return last ? json({ id: "i1", name: "x.crumb", size: 12 * MiB, eTag: "new" }, 201) : json({ nextExpectedRanges: [] }, 202);
    }
    throw new Error("unexpected " + method + " " + url);
  };
  return { calls, fetchFake };
}

test("分块上传：一块网络错 → 问会话传到哪了 → 从那里接着传（不从零），退避 1 s", async () => {
  const slept: number[] = [];
  const { calls, fetchFake } = harness({ failPutOnce: 5 * MiB });
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchFake;
  try {
    const g = createGraph(() => Promise.resolve("T"), { sleep: async (ms) => { slept.push(ms); }, chunkResume: true, verifyChunkedCommit: true });
    const progress: number[] = [];
    const item = await g.uploadFileToApproot("x.crumb", bytes(12 * MiB), "application/octet-stream", { conflictBehavior: "replace", eTag: "base", onProgress: (d) => progress.push(d) });
    eq(item?.eTag, "new", "最后一块的回执");
    eq(calls.filter((c) => c.startsWith("PUT")).length, 4, "3 块 + 重传 1 块 = 4 次 PUT（不是整份重来）");
    eq(calls.filter((c) => c === `GET ${SESS}`).length, 1, "问了一次会话进度");
    eq(slept.join(","), "1000", "退避 1 s");
    assert(progress.at(-1) === 12 * MiB, "进度到底");
    assert(calls.some((c) => c.startsWith(`GET ${ITEM}`)), "提交最后一块前核过 eTag");
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});

test("分块上传：提交前发现云端 eTag 变了 → 撤会话、抛 412（不盲落地）", async () => {
  const { calls, fetchFake } = harness({ statusEtag: "someone-else" });
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchFake;
  try {
    const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {}, verifyChunkedCommit: true });
    let err: { status?: number } | null = null;
    try { await g.uploadFileToApproot("x.crumb", bytes(12 * MiB), "application/octet-stream", { conflictBehavior: "replace", eTag: "base" }); } catch (e) { err = e as { status?: number }; }
    eq(err?.status, 412, "412 → cloud-sync 翻成 CloudConflictError → 冲突面");
    assert(calls.includes(`DELETE ${SESS}`), "会话撤掉了");
    eq(calls.filter((c) => c.startsWith("PUT")).length, 2, "最后一块没传");
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});

test("分块上传：连续失败超过上限 → CloudNetworkError（上层整份重试 / 留 dirty）", async () => {
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input), method = init?.method ?? "GET";
    if (method === "POST") return json({ uploadUrl: SESS });
    if (method === "GET" && url === SESS) return json({ nextExpectedRanges: ["0-"] });
    if (method === "PUT") throw new TypeError("Load failed");
    throw new Error("unexpected");
  };
  try {
    const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {}, chunkResume: true });
    let err: unknown = null;
    try { await g.uploadFileToApproot("x.crumb", bytes(6 * MiB), "application/octet-stream", { conflictBehavior: "fail" }); } catch (e) { err = e; }
    assert(err instanceof CloudNetworkError, "放弃后是网络错（可重试语义）：" + String(err));
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});

test("请求超时：挂死的 fetch 到点被中止 → CloudNetworkError", async () => {
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason ?? new Error("aborted")));
  });
  try {
    const g = createGraph(() => Promise.resolve("T"), { timeouts: { meta: 20 } });
    let err: unknown = null;
    const t0 = Date.now();
    try { await g.getItemByPath("x.crumb"); } catch (e) { err = e; }
    assert(err instanceof CloudNetworkError, "超时翻成网络错：" + String(err));
    assert(Date.now() - t0 < 2000, "没有真等");
  } finally {
    (globalThis as { fetch: unknown }).fetch = orig;
    createGraph(() => Promise.resolve("T"));   // 还原：不传 = 没有超时（0.17.0）
  }
});

test("0.17.2 默认 = 0.17.0 行为：一块网络错直接整份失败（不问会话、不退避），提交前不核 eTag，请求无超时", async () => {
  const { calls, fetchFake } = harness({ failPutOnce: 5 * MiB, statusEtag: "someone-else" });
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = fetchFake;
  try {
    const g = createGraph(() => Promise.resolve("T"));
    let err: unknown = null;
    try { await g.uploadFileToApproot("x.crumb", bytes(12 * MiB), "application/octet-stream", { conflictBehavior: "replace", eTag: "base" }); } catch (e) { err = e; }
    assert(err instanceof CloudNetworkError, "单块网络错 → 整份网络错：" + String(err));
    eq(calls.filter((c) => c === `GET ${SESS}`).length, 0, "没问会话");
    assert(!calls.some((c) => c.startsWith(`GET ${ITEM}`)), "没做提交前核 eTag");
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});
