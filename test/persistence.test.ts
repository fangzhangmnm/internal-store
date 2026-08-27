// persist 三件套契约测试（user 2026-08-27 拍板；全案 = src/persistence.ts 头注释）。
// created 2026-08-27 by Claude Fable 5 (claude-fable-5)
import { test, eq, assert } from "./runner.mjs";
import { queryStoragePersistence, requestStoragePersistence } from "../src/persistence.ts";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

test("[persist] queryStoragePersistence：纯查询三态（persisted true/false/环境缺失），异常诚实降级不谎报", async () => {
  eq((await queryStoragePersistence({ persisted: async () => true })).persisted, true);
  eq((await queryStoragePersistence({ persisted: async () => false })).persisted, false);
  eq((await queryStoragePersistence(null)).supported, false, "node/无 StorageManager → supported:false");
  const boom = await queryStoragePersistence({ persisted: async () => { throw new Error("x"); } });
  eq(`${boom.supported}/${boom.persisted}`, "false/false", "查询炸了 → 不谎报已持久");
});

test("[persist] requestStoragePersistence：已持久→granted 不重复调；persist true/false→granted/denied；缺环境/异常→unsupported", async () => {
  let persistCalls = 0;
  eq(await requestStoragePersistence({ persisted: async () => true, persist: async () => { persistCalls++; return true; } }), "granted");
  eq(persistCalls, 0, "已持久绝不重复调 persist()（Firefox 弹窗只许手势时刻、且不重复打扰）");
  eq(await requestStoragePersistence({ persisted: async () => false, persist: async () => true }), "granted");
  eq(await requestStoragePersistence({ persisted: async () => false, persist: async () => false }), "denied");
  eq(await requestStoragePersistence(null), "unsupported");
  eq(await requestStoragePersistence({ persist: async () => { throw new Error("x"); } }), "unsupported");
});

test("[persist] StoreConfig.persistence 必填表态：缺失 → createStore throw（编译期+运行时双门）；files.persistence() 感知面在", async () => {
  const mk = (persistence?: unknown) => createStore({
    ...(persistence != null ? { persistence } : {}),
    appId: "wp", provider: createMockProvider(),
    ui: { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => "cancel", reportError: () => {} },
    validateAdopt: () => true, kv: { get: () => null, set: () => {}, remove: () => {} },
    local: createMockLocal(), fileName: (n: string) => n, skipMigration: true,
  } as never);
  try { mk(); assert(false, "缺 persistence 必须抛"); }
  catch (e) { assert(String((e as Error).message).includes("persistence 必填"), (e as Error).message); }
  const store = mk("none");
  const st = await store.files.persistence();
  eq(`${st.supported}/${st.persisted}`, "false/false", "node 无 StorageManager → 诚实 unsupported（感知面永远可调）");
});
