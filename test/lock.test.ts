// 2.3.0 锁：作品默认只读、手动解锁才能改（家族「源文件原则上只读」，user 2026-11-08）。created 2026-11-08 by Claude Fable 5.1
//   「默认的文件你根本不能编辑，一编辑就报错，一保存就报错…得手动的解锁才行」「解锁肯定是每个作品单独解锁，过期的话，我觉得就用一天吧」
//   「只要你再画，这个时间就会无限往后拖」「改名不归所管，他是归档案员管」（所 = 锁，语音）。设计稿 = 家族根 ai-docs/20261108-design-lock-star-versions.md 第十节。
// 验：开关关着 = 2.2 行为；开着：没解锁改不了、新建不拦、放凉过期、存一次往后推、正开着的不打断；改名 / 删除 / 加密 / 同步都不归锁管；解锁只在本机。
import { test, eq, assert } from "./runner.mjs";
import { createStore, LockedError } from "../src/create-store.ts";
import { createUnlocks } from "../src/works/unlocks.ts";
import type { DocKind } from "../src/base/identifiers.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const text = async (b: Blob | null) => (b ? await b.text() : null);
function kvRaw() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()], _m: m };
}
const KINDS: DocKind[] = [
  { kind: "painting", suffix: ".ora", container: "zip" },
  { kind: "snap", suffix: ".crumb", container: "raw" },
  { kind: "snap", suffix: ".crumb", container: "raw", tier: "auto-backup", stem: /-a\d+$/ },
];
const H = 3600_000, DAY = 24 * H;
function rig(o: { lock?: boolean; provider?: ReturnType<typeof createMockProvider>; ttl?: number } = {}) {
  const provider = o.provider ?? createMockProvider();
  const local = createMockLocal(), kv = kvRaw();
  const clock = { t: 1_800_000_000_000 };
  const active = { id: null as string | null };
  const errors: unknown[] = [];
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => "keepMine", reportError: (e: unknown) => { errors.push(e); } } as never;
  const store = createStore({ docKinds: KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv, local, isOnline: () => true, signedIn: () => true, skipMigration: true,
    lockByDefault: o.lock, unlockTtlMs: o.ttl, now: () => clock.t, activeIdentifier: () => active.id });
  return { provider, local, kv, store, clock, active, errors };
}
async function throwsLocked(fn: () => Promise<unknown>, what: string): Promise<LockedError> {
  try { await fn(); } catch (e) { assert(e instanceof LockedError, `${what}: 应当抛 LockedError，实得 ${(e as Error)?.name}: ${(e as Error)?.message}`); return e as LockedError; }
  throw new Error(`${what}: 应当抛 LockedError，但没抛`);
}

test("[lock] 开关关着（默认）= 2.2 行为：没解锁照样改；files.lockByDefault 说 false", async () => {
  const { store } = rig();
  eq(store.files.lockByDefault, false);
  const f = store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: true });
  const g = store.file("画.ora", { mode: "existing" });
  const r = await g.save(enc("V2"), { tryPush: true });
  eq(r.pushed, true); eq(await text(await g.open()), "V2");
  eq(store.files.unlockOf("画.ora"), null, "关着的时候新建也不发解锁（没有东西要解）");
});

test("[lock] 开着：新建（mode:new 首存）不拦，存成后带一枚解锁，接着改得动", async () => {
  const { store } = rig({ lock: true });
  eq(store.files.lockByDefault, true);
  const f = store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: true });
  assert(store.files.unlockOf("画.ora"), "新建的带解锁");
  await f.save(enc("V2"), { tryPush: true });                                   // 同一个句柄接着存 = 改已有的
  await store.file("画.ora", { mode: "existing" }).save(enc("V3"), { tryPush: true });
  eq(await text(await f.open()), "V3");
});

