// 下载失败的报错要分得清是谁的问题，而且绝不带出签名地址（2.3.3，2026-11-12）。
// created 2026-11-12 by Claude Opus 5.5（小黑屋维修线施工单第 1 条；规矩 = 统筹 Claude Fable 5.2）
//   起因：小黑屋 11-12 办公室那台机器连着十几次 `downloadUrl: network fetch failed (TypeError: Failed to fetch)`，
//   黑匣子里分不清是网络拦了那台发文件的服务器（通常几十毫秒就失败），还是那边没回音（通常十几秒）。
//   现在报错带：阶段（stage）、主机名、文件名、用时。
//   硬规矩：下载地址是带签名的临时地址，拿到就能下载——整条地址、路径、查询串都不许进报错（也就不进黑匣子）。
//   这里拿一条带假签名的地址去撞；而且让 fetch 自己的报错也带上整条地址（别的运行时可能这样）。
//   2.3.5（统筹 Claude Fable 5.2 重审裁定一）：不再「找地址再删」，上游报错原文一个字都不进来——字里只有固定字样 + where + 固定词表类别，
//   cause = 只带 name 和类别的替身。统筹攻击脚本的 14 种写法 × 五条路（整份 / 按范围 / /content 兜底 / 上传会话 / 复制监控）全在下面。
import { readFileSync } from "node:fs";
import { test, assert, eq } from "./runner.mjs";
import { createGraph } from "../src/base/providers/graph.ts";
import { CloudNetworkError } from "../src/base/errors.ts";

const HOST = "public.dm.files.1drv.com";
const SIGNED = `https://${HOST}/y4mSECRETPATHxyz/a.txt?download=1&tempauth=FAKE-SECRET-TEMPAUTH&sig=FAKESIG123`;
const ITEM_ID = "ITEM42";
// 不许出现在报错里的片段：查询串、签名、路径
const FORBIDDEN = ["?", "tempauth", "sig=", "FAKE-SECRET", "FAKESIG", "y4mSECRETPATH", "download=1"];

function noSecrets(text: string, what: string): void {
  for (const f of FORBIDDEN) assert(!text.includes(f), `${what} 里不许出现「${f}」：${text}`);
}
function errTexts(e: unknown): string {
  const x = e as { message?: string; cause?: unknown };
  return `${String(e)}\n${x.message ?? ""}\n${x.cause == null ? "" : String(x.cause)}\n${(x.cause as { message?: string } | null)?.message ?? ""}`;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200, headers: { "Content-Type": "application/json" } });

/** 装一个按地址分派的假 fetch；返回还原函数。 */
function withFetch(handler: (url: string, init?: RequestInit) => Promise<Response>): () => void {
  const orig = globalThis.fetch;
  (globalThis as { fetch: unknown }).fetch = (input: unknown, init?: RequestInit) => handler(String(input), init);
  return () => { (globalThis as { fetch: unknown }).fetch = orig; };
}
/** 拿下载地址那一趟（Graph）照常回；别的交给 onContent。 */
function graphThen(onContent: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.startsWith("https://graph.microsoft.com/")) return json({ id: ITEM_ID, name: "a.txt", "@microsoft.graph.downloadUrl": SIGNED });
    return onContent(url, init);
  };
}
async function caught(p: Promise<unknown>): Promise<unknown> {
  try { await p; } catch (e) { return e; }
  throw new Error("应该失败却成功了");
}

test("[下载报错] 整份下载被网络拦下：stage=content、主机名、文件名、用时都在；签名地址一个字都不出", async () => {
  const restore = withFetch(graphThen(async (url) => { await sleep(40); throw new TypeError(`Failed to fetch ${url}`); }));
  try {
    const { downloadItemBlob } = createGraph(() => Promise.resolve("TOKEN"));
    const e = await caught(downloadItemBlob(ITEM_ID));
    assert(e instanceof CloudNetworkError, "翻成 CloudNetworkError");
    const ne = e as CloudNetworkError;
    eq(ne.stage, "content", "阶段 = 下载文件内容");
    eq(ne.host, HOST, "host 字段只有主机名");
    assert(ne.message.includes(`host=${HOST}`), `字里带主机名：${ne.message}`);
    assert(ne.message.includes(`file="a.txt"`), `字里带文件名：${ne.message}`);
    const m = /after=(\d+)ms/.exec(ne.message);
    assert(m != null, `字里带用时：${ne.message}`);
    assert(Number(m![1]) >= 30, `用时从发出算到失败（假 fetch 等了 40ms），实得 ${m![1]}ms`);
    assert(ne.message.endsWith("(other)"), `原错的字带着地址 = 和已知原话对不上 → 类别 other，原话一个字不抄：${ne.message}`);
    noSecrets(errTexts(e), "报错（含 cause）");
    eq(JSON.stringify(ne.cause), JSON.stringify({ name: "TypeError", category: "other" }), "cause = 只带 name 和类别的替身");
    eq((e as { status?: number }).status, undefined, "status 照旧 undefined（重试语义不变）");
  } finally { restore(); }
});

