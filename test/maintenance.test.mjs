// maintenance（深清两口子）契约测试。node 无 idb/localStorage → globalThis 垫假件（测完还原）。
// created 2026-08-28 by Claude Fable 5.
import { describe, it, assert, eq } from "./runner.mjs";
import { wipeAppNamespace, scanAppNamespace, WipeConsentError } from "../src/maintenance.ts";

function fakeEnv({ dbs = [], blocked = [], lsKeys = [] } = {}) {
  const alive = new Set(dbs);
  const blockedSet = new Set(blocked);
  const idb = {
    databases: async () => [...alive].map((name) => ({ name })),
    deleteDatabase(name) {
      const req = {};
      queueMicrotask(() => {
        if (blockedSet.has(name)) { req.onblocked?.(); return; }   // 永不 success → 走放弃线
        alive.delete(name);
        req.onsuccess?.();
      });
      return req;
    },
  };
  const m = new Map(lsKeys.map((k) => [k, "1"]));
  const ls = {
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    removeItem: (k) => m.delete(k),
  };
  const prevIdb = globalThis.indexedDB, prevLs = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  globalThis.indexedDB = idb;
  Object.defineProperty(globalThis, "localStorage", { value: ls, configurable: true });
  return { alive, m, restore() {
    globalThis.indexedDB = prevIdb;
    if (prevLs) Object.defineProperty(globalThis, "localStorage", prevLs); else delete globalThis.localStorage;
  } };
}

const CONSENT = { expected: "删除全部本地数据", typed: "删除全部本地数据" };

describe("maintenance · typed consent（库内比对，不过不执行）", () => {
  it("typed ≠ expected / expected 过短 → WipeConsentError，零副作用", async () => {
    const env = fakeEnv({ dbs: ["wp.defaultStore"], lsKeys: ["wp.defaultStore.files.etag:秘密画.ora"] });
    try {
      for (const consent of [
        { expected: "删除全部本地数据", typed: "删除全部本地数掘" },   // 打错字
        { expected: "删除全部本地数据", typed: "" },
        { expected: "  ", typed: "  " },                                // expected 空/过短
      ]) {
        let threw = null;
        try { await wipeAppNamespace({ appId: "wp", consent }); } catch (e) { threw = e; }
        assert(threw instanceof WipeConsentError, "必须 WipeConsentError");
      }
      eq(env.alive.size, 1, "库原样");
      eq(env.m.size, 1, "键原样");
    } finally { env.restore(); }
  });
});

describe("maintenance · wipe 作用域 + blocked 诚实报告", () => {
  it("只删 `${appId}.` 前缀（多实例全删；GUID `-` 前缀/兄弟 app 不碰）；localStorage 只报计数", async () => {
    const env = fakeEnv({
      dbs: ["wp.defaultStore", "wp.gallery-g1", "wp-bd6cece69075d759.crash", "jrp.defaultStore"],
      lsKeys: ["wp.defaultStore.files.etag:画.ora", "wp.gallery-g1.database-version", "jrp.defaultStore.x", "unrelated"],
    });
    try {
      const r = await wipeAppNamespace({ appId: "wp", consent: CONSENT });
      eq(r.deletedDatabases.sort().join(","), "wp.defaultStore,wp.gallery-g1", "两实例全删");
      eq(r.blockedDatabases.length, 0);
      eq(r.localStorageKeysRemoved, 2, "本命名空间两键（只报计数）");
      assert(env.alive.has("wp-bd6cece69075d759.crash"), "app 自家 GUID 库（`-` 非 `.`）不碰");
      assert(env.alive.has("jrp.defaultStore"), "兄弟 app 不碰");
      assert(env.m.has("jrp.defaultStore.x") && env.m.has("unrelated"), "界外键不碰");
    } finally { env.restore(); }
  });
  it("活连接堵住的库 → blocked 报告（不傻等不谎报删净）", async () => {
    const env = fakeEnv({ dbs: ["wp.defaultStore", "wp.gallery-g1"], blocked: ["wp.gallery-g1"] });
    try {
      const r = await wipeAppNamespace({ appId: "wp", consent: CONSENT });
      eq(r.deletedDatabases.join(","), "wp.defaultStore");
      eq(r.blockedDatabases.join(","), "wp.gallery-g1", "被堵的库诚实报出（UI 提示关别的 tab）");
    } finally { env.restore(); }
  }, { timeout: 15_000 });   // 内含 2s 放弃线
});

describe("maintenance · 无痕扫（红线口径：库名可返、键名/文件名永不返）", () => {
  it("残留 = 命名空间级库名 + 键计数；wipe 后归零", async () => {
    const env = fakeEnv({ dbs: ["wp.defaultStore"], lsKeys: ["wp.defaultStore.files.dirty:私密作品.ora"] });
    try {
      const before = await scanAppNamespace("wp");
      eq(before.databasesSupported, true);
      eq(before.databases.join(","), "wp.defaultStore", "库名=命名空间级（固定模式，无内容）");
      eq(before.localStorageKeys, 1, "键只报计数");
      assert(!JSON.stringify(before).includes("私密作品"), "★红线：报告任何角落不出现文件名");
      await wipeAppNamespace({ appId: "wp", consent: CONSENT });
      const after = await scanAppNamespace("wp");
      eq(after.databases.length, 0, "库归零");
      eq(after.localStorageKeys, 0, "键归零");
    } finally { env.restore(); }
  });
  it("databases() 不可用平台 → supported:false 诚实报（绝不假装扫过）", async () => {
    const env = fakeEnv({});
    delete globalThis.indexedDB.databases;
    try {
      const r = await scanAppNamespace("wp");
      eq(r.databasesSupported, false);
      eq(r.databases.length, 0);
    } finally { env.restore(); }
  });
});
