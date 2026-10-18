// chunk-scheduler（2.0.0，2026-10-17 Claude Fable 5.1）—— 「一个 key 拿一次字节」的调度政策。
// 验：
//   · 互等修了：pin 在等让路、播放加入它的 job、先前的播放完成 → 这片照样发出去、读完成（0.18 永远不醒，10-17 探针坐实）。
//   · 车道：lanes=1 同刻投机 ≤ 1（= 0.18）；lanes=3 ≤ 3；播放不占车道、不限。
//   · 让路：播放在飞时投机不开新分片。
//   · 卡住（按「多久没到字节」）：投机中止让道 → StreamStallError（有别的来源就换）；播放对冲（先到的赢、输的中止）；有进度就不算卡。
//   · 播放加入已卡住的投机 → 立刻对冲。
//   · 来源回落：[0] 出错 → [1]；都错 → 以最后的错失败。
//   · 字节到了都交 arrived（赢家、没理会中止的晚到者）。preflight 命中不上网、不 arrived。
//   · status() 数在飞 / 卡住。
import { describe, it, assert, eq } from "./runner.mjs";
import { createChunkScheduler, StreamStallError } from "../src/chunk-scheduler.ts";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const bytes = (n, seed = 0) => Uint8Array.from({ length: n }, (_, i) => (i + seed) % 251);
/** 永远不回、但理会中止的来源。 */
const hang = (opts) => new Promise((_, rej) => { opts.signal?.addEventListener("abort", () => rej(new Error("aborted by scheduler")), { once: true }); });
/** 可控来源：calls 记每次调用；每次 fetch 等 gate(n) 再回 data。 */
function source(origin, data, gate = async () => {}) {
  const calls = [];
  return {
    calls,
    src: { origin, fetch: async (opts) => { const n = calls.length; calls.push(opts); await gate(n, opts); return data; } },
  };
}

describe("chunk-scheduler · 2.0.0 互等 / 让路 / 车道", () => {
  it("★互等修了：pin 等让路时播放加入它的 job，先前的播放完成 → 这片发出、读完成", async () => {
    const s = createChunkScheduler();
    let releaseA;
    const a = source("cloud", bytes(4, 1), () => new Promise((r) => { releaseA = r; }));
    const b = source("cloud", bytes(4, 2));
    const readA = s.request({ key: "f:0", prio: "playback", sources: [a.src] });
    await sleep(5);
    const pinB = s.request({ key: "f:1", prio: "pin", sources: [b.src] });     // 播放 A 在飞 → 等让路
    await sleep(10);
    eq(b.calls.length, 0, "让路：播放在飞时 pin 不开工");
    const readB = s.request({ key: "f:1", prio: "playback", sources: [b.src] });   // 播放也要 B → 加入 pin 的 job → 升格
    await sleep(10);
    eq(b.calls.length, 1, "★升格后立刻发出（不再等 A）");
    releaseA();
    await readA;
    eq([...await readB].join(","), [...bytes(4, 2)].join(","), "读 B 完成、字节对");
    eq([...await pinB].join(","), [...bytes(4, 2)].join(","), "pin 同一份");
  });

  it("车道：lanes=1 同刻投机 ≤ 1（0.18）；lanes=3 ≤ 3；播放不占车道", async () => {
    for (const [lanes, want] of [[1, 1], [3, 3]]) {
      const s = createChunkScheduler({ lanes });
      let inflight = 0, max = 0;
      const gate = async () => { inflight++; max = Math.max(max, inflight); await sleep(10); inflight--; };
      const src = source("cloud", bytes(4), gate).src;
      await Promise.all(Array.from({ length: 6 }, (_, i) => s.request({ key: `f:${i}`, prio: "pin", sources: [src] })));
      eq(max, want, `lanes=${lanes} → 同刻在飞 ${want}`);
    }
    const s = createChunkScheduler({ lanes: 1 });
    let inflight = 0, max = 0;
    const gate = async () => { inflight++; max = Math.max(max, inflight); await sleep(10); inflight--; };
    const src = source("cloud", bytes(4), gate).src;
    await Promise.all(Array.from({ length: 4 }, (_, i) => s.request({ key: `f:${i}`, prio: "playback", sources: [src] })));
    eq(max, 4, "播放不限、不占车道");
  });

  it("preflight 命中：不上网、不 arrived；同 key 去重只 preflight 一次", async () => {
    const s = createChunkScheduler();
    const a = source("cloud", bytes(4));
    let pre = 0, arrived = 0;
    const req = (prio) => s.request({ key: "f:0", prio, preflight: async () => { pre++; await sleep(5); return bytes(4, 9); }, sources: [a.src], arrived: () => { arrived++; } });
    const [x, y] = await Promise.all([req("pin"), req("playback")]);
    eq(a.calls.length, 0, "没上网");
    eq(pre, 1, "去重：只 preflight 一次");
    eq(arrived, 0, "本机命中不 arrived");
    eq([...x].join(","), [...bytes(4, 9)].join(",")); eq([...y].join(","), [...bytes(4, 9)].join(","));
  });
});