test("[lock] 开着：没解锁改已有的 → LockedError；字节不变、不标脏、云端不动；解锁后能改", async () => {
  const { store, provider } = rig({ lock: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await store.files.lock("画.ora");
  eq(store.files.unlockOf("画.ora"), null);
  const f = store.file("画.ora", { mode: "existing" });
  const uploadsBefore = provider._dump().length;
  const e = await throwsLocked(() => f.save(enc("手滑"), { tryPush: true }), "锁着的保存");
  eq(e.identifier, "画.ora"); eq(e.op, "save");
  await throwsLocked(() => f.save(enc("手滑"), { tryPush: false }), "只落本机的保存（自动保存）也一样拦");
  eq(await text(await f.open()), "V1", "字节没动");
  eq(await store.files.dirty.count(), 0, "没有被标成没传上去");
  eq(provider._dump().length, uploadsBefore, "云端没多东西");
  const u = await store.files.unlock("画.ora");
  eq(u.identifier, "画.ora"); eq(u.expiresAt - u.unlockedAt, DAY, "默认一天");
  await f.save(enc("V2"), { tryPush: true });
  eq(await text(await f.open()), "V2");
});

test("[lock] 生来锁着（存下来的一版 / 导入）：save(…, { bornLocked: true }) 不带解锁，再改要先解", async () => {
  const { store } = rig({ lock: true });
  const f = store.file("画.backup-20261108.ora", { mode: "new" });
  await f.save(enc("版本"), { tryPush: true, bornLocked: true });
  eq(store.files.unlockOf("画.backup-20261108.ora"), null);
  await throwsLocked(() => f.save(enc("改"), { tryPush: false }), "生来锁着的再存");
});

test("[lock] 放凉一天过期；每存一次往后推一天（只要还在画就一直往后拖）", async () => {
  const { store, clock } = rig({ lock: true });
  const f = store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: false });                                  // t0：新建带解锁
  clock.t += 20 * H; await f.save(enc("V2"), { tryPush: false });               // +20h：还活着，存成 → 过期推到 +44h
  clock.t += 20 * H; await f.save(enc("V3"), { tryPush: false });               // +40h：离上次存 20h，还活着 → 推到 +64h
  eq(store.files.unlockOf("画.ora")!.expiresAt, clock.t + DAY, "过期 = 最近一次成功的保存 + 一天");
  clock.t += DAY - 1; assert(store.files.unlockOf("画.ora"), "差一毫秒还活着");
  clock.t += 1; eq(store.files.unlockOf("画.ora"), null, "放凉满一天 → 锁上");
  await throwsLocked(() => f.save(enc("V4"), { tryPush: false }), "过期后的保存");
  eq(await text(await f.open()), "V3");
});

test("[lock] 正开着的那份过期不打断（开着没存、放了一天回来接着画，那一笔存得下来）；放下之后才落锁", async () => {
  const { store, clock, active } = rig({ lock: true });
  const f = store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: false });
  active.id = "画.ora";
  clock.t += 3 * DAY;
  assert(store.files.unlockOf("画.ora"), "开着的那份仍然算解着");
  await f.save(enc("V2"), { tryPush: false });                                  // 存得下来，并且把过期推到现在 + 一天
  active.id = null;
  assert(store.files.unlockOf("画.ora"), "刚存过，放下也还有一天");
  clock.t += DAY;
  eq(store.files.unlockOf("画.ora"), null);
  // 没存就放下：过期了 ∧ 不再开着 → 当场锁
  await store.files.unlock("画.ora"); active.id = "画.ora"; clock.t += 2 * DAY;
  assert(store.files.unlockOf("画.ora")); active.id = null;
  eq(store.files.unlockOf("画.ora"), null, "不再是活动文档的那一刻落锁");
});

