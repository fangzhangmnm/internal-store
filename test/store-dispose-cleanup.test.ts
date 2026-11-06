// 2.2.7：dispose 的两个缺口（家族周账 F-199；发版说明 ai-docs/20261105-2.2.7-dispose-closes-collections-and-inflight-frames.md）。
//   ① 每份 collection 排着的本地写定时器到点撞上已关的 IDB → 给用户冒一条英文警告（CatsUp 开机拆空库每次都中）。
//   ② 在飞的目录帧读到一半撞上关掉的 IDB → 红色英文 + 叫 app 的 onError 把列表画成「读取失败」。
//   同时钉住「诚实」这一头：释放**之前**的真失败、drain 那一笔真落不下去，照常响亮；取消的云推靠脏账下次开库补上，改动不丢。
// created 20261105 by Claude Opus 5.5
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createCollection, type CollectionLifecycle } from "../src/works/collection.ts";
import { setStoreErrorReporter } from "../src/base/error-handling.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal, createMockLocalBacking, type MockLocalBacking } from "../src/testing/mock-local.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
function deferred<T = void>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
async function until(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) { if (cond()) return; await sleep(5); }
  throw new Error(`等不到：${what}`);
}

type Report = { level: string; msg: string };
const loud = (rs: Report[]): string => JSON.stringify(rs.filter((r) => r.level === "warning" || r.level === "error"));

function dumpKv() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => (m.has(k) ? m.get(k)! : null),
    set: (k: string, v: string) => { m.set(k, String(v)); },
    remove: (k: string) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}

