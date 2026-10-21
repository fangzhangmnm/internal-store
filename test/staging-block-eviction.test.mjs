// 2.1.5 按块淘汰（user 10-21「store 的其他做」；预取库出生稿「按块的淘汰 + 钉热集」）：streaming 模式下 staging 超限不再整组 FIFO、
//   也不再对在用会话一个字节不动——按块：不在用的先、命中少的先、最久没碰的先；在用会话 hotMs 以内碰过的块钉住。
//   created 20261021 by Claude Fable 5.1
import { describe, it, assert, eq } from "./runner.mjs";
import { createDownloadSessions } from "../src/stream/download-session.ts";

const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251);
function memStaging() {
  const m = new Map();
  return { _map: m, async get(k) { return m.get(k) ?? null; }, async put(k, b) { m.set(k, b); }, async del(k) { m.delete(k); }, async keys() { return [...m.keys()]; } };
}
/** chunk 4 字节；files = Map(name → data)；now = 可拨的假时钟（毫秒）。 */
function mk({ files, capBytes, hotMs = 0, streaming = {} }) {
  const staging = memStaging();
  const calls = [];
  const clock = { t: 1000 };
  const sessions = createDownloadSessions({
    staging,
    fetchMeta: async (name) => { const f = files.get(name); return f ? { etag: "e", size: f.length, item: { name } } : null; },
    range: async (item, off, len) => { calls.push(`${item.name}:${off}`); return files.get(item.name).slice(off, off + len); },
    adoptLocal: async () => true,
    chunkSize: 4, capBytes, hotMs, now: () => clock.t, streaming: streaming === null ? undefined : { ...streaming, mirrors: () => [] },
  });
  const chunksOf = (name) => [...staging._map.keys()].filter((k) => k.startsWith(`chunk:${name}:`)).map((k) => Number(k.split(":")[2])).sort((a, b) => a - b);
  return { sessions, staging, calls, clock, chunksOf };
}
const readChunk = async (s, i) => { await s.read(i * 4, 4); };

describe("staging · 2.1.5 按块淘汰", () => {
  it("在用会话冷掉的块也淘汰（hotMs=0）：超限后最久没碰的先走，在用会话的 got 同步划掉、再读从云端重拉", async () => {
    const files = new Map([["f", bytes(20)]]);                    // 5 块
    const h = mk({ files, capBytes: 12, hotMs: 0 });               // 只容 3 块
    const s = await h.sessions.open("f");
    for (const i of [0, 1, 2]) { await readChunk(s, i); h.clock.t += 10; }
    await h.sessions._enforceCap();
    eq(h.chunksOf("f").join(","), "0,1,2", "没超限：三块都在");
    await readChunk(s, 3); h.clock.t += 10;
    await h.sessions._enforceCap();
    eq(h.chunksOf("f").join(","), "1,2,3", "★超限：最久没碰的第 0 块走了（在用会话也清，以前一个字节不动）");
    eq((await h.sessions.coverage("f")).bytes, 12, "账本同步（coverage 只算还在的）");
    const before = h.calls.length;
    await readChunk(s, 0);
    eq(h.calls.length, before + 1, "★第 0 块重新从云端拉（got 已划掉，不会误以为还在）");
    s.close();
  });

  it("命中多的块后走：一次性扫过的（hits=0）先于反复用到的（抗扫描污染）", async () => {
    const files = new Map([["f", bytes(20)]]);
    const h = mk({ files, capBytes: 12, hotMs: 0 });
    const s = await h.sessions.open("f");
    await readChunk(s, 0); h.clock.t += 10;
    await readChunk(s, 1); h.clock.t += 10;
    await readChunk(s, 2); h.clock.t += 10;
    await readChunk(s, 0); h.clock.t += 10;                        // 第 0 块从 staging 命中 → hits 1（虽然它最早到）
    await readChunk(s, 3); h.clock.t += 10;
    await h.sessions._enforceCap();
    eq(h.chunksOf("f").join(","), "0,2,3", "★走的是第 1 块（hits 0、最老），不是最早到但被再用过的第 0 块");
    s.close();
  });

  it("不在用的会话先于在用的；在用会话 hotMs 以内碰过的块钉住（宁可暂时超限）", async () => {
    const files = new Map([["a", bytes(12)], ["b", bytes(12)]]);
    const h = mk({ files, capBytes: 16, hotMs: 1_000_000 });
    const sa = await h.sessions.open("a");
    for (const i of [0, 1, 2]) { await readChunk(sa, i); h.clock.t += 10; }
    sa.close();                                                    // a 不在用了
    const sb = await h.sessions.open("b");
    for (const i of [0, 1, 2]) { await readChunk(sb, i); h.clock.t += 10; }
    await h.sessions._enforceCap();                                // 24 > 16
    eq(h.chunksOf("b").join(","), "0,1,2", "★在用会话 b 的块全在（都在 hotMs 内 = 热集钉住）");
    eq(h.chunksOf("a").length, 1, "不在用的 a 被清到刚好不超限（24 - 8 = 16）");
    sb.close();
  });

  it("0.18 模式（不传 streaming）照旧整组 FIFO、在用会话不动", async () => {
    const files = new Map([["a", bytes(12)], ["b", bytes(12)]]);
    const h = mk({ files, capBytes: 16, hotMs: 0, streaming: null });
    const sa = await h.sessions.open("a");
    for (const i of [0, 1, 2]) { await readChunk(sa, i); h.clock.t += 10; }
    sa.close();
    const sb = await h.sessions.open("b");
    for (const i of [0, 1, 2]) { await readChunk(sb, i); h.clock.t += 10; }
    await h.sessions._enforceCap();
    eq(h.chunksOf("a").length, 0, "整组清");
    eq(h.chunksOf("b").join(","), "0,1,2", "在用的不动");
    sb.close();
  });
});
