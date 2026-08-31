// Per-folder 列举 / cloud-gone / watchFolder（网盘模型，2026-07-11）——红线覆盖。
//   sync-store 引擎在 WebPaint 侧此前零 node 覆盖（audit C10）；本文件补 per-folder 路径 + 数据安全 guardrail。
// 验：
//   · listing.listFolder：只列**该夹直属**子项、子夹从 nested-local/cloud/pending 派生；**别夹 local key 绝不进本夹**（guardrail #1）。
//   · reconcile.reconcileFolder：本夹 clean 孤儿→demote；**别夹 clean 文件绝不被本次降级**（身份=path 不跨夹追踪）；dirty 孤儿留（ghost）；非 complete→no-op。
//   · watchFolder：立即本地帧 + 云端帧、snapshot.path===订阅 path、本夹写即时重画、订阅 A 绝不收到 B 的文件。
import { describe, it, assert, eq } from "./runner.mjs";
import { createListing } from "../src/listing.ts";
import { createReconcile } from "../src/reconcile.ts";
import { createPendingGone } from "../src/pending-gone.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createStore } from "../src/create-store.ts";

const CTX_ON = { signedIn: true, online: true };
const bytes = (s) => new TextEncoder().encode(s);

// ── listing.listFolder（单夹、非递归、直属 scope）───────────────────────────────────────
describe("listing.listFolder · 单夹直属 scope + 子夹派生", () => {
  function mk(cloudFolderRes, appKeys, seen = {}, dirty = new Set(), pending = []) {
    const cloud = {
      async listFolder() { return cloudFolderRes; },
      async listAll() { return { files: [], folders: [], complete: true }; },
      getETag: () => null,
    };
    const local = { async appKeys() { return appKeys; } };
    const head = { seenBase: (n) => (n in seen ? seen[n] : null), isDirtyAnywhere: (n) => dirty.has(n) };
    return createListing({ cloud, local, head, pendingFolders: () => pending });
  }

  it("只返回本夹直属文件；别夹 local key 绝不进本夹（guardrail）", async () => {
    const listing = mk(
      { files: [{ path: "A/foo", name: "A/foo", eTag: "e1", size: 3 }], folders: ["A/cloudsub"], complete: true },   // name=toName(path)（cloud-sync 契约）
      ["A/foo", "A/deep/x", "B/other"],          // A/deep/x → 子夹 A/deep；B/other → 别夹，必须不出现
      { "A/foo": "e1" },
    );
    const snap = await listing.listFolder("A", CTX_ON);
    eq(snap.path, "A");
    eq(snap.items.length, 1, "只 A/foo 一个直属文件");
    eq(snap.items[0].path, "A/foo");
    eq(snap.items[0].syncState, "synced", "本地+云同 etag → synced");
    assert(!snap.items.some((i) => i.path === "B/other"), "别夹文件绝不进列表");
    assert(snap.folders.includes("A/cloudsub"), "云端子夹");
    assert(snap.folders.includes("A/deep"), "nested local key 派生的子夹");
    assert(!snap.folders.some((f) => f.startsWith("B")), "别夹子夹不出现");
  });

  it("离线视角（cloud 不可达）→ 纯本地 union、绝不空", async () => {
    const listing = mk({ files: [], folders: [], complete: true }, ["A/foo"], {}, new Set(["A/foo"]));
    const snap = await listing.listFolder("A", { signedIn: false, online: false });
    eq(snap.complete, false, "离线 → 不权威");
    eq(snap.items.length, 1);
    eq(snap.items[0].syncState, "float", "从没 synced + dirty + 云不可达 → float");
  });

  it("根目录 folder=''：nested local + pending 都算 immediate 子夹", async () => {
    const listing = mk(
      { files: [{ path: "top", name: "top", eTag: "e", size: 1 }], folders: [], complete: true },
      ["top", "P/inside"], { top: "e" }, new Set(), ["Q"],
    );
    const snap = await listing.listFolder("", CTX_ON);
    eq(snap.items.length, 1, "只 top 一个直属文件");
    assert(snap.folders.includes("P"), "nested local → 子夹 P");
    assert(snap.folders.includes("Q"), "pending 空夹 Q");
  });
});