test("[lock] 不归锁管的：改名 / 移动（解锁跟着新身份走）、送回收站、加密", async () => {
  const { store } = rig({ lock: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await store.files.lock("画.ora");
  const mv = await store.file("画.ora", { mode: "existing" }).tryMove("改名.ora");
  eq(mv.ok, true, "锁着也能改名");
  await store.files.unlock("改名.ora");
  eq((await store.file("改名.ora", { mode: "existing" }).tryMove("夹/改名.ora")).ok, true);
  assert(store.files.unlockOf("夹/改名.ora"), "解锁跟着新身份");
  eq(store.files.unlockOf("改名.ora"), null);
  await store.files.lock("夹/改名.ora");
  const en = await store.file("夹/改名.ora", { mode: "existing" }).encrypt();   // 没密码 → status locked（那是加密自己的「没口令」，不是这把锁）；关键是没抛 LockedError
  assert(typeof en.status === "string");
  const tr = await store.file("夹/改名.ora", { mode: "existing" }).trash();
  eq(tr.status, "trashed", "锁着也能送回收站（拦删除的是星）");
});

test("[lock] 送进回收站之后解锁不留：同名再新建一份生来锁着的，不会白捡一枚旧解锁", async () => {
  const { store } = rig({ lock: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  assert(store.files.unlockOf("画.ora"));
  await store.file("画.ora", { mode: "existing" }).trash();
  eq(store.files.unlockOf("画.ora"), null);
});

test("[lock] 同步不归锁管：存下没传的字节锁上后照样补推；云端的新版照样快进；处理…（本地覆盖云端）照样走", async () => {
  const { store, provider } = rig({ lock: true });
  const f = store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: true });
  await f.save(enc("V2"), { tryPush: false });                                  // 解着的时候存了、没传
  await store.files.lock("画.ora");
  const r = await store.files.dirty.pushAll();
  eq(r.pushed, 1, "锁着也补推（推的是已经存下的字节，不是改内容）");
  provider._seed("画.ora", "CLOUD-V3");                                         // 别的设备存了新版
  await f.pullIfClean();
  eq(await text(await f.open()), "CLOUD-V3", "锁着也快进");
  // 再造一份没传的，锁上，走 resolve：ui 选 keepMine
  await store.files.unlock("画.ora"); await f.save(enc("V4"), { tryPush: false }); await store.files.lock("画.ora");
  eq((await f.resolve()).status, "pushed");
});

test("[lock] 只管声明过的一等文档：图片 / 杂物、二等自动备份不受影响", async () => {
  const { store } = rig({ lock: true });
  await store.file("参考.png", { mode: "new" }).save(enc("P1"), { tryPush: false });
  eq(store.files.unlockOf("参考.png"), null, "不是文档：不发解锁");
  await store.file("参考.png", { mode: "existing" }).save(enc("P2"), { tryPush: false });   // 也不拦
  await store.file("格-a1.crumb", { mode: "new" }).save(enc("A1"), { tryPush: false });
  await store.file("格-a1.crumb", { mode: "existing" }).save(enc("A2"), { tryPush: false });   // 二等：机器轮转的格子，不拦
  await store.file("手动.crumb", { mode: "new" }).save(enc("M1"), { tryPush: false, bornLocked: true });
  await throwsLocked(() => store.file("手动.crumb", { mode: "existing" }).save(enc("M2"), { tryPush: false }), "同后缀的一等（手动格）照拦");
});

test("[lock] 解锁只在这台设备：不进任何云端写入；另一台设备（自己的 kv）看不见", async () => {
  const a = rig({ lock: true });
  const f = a.store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: true });
  await a.store.files.unlock("画.ora"); await f.save(enc("V2"), { tryPush: true });
  const paths = a.provider._dump().map((i) => (i as { path?: string }).path ?? "");
  assert(!paths.some((p) => /unlock/i.test(p)), "云端没有任何带 unlock 的东西：" + paths.join(","));
  for (const i of a.provider._dump()) { if ((i as { isFolder?: boolean }).isFolder) continue; const t = await (await a.provider.download((i as { ref: string }).ref)).text(); assert(!t.includes("internal.unlocks") && !t.includes("unlockedAt"), "云端文件内容里没有解锁的账"); }
  assert([...a.kv._m.keys()].some((k) => k.endsWith("internal.unlocks")), "账在本机 kv");
  const b = rig({ lock: true, provider: a.provider });
  eq(b.store.files.unlockOf("画.ora"), null, "另一台设备要自己解");
  await throwsLocked(() => b.store.file("画.ora", { mode: "existing" }).save(enc("B"), { tryPush: false }), "另一台没解锁的保存");
});

