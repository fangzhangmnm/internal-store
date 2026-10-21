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
import { TEST_KINDS } from "./kinds.mjs";
import { createDownloadSessions, EtagChangedError } from "../src/stream/download-session.ts";
import { memKv } from "../src/works/cloud-sync.ts";
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
    const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
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
    await store.file("t.mp3", { mode: "existing" }).keepOffline({ onProgress: (d, t) => prog.push([d, t]) });
    assert(local._items.has("t.mp3"), "本地已留离线");
    eq([...local._items.get("t.mp3")].join(","), [...data].join(","), "字节逐位对");
    assert(prog.length > 0 && prog.at(-1)[0] === 10, "进度收在 total");
    assert(await store.file("t.mp3", { mode: "existing" }).isKeptOffline(), "isKeptOffline true");
  });

  it("openStream 云端面：read 中段逐位对；keep() 后本地落全量；absent → null", async () => {
    const { store, provider, local } = mkStore();
    const data = bytes(10);
    provider._seed("s.mp3", data);
    const h = await store.file("s.mp3", { mode: "existing" }).openStream();
    assert(h, "云端面句柄");
    eq(h.totalSize, 10);
    const mid = await h.read(3, 5);
    eq([...mid].join(","), [...data.slice(3, 8)].join(","), "中段逐位对");
    await h.keep();
    h.close();
    eq([...local._items.get("s.mp3")].join(","), [...data].join(","), "keep 落全量");
    eq(await store.file("没有这个", { mode: "existing" }).openStream(), null, "absent → null（诚实）");
  });

  it("file.stagingCoverage：流播中段 → partial；keepOffline 升格后 → null 且 isKeptOffline", async () => {
    const { store, provider } = mkStore();
    const data = bytes(10);
    provider._seed("c.mp3", data);
    const f = store.file("c.mp3", { mode: "existing" });
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
    const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test", provider, local, kv: memKv(), staging, stagingChunkBytes: 4,
      ui: { ...UI, reportError: (e) => errors.push(String(e?.message ?? e)) },
      validateAdopt: () => true, isOnline: () => online, signedIn: () => true, skipMigration: true,
    });
    const data = bytes(10);
    provider._seed("off.mp3", data);
    // 全量流播（staging 完整）→ 断网
    const h = await store.file("off.mp3", { mode: "existing" }).openStream();
    await h.read(0, 10); h.close();
    online = false;
    provider.list = () => { throw new Error("离线"); };
    const origRange = provider.downloadRange.bind(provider);
    let ranges = 0;
    provider.downloadRange = (...a) => { ranges++; return origRange(...a); };
    await store.file("off.mp3", { mode: "existing" }).keepOffline();
    assert(local._items.has("off.mp3"), "★离线升格落地");
    eq([...local._items.get("off.mp3")].join(","), [...data].join(","), "字节逐位对");
    eq(ranges, 0, "★零网络");
    eq(await store.file("off.mp3", { mode: "existing" }).stagingCoverage(), null, "升格后清账");
    // 不完整案：只流了中段 → 离线 keepOffline 报人话、不落地、残片不清
    online = true;
    provider._seed("part.mp3", data);
    const h2 = await store.file("part.mp3", { mode: "existing" }).openStream();
    await h2.read(4, 4); h2.close();
    online = false;
    await store.file("part.mp3", { mode: "existing" }).keepOffline();
    assert(!local._items.has("part.mp3"), "不完整不落地");
    assert(errors.some((m) => m.includes("不完整")), `报人话（实=${errors.join("|")}）`);
    assert(await store.file("part.mp3", { mode: "existing" }).stagingCoverage(), "残片不清（仍可复用）");
  });

  it("openStream 本地面：本地有副本 → 切片直读（不打云）", async () => {
    const { store, provider, local } = mkStore();
    const data = bytes(10);
    provider._seed("l.mp3", data);
    await store.file("l.mp3", { mode: "existing" }).keepOffline();
    let ranges = 0;
    const orig = provider.downloadRange.bind(provider);
    provider.downloadRange = (...a) => { ranges++; return orig(...a); };
    const h = await store.file("l.mp3", { mode: "existing" }).openStream();
    const mid = await h.read(2, 6);
    eq([...mid].join(","), [...data.slice(2, 8)].join(","), "本地切片逐位对");
    eq(ranges, 0, "★零云端往返");
    h.close();
  });
});

