// 窄腰 + collection-KV 验收（2026-07-13）：命名空间根 `${appId}.${databaseId}` + kv 前缀 choke point +
//   isHidden 列举过滤 + collection 合法名 + files/collections 两实例 etag 隔离 +
//   collection KV 面（getItem/default/setItem/getEntry/pre-init 守卫/local-only 变体） +
//   collection 云端落 `.${appId}/<name>.json` + scaffold + backupFolder 默认 `.backup`。
//   （localSettings/syncedSettings 已删 2026-07-13——设置/状态全走 collection。）
import { test, eq, assert } from "./runner.mjs";
import { isHidden, assertValidFileName, assertValidCollectionName } from "../src/is-hidden.ts";
import { namespacedKv } from "../src/kv-namespace.ts";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createCloudSync } from "../src/cloud-sync.ts";

// 可 dump 的内存 kv（含 keys()）——检查命名空间。
function dumpKv() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => (m.has(k) ? m.get(k)! : null),
    set: (k: string, v: string) => { m.set(k, String(v)); },
    remove: (k: string) => { m.delete(k); },
    keys: () => [...m.keys()],
    _map: m,
  };
}

const STUB_UI = { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} } as never;
function mkStore(kv: ReturnType<typeof dumpKv>, provider = createMockProvider(), databaseId?: string) {
  return {
    provider,
    store: createStore({ encryption: createMockEncryption(), persistence: "none",
      appId: "wp", databaseId, provider, ui: STUB_UI,
      validateAdopt: () => true, kv, local: createMockLocal(),
      fileName: (n: string) => n, isOnline: () => true, signedIn: () => true, skipMigration: true,
    }),
  };
}

// ── isHidden（纯）────────────────────────────────────────────────────────────
test("[narrow-waist] isHidden：末段 dot 判隐藏（.trash/.backup/.wp/任意 dot；a/.b；.x/y 段）", () => {
  for (const h of [".trash", ".backup", ".wp", ".secret.ora", "a/.hidden", "folder/.b.ora"])
    assert(isHidden(h), `应隐藏: ${h}`);
  for (const v of ["x.ora", "folder/x.ora", "reading-state", "a.b/c.ora", ""])
    assert(!isHidden(v), `不应隐藏: ${v}`);
});

// ── namespacedKv（纯）────────────────────────────────────────────────────────
test("[narrow-waist] namespacedKv：所有键补 `${ns}.` 前缀，keys() 只返本命名空间去前缀键", () => {
  const raw = dumpKv();
  raw.set("other.app.foo", "x");                 // 别的命名空间的键
  const kv = namespacedKv(raw, "wp.defaultStore");
  kv.set("files.etag:a.ora", "E");
  kv.set("collections.etag:pref", "F");
  eq(raw.get("wp.defaultStore.files.etag:a.ora"), "E", "写落命名空间");
  eq(kv.get("files.etag:a.ora"), "E", "读经命名空间");
  const ks = kv.keys().sort();
  eq(ks.join(","), "collections.etag:pref,files.etag:a.ora", "keys() 只列本命名空间、去前缀，不含别的 app");
});

// ── collection KV 面：getItem 缺省 / setItem 往返 / getEntry / 信封 {id,uat,value} ─────────
test("[collection] getItem 缺省 + setItem/getItem 往返 + getEntry(uat) + 裸值/对象 value", async () => {
  const { store } = mkStore(dumpKv());
  const c = store.collection("synced-user-preference");
  eq(c.getItem("lang", "en"), "en", "init/无值 → 返 default");
  eq(c.getItem("lang", () => "zh"), "zh", "default 支持 lambda");
  await c.init();
  eq(c.getItem("lang", "en"), "en", "hydrate 空 → 仍 default");
  c.setItem("lang", "ja");                       // 裸值
  c.setItem("panel", { x: 1, y: 2 });            // 对象值
  eq(c.getItem("lang", "en"), "ja", "setItem/getItem 往返（裸值）");
  eq(JSON.stringify(c.getItem("panel", null)), JSON.stringify({ x: 1, y: 2 }), "对象 value 往返");
  const e = c.getEntry("lang");
  assert(e && e.id === "lang" && e.value === "ja" && typeof e.uat === "number" && e.uat > 0, "getEntry 带 id/value/uat 盖戳");
  assert(c.keys().includes("lang") && c.keys().includes("panel"), "keys() 列所有 id");
});