// ── reconcile.reconcileFolder（per-folder cloud-gone + 数据安全 guardrail）──────────────────
describe("reconcile.reconcileFolder · per-folder cloud-gone guardrail", () => {
  // grace=0：第一次 reconcileFolder 只标 candidate，第二次即动手（now-first=0≥0）——单测里不必真等 24h。
  function mk(cloudFolderRes, appKeys, seen, dirty = new Set(), online = true) {
    const cleared = [], forgot = [], trashed = [];
    const cloud = {
      async listAll() { return { files: [], folders: [], complete: true }; },
      async listFolder() { return cloudFolderRes; },
      clearState: (n) => cleared.push(n),
    };
    const local = { async appKeys() { return appKeys; }, async trash(n) { trashed.push(n); return `trash/${n}`; } };
    const head = {
      seenBase: (n) => (n in seen ? seen[n] : null),
      isDirtyAnywhere: (n) => dirty.has(n),
      forget: (n) => forgot.push(n),
    };
    const pending = createPendingGone(memKv(), 0);
    return { rec: createReconcile({ cloud, local, head, pending, now: () => 1, isOnline: () => online }), cleared, forgot, trashed, pending };
  }

  it("本夹 clean 孤儿→去抖后 send trash；别夹 clean 文件绝不被降级（不跨夹追踪）；dirty 孤儿留", async () => {
    const { rec, cleared, forgot, trashed, pending } = mk(
      { files: [{ path: "A/keep", eTag: "e" }], folders: [], complete: true },
      ["A/keep", "A/goneClean", "A/goneDirty", "B/goneClean"],
      { "A/keep": "e", "A/goneClean": "old", "A/goneDirty": "old", "B/goneClean": "old" },
      new Set(["A/goneDirty"]),
    );
    const first = await rec.reconcileFolder("A");
    eq(first.demoted.length, 0, "第一次只标 candidate、不删");
    assert(pending.isPending("A/goneClean"), "A/goneClean 标 candidate");
    assert(!pending.isPending("B/goneClean"), "★别夹 clean 文件绝不被本次标（guardrail：不列别夹 local key）");
    const { demoted } = await rec.reconcileFolder("A");   // 第二次：grace=0 → 动手
    eq(demoted.length, 1, "只降级一个");
    eq(demoted[0], "A/goneClean");
    eq(trashed.join(","), "A/goneClean", "本地 send trash");
    assert(cleared.includes("A/goneClean") && forgot.includes("A/goneClean"), "清两条 etag 轨道");
    assert(!cleared.includes("B/goneClean") && !forgot.includes("B/goneClean"), "★别夹 clean 文件绝不被降级（guardrail）");
    assert(!demoted.includes("A/goneDirty") && trashed.length === 1, "dirty 孤儿留（ghost，绝不删）");
  });

  it("这一夹没列全（complete:false）→ no-op，绝不据此判 gone", async () => {
    const { rec, cleared } = mk(
      { files: [], folders: [], complete: false },
      ["A/x"], { "A/x": "old" },
    );
    const { demoted } = await rec.reconcileFolder("A");
    eq(demoted.length, 0);
    eq(cleared.length, 0, "不权威 → 一个都不清");
  });

  it("离线 → no-op；从没 synced（seenBase=null）→ 永不碰", async () => {
    const { rec: recOff } = mk({ files: [], folders: [], complete: true }, ["A/x"], { "A/x": "e" }, new Set(), false);
    eq((await recOff.reconcileFolder("A")).demoted.length, 0, "离线 no-op");
    const { rec, cleared } = mk(
      { files: [], folders: [], complete: true },
      ["A/newLocal"], {},   // seenBase=null → 真本地新文件
    );
    eq((await rec.reconcileFolder("A")).demoted.length, 0, "从没 synced 不降级");
    eq(cleared.length, 0);
  });
});