test("[lock] 本机时钟被往回拨：记下的时刻在「现在」之后 → 改记成现在，最多再等一个 ttl（不会变成永远开着）", async () => {
  const { store, clock } = rig({ lock: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: false });
  clock.t -= 30 * DAY;                                                          // 钟被拨回一个月前
  const u = store.files.unlockOf("画.ora")!;
  eq(u.unlockedAt, clock.t, "改记成现在"); eq(u.expiresAt, clock.t + DAY);
  clock.t += DAY;
  eq(store.files.unlockOf("画.ora"), null);
});

test("[lock] watchUnlocks：订阅当场给一次全表；解 / 锁 / 改名有变化再给", async () => {
  const { store } = rig({ lock: true });
  await store.file("甲.ora", { mode: "new" }).save(enc("1"), { tryPush: false });
  const seen: string[] = [];
  const un = store.files.watchUnlocks((live) => seen.push(live.map((u) => u.identifier).join("+") || "∅"));
  eq(seen.join(" | "), "甲.ora");
  await store.file("乙.ora", { mode: "new" }).save(enc("2"), { tryPush: false });
  await store.files.lock("甲.ora");
  await store.file("乙.ora", { mode: "existing" }).tryMove("丙.ora");
  eq(seen.join(" | "), "甲.ora | 乙.ora+甲.ora | 乙.ora | 丙.ora");
  un();
  await store.files.lock("丙.ora");
  eq(seen.length, 4, "退订后不再叫");
  await store.dispose();
});

test("[unlocks] 过期的那一刻通知订阅者（定时器 seam）；正开着的过期后隔一会儿回来看；close 收定时器", () => {
  const kv = kvRaw(); let t = 1000; let active: string | null = null;
  const timers: { fn: () => void; ms: number; live: boolean }[] = [];
  const u = createUnlocks({ kv, ttlMs: 100, now: () => t, activeIdentifier: () => active,
    setTimer: (fn, ms) => { const h = { fn, ms, live: true }; timers.push(h); return h; }, clearTimer: (h) => { (h as { live: boolean }).live = false; } });
  const seen: string[] = [];
  u.watch((live) => seen.push(live.map((x) => x.identifier).join("+") || "∅"));
  u.unlock("a");
  const pending = () => timers.filter((x) => x.live);
  eq(pending().length, 1); eq(pending()[0]!.ms, 101, "排在过期点后一毫秒");
  t += 101; pending()[0]!.live = false; timers[timers.length - 1]!.fn();
  eq(seen.join(" | "), "∅ | a | ∅", "到点通知：锁上了");
  eq(pending().length, 0, "没有活着的解锁 = 不留定时器");
  u.unlock("b"); active = "b"; t += 500;
  const h = pending()[0]!; h.live = false; h.fn();
  eq(u.get("b")!.identifier, "b", "正开着：过期也活着");
  eq(pending()[0]!.ms, 60_000, "隔一分钟回来看它放下没有");
  active = null; const h2 = pending()[0]!; h2.live = false; h2.fn();
  eq(seen[seen.length - 1], "∅", "放下之后回来看的那一次：通知锁上");
  u.unlock("c"); u.close();
  eq(pending().length, 0, "close 收掉定时器");
});

test("[unlocks] 存不等于解锁：没解锁的 noteSaved 什么都不做；账读不出来 = 当作锁着", () => {
  const kv = kvRaw();
  const u = createUnlocks({ kv, ttlMs: 100, now: () => 1 });
  u.noteSaved("a"); eq(u.get("a"), null);
  kv.set("internal.unlocks", "{坏的");
  eq(u.get("a"), null); eq(u.live().length, 0);
  kv.set("internal.unlocks", JSON.stringify({ a: { at: "不是数" }, b: 3 }));
  eq(u.live().length, 0, "形状不认的条目当没有");
});