describe("chunk-scheduler · 2.0.0 卡住判定", () => {
  it("投机卡住 → 中止让道 → StreamStallError；车道还回来（下一片能开）", async () => {
    const s = createChunkScheduler({ lanes: 1, stallMs: 30 });
    const stuck = { origin: "cloud", fetch: hang };
    const next = source("cloud", bytes(4));
    const p1 = s.request({ key: "f:0", prio: "pin", sources: [stuck] });
    const p2 = s.request({ key: "f:1", prio: "pin", sources: [next.src] });
    let err = null;
    try { await p1; } catch (e) { err = e; }
    assert(err instanceof StreamStallError, `★卡住 → StreamStallError（实得 ${err?.name}）`);
    await p2;
    eq(next.calls.length, 1, "车道让出来了，下一片开工");
    eq(s.stats.stallAborts, 1);
  });

  it("投机卡住、还有别的来源 → 换来源（镜像卡 → 云端）", async () => {
    const s = createChunkScheduler({ stallMs: 30 });
    const cloud = source("cloud", bytes(4, 3));
    const got = await s.request({ key: "f:0", prio: "pin", sources: [{ origin: "mirror", fetch: hang }, cloud.src] });
    eq([...got].join(","), [...bytes(4, 3)].join(","), "换云端拿到");
    eq(s.stats.fallbacks, 1);
  });

  it("播放卡住 → 对冲：再开一路同源，先到的赢，输的中止", async () => {
    const s = createChunkScheduler({ stallMs: 30 });
    const calls = [];
    const src = { origin: "cloud", fetch: (opts) => { calls.push(opts); return calls.length === 1 ? hang(opts) : Promise.resolve(bytes(4, 5)); } };
    const got = await s.request({ key: "f:0", prio: "playback", sources: [src] });
    eq([...got].join(","), [...bytes(4, 5)].join(","), "对冲那路的字节");
    eq(calls.length, 2, "★两路");
    assert(calls[0].signal.aborted, "输的那路被中止");
    eq(s.stats.hedges, 1);
  });

  it("有进度就不算卡：慢而不停的链路不被对冲", async () => {
    const s = createChunkScheduler({ stallMs: 30 });
    const calls = [];
    const src = { origin: "cloud", fetch: async (opts) => { calls.push(opts); for (let k = 1; k <= 8; k++) { await sleep(12); opts.onProgress?.(k * 512); } return bytes(4); } };
    await s.request({ key: "f:0", prio: "playback", sources: [src] });
    eq(calls.length, 1, "★96 ms 慢读、每 12 ms 到字节 → 一路到底");
    eq(s.stats.hedges, 0);
  });

  it("播放加入在飞、已过 stallMs 的投机 → 当场对冲", async () => {
    // 投机 stall 用长窗口模拟「定时器还没到、但 lastAt 已经很老」：now 注入
    let t = 0;
    const s = createChunkScheduler({ stallMs: 1000, now: () => t });
    const calls = [];
    const src = { origin: "cloud", fetch: (opts) => { calls.push(opts); return calls.length === 1 ? hang(opts) : Promise.resolve(bytes(4, 8)); } };
    const pin = s.request({ key: "f:0", prio: "pin", sources: [src] });
    await sleep(5);
    eq(calls.length, 1, "投机一路在飞");
    t = 5000;                                                    // 虚拟时间：早就过了 stallMs
    const got = await s.request({ key: "f:0", prio: "playback", sources: [src] });
    eq(calls.length, 2, "★加入即对冲");
    eq([...got].join(","), [...bytes(4, 8)].join(","));
    await pin;
  });
});

