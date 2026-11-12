// 2.3.4：按请求种类分超时档（统筹 Claude Fable 5.2 定；代码 / 测试 Claude Opus 5.5，2026-11-12）
//   毛病：graphFetch 一律用 meta 那档（30 s）。一次性上传（≤ 4 MB）带着整份字节也落在这一档——慢网上一本 3–4 MB 带图的书每次都超时、
//   永远传不上去；拿不到下载地址时的 /content 兜底下载同样。修的是分档，不调数字：/content 整份 = blob 档、按范围 = range 档（保留默认开，理由见 2.3.6 发版说明）；
//   一次性上传 2.3.4 / 2.3.5 默认改成 chunk 档是错的（默认生效的行为变更），2.3.6 改成单列的 upload 档：不写 = meta 档（2.3.3 及以前）、宿主显式写了才用。
//   守的：超时把上传掐断时那一次可能已经落盘 → 必须走「落地未确认 → 留着待传 → 下次推对字节自愈」，不许记成传完。
import { test, eq, assert } from "./runner.mjs";
import { createGraph, DEFAULT_GRAPH_TIMEOUTS } from "../src/base/providers/graph.ts";
import { CloudNetworkError } from "../src/base/errors.ts";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

// 四档各给一个认得出的数（upload 不写 = meta 那档）
const TIERS = { meta: 1111, chunk: 2222, range: 3333, blob: 4444 };
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

/** 记下每个请求带的超时档：给 AbortSignal.timeout 造出来的信号贴上毫秒数，fetch 替身按「方法 路径」记。 */
function rig(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const seen: Array<{ what: string; ms: number | null }> = [];
  const origTimeout = AbortSignal.timeout;
  (AbortSignal as { timeout: unknown }).timeout = (ms: number) => { const s = origTimeout.call(AbortSignal, ms); (s as { __ms?: number }).__ms = ms; return s; };
  const origFetch = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (input: unknown, init?: RequestInit) => {
    const url = String(input);
    seen.push({ what: `${init?.method ?? "GET"} ${new URL(url).pathname}`, ms: init?.signal ? ((init.signal as { __ms?: number }).__ms ?? -1) : null });
    return handler(url, init);
  };
  return { seen, restore: () => { (globalThis as { fetch: unknown }).fetch = origFetch; (AbortSignal as { timeout: unknown }).timeout = origTimeout; } };
}
const msOf = (seen: Array<{ what: string; ms: number | null }>, pred: (w: string) => boolean): Array<number | null> => seen.filter((x) => pred(x.what)).map((x) => x.ms);

test("[超时分档] 开着 timeouts、没写 upload：一次性上传的 PUT 用 meta 档（2.3.3 及以前的行为；2.3.4 / 2.3.5 默认 chunk 是错的，2.3.6 改回）", async () => {
  const r = rig(async () => json({ id: "I1", name: "书.zip", eTag: "e2", size: 3 }));
  try {
    const g = createGraph(() => Promise.resolve("TOKEN"), { timeouts: TIERS });
    await g.uploadFileToApproot("书.zip", new Blob([new Uint8Array([1, 2, 3])]), "application/zip", { conflictBehavior: "replace", eTag: "e1" });
    const puts = msOf(r.seen, (w) => w.startsWith("PUT ") && w.endsWith("/content"));
    eq(puts.length, 1, "一次性上传打了一个 PUT");
    eq(puts[0], TIERS.meta, "PUT 的时限 = meta 档（没写 upload）");
  } finally { r.restore(); }
});

