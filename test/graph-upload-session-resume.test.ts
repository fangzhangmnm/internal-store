// F-54（2026-10-21 Claude Fable 5.1）：上传会话落盘——记忆面 session 递进来时，分块上传开会话先 save；下次推同一份字节（token 相等）
//   先 GET 会话问 nextExpectedRanges、从那里接着传、不再 createUploadSession；传完 / 412 / 4xx → clear；token 不同 / 会话没了 → 重开。
import { test, assert, eq } from "./runner.mjs";
import { createGraph } from "../src/base/providers/graph.ts";

const MiB = 1024 * 1024;
const bytes = (n: number) => new Blob([new Uint8Array(n)]);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const SESS = "https://up.example/session/1";
const ITEM = "/me/drive/special/approot:/x.crumb";
const TOTAL = 12 * MiB;   // 3 块（5 + 5 + 2）

type Rec = { uploadUrl: string; total: number; eTag: string | null; token: string; createdAt: number; expiresAt: number | null };
function memo(token: string, initial: Rec | null = null) {
  let rec: Rec | null = initial;
  const log: string[] = [];
  return { port: { token, load: async () => { log.push("load"); return rec; }, save: async (r: Rec) => { log.push("save"); rec = r; }, clear: async () => { log.push("clear"); rec = null; } }, log, get: () => rec };
}

/** 假 Graph：第一轮 PUT 第二块时网络断（且 chunkResume 关 → 整份失败）；会话问进度回 5 MiB；第二轮从 5 MiB 续。 */
function harness(opts: { breakAt?: number; sessionGone?: boolean; itemEtag?: string } = {}) {
  const calls: string[] = [];
  let broke = false;
  const fetchFake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input).replace(/^https:\/\/graph\.microsoft\.com\/v1\.0/, ""), method = init?.method ?? "GET";
    calls.push(`${method} ${url}`);
    if (method === "POST" && url.includes("createUploadSession")) return json({ uploadUrl: SESS, expirationDateTime: new Date(Date.now() + 86400e3).toISOString() });
    if (method === "GET" && url.startsWith(ITEM)) return json({ id: "i1", name: "x.crumb", size: TOTAL, eTag: opts.itemEtag ?? "base" });
    if (method === "GET" && url === SESS) return opts.sessionGone ? new Response("", { status: 404 }) : json({ nextExpectedRanges: [`${5 * MiB}-`] });
    if (method === "DELETE" && url === SESS) return new Response("", { status: 204 });
    if (method === "PUT" && url === SESS) {
      const range = (init!.headers as Record<string, string>)["Content-Range"];
      if (opts.breakAt != null && range.startsWith(`bytes ${opts.breakAt}-`) && !broke) { broke = true; throw new TypeError("Load failed"); }
      const last = range.includes(`-${TOTAL - 1}/`);
      return last ? json({ id: "i1", name: "x.crumb", size: TOTAL, eTag: "new" }, 201) : json({ nextExpectedRanges: [] }, 202);
    }
    throw new Error("unexpected " + method + " " + url);
  };
  return { calls, fetchFake };
}
const withFetch = async (f: typeof fetch, fn: () => Promise<void>) => { const orig = globalThis.fetch; (globalThis as { fetch: unknown }).fetch = f; try { await fn(); } finally { (globalThis as { fetch: unknown }).fetch = orig; } };