describe("chunk-scheduler · 2.0.0 来源回落 / arrived / status", () => {
  it("[0] 出错 → 换 [1]；都错 → 以最后的错失败", async () => {
    const s = createChunkScheduler();
    const bad = { origin: "mirror", fetch: async () => { throw new Error("mirror 500"); } };
    const cloud = source("cloud", bytes(4, 2));
    const got = await s.request({ key: "f:0", prio: "playback", sources: [bad, cloud.src] });
    eq([...got].join(","), [...bytes(4, 2)].join(","), "回落云端");
    const bad2 = { origin: "cloud", fetch: async () => { throw new Error("cloud 503"); } };
    let err = null;
    try { await s.request({ key: "f:1", prio: "playback", sources: [bad, bad2] }); } catch (e) { err = e; }
    eq(err?.message, "cloud 503", "都错：最后的错");
  });

  it("arrived：赢家 + 没理会中止的晚到者都交；job 留表到 arrived 完 → 其间同片的读直接拿字节", async () => {
    const s = createChunkScheduler({ stallMs: 30 });
    const arrivals = [];
    let releaseLate;
    const late = { origin: "mirror", fetch: () => new Promise((r) => { releaseLate = r; }) };   // 不理会 signal
    const cloud = source("cloud", bytes(4, 1));
    let teeDone;
    const arrived = (b, origin) => { arrivals.push(origin); return new Promise((r) => { teeDone = r; }); };
    const got = await s.request({ key: "f:0", prio: "playback", sources: [late, cloud.src], arrived });
    eq([...got].join(","), [...bytes(4, 1)].join(","), "对冲（云端）赢");
    eq(arrivals.join(","), "cloud");
    const again = await s.request({ key: "f:0", prio: "playback", sources: [late, cloud.src], arrived });   // tee 还没完 → 加入同一 job
    eq(cloud.calls.length, 1, "★tee 期间同片的读不再上网");
    eq([...again].join(","), [...bytes(4, 1)].join(","));
    teeDone();
    releaseLate(bytes(4, 1));
    await sleep(5);
    eq(arrivals.join(","), "cloud,mirror", "输了的那路晚到也交 arrived（字节不浪费）");
  });

  it("status()：在飞的播放 / 投机、最老等了多久、卡住几片", async () => {
    let t = 0;
    const s = createChunkScheduler({ stallMs: 100, now: () => t });
    const stuck = { origin: "cloud", fetch: hang };
    const read = s.request({ key: "f:0", prio: "playback", sources: [stuck] });
    const pin = s.request({ key: "g:1", prio: "pin", sources: [stuck] });
    await sleep(5);
    let st = s.status();
    eq(st.demand, 1); eq(st.speculative, 0, "播放在飞时投机还在等让路（没上网）"); eq(st.queued, 1, "等让路的算 queued"); eq(st.stalled, 0);
    t = 250;
    st = s.status();
    eq(st.oldestMs, 250); eq(st.stalled, 1, "★一路 250 ms 没字节 = 卡住");
    eq(s.status("g:").demand, 0, "按前缀只看某文件");
    eq(s.status("f:").demand, 1);
    read.catch(() => {}); pin.catch(() => {});
  });
});