// 2.3.6（统筹 Claude Fable 5.2 定；Claude Opus 5.5）：一次传完的上传单列成可选的 upload 档——不写 = meta 那档（上面那条验）；
//   写了 = 一次传完的上传用它，分块上传的每一块照旧 chunk，元数据照旧 meta。
const BIG = 4 * 1024 * 1024 + 10;   // > 4 MiB → 分块上传
test("[超时分档 · 2.3.6] 写了 upload：一次传完的上传用 upload 档；分块上传那一块还是 chunk 档；元数据还是 meta 档", async () => {
  const UP = 5555;
  const r = rig(async (url, init) => {
    if (url.includes("createUploadSession")) return json({ uploadUrl: "https://upload.example/sess/1" });
    if (url.startsWith("https://upload.example/") && init?.method === "PUT") return new Response(JSON.stringify({ id: "I2", name: "大书.zip", eTag: "e9", size: BIG }), { status: 201 });
    return json({ id: "I1", name: "书.zip", eTag: "e2", size: 3 });
  });
  try {
    const g = createGraph(() => Promise.resolve("TOKEN"), { timeouts: { ...TIERS, upload: UP } });
    await g.uploadFileToApproot("书.zip", new Blob([new Uint8Array([1, 2, 3])]), "application/zip", { conflictBehavior: "replace", eTag: "e1" });
    await g.uploadFileToApproot("大书.zip", new Blob([new Uint8Array(BIG)]), "application/zip", { conflictBehavior: "fail" });
    const simple = msOf(r.seen, (w) => w.startsWith("PUT ") && w.endsWith("/content"));
    eq(JSON.stringify(simple), JSON.stringify([UP]), "一次传完的 PUT = upload 档");
    const chunks = msOf(r.seen, (w) => w.startsWith("PUT /sess/"));
    assert(chunks.length >= 1 && chunks.every((ms) => ms === TIERS.chunk), `分块的每一块 = chunk 档：${JSON.stringify(chunks)}`);
    eq(JSON.stringify(msOf(r.seen, (w) => w.startsWith("POST ") && w.includes("createUploadSession"))), JSON.stringify([TIERS.meta]), "会话创建（元数据）= meta 档");
  } finally { r.restore(); }
});
test("[超时分档 · 2.3.6] 默认时限表里没有 upload（宿主传 DEFAULT_GRAPH_TIMEOUTS = 一次传完的上传用 meta 那档，和 2.3.3 及以前一样）", () => {
  assert(!("upload" in DEFAULT_GRAPH_TIMEOUTS), "默认表不写 upload");
});
test("[超时分档 · 2.3.6] upload 档到点：抛的是没有 status 的网络错（类别 timed-out）——和整台测试注入的那种一样，走「不算推成、仍是待传、下次续推自愈」", async () => {
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (_u: unknown, init?: RequestInit) => new Promise((_res, rej) => {
    const sig = init?.signal;
    if (sig) sig.addEventListener("abort", () => rej(sig.reason));   // 上传卡死：一直不回，直到时限把它掐掉
  });
  try {
    const g = createGraph(() => Promise.resolve("TOKEN"), { timeouts: { ...TIERS, upload: 60 } });
    const t0 = Date.now();
    let err: unknown = null;
    try { await g.uploadFileToApproot("书.zip", new Blob([new Uint8Array([1, 2, 3])]), "application/zip", { conflictBehavior: "replace", eTag: "e1" }); } catch (e) { err = e; }
    assert(err instanceof CloudNetworkError, `是 CloudNetworkError：${String(err)}`);
    eq((err as { status?: number }).status, undefined, "没有 status（推送层按可重试处理）");
    eq(((err as { cause?: { category?: string } }).cause)?.category, "timed-out", "类别 = timed-out");
    assert(Date.now() - t0 < 1000, "按显式写的 upload 档 60 ms 掐，不是 meta 档的 1111 ms 那么久之后才掐");
  } finally { (globalThis as { fetch: unknown }).fetch = orig; }
});