test("[下载报错] 浏览器的原话精确对上才归类（Chromium Failed to fetch / WebKit Load failed）；cause 是冻结的替身、不是原错对象", async () => {
  for (const [msg, cat] of [["Failed to fetch", "failed-to-fetch"], ["Load failed", "load-failed"]] as const) {
    const orig = new TypeError(msg);
    const restore = withFetch(graphThen(async () => { throw orig; }));
    try {
      const { downloadItemBlob } = createGraph(() => Promise.resolve("TOKEN"));
      const e = await caught(downloadItemBlob(ITEM_ID)) as CloudNetworkError;
      assert(e.message.endsWith(`(${cat})`), e.message);
      assert(e.cause !== orig, "不挂原错对象");
      eq(JSON.stringify(e.cause), JSON.stringify({ name: "TypeError", category: cat }), "替身只有 name 和类别");
      assert(Object.isFrozen(e.cause), "替身冻结");
    } finally { restore(); }
  }
});

test("[下载报错] 发文件的服务器回了 403（比如公司网关拦了）：字里带主机名、文件名、用时，不带地址", async () => {
  const restore = withFetch(graphThen(async () => new Response("blocked by proxy", { status: 403 })));
  try {
    const { downloadItemBlob } = createGraph(() => Promise.resolve("TOKEN"));
    const e = await caught(downloadItemBlob(ITEM_ID)) as Error;
    assert(e.message.startsWith("downloadUrl failed 403"), `原来那句开头不变：${e.message}`);
    assert(e.message.includes(`host=${HOST}`) && e.message.includes(`file="a.txt"`) && /after=\d+ms/.test(e.message), `带定位：${e.message}`);
    noSecrets(errTexts(e), "报错");
  } finally { restore(); }
});

test("[下载报错] 拿到 200 之后读体中途断了：也是 stage=content 的 CloudNetworkError（以前裸抛 TypeError）", async () => {
  const restore = withFetch(graphThen(async (url) => {
    const r = new Response("partial", { status: 200 });
    Object.defineProperty(r, "blob", { value: () => Promise.reject(new TypeError(`network error while reading ${url}`)) });
    return r;
  }));
  try {
    const { downloadItemBlob } = createGraph(() => Promise.resolve("TOKEN"));
    const e = await caught(downloadItemBlob(ITEM_ID));
    assert(e instanceof CloudNetworkError, "读体失败 = 网络层失败");
    eq((e as CloudNetworkError).stage, "content", "阶段 = 下载文件内容");
    assert((e as Error).message.includes("body failed"), (e as Error).message);
    noSecrets(errTexts(e), "报错（含 cause）");
  } finally { restore(); }
});

test("[下载报错] 按范围下载（重申请一次地址后仍失败）：stage=content、带文件名，不带地址", async () => {
  let contentHits = 0;
  const restore = withFetch(graphThen(async (url) => { contentHits++; throw new TypeError(`Failed to fetch ${url}`); }));
  try {
    const { downloadItemRange } = createGraph(() => Promise.resolve("TOKEN"));
    const e = await caught(downloadItemRange(ITEM_ID, 0, 100));
    eq(contentHits, 2, "第一次失败 → 清缓存重申请地址再试一次（2.0.0 起的行为不变）");
    assert(e instanceof CloudNetworkError, "翻成 CloudNetworkError");
    eq((e as CloudNetworkError).stage, "content", "阶段 = 下载文件内容");
    eq((e as CloudNetworkError).host, HOST, "主机名");
    assert((e as Error).message.includes(`file="a.txt"`), (e as Error).message);
    noSecrets(errTexts(e), "报错（含 cause）");
  } finally { restore(); }
});