// ── cloud-sync.listFolder（真 cloud-sync over mock provider，非递归 + .trash/.backup 跳过）──
describe("cloud-sync.listFolder · 非递归 + 顶层安全网跳过", () => {
  it("只返回直属文件+子夹；根跳过 .trash/.backup；子夹列全", async () => {
    const provider = createMockProvider();
    const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
    await cloud.push("root1", bytes("a"));
    await cloud.push("A/foo", bytes("b"));
    await cloud.push("A/sub/deep", bytes("c"));
    await provider.ensureFolder(".trash");
    await provider.ensureFolder(".backup");

    const root = await cloud.listFolder("");
    eq(root.complete, true);
    assert(root.files.some((f) => f.path === "root1"), "根直属文件");
    assert(!root.files.some((f) => f.path === "A/foo"), "非递归：不含深层文件");
    assert(root.folders.includes("A"), "子夹 A");
    assert(!root.folders.includes(".trash") && !root.folders.includes(".backup"), "顶层 .trash/.backup 跳过");

    const a = await cloud.listFolder("A");
    assert(a.files.some((f) => f.path === "A/foo"), "A 直属文件");
    assert(a.folders.includes("A/sub"), "A 的子夹");
    assert(!a.files.some((f) => f.path === "A/sub/deep"), "非递归");
  });

  it("不存在的夹 → complete:false（list 抛错被吞），绝不 throw", async () => {
    const provider = createMockProvider();
    const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n) => n });
    const r = await cloud.listFolder("nope");
    eq(r.complete, false);
    eq(r.files.length, 0);
  });
});

// ── tile 时间口径（0.11.2，user 2026-08-31 拍板方案③）：dirty 显本地时间，否则显云端时间 ─────────────
//   守：① dirty ∧ 两边都有 → 本地 updatedAt；② clean ∧ 两边都有 → 云端 lastModified（拉取刷新的本地戳不上位）；
//      ③ dirty 但本地 stat 缺 → 回落云端；④ 纯本地 → 本地；⑤ cloud-only → 云端。added by Claude Fable 5 2026-08-31
describe("listing · tile 时间口径（dirty→本地，否则云端）", () => {
  const CLOUD_T = 1_000_000, LOCAL_T = 4_000_000;
  function mkT({ dirty = false, withStat = true, hasCloud = true, hasLocal = true } = {}) {
    const cloud = {
      async listFolder() { return { files: hasCloud ? [{ path: "A/x", name: "A/x", eTag: "e1", size: 3, lastModifiedDateTime: CLOUD_T }] : [], folders: [], complete: true }; },
      async listAll() { return { files: [], folders: [], complete: true }; },
      getETag: () => null,
    };
    const local = { async appKeys() { return hasLocal ? ["A/x"] : []; }, ...(withStat ? { async stat() { return { size: 3, updatedAt: LOCAL_T }; } } : {}) };
    const head = { seenBase: () => (hasCloud && hasLocal ? "e1" : null), isDirtyAnywhere: () => dirty };
    return createListing({ cloud, local, head, pendingFolders: () => [] });
  }
  const one = async (l) => (await l.listFolder("A", CTX_ON)).items.find((i) => i.path === "A/x");

  it("① dirty ∧ 云本地都有 → 本地时间（推云失败后不再倒退）", async () => { eq((await one(mkT({ dirty: true }))).lastModified, LOCAL_T); });
  it("② clean ∧ 云本地都有 → 云端时间（只打开看过的画不显「刚刚」）", async () => { eq((await one(mkT({ dirty: false }))).lastModified, CLOUD_T); });
  it("③ dirty 但本地 stat 缺（老 mock）→ 回落云端", async () => { eq((await one(mkT({ dirty: true, withStat: false }))).lastModified, CLOUD_T); });
  it("④ 纯本地（无云）→ 本地时间", async () => { eq((await one(mkT({ hasCloud: false }))).lastModified, LOCAL_T); });
  it("⑤ cloud-only（无本地）→ 云端时间", async () => { eq((await one(mkT({ hasLocal: false, withStat: false }))).lastModified, CLOUD_T); });
});