/** 真 IDB 层的形状（idb-store.ts）：close() 之后每个方法 reject「idb cache closed (disposed)」。hold = 把读卡住，造「帧读到一半」。 */
function closableLocal(backing?: MockLocalBacking) {
  const inner = createMockLocal(backing ? { backing } : {});
  let closed = false;
  let hold: Promise<void> | null = null;
  let heldCalls = 0;
  const proxied = new Proxy(inner as unknown as Record<string, unknown>, {
    get(t, k) {
      if (k === "close") return () => { closed = true; };
      const v = t[k as string];
      if (typeof v !== "function") return v;
      return async (...a: unknown[]) => {
        if (hold) { heldCalls++; await hold; }
        if (closed) throw new Error("idb cache closed (disposed): test");
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
  return { local: proxied as never, inner, holdUntil: (p: Promise<void>) => { hold = p; }, heldCalls: () => heldCalls, release: () => { hold = null; } };
}

function mk(o: { provider?: ReturnType<typeof createMockProvider>; kv?: ReturnType<typeof dumpKv>; backing?: MockLocalBacking } = {}) {
  const reports: Report[] = [];
  const ui = { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => "cancel",
    reportError: (e: unknown, level: string = "error") => { reports.push({ level, msg: String((e as Error)?.message ?? e) }); } };
  const provider = o.provider ?? createMockProvider();
  const kv = o.kv ?? dumpKv();
  const cl = closableLocal(o.backing);
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui: ui as never, validateAdopt: () => true, kv, local: cl.local,
    isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { store, provider, kv, reports, ...cl };
}
const textOf = (b: unknown): string => new TextDecoder().decode(b as Uint8Array);
async function cloudText(provider: ReturnType<typeof createMockProvider>, path: string): Promise<string | null> {
  const item = await provider.getItemByPath(path);
  if (!item) return null;
  return (await provider.download(item.ref ?? item.id, { path })).text();
}

// ── ① 排着的本地写 ─────────────────────────────────────────────────────────────────────────
test("[dispose-cleanup] 排着的本地写：dispose 先落盘再关，到点不撞已关的 IDB、不冒警告", async () => {
  const h = mk();
  const coll = h.store.collection("app-state");
  await coll.init();
  coll.setItem("k", { v: 1 });          // 排了 400 ms 的本地写
  await h.store.dispose();
  await sleep(500);                     // 过了原来定时器到点的时刻
  eq(loud(h.reports), "[]", "释放后不许有 warning / error");
  const bytes = h.inner._items.get("collections/app-state");
  assert(bytes, "排着的那笔落了盘（第 2 条：没落盘的改动不丢）");
  assert(textOf(bytes).includes('"k"'), "落盘的是带这次改动的那份");
});

test("[dispose-cleanup] 云推被取消不丢改动：脏账 + 本地字节 → 下次开库补推", async () => {
  const provider = createMockProvider(); const kv = dumpKv(); const backing = createMockLocalBacking();
  const a = mk({ provider, kv, backing });
  const c1 = a.store.collection("app-state");
  await c1.init();
  await sleep(30);                      // init 的后台对齐走完，下面只看这次改动
  c1.setItem("k", { v: 4242 });
  await a.store.dispose();
  assert(!(await cloudText(provider, ".wp/app-state.json") ?? "").includes("4242"), "前提：释放时这次改动还没上云");

  const b = mk({ provider, kv, backing });
  const c2 = b.store.collection("app-state");
  await c2.init();
  eq((c2.getItem("k") as { v: number }).v, 4242, "重开先从本地读回");
  await until(() => !c2.isDirty(), "补推收尾清脏");
  assert((await cloudText(provider, ".wp/app-state.json") ?? "").includes("4242"), "云端补上了这次改动");
  await b.store.dispose();
});

test("[dispose-cleanup] drain:false：只取消，到点不撞墙、不冒警告；扔掉的那笔进黑匣子", async () => {
  const h = mk();
  const coll = h.store.collection("app-state");
  await coll.init();
  coll.setItem("k", { v: 1 });
  await h.store.dispose({ drain: false });
  await sleep(500);
  eq(loud(h.reports), "[]", "快速拆除不许有 warning / error");
  assert(h.reports.some((r) => r.level === "log" && r.msg.includes("dropped")), "扔掉一笔要留记录（不静默）");
});

// ── ② 在飞的目录帧 ─────────────────────────────────────────────────────────────────────────
test("[dispose-cleanup] 本地帧读到一半撞上释放：不投帧、不叫 onError、只进黑匣子", async () => {
  const h = mk();
  const gate = deferred();
  h.holdUntil(gate.promise);
  const frames: unknown[] = []; const errs: string[] = [];
  h.store.files.watchFolder("", (s: unknown) => frames.push(s), { onError: (_e: unknown, phase: string) => errs.push(phase) });
  await until(() => h.heldCalls() > 0, "帧读进了本地");
  await h.store.dispose();
  h.release(); gate.resolve();          // 放行 = 撞上关掉的 IDB，全部 reject
  await sleep(30);
  eq(loud(h.reports), "[]", "释放后的帧不许有 warning / error");
  eq(errs.length, 0, "不叫 app 把列表画成「读取失败」");
  eq(frames.length, 0, "不投帧");
  assert(h.reports.some((r) => r.level === "log" && r.msg.includes("closed (disposed)")), "撞墙的错进了黑匣子（不吞）");
});

test("[dispose-cleanup] 云端帧在飞撞上释放：不投第二帧、不写目录索引缓存、不再碰本地", async () => {
  const provider = createMockProvider();
  const gate = deferred();
  const origList = provider.list.bind(provider);
  provider.list = (async (...a: Parameters<typeof origList>) => { await gate.promise; return origList(...a); }) as typeof provider.list;
  const h = mk({ provider });
  const frames: unknown[] = []; const errs: string[] = [];
  h.store.files.watchFolder("", (s: unknown) => frames.push(s), { onError: (_e: unknown, phase: string) => errs.push(phase) });
  await until(() => frames.length === 1, "本地帧先到");
  await h.store.dispose();
  gate.resolve();
  await sleep(30);
  eq(frames.length, 1, "释放后不再投帧");
  eq(errs.length, 0, "不叫 onError");
  eq(h.inner._dirIndex.size, 0, "拆了的库上不写目录索引缓存");
  eq(loud(h.reports), "[]", "不许有 warning / error");
});

test("[dispose-cleanup] 对照：释放之前帧读失败，照常 error + onError（诚实这头没松）", async () => {
  const h = mk();
  h.inner.appKeys = async () => { throw new Error("disk gone"); };
  const errs: string[] = [];
  h.store.files.watchFolder("", () => {}, { onError: (_e: unknown, phase: string) => errs.push(phase) });
  await until(() => errs.length > 0, "onError 被叫");
  assert(h.reports.some((r) => r.level === "error" && r.msg === "disk gone"), "未释放时读失败 = error 级");
  await h.store.dispose({ drain: false });
});

// ── collection 单元 ────────────────────────────────────────────────────────────────────────
function mockCloud() {
  const dirty = new Map<string, boolean>(); const etags = new Map<string, string>();
  return {
    pulls: 0, pushes: 0,
    pull: async function (this: { pulls: number }) { this.pulls++; return null; },
    push: async function (this: { pushes: number }) { this.pushes++; return { item: { eTag: "e" + this.pushes } }; },
    fetchMeta: async () => null,
    setDirty: (n: string, v: boolean) => { dirty.set(n, v); },
    isDirty: (n: string) => !!dirty.get(n),
    setETag: (n: string, v: string) => { etags.set(n, v); },
    getETag: (n: string) => etags.get(n) ?? null,
  };
}
function unit(o: { save?: () => Promise<void>; exists?: () => Promise<boolean>; getInitData?: () => { id: string; value: unknown }[] } = {}) {
  const reports: Report[] = [];
  setStoreErrorReporter((e, level) => { reports.push({ level, msg: String((e as Error)?.message ?? e) }); });
  const saves: string[] = [];
  const local = { exists: o.exists ?? (async () => false), get: async () => null,
    save: async (k: string) => { saves.push(k); await o.save?.(); } };
  let handle!: CollectionLifecycle;
  const cloud = mockCloud();
  const c = createCollection({ cloud: cloud as never, name: "c", local: local as never, localWriteDelayMs: 10, syncDelayMs: 10, now: () => 1000,
    getInitData: o.getInitData, lifecycle: (h) => { handle = h; } });
  return { c, cloud, saves, reports, close: (flush: boolean) => handle.close({ flush }) };
}

test("[collection.close] flush：立刻写一次；之后定时器都没了（不再写、不再推）；flushLocal 返 ok:false 不上报", async () => {
  const u = unit();
  await u.c.init();
  await sleep(25);                      // init 的后台对齐和它排的本地写走完
  u.saves.length = 0;
  const pushes = u.cloud.pushes;
  u.c.setItem("a", 1);
  await u.close(true);
  eq(u.saves.length, 1, "close 里立刻写了一次");
  await sleep(30);
  eq(u.saves.length, 1, "没有第二次本地写");
  eq(u.cloud.pushes, pushes, "云推定时器也取消了");
  const r = await u.c.flushLocal();
  eq(r.ok, false, "关了以后 flushLocal 说实话");
  eq(u.saves.length, 1, "也不再写");
  eq(u.reports.length, 0, "不上报");
});

test("[collection.close] flush：等在飞的那笔写完才算关", async () => {
  const gate = deferred();
  const u = unit({ save: () => gate.promise });
  await u.c.init();
  u.c.setItem("a", 1);
  await until(() => u.saves.length >= 1, "写进了在飞");
  let done = false;
  void u.close(true).then(() => { done = true; });
  await sleep(10);
  eq(done, false, "在飞的没完不能算关（马上要断 IDB 连接）");
  gate.resolve();
  await until(() => done, "写完就关");
});

test("[collection.close] flush 真落不下去：照常 warning（诚实这头没松）", async () => {
  const u = unit({ save: async () => { throw new Error("quota"); } });
  await u.c.init();
  await sleep(25);
  u.reports.length = 0;
  u.c.setItem("a", 1);
  await u.close(true);
  assert(u.reports.some((r) => r.level === "warning" && r.msg === "quota"), `真失败要响亮：${JSON.stringify(u.reports)}`);
});

test("[collection.close] 不 flush：卡住的写不拖住拆除；撞墙的错只进黑匣子", async () => {
  const gate = deferred();
  const u = unit({ save: () => gate.promise });
  await u.c.init();
  u.c.setItem("a", 1);
  await until(() => u.saves.length >= 1, "写进了在飞、卡住");
  const raced = await Promise.race([u.close(false).then(() => "closed"), sleep(50).then(() => "hung")]);
  eq(raced, "closed", "快速拆除一步也不等");
  gate.reject(new Error("idb cache closed (disposed): test"));
  await sleep(5);
  eq(loud(u.reports), "[]", "快速拆除要的结果，不是用户的事");
  assert(u.reports.some((r) => r.level === "log"), "但进黑匣子，不吞");
});

test("[collection.close] 开库走到一半撞上释放：不种初始值、不标脏、不打网", async () => {
  const gate = deferred<boolean>();
  let seeded = 0;
  const u = unit({ exists: () => gate.promise, getInitData: () => { seeded++; return [{ id: "x", value: 1 }]; } });
  const opening = u.c.init();
  await u.close(true);
  gate.resolve(false);                  // hydrate 回来说「本地没有」——释放后这句不可信，不许据此当新库
  await opening;
  await sleep(25);
  eq(seeded, 0, "不种初始值");
  eq(u.c.isDirty(), false, "拆掉的库上不留脏标记");
  eq(u.cloud.pulls + u.cloud.pushes, 0, "不打网");
  eq(u.saves.length, 0, "不写本地");
});
