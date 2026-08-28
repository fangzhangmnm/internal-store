// download-session（A1，2026-08-15 user 批）—— 分片下载会话 / staging tee / 调度纪律。
// 验：
//   · read 跨分片组装逐位正确；tee：读过的分片落 staging，重开会话（同 eTag）不重下。
//   · 先播后 pin 只补缺口：promote 的 range 调用只打缺失分片；落地字节逐位 == 云端；staging 清账。
//   · **pin 严格串行**（user 钉死「不要 spike 炸」）：并发 promote 同刻 range in-flight ≤ 1。
//   · 播放让路：playback 分片在飞时 pin 不开新分片；playback 完成后 pin 继续。
//   · eTag 钉版：旧版残片开会话即清；promote 中途换版 → EtagChangedError + 清 staging。
//   · cap FIFO：超限清最旧 touched 整组；在用会话不清。
//   · promote 不覆盖已有本地副本（§A：连 clean 副本都不碰，dirty 更不必说）。
//   · store 级：keepOffline 进度回调 + openStream 本地面/云端面/absent。
import { describe, it, assert, eq } from "./runner.mjs";
import { createDownloadSessions, EtagChangedError } from "../src/download-session.ts";
import { memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createStore } from "../src/create-store.ts";

const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const tick = () => new Promise((r) => setTimeout(r, 5));
const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {}, onReplayStatus: () => {} };

function memStaging() {
  const m = new Map();
  return {
    _map: m,
    async get(k) { return m.get(k) ?? null; },
    async put(k, b) { m.set(k, b); },
    async del(k) { m.delete(k); },
    async keys() { return [...m.keys()]; },
  };
}

// 单测夹具：一个「云端文件表」+ 可控 range。
function mkSessions({ files, chunkSize = 4, capBytes, gate = null, localHas = () => false } = {}) {
  const calls = [];                      // { name, off, len } 顺序账
  let inflightNow = 0, inflightMax = 0;
  const adopted = new Map();             // name → Blob（promote 落地）
  const staging = memStaging();
  const sessions = createDownloadSessions({
    staging,
    fetchMeta: async (name) => { const f = files.get(name); return f ? { etag: f.etag, size: f.data.length, item: { name } } : null; },
    range: async (item, off, len) => {
      const f = files.get(item.name);
      calls.push({ name: item.name, off, len });
      inflightNow++; inflightMax = Math.max(inflightMax, inflightNow);
      try { if (gate) await gate(item.name, off); return f.data.slice(off, off + len); }
      finally { inflightNow--; }
    },
    adoptLocal: async (name, blob, etag) => { if (localHas(name)) return false; adopted.set(name, { blob, etag }); return true; },
    chunkSize, capBytes, now: (() => { let t = 0; return () => ++t; })(),
  });
  return { sessions, staging, calls, adopted, stats: () => ({ inflightMax }) };
}
const asU8 = async (blob) => new Uint8Array(await blob.arrayBuffer());

describe("download-session · read/tee/续用", () => {
  it("read 跨分片组装逐位正确 + tee 落 staging；重开会话同区不重下", async () => {
    const data = bytes(10);
    const { sessions, staging, calls } = mkSessions({ files: new Map([["f", { etag: "e1", data }]]) });
    const s = await sessions.open("f");
    eq(s.totalSize, 10);
    const got = await s.read(3, 5);                     // 跨分片 0(0-3)/1(4-7)/2(8-9) 的中段
    eq([...got].join(","), [...data.slice(3, 8)].join(","), "字节逐位对");
    eq(calls.length, 2, "打了分片 0 和 1");
    s.close();
    const s2 = await sessions.open("f");                // 同 eTag 重开 → staging 续用
    const got2 = await s2.read(0, 8);
    eq([...got2].join(","), [...data.slice(0, 8)].join(","));
    eq(calls.length, 2, "★重开会话同区零重下（staging 命中）");
    assert(staging._map.has("chunk:f:0") && staging._map.has("chunk:f:1"), "分片躺在 staging");
    s2.close();
  });

  it("先播后 pin 只补缺口：promote 只打缺失分片；落地逐位对；staging 清账", async () => {
    const data = bytes(10);
    const { sessions, staging, calls, adopted } = mkSessions({ files: new Map([["f", { etag: "e1", data }]]) });
    const s = await sessions.open("f");
    await s.read(0, 8);                                  // 播放流过分片 0/1
    const before = calls.length;
    const prog = [];
    await s.promote({ onProgress: (d, t) => prog.push([d, t]) });
    eq(calls.length - before, 1, "★只补缺口（分片 2），已流分片不重下");
    const landed = await asU8(adopted.get("f").blob);
    eq([...landed].join(","), [...data].join(","), "落地字节逐位 == 云端");
    eq(adopted.get("f").etag, "e1", "采纳会话钉住的 etag");
    eq([...staging._map.keys()].filter((k) => k.includes("f")).length, 0, "★promote 后 staging 清账");
    assert(prog.length > 0 && prog.at(-1)[0] === 10 && prog.at(-1)[1] === 10, "进度到 total");
    s.close();
  });
});