// ── watchFolder（真 createStore + mock；两帧节律 + path 契约 + 本夹写即时重画 + 夹隔离）────────
describe("watchFolder · 网盘模型集成", () => {
  function mkStore({ online = true, signedIn = true } = {}) {
    const errors = [];
    const local = createMockLocal();
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test",
      provider: createMockProvider(),
      ui: { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: (e) => errors.push(e) },
      validateAdopt: () => true,
      kv: memKv(), local,
      isOnline: () => online, signedIn: () => signedIn,
      skipMigration: true,
    });
    return { store, errors, local };
  }
  const raw = (store, name) => store.file(name, { isZip: false });

  it("订阅立即回本地帧、snapshot.path===订阅 path、绝不空/throw", async () => {
    const { store } = mkStore({ online: false });   // 离线：只走本地帧，不碰云
    await raw(store, "A/foo").save(bytes("x"), { tryPush: false });
    const snaps = [];
    const unsub = await new Promise((resolve) => {
      const u = store.files.watchFolder("A", (s) => { snaps.push(s); if (snaps.length === 1) resolve(u); });
    });
    assert(snaps.length >= 1, "至少一帧");
    eq(snaps[0].path, "A", "snapshot 带订阅 path");
    assert(snaps[0].items.some((i) => i.path === "A/foo"), "本地文件即在首帧");
    unsub();
  });

  it("本夹保存 → watcher 即时重画（notifyFolderOf）", async () => {
    const { store } = mkStore({ online: false });
    let last = null, calls = 0;
    const unsub = store.files.watchFolder("A", (s) => { last = s; calls++; });
    await new Promise((r) => setTimeout(r, 5));   // 放过订阅两帧
    const before = calls;
    await raw(store, "A/bar").save(bytes("y"), { tryPush: false });
    await new Promise((r) => setTimeout(r, 5));
    assert(calls > before, "保存后 cb 再次触发");
    assert(last.items.some((i) => i.path === "A/bar"), "新文件反映进快照");
    unsub();
  });

  it("订阅 A 绝不收到 B 的文件（夹隔离）", async () => {
    const { store } = mkStore({ online: false });
    await raw(store, "A/inA").save(bytes("a"), { tryPush: false });
    await raw(store, "B/inB").save(bytes("b"), { tryPush: false });
    let last = null;
    const unsub = store.files.watchFolder("A", (s) => { last = s; });
    await new Promise((r) => setTimeout(r, 5));
    assert(last.items.some((i) => i.path === "A/inA"), "A 的文件在");
    assert(!last.items.some((i) => i.path === "B/inB"), "★B 的文件绝不出现在 A 的快照");
    unsub();
  });

  it("unsubscribe 后不再收帧", async () => {
    const { store } = mkStore({ online: false });
    let calls = 0;
    const unsub = store.files.watchFolder("A", () => { calls++; });
    await new Promise((r) => setTimeout(r, 5));
    unsub();
    const after = calls;
    await raw(store, "A/z").save(bytes("z"), { tryPush: false });
    await new Promise((r) => setTimeout(r, 5));
    eq(calls, after, "退订后写入不再回调");
  });
});

