// collectionPeek 契约（0.11.0，user 2026-08-30「同意」；首用=WeebPaint 笔刷播种案）。
// created 2026-08-30 by Claude Fable 5.
// 锁死三态 + 纯读：① 云端无 json → "absent"；② 有（哪怕空信封）→ "present"；
// ③ provider 抛（离线/未授权）→ "unknown"（绝不误判 absent）；④ 探针零副作用
// （不建 scaffold、不写 etag/dirty 记账）；⑤ dispose 后响亮拒。
import { test, eq, assert } from "./runner.mjs";
import { createStore, StoreDisposedError } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { emptyCollectionBytes } from "../src/collection.ts";

function dumpKv() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    set: (k, v) => { m.set(k, String(v)); },
    remove: (k) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}
const STUB_UI = { busy: (_l, fn) => fn(), resolveConflict: async () => "cancel", reportError: () => {} };
function mkStore(provider = createMockProvider()) {
  const kv = dumpKv();
  const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui: STUB_UI,
    validateAdopt: () => true, kv, local: createMockLocal(),
    fileName: (n) => n, isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { provider, store, kv };
}

test("[peek] 云端无 json → absent；纯读零记账（kv 不长、云端不被 scaffold）", async () => {
  const { store, provider, kv } = mkStore();
  const kvBefore = kv.keys().length;
  eq(await store.collectionPeek("brush-rack"), "absent");
  eq(kv.keys().length, kvBefore, "探针不得写 etag/dirty 记账");
  eq(await provider.getItemByPath(".wp/brush-rack.json"), null, "探针不得顺手建出文件（≠scaffold）");
  await store.dispose({ drain: false });
});

test("[peek] 有 json（含空信封）→ present", async () => {
  const { store, provider } = mkStore();
  await provider.ensureFolder(".wp");
  await provider.upload(".wp/brush-rack.json", new Blob([emptyCollectionBytes()]), { contentType: "application/json" });
  eq(await store.collectionPeek("brush-rack"), "present", "空信封残库也判 present（宁不问）");
  await store.dispose({ drain: false });
});

test("[peek] provider 抛（离线/未授权）→ unknown，绝不误判 absent", async () => {
  const provider = createMockProvider();
  const origGet = provider.getItemByPath.bind(provider);
  provider.getItemByPath = async () => { throw new Error("network down"); };
  const { store } = mkStore(provider);
  eq(await store.collectionPeek("brush-rack"), "unknown");
  provider.getItemByPath = origGet;
  await store.dispose({ drain: false });
});

test("[peek] dispose 后响亮拒", async () => {
  const { store } = mkStore();
  await store.dispose({ drain: false });
  let threw = null;
  try { await store.collectionPeek("brush-rack"); } catch (e) { threw = e; }
  assert(threw instanceof StoreDisposedError, "dispose 后必须 StoreDisposedError");
});