describe("download-session · 调度纪律", () => {
  it("pin 严格串行：两文件并发 promote → 同刻 range in-flight ≤ 1", async () => {
    const files = new Map([["a", { etag: "e", data: bytes(12) }], ["b", { etag: "e", data: bytes(12) }]]);
    const { sessions, stats } = mkSessions({ files, gate: () => tick() });
    const [sa, sb] = [await sessions.open("a"), await sessions.open("b")];
    await Promise.all([sa.promote(), sb.promote()]);
    eq(stats().inflightMax, 1, "★pin 串行不 spike（同刻最多 1 分片在飞）");
    sa.close(); sb.close();
  });

  it("播放让路：playback 分片在飞时 pin 不开新分片，playback 完成后继续", async () => {
    const files = new Map([["a", { etag: "e", data: bytes(12) }]]);
    let releasePlayback;
    const gates = { "a:8": new Promise((r) => { releasePlayback = r; }) };   // 播放拉分片 2（off=8）时吊住
    const { sessions, calls } = mkSessions({ files, gate: (n, off) => gates[`${n}:${off}`] ?? null });
    const s = await sessions.open("a");
    const reading = s.read(8, 4);                        // playback：分片 2 在飞（吊住）
    await tick();
    const pinning = s.prefetch(0, 4);                    // pin：分片 0
    await tick(); await tick();
    eq(calls.filter((c) => c.off === 0).length, 0, "★playback 在飞时 pin 不开工");
    releasePlayback();
    await reading; await pinning;
    eq(calls.filter((c) => c.off === 0).length, 1, "playback 完成后 pin 继续");
    s.close();
  });
});

describe("download-session · eTag 钉版 + cap + 不覆盖", () => {
  it("staging 里旧版残片 → 开新会话自动清；promote 中途换版 → EtagChangedError + 清 staging", async () => {
    const files = new Map([["f", { etag: "e1", data: bytes(8) }]]);
    const { sessions, staging } = mkSessions({ files });
    const s1 = await sessions.open("f");
    await s1.read(0, 4); s1.close();
    files.set("f", { etag: "e2", data: bytes(8) });      // 云端换版
    const s2 = await sessions.open("f");                 // 开新会话 → e1 残片应被清
    eq(JSON.parse(await (staging._map.get("meta:f")).text()).eTag, "e2", "★meta 已是新版（旧残片清掉重记）");
    // promote 中途云端再换版
    await s2.read(0, 8);
    files.set("f", { etag: "e3", data: bytes(8) });
    let err = null;
    try { await s2.promote(); } catch (e) { err = e; }
    assert(err instanceof EtagChangedError, "★promote 前重验 etag，版变即抛");
    eq([...staging._map.keys()].filter((k) => k.includes("f")).length, 0, "失效 staging 已清");
    s2.close();
  });

  it("cap FIFO：超限清最旧整组；在用会话不清", async () => {
    const files = new Map([["old", { etag: "e", data: bytes(8) }], ["new", { etag: "e", data: bytes(8) }]]);
    const { sessions, staging } = mkSessions({ files, capBytes: 10 });   // chunk=4：两组全量 16 > 10
    const so = await sessions.open("old");
    await so.read(0, 8); so.close();                     // old 组 8 字节，已关
    const sn = await sessions.open("new");
    await sn.read(0, 8);                                 // new 组 8 字节（在用）→ 总 16 > 10 → 清 old
    await tick();
    assert(!staging._map.has("meta:old") && !staging._map.has("chunk:old:0"), "★最旧整组被清");
    assert(staging._map.has("chunk:new:0"), "在用会话的组保留");
    sn.close();
  });

  it("promote 不覆盖已有本地副本（adoptLocal 返 false 也收摊清 staging，不炸）", async () => {
    const files = new Map([["f", { etag: "e1", data: bytes(8) }]]);
    const { sessions, staging, adopted } = mkSessions({ files, localHas: () => true });
    const s = await sessions.open("f");
    await s.promote();
    assert(!adopted.has("f"), "★没有覆盖动作");
    eq([...staging._map.keys()].filter((k) => k.includes("f")).length, 0, "staging 照样清账");
    s.close();
  });
});