// ── 目标名占用护栏（碰撞检查内化进 tryMove / mode:"new"，替代「app 先 list 目标夹」；防覆盖既有=data-loss）──
describe("改身份/新建 的目标占用护栏", () => {
  function mkStore() {
    const local = createMockLocal();
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test",
      provider: createMockProvider(),
      ui: { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} },
      validateAdopt: () => true, kv: memKv(), local,
      isOnline: () => false, signedIn: () => false, skipMigration: true,   // 离线：只验本地占用护栏
    });
    return { store, local };
  }
  const raw = (store, name) => store.file(name, { isZip: false });
  const dec = (u) => new TextDecoder().decode(u);

  // 承接原「saveAs 到已存在名」用例：saveAs 已删，写新身份统一走 file(name,{mode:"new"}).save()。
  //   红线不变——撞名绝不静默覆盖既有字节。
  it("mode:\"new\" 存到已存在名 → 抛 collision（旧的不动、新的不覆盖）", async () => {
    const { store, local } = mkStore();
    await raw(store, "keep").save(bytes("K"), { tryPush: false });
    let err = null;
    try { await store.file("keep", { isZip: false, mode: "new" }).save(bytes("NEW"), { tryPush: false }); } catch (e) { err = e; }
    assert(err && err.name === "CloudNameCollisionError", "撞名抛 collision");
    eq(dec(local._items.get("keep")), "K", "★既有不被覆盖");
  });

  it("mode:\"new\" 存到空名 → 正常落盘（护栏不误伤新建）", async () => {
    const { store, local } = mkStore();
    await store.file("fresh", { isZip: false, mode: "new" }).save(bytes("F"), { tryPush: false });
    eq(dec(local._items.get("fresh")), "F", "新身份写入成功");
  });

  it("store.tryMove：占用→{ok:false,where}（不动字节，防覆盖 data-loss）；空→{ok:true}（移动生效、字节随身份）", async () => {
    const { store, local } = mkStore();
    await raw(store, "A/keep").save(bytes("KEEP"), { tryPush: false });
    await raw(store, "A/src").save(bytes("SRC"), { tryPush: false });
    const bad = await store.file("A/src", { isZip: false, mode: "existing" }).tryMove("A/keep");
    assert(bad.ok === false && bad.reason === "name-collision" && bad.where === "local", "占用 → 结果式返错（不抛）");
    assert(local._items.has("A/src"), "不动字节：src 仍在");
    eq(dec(local._items.get("A/keep")), "KEEP", "★既有 keep 绝不被源覆盖（data-loss 防线）");
    const ok = await store.file("A/src", { isZip: false, mode: "existing" }).tryMove("B/dst");
    assert(ok.ok === true, "空 → ok");
    assert(!local._items.has("A/src") && local._items.has("B/dst"), "移动生效");
    eq(dec(local._items.get("B/dst")), "SRC", "字节随身份走");
  });

  it("store.files.nameOccupied：占用→true、无→false（boolean）", async () => {
    const { store } = mkStore();
    await raw(store, "x").save(bytes("X"), { tryPush: false });
    eq(await store.files.nameOccupied("x"), true);
    eq(await store.files.nameOccupied("nope"), false);
  });
});