// ── 2.0.0（2026-10-17 Claude Fable 5.1）：streaming 显式开关 ───────────────────────────────────────
//   不传 = 0.18 行为（prefetch 失败只 log、pin 严格串行、不判卡住、无镜像）；传了：reject / 多车道 / 卡住判定 / 镜像。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 2.0.0 夹具：range 带 opts（signal / onProgress）；可挂镜像；fetchMeta 可控。 */
function mkSessions2({ files, chunkSize = 4, streaming, gate = null, mirrors = [], cloudDown = () => false } = {}) {
  const calls = [];
  let inflightNow = 0, inflightMax = 0;
  const staging = memStaging();
  const sessions = createDownloadSessions({
    staging,
    fetchMeta: async (name) => { if (cloudDown()) throw new Error("cloud unreachable"); const f = files.get(name); return f ? { etag: f.etag, size: f.data.length, item: { name } } : null; },
    range: async (item, off, len, opts = {}) => {
      const f = files.get(item.name);
      calls.push({ name: item.name, off, len, opts });
      inflightNow++; inflightMax = Math.max(inflightMax, inflightNow);
      try { if (gate) await gate(item.name, off, opts); return f.data.slice(off, off + len); }
      finally { inflightNow--; }
    },
    adoptLocal: async () => true,
    chunkSize, streaming: streaming === undefined ? undefined : { ...streaming, mirrors: () => mirrors },
  });
  return { sessions, staging, calls, stats: () => ({ inflightMax }) };
}
/** 内存镜像：按名字给一份数据；reads 记每次读；fail 让 read 抛。 */
function memMirror(label, table, { fail = () => false } = {}) {
  const reads = [];
  return {
    reads,
    src: {
      label,
      async open(name, size) { const d = table.get(name); return d && d.length === size ? { async read(off, len) { reads.push(off); if (fail(off)) throw new Error(`${label} broke`); return d.slice(off, off + len); } } : null; },
    },
  };
}