test("F-54：第一轮断在第二块 → 记忆留着；第二轮同一份字节 → 问会话、从 5 MiB 接着传、不重开会话；传完记忆清掉", async () => {
  const { calls, fetchFake } = harness({ breakAt: 5 * MiB });
  const m = memo("sha-A");
  await withFetch(fetchFake, async () => {
    const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {} });   // chunkResume 关：单块失败 = 整份失败（模拟「页面死了」最严的情况）
    let err: unknown = null;
    try { await g.uploadFileToApproot("x.crumb", bytes(TOTAL), "application/octet-stream", { conflictBehavior: "replace", eTag: "base", session: m.port }); } catch (e) { err = e; }
    assert(err, "第一轮失败");
    assert(m.get() && m.get()!.uploadUrl === SESS && m.get()!.token === "sha-A", "★记忆留着（没 clear）");
    eq(calls.filter((c) => c.startsWith("POST")).length, 1, "开了一次会话");
    calls.length = 0;
    const item = await g.uploadFileToApproot("x.crumb", bytes(TOTAL), "application/octet-stream", { conflictBehavior: "replace", eTag: "base", session: m.port });
    eq(item?.eTag, "new", "第二轮传完");
    eq(calls.filter((c) => c.startsWith("POST")).length, 0, "★没有重开会话");
    eq(calls.filter((c) => c === `GET ${SESS}`).length, 1, "问了一次会话进度");
    const puts = calls.filter((c) => c.startsWith("PUT"));
    eq(puts.length, 2, "★只传了剩下两块（5–10、10–12），不从零");
    assert(calls.some((c) => c.startsWith(`GET ${ITEM}`)), "续上的会话提交前核了 eTag（不看开关）");
    eq(m.get(), null, "★传完记忆清掉");
  });
});

test("F-54：token 不同（字节变了）→ 不续、重开会话；会话没了（404）→ 清记忆、重开", async () => {
  {
    const { calls, fetchFake } = harness();
    const m = memo("sha-B", { uploadUrl: SESS, total: TOTAL, eTag: "base", token: "sha-A", createdAt: 0, expiresAt: null });
    await withFetch(fetchFake, async () => {
      const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {} });
      await g.uploadFileToApproot("x.crumb", bytes(TOTAL), "application/octet-stream", { conflictBehavior: "replace", eTag: "base", session: m.port });
      eq(calls.filter((c) => c.startsWith("POST")).length, 1, "★字节变了 → 重开会话");
      eq(calls.filter((c) => c === `GET ${SESS}`).length, 0, "没问旧会话");
      eq(calls.filter((c) => c.startsWith("PUT")).length, 3, "三块全传");
    });
  }
  {
    const { calls, fetchFake } = harness({ sessionGone: true });
    const m = memo("sha-A", { uploadUrl: SESS, total: TOTAL, eTag: "base", token: "sha-A", createdAt: 0, expiresAt: null });
    await withFetch(fetchFake, async () => {
      const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {} });
      await g.uploadFileToApproot("x.crumb", bytes(TOTAL), "application/octet-stream", { conflictBehavior: "replace", eTag: "base", session: m.port });
      eq(calls.filter((c) => c === `GET ${SESS}`).length, 1, "问了旧会话 → 404");
      eq(calls.filter((c) => c.startsWith("POST")).length, 1, "★重开会话");
      assert(m.log.includes("clear"), "旧记忆清了");
      eq(calls.filter((c) => c.startsWith("PUT")).length, 3);
    });
  }
});

test("F-54：续上的会话提交前发现云端 eTag 变了 → 撤会话、清记忆、抛 412（不盲落地）", async () => {
  const { calls, fetchFake } = harness({ itemEtag: "someone-else" });
  const m = memo("sha-A", { uploadUrl: SESS, total: TOTAL, eTag: "base", token: "sha-A", createdAt: 0, expiresAt: null });
  await withFetch(fetchFake, async () => {
    const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {} });   // verifyChunkedCommit 没开——续上的会话照样核
    let err: { status?: number } | null = null;
    try { await g.uploadFileToApproot("x.crumb", bytes(TOTAL), "application/octet-stream", { conflictBehavior: "replace", eTag: "base", session: m.port }); } catch (e) { err = e as { status?: number }; }
    eq(err?.status, 412);
    assert(calls.includes(`DELETE ${SESS}`), "会话撤掉");
    eq(m.get(), null, "★记忆清掉");
  });
});

test("F-54：没递 session = 2.1.3 行为（开会话、不 save、不问进度）", async () => {
  const { calls, fetchFake } = harness();
  await withFetch(fetchFake, async () => {
    const g = createGraph(() => Promise.resolve("T"), { sleep: async () => {} });
    const item = await g.uploadFileToApproot("x.crumb", bytes(TOTAL), "application/octet-stream", { conflictBehavior: "replace", eTag: "base" });
    eq(item?.eTag, "new");
    eq(calls.filter((c) => c === `GET ${SESS}`).length, 0);
    eq(calls.filter((c) => c.startsWith("POST")).length, 1);
  });
});
