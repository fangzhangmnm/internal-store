// IDB 挂死自愈（0.11.5，created 2026-09-06 by Claude Fable 5.1；user 2026-09-06 批 deadline / 老连接自关 / 超时重开重试一次）。
// node 无 IDB → 假 indexedDB：可控「open 永不回」「某条连接的事务永不 complete」「版本变更」。
// 钉：① 正常路径不受 deadline 影响；② 第一条连接挂死 → 超时后丢连接、重开、重试一次成功（open 计数 2、旧连接被 close）；
//     ③ 重试仍挂死 → 抛 IdbTimeoutError（name 可识别）；④ open 本身挂死 → 同样 IdbTimeoutError 且重试过一次；
//     ⑤ onversionchange → 老连接自己 close，下一 op 重开；⑥（0.11.6）pagehide：在飞 readonly 被 abort（IdbSuspendedError）、
//     readwrite 放行、无 readwrite 时关连接、下一 op 重开；close() 摘掉 pagehide 监听。
import { test, assert, eq } from "./runner.mjs";
import { createIdbCache, IdbTimeoutError, IdbSuspendedError, setIdbOpTimeoutForTests, idbOpTimeoutMs } from "../src/idb-store.ts";

function fakeIdb({ openHang = () => false, txHang = () => false } = {}) {
  let opens = 0; const dbs = [];
  const idb = {
    open() {
      opens++; const n = opens;
      const req = { onupgradeneeded: null, onsuccess: null, onerror: null, onblocked: null, result: null };
      if (openHang(n)) return req;                       // 永不回
      const db = {
        n, closed: false, onclose: null, onversionchange: null,
        close() { this.closed = true; },
        transaction(_store, mode) {
          const t = { mode, onerror: null, onabort: null, oncomplete: null, error: null, aborted: false,
            abort() { if (this.aborted) throw new Error("InvalidStateError"); this.aborted = true; setTimeout(() => this.onabort?.(), 0); },
            objectStore() { return { get(k) { return { result: `v:${k}` }; }, getAllKeys() { return { result: ["a", "b", 7] }; }, put() { return {}; } }; } };
          if (!txHang(n)) setTimeout(() => { if (!t.aborted) t.oncomplete?.(); }, 1);
          return t;
        },
      };
      dbs.push(db); req.result = db;
      setTimeout(() => req.onsuccess?.(), 0);
      return req;
    },
  };
  return { idb, dbs, opens: () => opens };
}
async function withFake(fake, ms, fn) {
  const prev = globalThis.indexedDB; const prevMs = idbOpTimeoutMs();
  globalThis.indexedDB = fake.idb; setIdbOpTimeoutForTests(ms);
  try { await fn(); } finally { globalThis.indexedDB = prev; setIdbOpTimeoutForTests(prevMs); }
}

test("idb-deadline · 正常路径：get/keys 照常 resolve，只 open 一次", async () => {
  const f = fakeIdb();
  await withFake(f, 200, async () => {
    const c = createIdbCache("t.db");
    eq(await c.get("a"), "v:a"); eq((await c.keys()).join(","), "a,b");
    eq(f.opens(), 1); eq(c._opens(), 1);
  });
});
test("idb-deadline · 第一条连接的事务挂死 → 超时丢连接、重开、重试一次成功；旧连接被 close", async () => {
  const f = fakeIdb({ txHang: (n) => n === 1 });
  await withFake(f, 40, async () => {
    const c = createIdbCache("t.db");
    const t0 = Date.now();
    eq(await c.get("x"), "v:x");
    assert(Date.now() - t0 >= 35, "应等过一次 deadline");
    eq(f.opens(), 2, "重开一次"); assert(f.dbs[0].closed, "挂死的旧连接被 close"); assert(!f.dbs[1].closed);
  });
});
test("idb-deadline · 重试仍挂死 → IdbTimeoutError（name 可识别），恰重开一次", async () => {
  const f = fakeIdb({ txHang: () => true });
  await withFake(f, 30, async () => {
    const c = createIdbCache("t.db");
    let err = null;
    try { await c.keys(); } catch (e) { err = e; }
    assert(err instanceof IdbTimeoutError && err.name === "IdbTimeoutError", `应抛 IdbTimeoutError，得 ${err && err.name}`);
    assert(/readonly keys/.test(err.message), err.message);
    eq(f.opens(), 2);
  });
});
test("idb-deadline · open 本身挂死 → IdbTimeoutError(open)，且重试过一次 open", async () => {
  const f = fakeIdb({ openHang: () => true });
  await withFake(f, 30, async () => {
    const c = createIdbCache("t.db");
    let err = null;
    try { await c.get("a"); } catch (e) { err = e; }
    assert(err instanceof IdbTimeoutError && /open/.test(err.message), `应抛 open 超时，得 ${err && err.message}`);
    eq(f.opens(), 2);
  });
});
test("idb-deadline · onversionchange → 老连接自己 close，下一 op 重开", async () => {
  const f = fakeIdb();
  await withFake(f, 200, async () => {
    const c = createIdbCache("t.db");
    eq(await c.get("a"), "v:a");
    f.dbs[0].onversionchange();
    assert(f.dbs[0].closed, "版本变更 → 老连接 close");
    eq(await c.get("b"), "v:b");
    eq(f.opens(), 2, "下一 op 重开");
  });
});