test("[下载报错] 问微软接口这一步断了：stage=graph、host=graph.microsoft.com、带用时", async () => {
  const restore = withFetch(async () => { throw new TypeError("Failed to fetch"); });
  try {
    const { getItemByPath } = createGraph(() => Promise.resolve("TOKEN"));
    const e = await caught(getItemByPath("a.txt"));
    assert(e instanceof CloudNetworkError, "翻成 CloudNetworkError");
    eq((e as CloudNetworkError).stage, "graph", "阶段 = Graph 接口");
    eq((e as CloudNetworkError).host, "graph.microsoft.com", "主机名");
    assert(/host=graph\.microsoft\.com after=\d+ms/.test((e as Error).message), (e as Error).message);
  } finally { restore(); }
});

// 统筹审稿补（2026-11-12）：Graph 没给下载地址 → 退到 /content，微软再重定向到发文件的服务器。断在这条路上也是「下载文件内容」，
//   归 stage "content"；真正的主机拿不到，写固定字样 via-graph-redirect，绝不写成 graph.microsoft.com（那会把锅归给接口）。
function noUrlThen(onContent: (url: string, init?: RequestInit) => Promise<Response>) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith(`/me/drive/items/${ITEM_ID}`)) return json({ id: ITEM_ID, name: "a.txt" });   // 没有 downloadUrl
    return onContent(url, init);
  };
}
for (const [label, call] of [
  ["整份下载", (g: ReturnType<typeof createGraph>) => g.downloadItemBlob(ITEM_ID)],
  ["按范围下载", (g: ReturnType<typeof createGraph>) => g.downloadItemRange(ITEM_ID, 0, 100)],
] as const) {
  test(`[下载报错] ${label}没拿到下载地址、走 Graph /content 兜底时断了：stage=content、host=via-graph-redirect，不说成 graph.microsoft.com`, async () => {
    let contentHits = 0;
    const restore = withFetch(noUrlThen(async (url) => { assert(url.endsWith("/content"), `兜底打的是 /content：${url}`); contentHits++; throw new TypeError("Failed to fetch"); }));
    try {
      const e = await caught(call(createGraph(() => Promise.resolve("TOKEN"))));
      eq(contentHits, 1, "兜底那一趟真打出去了");
      assert(e instanceof CloudNetworkError, "翻成 CloudNetworkError");
      eq((e as CloudNetworkError).stage, "content", "阶段 = 下载文件内容（不是接口）");
      eq((e as CloudNetworkError).host, "via-graph-redirect", "主机名写明是经 Graph 转过去的");
      const m = (e as Error).message;
      assert(!m.includes("graph.microsoft.com"), `字里不许把锅归给接口主机：${m}`);
      assert(m.includes("host=via-graph-redirect") && m.includes(`file="a.txt"`) && /after=\d+ms/.test(m), `带定位：${m}`);
      assert(m.endsWith("(failed-to-fetch)"), `原因 = 固定词表的类别（2.3.5 起不抄原话）：${m}`);
    } finally { restore(); }
  });
}
test("[下载报错] /content 兜底回了非 2xx：照旧是带 status 的错（调用方按 status 判），不翻成网络错", async () => {
  const restore = withFetch(noUrlThen(async () => new Response("nope", { status: 404 })));
  try {
    const e = await caught(createGraph(() => Promise.resolve("TOKEN")).downloadItemBlob(ITEM_ID));
    assert(!(e instanceof CloudNetworkError), "不是网络错");
    eq((e as { status?: number }).status, 404, "status 原样");
  } finally { restore(); }
});