// ── 离线 move = 删 old + 建 new（决策 1A 独立收敛 / 决策 2 在线保持服务端原子）───────────────────
describe("离线 move（删+建，tag 走法）", () => {
  function mkMoveStore() {
    const local = createMockLocal();
    const provider = createMockProvider();
    let online = true;
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test",
      provider, local, kv: memKv(),
      ui: { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {}, onReplayStatus: () => {} },
      validateAdopt: () => true, isOnline: () => online, signedIn: () => online,
      offlineUploadReplay: "auto", skipMigration: true,   // auto：证补推链路（WebPaint 实际 manual=等显式推）
    });
    return { store, local, provider, setOnline: (v) => { online = v; } };
  }
  const raw = (store, n) => store.file(n, { isZip: false });
  const dec = (u) => new TextDecoder().decode(u);
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("离线 move synced 文件 → old 本地move-aside+云删排队、new 本地float；重连独立收敛（决策1A）", async () => {
    const { store, local, provider, setOnline } = mkMoveStore();
    await raw(store, "old").save(bytes("OLD"), { tryPush: true });          // 在线 synced
    assert(await provider.getItemByPath("old"), "云端有 old");

    setOnline(false);
    const mv = await store.file("old", { isZip: false, mode: "existing" }).tryMove("new");   // 离线 move（唯一入口）
    assert(mv.ok === true, "离线 move 成功");

    // 本地：new 有、old 进本地 .trash（move-aside，绝不 hardDelete）
    assert(local._items.has("new") && !local._items.has("old"), "本地 new 有 old 无");
    assert([...local._trash.values()].some((t) => t.name === "old"), "old 进本地 .trash（可恢复）");
    eq(dec(local._items.get("new")), "OLD", "new 承载 old 的字节");

    // new 的 syncState = 本地未推（float：never-synced ∧ dirty）
    let snap = null; const un = store.files.watchFolder("", (s) => { snap = s; }); await tick(); un();
    const ni = snap.items.find((i) => i.path === "new");
    assert(ni && (ni.syncState === "float" || ni.syncState === "unpushed"), `new 本地未推（实=${ni && ni.syncState}）`);

    // 重连：两侧各自排队独立收敛（决策 1A）。drainOfflineQueue 统一按序：新夹→新上传→删文件。
    setOnline(true);
    await store.files.drainOfflineQueue();
    assert(await provider.getItemByPath("new"), "云端有 new（补推落地）");
    assert(!(await provider.getItemByPath("old")), "云端 old 没了（进 .trash）");
  });

  it("离线 move 后重连、目标云端撞名 → new 撞名不落云、字节留本地 dirty；old 删除独立照走", async () => {
    const { store, local, provider, setOnline } = mkMoveStore();
    await provider.upload("new", bytes("OCCUPIED-DIFFERENT-BYTES"));         // 目标已被别的文件占（云端、本地不知）
    await raw(store, "old").save(bytes("OLD"), { tryPush: true });           // 在线 synced

    setOnline(false);
    const mv = await store.file("old", { isZip: false, mode: "existing" }).tryMove("new");   // 离线：只查本地占用（无）→ 放行
    assert(mv.ok === true, "离线 move 放行（云端占用离线看不到）");
    eq(dec(local._items.get("new")), "OLD", "本地 new = 我方字节");

    setOnline(true);
    await store.files.drainOfflineQueue();                                   // 统一：推 new→conflictBehavior:fail 撞名出队 surface + old 云删独立照走
    eq(dec(local._items.get("new")), "OLD", "★撞名后 new 字节仍在本地（dirty 不丢）");
    const cloudNew = await provider.getItemByPath("new");
    assert(cloudNew && cloudNew.size !== bytes("OLD").length, "云端 new 仍是占位文件（我方没盲覆盖）");
    assert(!(await provider.getItemByPath("old")), "old 删除独立照走（决策1A）");
  });
});