test("[超时分档] 开着 timeouts：/content 兜底下载整份用 blob 档、按范围用 range 档；拿下载地址那一趟还是 meta 档", async () => {
  const r = rig(async (url) => (url.endsWith("/content") ? new Response("BYTES", { status: 200 }) : json({ id: "I1", name: "a.txt" })));   // 没有 downloadUrl → 走兜底
  try {
    const g = createGraph(() => Promise.resolve("TOKEN"), { timeouts: TIERS });
    await g.downloadItemBlob("I1");
    await g.downloadItemRange("I1", 0, 3);
    eq(JSON.stringify(msOf(r.seen, (w) => w.endsWith("/content"))), JSON.stringify([TIERS.blob, TIERS.range]), "整份 = blob 档，按范围 = range 档");
    assert(msOf(r.seen, (w) => w.endsWith("/items/I1")).every((ms) => ms === TIERS.meta), "拿下载地址（元数据）= meta 档");
  } finally { r.restore(); }
});

test("[超时分档] 不开 timeouts：一次性上传和兜底下载都不带时限（和以前一样）", async () => {
  const r = rig(async (url, init) => (init?.method === "PUT" ? json({ id: "I1", name: "书.zip", eTag: "e2", size: 3 }) : url.endsWith("/content") ? new Response("BYTES") : json({ id: "I1", name: "a.txt" })));
  try {
    const g = createGraph(() => Promise.resolve("TOKEN"));   // 不传 transport
    await g.uploadFileToApproot("书.zip", new Blob([new Uint8Array([1, 2, 3])]), "application/zip", { conflictBehavior: "replace", eTag: "e1" });
    await g.downloadItemBlob("I1");
    assert(r.seen.length >= 3, "请求都打了");
    assert(r.seen.every((x) => x.ms === null), `都不带 signal：${JSON.stringify(r.seen)}`);
  } finally { r.restore(); }
});

// 超时掐断上传、其实已经落盘：这里用假云端模拟「写进去了，然后抛一个超时形状的网络错（没有 status）」。
//   只给一次机会（pushRetry.maxAttempts = 1 = 重试用完 / 页面死了）：这次必须仍是待传；下次续推撞上网盘那份 → 逐字节比对自愈，不弹面。
test("[超时分档] 上传被超时掐断但其实落盘了 → 不记成传完、留着待传；下次续推自愈，不弹面", async () => {
  const provider = createMockProvider();
  const local = createMockLocal();
  let sheets = 0;
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => { sheets++; return "cancel" as const; }, reportError: () => {} } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: (() => { const m = new Map<string, string>(); return { get: (k: string) => m.get(k) ?? null, set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] }; })(),
    local, isOnline: () => true, signedIn: () => true, skipMigration: true, pushRetry: { maxAttempts: 1 } });
  const f = store.file("书.ora", { mode: "existing" });
  await f.save(new TextEncoder().encode("V1"), { tryPush: true });          // 建谱系
  const origUpload = provider.upload.bind(provider);
  let armed = true;
  provider.upload = (async (...a: Parameters<typeof provider.upload>) => {
    const item = await origUpload(...a);                                       // 真的写进网盘了
    if (!armed) return item;
    armed = false;
    throw new CloudNetworkError("Graph PUT …: network fetch failed host=graph.microsoft.com after=120000ms (TimeoutError: signal timed out)",
      new DOMException("signal timed out", "TimeoutError"), { stage: "graph", host: "graph.microsoft.com" });   // 回执被超时掐掉
  }) as typeof provider.upload;
  const r = await f.save(new TextEncoder().encode("V2-慢网上的书"), { tryPush: true });
  eq(r.pushed, false, "这次没确认 → 不算推成（诚实）");
  eq(await store.files.dirty.count(), 1, "★留着待传（没被记成传完）");
  const all = await store.files.dirty.pushAll();                              // 下次续推
  eq(all.failed.length, 0, `续推不失败：${JSON.stringify(all)}`);
  eq(all.pushed, 1, "自愈算推成");
  eq(sheets, 0, "★没弹冲突面（网盘那份就是自己的字节）");
  eq(await store.files.dirty.count(), 0, "待传清了");
});