// ⑥ pagehide 处置（假 window 抓监听）
function withWindow(fn) {
  const prev = globalThis.window; const handlers = {};
  globalThis.window = { addEventListener(type, f) { handlers[type] = f; }, removeEventListener(type) { delete handlers[type]; } };
  return Promise.resolve().then(() => fn(handlers)).finally(() => { if (prev === undefined) delete globalThis.window; else globalThis.window = prev; });
}
test("idb-deadline · pagehide：在飞 readonly 事务被 abort → IdbSuspendedError（不重试）、连接关掉、下一 op 重开", async () => {
  const f = fakeIdb({ txHang: () => true });
  await withWindow(async (handlers) => {
    await withFake(f, 5000, async () => {
      const c = createIdbCache("t.db");
      assert(typeof handlers.pagehide === "function", "注册了 pagehide 监听");
      const p = c.keys().catch((e) => e);
      await new Promise((r) => setTimeout(r, 5));     // 让 open 完成、事务开出来
      handlers.pagehide();
      const err = await p;
      assert(err instanceof IdbSuspendedError && err.name === "IdbSuspendedError", `应抛 IdbSuspendedError，得 ${err && err.name}: ${err && err.message}`);
      assert(f.dbs[0].closed, "无 readwrite 在飞 → 连接关掉");
      eq(f.opens(), 1, "suspend 弃读不重试（不是超时）");
      const f2 = fakeIdb(); globalThis.indexedDB = f2.idb;   // 下一 op：重开（换成会回的假库）
      eq(await c.get("z"), "v:z"); eq(f2.opens(), 1, "下一 op 重开连接");
    });
  });
});
test("idb-deadline · pagehide：在飞 readwrite 放行（不 abort、连接不关）", async () => {
  const f = fakeIdb({ txHang: () => true });
  await withWindow(async (handlers) => {
    await withFake(f, 5000, async () => {
      const c = createIdbCache("t.db");
      const p = c.put("k", { blob: null, updatedAt: 0 });
      await new Promise((r) => setTimeout(r, 5));
      handlers.pagehide();
      await new Promise((r) => setTimeout(r, 5));
      assert(!f.dbs[0].closed, "有 readwrite 在飞 → 连接不关");
      eq(f.dbs[0].n, 1);
      let settled = false; p.then(() => { settled = true; }, () => { settled = true; });
      await new Promise((r) => setTimeout(r, 5));
      assert(!settled, "readwrite 没被腰斩（仍在飞）");
      c.close();   // 收尾：关连接（挂着的假事务随测试结束丢弃）
    });
  });
});
test("idb-deadline · close() 摘掉 pagehide 监听", async () => {
  const f = fakeIdb();
  await withWindow(async (handlers) => {
    await withFake(f, 5000, async () => {
      const c = createIdbCache("t.db");
      assert(handlers.pagehide, "有监听");
      c.close();
      assert(!handlers.pagehide, "close 后摘掉");
    });
  });
});
