// mirror（0.19，2026-10-17 Claude Fable 5.1）—— 替代来源的两个现成实现。
// 验：
//   · HTTP 镜像 open：Range 0-0 探针 206 且 Content-Range 总长 == 尺寸 → 句柄；200（不支持 Range）/ 404 / 总长不等 / 够不着 → null（不抛）。
//   · HTTP 镜像 read：206 → 字节、按流报进度；非 206 / 长度不对 → 抛；signal 中止 → 抛。
//   · File 镜像：尺寸相等 → slice；不等 → null。
import { describe, it, assert, eq } from "./runner.mjs";
import { createFileMirror, createHttpMirror } from "../src/mirror.ts";

const bytes = (n) => Uint8Array.from({ length: n }, (_, i) => i % 251);
const data = bytes(1000);
/** 假服务器：支持 Range 的静态文件；mode 控制怪癖。 */
function fakeFetch({ total = 1000, mode = "ok", onCall = () => {} } = {}) {
  return async (url, init = {}) => {
    onCall(url, init);
    if (mode === "throw") throw new TypeError("Load failed");
    if (mode === "404") return new Response("nope", { status: 404 });
    if (mode === "no-range") return new Response(data, { status: 200 });
    const m = /bytes=(\d+)-(\d+)/.exec(init.headers?.Range ?? "");
    const [a, b] = [Number(m[1]), Number(m[2])];
    const slice = data.slice(a, b + 1);
    const body = new ReadableStream({
      start(c) { c.enqueue(slice.slice(0, Math.ceil(slice.length / 2))); c.enqueue(slice.slice(Math.ceil(slice.length / 2))); c.close(); },
    });
    if (mode === "short") return new Response(slice.slice(0, slice.length - 1), { status: 206, headers: { "Content-Range": `bytes ${a}-${b}/${total}` } });
    return new Response(body, { status: 206, headers: { "Content-Range": `bytes ${a}-${b}/${total}` } });
  };
}

describe("mirror · 0.19 HTTP 镜像", () => {
  it("open：探针 206 + 总长相等 → 句柄；200 / 404 / 总长不等 / 网络错 → null", async () => {
    const url = (name) => `https://pc.tailnet.ts.net/assets/${encodeURIComponent(name)}`;
    assert(await createHttpMirror("pc", url, { fetch: fakeFetch() }).open("a.pack", 1000), "有这份");
    eq(await createHttpMirror("pc", url, { fetch: fakeFetch({ total: 999 }) }).open("a.pack", 1000), null, "尺寸不等 = 不是同一份");
    eq(await createHttpMirror("pc", url, { fetch: fakeFetch({ mode: "no-range" }) }).open("a.pack", 1000), null, "不支持 Range → 不用");
    eq(await createHttpMirror("pc", url, { fetch: fakeFetch({ mode: "404" }) }).open("a.pack", 1000), null, "没有");
    eq(await createHttpMirror("pc", url, { fetch: fakeFetch({ mode: "throw" }) }).open("a.pack", 1000), null, "够不着 → null 不抛");
    eq(await createHttpMirror("pc", () => null, { fetch: fakeFetch() }).open("a.pack", 1000), null, "urlFor 不认识 → null");
  });

  it("read：206 → 字节逐位对、按流报进度；长度不对 → 抛；中止 → 抛", async () => {
    const calls = [];
    const h = await createHttpMirror("pc", () => "https://x/a", { fetch: fakeFetch({ onCall: (u, i) => calls.push(i.headers?.Range) }) }).open("a", 1000);
    const prog = [];
    const got = await h.read(100, 50, { onProgress: (n) => prog.push(n) });
    eq([...got].join(","), [...data.slice(100, 150)].join(","), "字节对");
    eq(calls.at(-1), "bytes=100-149", "Range 头对");
    eq(prog.join(","), "25,50", "★按流报累计字节");
    const short = await createHttpMirror("pc", () => "https://x/a", { fetch: fakeFetch({ mode: "short" }) }).open("a", 1000);
    let err = null;
    try { await short.read(0, 10); } catch (e) { err = e; }
    assert(err && /wanted 10/.test(err.message), "长度不对 → 抛");
  });

  it("read 的 signal 透传：调度层中止 → read 抛", async () => {
    let probe = true;
    const f = (u, init) => {
      if (probe) { probe = false; return fakeFetch()(u, init); }
      return new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(new Error("aborted"))));
    };
    const h = await createHttpMirror("pc", () => "https://x/a", { fetch: f }).open("a", 1000);
    const ctrl = new AbortController();
    const p = h.read(0, 10, { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 5);
    let err = null;
    try { await p; } catch (e) { err = e; }
    assert(err && /range fetch failed/.test(err.message), `中止 → 抛（${err?.message}）`);
  });
});

describe("mirror · 0.19 File 镜像", () => {
  it("尺寸相等 → slice 字节对；不等 / 没有 → null", async () => {
    const file = new Blob([data]);
    const m = createFileMirror("本机", (name) => (name === "a.pack" ? file : null));
    const h = await m.open("a.pack", 1000);
    assert(h, "有");
    eq([...await h.read(990, 20)].join(","), [...data.slice(990, 1000)].join(","), "越界自动钳、字节对");
    eq(await m.open("a.pack", 1001), null, "尺寸不等");
    eq(await m.open("b.pack", 1000), null, "没有");
  });
});
