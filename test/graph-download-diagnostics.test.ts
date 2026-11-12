// 下载失败的报错要分得清是谁的问题，而且绝不带出签名地址（2.3.3，2026-11-12）。
// created 2026-11-12 by Claude Opus 5.5（小黑屋维修线施工单第 1 条；规矩 = 统筹 Claude Fable 5.2）
//   起因：小黑屋 11-12 办公室那台机器连着十几次 `downloadUrl: network fetch failed (TypeError: Failed to fetch)`，
//   黑匣子里分不清是网络拦了那台发文件的服务器（通常几十毫秒就失败），还是那边没回音（通常十几秒）。
//   现在报错带：阶段（stage）、主机名、文件名、用时。
//   硬规矩：下载地址是带签名的临时地址，拿到就能下载——整条地址、路径、查询串都不许进报错（也就不进黑匣子）。
//   这里拿一条带假签名的地址去撞；而且让 fetch 自己的报错也带上整条地址（别的运行时可能这样），库必须洗掉。
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
    assert(ne.message.includes("Failed to fetch"), "原来的报错原因还在（只洗掉地址）");
    noSecrets(errTexts(e), "报错（含 cause）");
    eq((ne.cause as Error).name, "TypeError", "cause 的类型还在（字被洗过）");
    eq((e as { status?: number }).status, undefined, "status 照旧 undefined（重试语义不变）");
  } finally { restore(); }
});

test("[下载报错] 浏览器报错本来就不带地址时，cause 原样保留（同一个对象）", async () => {
  const orig = new TypeError("Failed to fetch");
  const restore = withFetch(graphThen(async () => { throw orig; }));
  try {
    const { downloadItemBlob } = createGraph(() => Promise.resolve("TOKEN"));
    const e = await caught(downloadItemBlob(ITEM_ID)) as CloudNetworkError;
    assert(e.cause === orig, "没有地址可洗 → cause 就是原错（栈都在）");
    noSecrets(errTexts(e), "报错");
  } finally { restore(); }
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

// 结构守卫：以后在 graph.ts 里加新的网络报错，也走同一套洗法。
test("[下载报错·守卫] graph.ts 里 String(e) 一律过 scrubUrls、CloudNetworkError 的 cause 一律过 safeCause、模板里不插地址变量", () => {
  const src = readFileSync(new URL("../src/base/providers/graph.ts", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !l.trim().startsWith("//"));
  const bad: string[] = [];
  code.forEach((l, i) => {
    if ((l.match(/String\(e\)/g) ?? []).length !== (l.match(/scrubUrls\(String\(e\)\)/g) ?? []).length) bad.push(`${i + 1}: String(e) 没过 scrubUrls：${l.trim()}`);
    if (/new CloudNetworkError\(/.test(l) && /`\s*,\s*e\s*[,)]/.test(l)) bad.push(`${i + 1}: cause 直接传了 e（要 safeCause(e)）：${l.trim()}`);
    if (/\$\{(dl|downloadUrl|url|sessionUrl|uploadUrl|monitor|rec\.uploadUrl|info\.url)\}/.test(l)) bad.push(`${i + 1}: 模板里插了地址变量：${l.trim()}`);
  });
  eq(bad.length, 0, `graph.ts 的网络报错要洗地址：\n${bad.join("\n")}`);
});
