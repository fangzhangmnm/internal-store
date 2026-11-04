// collection-offline —— collection 也吃 store 的 isOnline（2.2.4，家族周账 F-100 / 工单 D 查出，2026-11-03）。
// created 2026-11-03 by Claude Fable 5.1
// 以前 create-store 的 collection 工厂没把 isOnline 递给 createCollection → 宿主选了「离线继续」（isOnline 返 false）之后，
//   改偏好 / 阅读位置的 reconcile 仍会 fetchMeta / push。「离线一条网都不打」要对 file 和 collection 同时成立。
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

function kvRaw() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] };
}
function rig(online: boolean) {
  const ops: string[] = [];
  const provider = createMockProvider({ hook: (op) => { ops.push(op); } });
  const local = createMockLocal();
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => "cancel", reportError: () => {} } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => online, signedIn: () => true, skipMigration: true });
  return { ops, store };
}

test("[collection-offline] isOnline=false：建 collection、改值、flushLocal、reconcileWithRemote → 云端一个 op 都没有、状态 offline、本地照写", async () => {
  const r = rig(false);
  const c = r.store.collection("prefs");
  await c.init();
  r.ops.length = 0;                              // 只数建完 collection 之后的
  c.setItem("theme", "dark");
  const fl = await c.flushLocal();
  eq(fl.ok, true, "本地照写");
  const rr = await c.reconcileWithRemote();
  eq(rr.status, "offline", "reconcile 报 offline，不假装同步");
  eq(r.ops.length, 0, "云端零请求（以前这里会 fetchMeta / push）：" + r.ops.join(","));
  eq(c.getEntry("theme")?.value, "dark", "值在本地");
});

test("[collection-offline] 对照：isOnline=true 时同一套动作会碰云端（证明谓词真在起作用）", async () => {
  const r = rig(true);
  const c = r.store.collection("prefs");
  await c.init();
  r.ops.length = 0;
  c.setItem("theme", "dark");
  await c.flushLocal();
  const rr = await c.reconcileWithRemote();
  assert(rr.status !== "offline", "在线不该报 offline（实际：" + rr.status + "）");
  assert(r.ops.length > 0, "在线时 reconcile 碰了云端");
});