// ── 2.3.5：统筹攻击脚本的 14 种写法 × 五条路（整份下载 / 按范围下载 / /content 兜底 / 上传会话 / 复制监控）──
//   断言看 message、String、stack、整条 cause 链、JSON 序列化（含自有属性）——一个签名片段都不许有。
const SECRETS = ["SECRETPATH", "SECRETAUTH", "SECRETSIG"];
function deepText(e: unknown, depth = 0): string {
  if (e == null || depth > 6) return "";
  let out = "";
  try { out += String(e) + "\n"; } catch { /* */ }
  if (typeof e === "object") {
    const o = e as Record<string, unknown>;
    for (const k of ["message", "stack", "name", "host", "stage"]) { try { if (o[k] != null) out += String(o[k]) + "\n"; } catch { /* */ } }
    try { out += JSON.stringify(e, Object.getOwnPropertyNames(e)) + "\n"; } catch { /* */ }
    out += deepText(o.cause, depth + 1);
  }
  return out;
}
const ATTACKS: Array<[string, string, (u: string) => unknown]> = [
  ["地址原样在 TypeError 里", `https://${HOST}/y4mSECRETPATH/a.txt?download=1&tempauth=SECRETAUTH&sig=SECRETSIG`, (u) => new TypeError(`Failed to fetch ${u}`)],
  ["路径里带括号", `https://${HOST}/y4m/a%20(1).txt?download=1&tempauth=SECRETAUTH&sig=SECRETSIG`, (u) => new TypeError(`Failed to fetch ${u}`)],
  ["路径里带撇号", `https://${HOST}/y4m/it's.txt?tempauth=SECRETAUTH&sig=SECRETSIG`, (u) => new TypeError(`Failed to fetch ${u}`)],
  ["地址包在括号里", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => new TypeError(`fetch failed (${u})`)],
  ["地址包在双引号里", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => new TypeError(`fetch "${u}" failed`)],
  ["查询串里带引号", `https://${HOST}/y4m/a.txt?x="1"&tempauth=SECRETAUTH`, (u) => new TypeError(`Failed to fetch ${u}`)],
  ["查询串里带尖括号", `https://${HOST}/y4m/a.txt?x=<1>&tempauth=SECRETAUTH`, (u) => new TypeError(`Failed to fetch ${u}`)],
  ["没有协议头", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => new TypeError(`Failed to fetch ${u.replace("https://", "")}`)],
  ["大写协议头", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => new TypeError(`Failed to fetch ${u.replace("https://", "HTTPS://")}`)],
  ["错误里再套一层", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => new TypeError("fetch failed", { cause: new Error(`connect ECONNREFUSED ${u}`) })],
  ["错误对象上另挂地址字段", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => Object.assign(new TypeError("fetch failed"), { url: u, request: { url: u } })],
  ["抛的不是 Error", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => ({ message: `boom ${u}`, url: u, name: u })],
  ["DOMException", `https://${HOST}/y4mSECRETPATH/a.txt?tempauth=SECRETAUTH`, (u) => new DOMException(`The operation was aborted: ${u}`, "AbortError")],
  ["查询串前有换行", `https://${HOST}/y4m/a.txt?download=1&tempauth=SECRETAUTH`, (u) => new TypeError(`Failed to fetch ${u.replace("?", "\n?")}`)],
];
const BIG = 4 * 1024 * 1024 + 10;   // > 4 MiB → 分块上传（上传会话）
type Path = { label: string; run: (signed: string, mk: (u: string) => unknown) => Promise<unknown> };
const PATHS: Path[] = [
  { label: "整份下载", run: async (signed, mk) => { const r = withFetch(async (url) => (url.startsWith("https://graph.microsoft.com/") ? json({ id: "I", name: "a.txt", "@microsoft.graph.downloadUrl": signed }) : Promise.reject(mk(url)))); try { return await caught(createGraph(() => Promise.resolve("T")).downloadItemBlob("I")); } finally { r(); } } },
  { label: "按范围下载", run: async (signed, mk) => { const r = withFetch(async (url) => (url.startsWith("https://graph.microsoft.com/") ? json({ id: "I", name: "a.txt", "@microsoft.graph.downloadUrl": signed }) : Promise.reject(mk(url)))); try { return await caught(createGraph(() => Promise.resolve("T")).downloadItemRange("I", 0, 10)); } finally { r(); } } },
  { label: "/content 兜底（被跳到签名地址上断）", run: async (signed, mk) => { const r = withFetch(async (url) => (url.endsWith("/content") ? Promise.reject(mk(signed)) : json({ id: "I", name: "a.txt" }))); try { return await caught(createGraph(() => Promise.resolve("T")).downloadItemBlob("I")); } finally { r(); } } },
  { label: "上传会话（分块 PUT 断）", run: async (signed, mk) => { const r = withFetch(async (url, init) => (url.includes("createUploadSession") ? json({ uploadUrl: signed }) : init?.method === "PUT" ? Promise.reject(mk(url)) : json({}))); try { return await caught(createGraph(() => Promise.resolve("T")).uploadFileToApproot("书.zip", new Blob([new Uint8Array(BIG)]), "application/zip", { conflictBehavior: "fail" })); } finally { r(); } } },
  { label: "上传会话（接着传时问进度也断）", run: async (signed, mk) => { const r = withFetch(async (url, init) => (url.includes("createUploadSession") ? json({ uploadUrl: signed }) : url === signed ? Promise.reject(mk(url)) : json({}))); try { return await caught(createGraph(() => Promise.resolve("T"), { chunkResume: true, sleep: async () => {} }).uploadFileToApproot("书.zip", new Blob([new Uint8Array(BIG)]), "application/zip", { conflictBehavior: "fail" })); } finally { r(); } } },
  { label: "复制监控", run: async (signed, mk) => { const r = withFetch(async (url) => (url.includes("/copy?") ? new Response(null, { status: 202, headers: { Location: signed } }) : url === signed ? Promise.reject(mk(url)) : json({}))); try { return await caught(createGraph(() => Promise.resolve("T")).copyItemToFolder("I", "F", "b.txt")); } finally { r(); } } },
];
for (const path of PATHS) {
  test(`[签名地址 · 2.3.5] ${path.label}：14 种写法一个签名片段都不出（message / String / stack / cause 链 / JSON）`, async () => {
    const leaks: string[] = [];
    for (const [label, signed, mk] of ATTACKS) {
      const e = await path.run(signed, mk);
      assert(e instanceof CloudNetworkError, `${label}：是 CloudNetworkError（${String((e as Error)?.name)}）`);
      const text = deepText(e);
      const hit = SECRETS.filter((x) => text.includes(x));
      if (hit.length) leaks.push(`${label}: ${hit.join(",")} ← ${(e as Error).message}`);
      const c = (e as { cause?: unknown }).cause as { name?: string; category?: string } | undefined;
      assert(c && Object.keys(c).sort().join(",") === "category,name", `${label}：cause 只有 name 和 category（${JSON.stringify(c)}）`);
    }
    eq(leaks.length, 0, `漏了：\n${leaks.join("\n")}`);
  }, { timeout: 30_000 });
}
test("[签名地址 · 2.3.5] graphFetch 拿到整条绝对地址（分页 nextLink）断了：字里只留主机名；我们自己拼的相对路径照旧原样", async () => {
  const next = `https://graph.microsoft.com/v1.0/me/drive/items/X/children?$skiptoken=SECRETAUTH&sig=SECRETSIG`;
  let n = 0;
  const r = withFetch(async (url) => { n++; if (n === 1) return json({ value: [], "@odata.nextLink": next }); throw new TypeError(`Failed to fetch ${url}`); });
  try {
    const e = await caught(createGraph(() => Promise.resolve("T")).listChildren("书")) as CloudNetworkError;
    assert(e.message.startsWith("Graph GET graph.microsoft.com: network fetch failed"), e.message);
    assert(!SECRETS.some((x) => deepText(e).includes(x)), deepText(e));
  } finally { r(); }
  const r2 = withFetch(async () => { throw new TypeError("Failed to fetch"); });
  try {
    const e = await caught(createGraph(() => Promise.resolve("T")).getItemByPath("a.txt")) as CloudNetworkError;
    assert(e.message.startsWith("Graph GET /me/drive/special/approot:/a.txt?$select="), `相对路径原样：${e.message}`);
  } finally { r2(); }
});

