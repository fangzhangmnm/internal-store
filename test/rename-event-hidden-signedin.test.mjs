// 0.14.0 三件（user 2026-09-19，JRB 第三消费者切分审计）：
//   ① files.onRenamed —— 改名事件源在 store（任何入口 tryMove 成功后同步回调），图库只是前端；
//   ② 云腿「在线」= isOnline ∧ signedIn —— 未登录时本地件改名走离线 move，零网络零等待（此前 doPush 重试退避 1.2s）；
//   ③ config.hiddenName —— 宿主隐藏名不进列举帧、不进 cloud-gone 收敛，但 nameOccupied 照常看见。
// created 2026-09-19 by Claude Fable 5.1
import { describe, it, assert, eq } from "./runner.mjs";
import { memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createStore } from "../src/create-store.ts";

const bytes = (s) => new TextEncoder().encode(s);
const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => "cancel", reportError: () => {}, onReplayStatus: () => {} };
function memStaging() { const m = new Map(); return { async get(k) { return m.get(k) ?? null; }, async put(k, b) { m.set(k, b); }, async del(k) { m.delete(k); }, async keys() { return [...m.keys()]; } }; }
function mk(opts = {}) {
  const provider = createMockProvider();
  const local = createMockLocal();
  const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "test", provider, local, kv: memKv(), staging: memStaging(), ui: UI,
    validateAdopt: () => true, isOnline: () => true, signedIn: () => true, skipMigration: true, ...opts });
  return { store, provider, local };
}
const firstFrame = (store, folder = "") => new Promise((resolve) => { const off = store.files.watchFolder(folder, (s) => { resolve(s); setTimeout(off, 0); }); });

describe("0.14.0 · files.onRenamed（身份变更事件源在 store）", () => {
  it("tryMove 成功 → 同步回调 (from, to) 一次；退订后不再收；撞名 ok:false 不发", async () => {
    const { store } = mk();
    await store.file("a.txt", { isZip: false, mode: "new" }).save(bytes("A"), { tryPush: false });
    await store.file("c.txt", { isZip: false, mode: "new" }).save(bytes("C"), { tryPush: false });
    const seen = [];
    const off = store.files.onRenamed((f, t) => seen.push([f, t]));
    const r = await store.file("a.txt", { isZip: false, mode: "existing" }).tryMove("b.txt");
    assert(r.ok, "改名成功"); eq(JSON.stringify(seen), JSON.stringify([["a.txt", "b.txt"]]));
    const r2 = await store.file("b.txt", { isZip: false, mode: "existing" }).tryMove("c.txt");
    assert(!r2.ok && r2.reason === "name-collision", "撞名不改"); eq(seen.length, 1, "撞名不发事件");
    off();
    await store.file("b.txt", { isZip: false, mode: "existing" }).tryMove("d.txt");
    eq(seen.length, 1, "退订后不再收");
  });
  it("监听器抛错不污染改名结果（reportError warning）", async () => {
    let reported = 0;
    const { store } = mk({ ui: { ...UI, reportError: () => { reported++; } } });
    await store.file("a.txt", { isZip: false, mode: "new" }).save(bytes("A"), { tryPush: false });
    store.files.onRenamed(() => { throw new Error("boom"); });
    const r = await store.file("a.txt", { isZip: false, mode: "existing" }).tryMove("b.txt");
    assert(r.ok); assert(reported >= 1);
  });
});

describe("0.14.0 · 云腿在线 = isOnline ∧ signedIn（未登录 = 云不可达）", () => {
  it("未登录 + navigator 在线：本地件改名走离线 move（零网络、<300ms）", async () => {
    const { store, provider } = mk({ signedIn: () => false });
    await store.file("a.txt", { isZip: false, mode: "new" }).save(bytes("A"), { tryPush: false });
    const pushBefore = provider.calls ? provider.calls.filter((c) => c[0] === "push" || c === "push").length : null;
    const t0 = performance.now();
    const r = await store.file("a.txt", { isZip: false, mode: "existing" }).tryMove("b.txt");
    const ms = performance.now() - t0;
    assert(r.ok, "改名成功"); eq(r.where, "offline-move", "未登录 = 离线 move 分支");
    assert(ms < 300, `应零等待，实测 ${ms.toFixed(0)}ms`);
    if (pushBefore != null) eq(provider.calls.filter((c) => c[0] === "push" || c === "push").length, pushBefore, "没碰 push");
    const snap = await firstFrame(store);
    eq(snap.items.map((i) => i.path).join("|"), "b.txt");
  });
});

describe("0.14.0 · config.hiddenName（夹里有什么是 store 的事）", () => {
  it("命中的名不进帧（本地帧）；nameOccupied 照常看见；不命中的照常", async () => {
    const { store } = mk({ hiddenName: (p) => /\.part$|(^|\/)session\.json$/.test(p) });
    await store.file("a.txt", { isZip: false, mode: "new" }).save(bytes("A"), { tryPush: false });
    await store.file("b.txt.part", { isZip: false, mode: "new" }).save(bytes("half"), { tryPush: false });
    await store.file("session.json", { isZip: false, mode: "new" }).save(bytes("{}"), { tryPush: false });
    const snap = await firstFrame(store);
    eq(snap.items.map((i) => i.path).sort().join("|"), "a.txt", "半成品与遗留 json 不进帧");
    assert(await store.files.nameOccupied("b.txt.part"), "占用检查仍看见");
  });
});