// ── 离线删文件夹队列（deleteEmptyFolder 护栏 + drainOfflineQueue 第 4 步；safety agent 论证过）─────
describe("离线删文件夹（排队/隐藏/回线删/content-wins/eager-cancel）", () => {
  function mk() {
    const local = createMockLocal();
    const provider = createMockProvider();
    const kv = memKv();
    let online = true;
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test", provider, local, kv,
      ui: { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {}, onReplayStatus: () => {} },
      validateAdopt: () => true, isOnline: () => online, signedIn: () => online, skipMigration: true,
    });
    return { store, provider, kv, setOnline: (v) => { online = v; } };
  }
  const tick = () => new Promise((r) => setTimeout(r, 5));

  it("离线删已上云空夹 → 排队+listing 隐藏；回线 drainOfflineQueue → 云端删掉", async () => {
    const { store, provider, setOnline } = mk();
    await store.files.ensureFolder("F");
    assert(await provider.getItemByPath("F"), "云端建了 F");
    setOnline(false);
    await store.files.deleteFolder("F");
    assert(await provider.getItemByPath("F"), "离线：云端 F 还在（只排队，不删）");
    setOnline(true);
    let snap = null; const un = store.files.watchFolder("", (s) => { snap = s; }); await tick(); await tick(); un();
    assert(snap && !snap.folders.includes("F"), "未 drain 时 listing 已隐藏 F（post-union 减去待删）");
    await store.files.drainOfflineQueue();
    assert(!(await provider.getItemByPath("F")), "drain → 云端 F 删掉");
  });

  it("离线删夹后别端往夹加内容 → 回线 drain 取消删除（content wins，非空不删）", async () => {
    const { store, provider, setOnline } = mk();
    await store.files.ensureFolder("F");
    setOnline(false);
    await store.files.deleteFolder("F");
    await provider.upload("F/fromOther.ora", bytes("O"));   // 别端往 F 加内容（直接写云）
    setOnline(true);
    await store.files.drainOfflineQueue();
    assert(await provider.getItemByPath("F"), "F 还在（非空 → 取消删除）");
    assert(await provider.getItemByPath("F/fromOther.ora"), "别端内容没被递归删");
  });

  it("嵌套夹排队 → drain **深→浅**（先删子后删父，否则父恒非空、永远删不掉）", async () => {
    const { store, provider, kv, setOnline } = mk();
    await store.files.ensureFolder("P/C/G");            // 三层
    setOnline(false);
    // 故意**按浅→深**的顺序排队，逼 drain 自己去排序（不能靠调用方的顺序）
    await store.files.deleteFolder("P/C/G");
    await store.files.deleteFolder("P/C");
    await store.files.deleteFolder("P");
    // 队列是持久化的 kv 记录（离线跨重启也要活）
    const q = JSON.parse(kv.get("test.defaultStore.internal.pending_folder_deletions"));
    eq(q.length, 3, "三层都排了队");
    setOnline(true);
    await store.files.drainOfflineQueue();
    assert(!(await provider.getItemByPath("P/C/G")), "最深的删了");
    assert(!(await provider.getItemByPath("P/C")), "中间的删了");
    assert(!(await provider.getItemByPath("P")), "★父夹也删了——drain 若不按深→浅，父恒非空、永远删不掉");
  });

  it("eager-cancel：离线删 X 后在 X 下建文件 → drain 不删 X（撤销排队删除）", async () => {
    const { store, provider, setOnline } = mk();
    await store.files.ensureFolder("X");
    setOnline(false);
    await store.files.deleteFolder("X");
    await store.file("X/foo", { isZip: false, mode: "new" }).save(bytes("F"), { tryPush: false });   // X 下建文件 → eager-cancel
    setOnline(true);
    await store.files.drainOfflineQueue();
    assert(await provider.getItemByPath("X"), "eager-cancel：X 删除被撤销，X 还在");
  });
});

// ── 打开纯云端未缓存文件：OneDrive 不可达时必须能「跳到离线」──────────────────────────────
describe("open 纯云端项 · offlineEscape 出口", () => {
  it("provider 挂死 + 用户点跳到离线 → open 返回（不永久卡住），且绝不假装成功", async () => {
    const provider = createMockProvider();
    let onSkip;
    const probe = new Promise((res) => { onSkip = () => res(undefined); });
    // 云端有这个文件，但 download 永不 resolve（模拟「在线但 OneDrive 不可达」）
    provider._seed("cloudonly", new TextEncoder().encode("REMOTE"));
    provider.download = () => new Promise(() => {});
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test", provider,
      ui: {
        busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {},
        offlineEscape: () => ({ probe, settle: () => {} }),
      },
      validateAdopt: () => true, kv: memKv(), local: createMockLocal(),
      isOnline: () => true, signedIn: () => true, skipMigration: true,
    });
    const opened = store.file("cloudonly", { isZip: false, mode: "existing" }).open();
    onSkip();                                   // 用户点「跳到离线」
    const bytes = await opened;                 // ★关键：这里必须能 resolve（旧代码永远挂着）
    eq(bytes, null, "本地本来就没有 → 诚实返回 null，绝不假装打开成功");
  });
});