describe("download-session · coverage 透明面（A5）", () => {
  it("无残片 → null；读过中段 → partial（bytes 对、headBytes=0）；读头部 → headBytes 连续段；全读 → complete", async () => {
    const data = bytes(10);   // chunkSize=4 → 分片 [0..3][4..7][8..9]
    const { sessions } = mkSessions({ files: new Map([["f", { etag: "e1", data }]]) });
    eq(await sessions.coverage("f"), null, "无残片 → null");
    const s = await sessions.open("f");
    await s.read(4, 4);                                   // 只拿分片 1
    let c = await sessions.coverage("f");
    eq(c.totalBytes, 10); eq(c.bytes, 4); eq(c.headBytes, 0); eq(c.complete, false);
    await s.read(0, 1);                                   // 补分片 0 → 头部连续 8B
    c = await sessions.coverage("f");
    eq(c.bytes, 8); eq(c.headBytes, 8); eq(c.complete, false); eq(c.eTag, "e1");
    await s.read(8, 2);                                   // 补尾片 → 全量
    c = await sessions.coverage("f");
    eq(c.bytes, 10); eq(c.headBytes, 10); eq(c.complete, true);
    s.close();
  });

  it("promote 清账后 → null（已升格正式副本，staging 归零）", async () => {
    const data = bytes(10);
    const { sessions } = mkSessions({ files: new Map([["f", { etag: "e1", data }]]) });
    const s = await sessions.open("f");
    await s.promote();
    s.close();
    eq(await sessions.coverage("f"), null, "promote 后账本清空");
  });
});