// ── getItem/setItem 两侧 shallow copy 隔离：app 改拿到/传入的对象都不污染信封 ───────────────
test("[collection] getItem/setItem 两侧 shallow copy 隔离（改副本不污染信封）", async () => {
  const { store } = mkStore(dumpKv());
  const c = store.collection("synced-app-state");
  await c.init();
  const src = { left: 1, top: 2 };
  c.setItem("pos", src);
  src.left = 999;                                  // app 事后改传入对象
  eq((c.getItem("pos", null) as { left: number }).left, 1, "setItem 浅拷贝：事后改传入对象不污染信封");
  const got = c.getItem("pos", null) as { left: number };
  got.left = 777;                                  // app 原地改拿到的对象
  eq((c.getItem("pos", null) as { left: number }).left, 1, "getItem 浅拷贝：原地改返回对象不污染信封");
});

// ── onChange 单 key 绑定：只该 key 变才触发（跨设备 pull 带来值变）─────────────────────────
test("[collection] onChange(id,cb) 单 key 绑定：只该 key 变才触发", async () => {
  const provider = createMockProvider();
  const a = mkStore(dumpKv(), provider).store.collection("synced-user-preference");
  await a.init(); a.setItem("lang", "zh"); await a.reconcileWithRemote();   // A 先推云 lang=zh
  const b = mkStore(dumpKv(), provider).store.collection("synced-user-preference");   // B 后登录（另一台设备）
  let langHits = 0, otherHits = 0;
  b.onChange("lang", () => { langHits++; });
  b.onChange("other-key", () => { otherHits++; });
  await b.init(); await b.reconcileWithRemote();       // B 拉云 → lang 从无→zh 值变
  assert(langHits >= 1, "绑定的 lang 变了 → 触发");
  eq(otherHits, 0, "没变的 other-key → 不触发");
});

// ── pre-init 守卫：init() 前 setItem 抛错；getItem 恒返 default ───────────────────────────
test("[collection] pre-init 守卫：init 前 setItem 抛、getItem 返 default", () => {
  const { store } = mkStore(dumpKv());
  const c = store.collection("synced-app-state");
  eq(c.getItem("current-file", null), null, "init 前 getItem 返 default（不崩）");
  let threw = false;
  try { c.setItem("current-file", "x.ora"); } catch { threw = true; }
  assert(threw, "init 前 setItem 应抛（设置未就绪，防覆盖未 hydrate 的值）");
});

// ── P3（v436）：接缝不许把 store 的诚实结果收窄成 void ────────────────────────────────────
//   本次审计的核心发现：深模块的返回类型早就是有信息量的联合类型，所有活着的谎报都发生在
//   store 与 UI 之间那一层。这几条锁住「结果确实流出来了」。
test("collection.flushLocal 本地写失败 → ok:false（不得 resolve 成功；三个 unload 屏障全靠它）", async () => {
  const { createCollection } = await import("../src/collection.ts");
  const col = createCollection({
    name: "c", cloud: { setDirty: () => {}, isDirty: () => false, getETag: () => null, setETag: () => {} }, manual: true,
    local: { save: async () => { throw new Error("QuotaExceeded"); }, get: async () => null },
    reportError: () => {},
  } as never);
  await col.init();
  col.setItem("k", 1);
  const r = await col.flushLocal();
  eq(r.ok, false, "IDB 拒绝 → ok:false（旧版这里 resolve 成功且只进 console）");
});

test("collection.flushLocal 正常路径 → ok:true", async () => {
  const { createCollection } = await import("../src/collection.ts");
  const saved: unknown[] = [];
  const col = createCollection({
    name: "c", cloud: { setDirty: () => {}, isDirty: () => false, getETag: () => null, setETag: () => {} }, manual: true,
    local: { save: async (_k: string, b: unknown) => { saved.push(b); }, get: async () => null },
    reportError: () => {},
  } as never);
  await col.init();
  col.setItem("k", 1);
  eq((await col.flushLocal()).ok, true, "写成功 → ok:true");
  assert(saved.length > 0, "确实落了盘");
});