// ── watchFolder opts.onError（0.11.1，user 2026-08-31 批准 S1；案发：iPad 长画锁屏后图库停在 loading 空白）────
//   守：① 本地帧产不出 → onError(err,"local") 且仍 ui.reportError；② 首帧成功、远端合帧失败 → onError(err,"remote")；
//      ③ 不传 onError = 旧行为（只 reportError，不 throw）；④ 退订后不再收 onError。
//   added by Claude Fable 5 2026-08-31
describe("watchFolder · opts.onError 帧失败信号（0.11.1）", () => {
  function mkFailingStore({ failAppKeysOnCall, online = false, signedIn = false } = {}) {
    const errors = [];
    const base = createMockLocal();
    let calls = 0;
    const local = new Proxy(base, {
      get(t, k) {
        if (k === "appKeys") return async (...a) => { calls++; if (failAppKeysOnCall(calls)) throw new Error(`idb appKeys wedged (call ${calls})`); return t.appKeys(...a); };
        return t[k];
      },
    });
    const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "test", provider: createMockProvider(),
      ui: { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: (e) => errors.push(e) },
      validateAdopt: () => true, kv: memKv(), local,
      isOnline: () => online, signedIn: () => signedIn, skipMigration: true,
    });
    return { store, errors };
  }
  const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));

  it("本地帧产不出 → onError(err,'local')，且 ui.reportError 照旧", async () => {
    const { store, errors } = mkFailingStore({ failAppKeysOnCall: () => true });
    const frames = [], errs = [];
    const unsub = store.files.watchFolder("A", (s) => frames.push(s), { onError: (e, phase) => errs.push([String(e), phase]) });
    await tick();
    eq(frames.length, 0, "没有帧");
    assert(errs.length >= 1, "订阅者收到失败信号");
    eq(errs[0][1], "local", "phase=local");
    assert(errs[0][0].includes("wedged"), "原错误透传");
    assert(errors.length >= 1, "ui.reportError 仍上报（横幅不退役）");
    unsub();
  });

  it("首帧成功、远端合帧失败 → onError(err,'remote')；首帧已到手", async () => {
    // call1 = 本地帧 appKeys（成功）；call2 = 远端阶段 listFolder 内 appKeys（失败）
    const { store } = mkFailingStore({ failAppKeysOnCall: (n) => n >= 2, online: true, signedIn: true });
    const frames = [], errs = [];
    const unsub = store.files.watchFolder("A", (s) => frames.push(s), { onError: (e, phase) => errs.push(phase) });
    await tick(20);
    assert(frames.length >= 1, "本地首帧照常到");
    assert(errs.includes("remote"), "远端合帧失败 → phase=remote");
    unsub();
  });

  it("不传 onError = 旧行为：只 reportError、不 throw、不炸订阅", async () => {
    const { store, errors } = mkFailingStore({ failAppKeysOnCall: () => true });
    let threw = false;
    try { const u = store.files.watchFolder("A", () => {}); await tick(); u(); } catch { threw = true; }
    assert(!threw, "无 onError 也不抛");
    assert(errors.length >= 1, "仍 reportError");
  });

  it("退订后不再收到 onError（边表随 watcher 散）", async () => {
    // 订阅期两帧全部放行；退订**之后**才让 appKeys 失败，再用本夹写触发 pushLocalFrame——已退订，不该收到
    const ctl = { fail: false };
    const { store } = mkFailingStore({ failAppKeysOnCall: () => ctl.fail });
    const errs = [];
    const unsub = store.files.watchFolder("A", () => {}, { onError: (_e, p) => errs.push(p) });
    await tick(20);
    eq(errs.length, 0, "订阅期两帧正常，零信号");
    unsub();
    ctl.fail = true;
    await store.file("A/x", { isZip: false }).save(bytes("x"), { tryPush: false });
    await tick();
    eq(errs.length, 0, "退订后零信号");
  });
});