describe("download-session · store 级（keepOffline / openStream）", () => {
  function mkStore() {
    const provider = createMockProvider();
    const local = createMockLocal();
    const staging = memStaging();
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test", provider, local, kv: memKv(), staging, stagingChunkBytes: 4, ui: UI,
      validateAdopt: () => true, isOnline: () => true, signedIn: () => true, skipMigration: true,
    });
    return { store, provider, local, staging };
  }

  it("keepOffline：分片会话下载 + 进度回调到 total；本地字节逐位对", async () => {
    const { store, provider, local } = mkStore();
    const data = bytes(10);
    provider._seed("t.mp3", data);
    const prog = [];
    await store.file("t.mp3", { isZip: false, mode: "existing" }).keepOffline({ onProgress: (d, t) => prog.push([d, t]) });
    assert(local._items.has("t.mp3"), "本地已留离线");
    eq([...local._items.get("t.mp3")].join(","), [...data].join(","), "字节逐位对");
    assert(prog.length > 0 && prog.at(-1)[0] === 10, "进度收在 total");
    assert(await store.file("t.mp3", { isZip: false, mode: "existing" }).isKeptOffline(), "isKeptOffline true");
  });

  it("openStream 云端面：read 中段逐位对；keep() 后本地落全量；absent → null", async () => {
    const { store, provider, local } = mkStore();
    const data = bytes(10);
    provider._seed("s.mp3", data);
    const h = await store.file("s.mp3", { isZip: false, mode: "existing" }).openStream();
    assert(h, "云端面句柄");
    eq(h.totalSize, 10);
    const mid = await h.read(3, 5);
    eq([...mid].join(","), [...data.slice(3, 8)].join(","), "中段逐位对");
    await h.keep();
    h.close();
    eq([...local._items.get("s.mp3")].join(","), [...data].join(","), "keep 落全量");
    eq(await store.file("没有这个", { isZip: false, mode: "existing" }).openStream(), null, "absent → null（诚实）");
  });

  it("file.stagingCoverage：流播中段 → partial；keepOffline 升格后 → null 且 isKeptOffline", async () => {
    const { store, provider } = mkStore();
    const data = bytes(10);
    provider._seed("c.mp3", data);
    const f = store.file("c.mp3", { isZip: false, mode: "existing" });
    eq(await f.stagingCoverage(), null, "没流过 → null");
    const h = await f.openStream();
    await h.read(0, 5);                                   // 分片 0+1
    h.close();
    const c = await f.stagingCoverage();
    eq(c.totalBytes, 10); eq(c.headBytes, 8); eq(c.complete, false);
    await f.keepOffline();
    eq(await f.stagingCoverage(), null, "升格后 staging 清账（徽章走 isKeptOffline）");
    assert(await f.isKeptOffline(), "已钉");
  });

  it("A6 离线升格：缓存完整 → keepOffline 零网络落地（谱系=账上 eTag）；不完整 → 人话报错不落地", async () => {
    const provider = createMockProvider();
    const local = createMockLocal();
    const staging = memStaging();
    let online = true;
    const errors = [];
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test", provider, local, kv: memKv(), staging, stagingChunkBytes: 4,
      ui: { ...UI, reportError: (e) => errors.push(String(e?.message ?? e)) },
      validateAdopt: () => true, isOnline: () => online, signedIn: () => true, skipMigration: true,
    });
    const data = bytes(10);
    provider._seed("off.mp3", data);
    // 全量流播（staging 完整）→ 断网
    const h = await store.file("off.mp3", { isZip: false, mode: "existing" }).openStream();
    await h.read(0, 10); h.close();
    online = false;
    provider.list = () => { throw new Error("离线"); };
    const origRange = provider.downloadRange.bind(provider);
    let ranges = 0;
    provider.downloadRange = (...a) => { ranges++; return origRange(...a); };
    await store.file("off.mp3", { isZip: false, mode: "existing" }).keepOffline();
    assert(local._items.has("off.mp3"), "★离线升格落地");
    eq([...local._items.get("off.mp3")].join(","), [...data].join(","), "字节逐位对");
    eq(ranges, 0, "★零网络");
    eq(await store.file("off.mp3", { isZip: false, mode: "existing" }).stagingCoverage(), null, "升格后清账");
    // 不完整案：只流了中段 → 离线 keepOffline 报人话、不落地、残片不清
    online = true;
    provider._seed("part.mp3", data);
    const h2 = await store.file("part.mp3", { isZip: false, mode: "existing" }).openStream();
    await h2.read(4, 4); h2.close();
    online = false;
    await store.file("part.mp3", { isZip: false, mode: "existing" }).keepOffline();
    assert(!local._items.has("part.mp3"), "不完整不落地");
    assert(errors.some((m) => m.includes("不完整")), `报人话（实=${errors.join("|")}）`);
    assert(await store.file("part.mp3", { isZip: false, mode: "existing" }).stagingCoverage(), "残片不清（仍可复用）");
  });

  it("openStream 本地面：本地有副本 → 切片直读（不打云）", async () => {
    const { store, provider, local } = mkStore();
    const data = bytes(10);
    provider._seed("l.mp3", data);
    await store.file("l.mp3", { isZip: false, mode: "existing" }).keepOffline();
    let ranges = 0;
    const orig = provider.downloadRange.bind(provider);
    provider.downloadRange = (...a) => { ranges++; return orig(...a); };
    const h = await store.file("l.mp3", { isZip: false, mode: "existing" }).openStream();
    const mid = await h.read(2, 6);
    eq([...mid].join(","), [...data.slice(2, 8)].join(","), "本地切片逐位对");
    eq(ranges, 0, "★零云端往返");
    h.close();
  });
});