// 结构守卫（2.3.5）：以后在 graph.ts 里加新的网络报错，原错的字也进不来。
test("[下载报错·守卫] graph.ts 构造网络报错的地方没有 String(e) / e.message / e.stack，cause 只许是替身；模板里不插地址变量", () => {
  const src = readFileSync(new URL("../src/base/providers/graph.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));
  const bad: string[] = [];
  code.forEach((l, i) => {
    if (/new CloudNetworkError\(/.test(l)) {
      if (/String\(e\b|\be\.message|\be\.stack|String\(err\b/.test(l)) bad.push(`${i + 1}: 原错的字进了报错：${l.trim()}`);
      if (/`\s*,\s*(e|err|e\.cause)\s*[,)]/.test(l)) bad.push(`${i + 1}: cause 直接挂了原错（要 netCause）：${l.trim()}`);
    }
    if (/new (CloudNetworkError|Error)\(/.test(l) && /\$\{(dl|downloadUrl|url|sessionUrl|uploadUrl|monitor|rec\.uploadUrl|info\.url|pathOrUrl)\}/.test(l)) bad.push(`${i + 1}: 报错的模板里插了地址变量：${l.trim()}`);
    if (/\b(scrubUrls|safeCause)\(/.test(l)) bad.push(`${i + 1}: 2.3.3 的洗字法回来了：${l.trim()}`);
  });
  eq(bad.length, 0, `graph.ts 的网络报错不许带原错的字：\n${bad.join("\n")}`);
});