describe("download-session · 2.0.0 streaming 开关", () => {
  it("不传 streaming = 0.18：prefetch 失败只 log 不 reject；传了 → 如实 reject", async () => {
    const files = new Map([["f", { etag: "e", data: bytes(8) }]]);
    const boom = (n, off) => { if (off === 4) throw new Error("range 503"); };
    const legacy = mkSessions2({ files, gate: boom });
    const s1 = await legacy.sessions.open("f");
    await s1.prefetch(4, 4);                                  // 不抛
    s1.close();
    const modern = mkSessions2({ files, gate: boom, streaming: {} });
    const s2 = await modern.sessions.open("f");
    let err = null;
    try { await s2.prefetch(4, 4); } catch (e) { err = e; }
    eq(err?.message, "range 503", "★streaming 模式 prefetch 如实 reject（预取方靠它学）");
    s2.close();
  });

  it("lanes=3：promote 补缺口同刻 ≤ 3 路；lanes 不传仍 1", async () => {
    const files = new Map([["a", { etag: "e", data: bytes(24) }]]);
    const three = mkSessions2({ files, gate: () => sleep(8), streaming: { lanes: 3 } });
    const sa = await three.sessions.open("a");
    await sa.promote();
    eq(three.stats().inflightMax, 3, "★3 路并行补缺口");
    sa.close();
    const one = mkSessions2({ files, gate: () => sleep(8), streaming: {} });
    const sb = await one.sessions.open("a");
    await sb.promote();
    eq(one.stats().inflightMax, 1, "streaming 但没给 lanes → 仍 1");
    sb.close();
  });

  it("status()：挂住的播放读 → demand 1、oldestMs 在涨、过 stallMs 判卡住；对冲后读完成", async () => {
    const files = new Map([["f", { etag: "e", data: bytes(8) }]]);
    let n = 0;
    const { sessions, calls } = mkSessions2({ files, streaming: { stallMs: 30 }, gate: (name, off, opts) => (++n === 1 ? new Promise((_, rej) => opts.signal.addEventListener("abort", () => rej(new Error("aborted")))) : null) });
    const s = await sessions.open("f");
    const reading = s.read(0, 4);
    await sleep(10);
    let st = s.status();
    eq(st.demand, 1); eq(st.stalled, 0); assert(st.oldestMs >= 5, "等了一会");
    await sleep(40);
    st = s.status();
    eq(st.stalled, 0, "对冲那路已发出、它还没卡 → 这片不算卡住");
    eq([...await reading].join(","), [...bytes(4)].join(","), "读完成");
    eq(calls.filter((c) => c.off === 0).length, 2, "★两路（原路 + 对冲）");
    assert(calls[0].opts.signal.aborted, "输的原路被中止");
    eq(s.status().demand, 0);
    s.close();
  });

  it("镜像：开会话按名字 + 尺寸问；片从镜像来；第一片先和云端比过；meta.mirrored 记没验过的片", async () => {
    const data = bytes(12);
    const files = new Map([["f", { etag: "e", data }]]);
    const m = memMirror("pc", new Map([["f", data], ["other", bytes(5)]]));
    const { sessions, staging, calls } = mkSessions2({ files, streaming: {}, mirrors: [m.src] });
    const s = await sessions.open("f");
    eq(s.status().mirror, "ok"); eq(s.status().mirrorLabel, "pc"); eq(s.status().cloudless, false);
    const got = await s.read(0, 12);
    eq([...got].join(","), [...data].join(","), "字节对");
    eq(m.reads.length, 3, "三片都从镜像来");
    eq(calls.length, 1, "★云端只打了一次 = 第一片的核对");
    await sleep(10);
    const meta = JSON.parse(await staging._map.get("meta:f").text());
    eq(meta.chunks.length, 3, "三片都在账");
    eq((meta.mirrored ?? []).length, 2, "★两片来自镜像、没验过；核对过的那片不算");
    s.close();
    const s2 = await sessions.open("f");
    eq((await s2.read(0, 12)).length, 12);
    eq(m.reads.length, 3, "staging 命中：镜像不再被打");
    s2.close();
  });

  it("镜像字节和云端不一样 → 第一片不交出去、拒掉镜像、回落云端；重开会话不再用它", async () => {
    const data = bytes(12);
    const files = new Map([["f", { etag: "e", data }]]);
    const wrong = Uint8Array.from(data, (x) => (x + 1) % 251);
    const m = memMirror("stale", new Map([["f", wrong]]));
    const { sessions, staging, calls } = mkSessions2({ files, streaming: {}, mirrors: [m.src] });
    const s = await sessions.open("f");
    eq(s.status().mirror, "ok");
    const got = await s.read(0, 4);
    eq([...got].join(","), [...data.slice(0, 4)].join(","), "★交出去的是云端的字节（错盘一个字节都不交）");
    eq(s.status().mirror, "rejected");
    eq(calls.length, 2, "核对一次 + 回落云端拉一次");
    assert(!staging._map.has("chunk:f:0") || [...new Uint8Array(await staging._map.get("chunk:f:0").arrayBuffer())].join(",") === [...data.slice(0, 4)].join(","), "staging 里没有错字节");
    await s.read(4, 4);
    eq(m.reads.length, 1, "拒掉后镜像不再被打");
    s.close();
    const s2 = await sessions.open("f");
    eq(s2.status().mirror, "rejected", "★这一版记住了：重开也不用");
    s2.close();
  });

  it("镜像抽样核对（事后）：中段不同 → 拒掉 + 清掉它没验过的片，后续走云端", async () => {
    const data = bytes(80);                                   // 20 片；第 1 片核对、第 16 片抽样
    const files = new Map([["f", { etag: "e", data }]]);
    const bad = Uint8Array.from(data); bad[70] = 7;            // 第 17 片（off 68）不同
    const m = memMirror("half", new Map([["f", bad]]));
    const { sessions, staging } = mkSessions2({ files, streaming: {}, mirrors: [m.src] });
    const s = await sessions.open("f");
    for (let i = 0; i < 20; i++) await s.read(i * 4, 4);     // 顺序读全盘；第 16 片（off 60）抽样和云端比——那里是一样的
    await sleep(10);
    eq(s.status().mirror, "ok", "抽到的片一样 → 还在用");
    // 换一个抽样会撞到不同处的布局：直接再开一会话、读第 17 片两次（mirrorChunks 节拍从 0 起：第 1 片核对 = off 68 → 不同）
    s.close();
    const s2 = await sessions.open("f");
    await staging.del("chunk:f:17");                          // 让它必须去镜像拿
    const got = await s2.read(68, 4);
    eq([...got].join(","), [...data.slice(68, 72)].join(","), "核对发现不同 → 这片交的是云端的");
    eq(s2.status().mirror, "rejected");
    const meta = JSON.parse(await staging._map.get("meta:f").text());
    eq((meta.mirrored ?? []).length, 0, "★没验过的镜像片全清");
    assert(!staging._map.has("chunk:f:5"), "没验过的片不在 staging 了");
    assert(staging._map.has("chunk:f:0"), "验过的片留着");
    s2.close();
  });

  it("镜像抽样核对在并发下也按节拍抽（2.1.3 修：节拍在片到达那一刻定，不在 await 之后看计数）", async () => {
    // 2.1.2 及以前：arrived() 先 mirrorChunks++、再 await 落 staging、之后才看 mirrorChunks % 16——三路并发时第 16 片醒来看到的计数已经是 17、18 → 抽样被系统性跳过。
    const data = bytes(80);                                   // 20 片；第 1 片核对（一样），之后任何一片被抽到都该不一样
    const files = new Map([["f", { etag: "e", data }]]);
    const bad = Uint8Array.from(data, (x, i) => (i < 4 ? x : (x + 1) % 251));   // 只有第 1 片和云端一样
    const m = memMirror("busy", new Map([["f", bad]]));
    const { sessions } = mkSessions2({ files, streaming: { lanes: 3 }, mirrors: [m.src] });
    const s = await sessions.open("f");
    await s.read(0, 80);                                      // 一口气要全盘 = 20 片并发排队
    await sleep(30);
    eq(s.status().mirror, "rejected", "★20 片里至少一片被抽到 → 镜像必被拒");
    s.close();
  });

  it("镜像出错 → 回落云端 + 进冷却（status down）；云端够不着而账上有这份 → 只用镜像开会话（cloudless）", async () => {
    const data = bytes(12);
    const files = new Map([["f", { etag: "e", data }]]);
    let breakIt = false;
    const m = memMirror("lan", new Map([["f", data]]), { fail: () => breakIt });
    let down = false;
    const { sessions, calls } = mkSessions2({ files, streaming: {}, mirrors: [m.src], cloudDown: () => down });
    const s = await sessions.open("f");
    await s.read(0, 4);                                       // 第一片：镜像 + 云端核对
    breakIt = true;
    const got = await s.read(4, 4);
    eq([...got].join(","), [...data.slice(4, 8)].join(","), "镜像坏了 → 云端拿到");
    eq(s.status().mirror, "down", "★进冷却");
    const before = m.reads.length;
    await s.read(8, 4);
    eq(m.reads.length, before, "冷却期内不再打镜像");
    s.close();
    breakIt = false; down = true;                             // 云端够不着
    const s2 = await sessions.open("f");
    assert(s2, "账上有这份 + 镜像有 → 能开");
    eq(s2.status().cloudless, true);
    s2.close();
    const empty = mkSessions2({ files, streaming: {}, mirrors: [m.src], cloudDown: () => true });
    let err = null;
    try { await empty.sessions.open("f"); } catch (e) { err = e; }
    eq(err?.message, "cloud unreachable", "账上没有这份 → 诚实抛云端的错");
    void calls;
  });
});
