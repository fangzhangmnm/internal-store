// 2.3.0 记号：星（拒绝送进回收站）/ 收起（纯显示）。created 2026-11-08 by Claude Fable 5.1
//   user 2026-11-08：「星星的语义实际上就是手游里面的星星，就是说防止你把一些稀有卡牌不小心当做狗粮给删掉了…你要删之前，你必须得先把星星给撤掉。」
//   「我们没有彻底删…是进了回收站之后才能彻底删。然后星就是只是我们又多加了一层拦的」「星星能做一个同步文件」
//   「收起…它应该是一个纯 UI 层面的事情，就是它文件的归属还是应该是平铺的」。设计稿 = 家族根 ai-docs/20261108-design-lock-star-versions.md 第十节。
// 验：开关关着 = 2.2 行为；星：trash 抛、撤星后能删、改名后星还在、冲突面里选进回收站被拦、云端没了过宽限不自动送、两台设备合并、重开还在；
//     收起：列举带记号、库照常列出、不拦任何动作、改名后还在。
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore, StarredError } from "../src/create-store.ts";
import { MARKS_COLLECTION } from "../src/works/marks.ts";
import type { FolderSnapshot } from "../src/works/listing.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 3000): Promise<void> {
  const t0 = Date.now();
  while (!(await pred())) { if (Date.now() - t0 > ms) throw new Error(`等不到：${what}`); await sleep(5); }
}
function kvRaw() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] };
}
type Choice = "keepMine" | "takeCloud" | "cancel";
function rig(o: { marks?: boolean; provider?: ReturnType<typeof createMockProvider>; local?: ReturnType<typeof createMockLocal>; kv?: ReturnType<typeof kvRaw>; grace?: number; choices?: Choice[] } = {}) {
  const provider = o.provider ?? createMockProvider();
  const local = o.local ?? createMockLocal(), kv = o.kv ?? kvRaw();
  const errors: unknown[] = [];
  const choices = o.choices ?? [];
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => choices.shift() ?? "cancel", reportError: (e: unknown, level?: string) => { if (level !== "log") errors.push(e); } } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv, local, isOnline: () => true, signedIn: () => true, skipMigration: true,
    fileMarks: o.marks, cloudGoneGraceMs: o.grace });
  /** 订阅一夹，拿到「现在的最新帧」；frames() 数到过几帧。 */
  const watch = (folder = "") => {
    const snaps: FolderSnapshot[] = [];
    const un = store.files.watchFolder(folder, (s) => snaps.push(s));
    const item = (id: string) => snaps[snaps.length - 1]?.items.find((i) => i.identifier === id);
    return { snaps, un, item, last: () => snaps[snaps.length - 1] };
  };
  /** 走一轮「开夹」：本地帧 + 云端帧（含那一夹的收敛）都到了才回来。 */
  const visit = async (folder = "") => { const w = watch(folder); await until(() => w.snaps.length >= 2, "两帧"); await sleep(10); w.un(); return w.last()!; };
  const cloudPaths = () => provider._dump().filter((i) => !(i as { isFolder?: boolean }).isFolder).map((i) => (i as { path?: string }).path ?? "");
  const cloudGone = async (name: string) => {
    const it = provider._dump().find((i) => (i as { path?: string }).path === name) as { ref: string; eTag?: string };
    await provider.delete(it.ref, it.eTag);
  };
  return { provider, local, kv, store, errors, watch, visit, cloudPaths, cloudGone };
}
async function throwsStarred(fn: () => Promise<unknown>, what: string): Promise<StarredError> {
  try { await fn(); } catch (e) { assert(e instanceof StarredError, `${what}: 应当抛 StarredError，实得 ${(e as Error)?.name}: ${(e as Error)?.message}`); return e as StarredError; }
  throw new Error(`${what}: 应当抛 StarredError，但没抛`);
}
const MARKS_FILE = `.wp/${MARKS_COLLECTION}`;

test("[marks] 开关关着（默认）= 2.2 行为：不建记号文件、列举不带字段、star / fold 抛", async () => {
  const { store, visit, cloudPaths } = rig();
  eq(store.files.fileMarks, false);
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  const snap = await visit();
  const it = snap.items.find((i) => i.identifier === "画.ora")!;
  assert(!("starred" in it) && !("folded" in it), "条目上没有这两个字段");
  assert(!cloudPaths().some((p) => p.includes(MARKS_COLLECTION)), "云端没有记号文件：" + cloudPaths().join(","));
  let threw = false; try { await store.files.star("画.ora"); } catch (e) { threw = /fileMarks/.test(String(e)); }
  assert(threw, "star 抛（说清要开 fileMarks）");
  eq((await store.file("画.ora", { mode: "existing" }).trash()).status, "trashed", "删除照旧");
});

test("[marks] 加了星：列举带 starred；trash 抛 StarredError，本机和云端都没动；撤星后能删", async () => {
  const { store, watch, cloudPaths } = rig({ marks: true });
  eq(store.files.fileMarks, true);
  const f = store.file("画.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: true });
  const w = watch();
  await until(() => !!w.item("画.ora"), "列出来");
  assert(!("starred" in w.item("画.ora")!), "没加星 = 没有这个字段");
  await store.files.star("画.ora");
  await until(() => w.item("画.ora")?.starred === true, "加星后那一夹重画、条目带 starred");
  const e = await throwsStarred(() => f.trash(), "加了星的送回收站");
  eq(e.identifier, "画.ora"); eq(e.op, "trash");
  eq(await (await f.open())!.text(), "V1", "本机还在");
  assert(cloudPaths().includes("画.ora"), "云端还在");
  eq((await store.files.listTrash()).length, 0, "回收站是空的");
  await store.files.unstar("画.ora");
  await until(() => w.item("画.ora") != null && !("starred" in w.item("画.ora")!), "撤星后字段没了");
  eq((await f.trash()).status, "trashed", "撤了星就能删");
  w.un();
});

test("[marks] 改名 / 移动：星跟着新身份走，旧名字上不留", async () => {
  const { store, watch } = rig({ marks: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await store.files.star("画.ora");
  eq((await store.file("画.ora", { mode: "existing" }).tryMove("新名.ora")).ok, true, "加了星也能改名（改名归档案那头）");
  const w = watch();
  await until(() => w.item("新名.ora")?.starred === true, "新名字带星");
  await throwsStarred(() => store.file("新名.ora", { mode: "existing" }).trash(), "新名字照样删不掉");
  w.un();
  // 旧名字再建一份：没有星
  await store.file("画.ora", { mode: "new" }).save(enc("另一幅"), { tryPush: true });
  eq((await store.file("画.ora", { mode: "existing" }).trash()).status, "trashed", "旧名字上的新文件没有白捡一颗星");
});

test("[marks] 收起：列举带 folded、库照常列出它；不拦删除、不拦保存；改名后还在；取消收起清掉", async () => {
  const { store, watch } = rig({ marks: true });
  const f = store.file("练习.ora", { mode: "new" });
  await f.save(enc("V1"), { tryPush: true });
  await store.files.fold("练习.ora");
  const w = watch();
  await until(() => w.item("练习.ora")?.folded === true, "条目带 folded，而且照常在列举里");
  await f.save(enc("V2"), { tryPush: true });                                    // 收起不拦保存
  eq((await f.tryMove("练习2.ora")).ok, true);
  await until(() => w.item("练习2.ora")?.folded === true, "改名后记号跟着");
  await store.files.unfold("练习2.ora");
  await until(() => w.item("练习2.ora") != null && !("folded" in w.item("练习2.ora")!), "取消收起");
  await store.files.fold("练习2.ora");
  eq((await store.file("练习2.ora", { mode: "existing" }).trash()).status, "trashed", "收起不拦删除（拦删除的只有星）");
  w.un();
});

test("[marks] 星和收起各管各的：同一份可以两样都有，撤一样不动另一样", async () => {
  const { store, watch } = rig({ marks: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await store.files.star("画.ora"); await store.files.fold("画.ora");
  const w = watch();
  await until(() => w.item("画.ora")?.starred === true && w.item("画.ora")?.folded === true, "两样都有");
  await store.files.unfold("画.ora");
  await until(() => w.item("画.ora")?.starred === true && !("folded" in w.item("画.ora")!), "撤收起，星还在");
  await throwsStarred(() => store.file("画.ora", { mode: "existing" }).trash(), "星还拦着");
  w.un();
});

test("[marks] 云端那份没了、过了宽限：没加星的自动进回收站（原行为）；加了星的机器不动，停在「要你处理」", async () => {
  const { store, visit, cloudGone } = rig({ marks: true, grace: 0 });
  await store.file("普通.ora", { mode: "new" }).save(enc("A"), { tryPush: true });
  await store.file("宝贝.ora", { mode: "new" }).save(enc("B"), { tryPush: true });
  await store.files.star("宝贝.ora");
  await cloudGone("普通.ora"); await cloudGone("宝贝.ora");                      // 别的设备把两份都删了
  await visit();                                                                 // 第一次权威见 gone：只标记
  const snap = await visit();                                                    // 第二次 + 宽限 0 → 该动手了
  assert(!snap.items.some((i) => i.identifier === "普通.ora"), "没加星的：本机那份进了回收站");
  const kept = snap.items.find((i) => i.identifier === "宝贝.ora");
  assert(kept, "加了星的：还在");
  eq(kept!.syncState, "pendingGone", "停在「云端没了，要你处理」");
  eq(await (await store.file("宝贝.ora", { mode: "existing" }).open())!.text(), "B");
  const third = await visit();                                                   // 再来几轮也一样
  assert(third.items.some((i) => i.identifier === "宝贝.ora"));
  // 人撤了星 → 下一轮照常收敛
  await store.files.unstar("宝贝.ora");
  const fourth = await visit();
  assert(!fourth.items.some((i) => i.identifier === "宝贝.ora"), "撤星后机器照常把它送进回收站");
});

test("[marks] 冲突面里选「云端覆盖本地 = 这份进回收站」：加了星 → 两边不动、unresolved / starred；选「本地覆盖云端」照常传回去", async () => {
  // 干净的副本、云端被别处删了
  const a = rig({ marks: true, choices: ["takeCloud", "keepMine"] });
  const f = a.store.file("宝贝.ora", { mode: "new" });
  await f.save(enc("B"), { tryPush: true });
  await a.store.files.star("宝贝.ora");
  await a.cloudGone("宝贝.ora");
  const r1 = await f.resolve();
  eq(r1.status, "unresolved"); eq((r1 as { reason?: string }).reason, "starred");
  eq(await (await f.open())!.text(), "B", "本机没动");
  eq((await a.store.files.listTrash()).length, 0, "回收站是空的");
  eq((await f.resolve()).status, "pushed", "本地覆盖云端：传回去（星不拦这个方向）");
  assert(a.cloudPaths().includes("宝贝.ora"));
  // 没传的改动 + 云端没了（脏的那条路）
  const b = rig({ marks: true, choices: ["takeCloud"] });
  const g = b.store.file("宝贝.ora", { mode: "new" });
  await g.save(enc("B1"), { tryPush: true });
  await b.store.files.star("宝贝.ora");
  await g.save(enc("B2"), { tryPush: false });
  await b.cloudGone("宝贝.ora");
  const r2 = await g.resolve();
  eq(r2.status, "unresolved"); eq((r2 as { reason?: string }).reason, "starred");
  eq(await (await g.open())!.text(), "B2");
});

test("[marks] 记号是一份普通的同步文件：两台设备合并——甲加的星，乙同步到之后在乙上也删不掉", async () => {
  const a = rig({ marks: true });
  await a.store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await a.store.files.star("画.ora");
  await a.visit();                                                               // 甲开一次夹：云端帧顺手把记号对上云端
  await until(() => a.cloudPaths().some((p) => p.startsWith(MARKS_FILE)), "云端有了记号文件（.wp/ 下）");
  await until(async () => { const it = a.provider._dump().find((i) => ((i as { path?: string }).path ?? "").startsWith(MARKS_FILE)) as { ref: string }; return (await (await a.provider.download(it.ref)).text()).includes("画.ora"); }, "记号文件里有这一条");
  const b = rig({ marks: true, provider: a.provider });                          // 乙：自己的本机库
  const w = b.watch();
  await until(() => w.item("画.ora")?.starred === true, "乙列举到星");
  await throwsStarred(() => b.store.file("画.ora", { mode: "existing" }).trash(), "乙上也删不掉");
  // 乙撤星 → 甲同步到 → 甲能删
  await b.store.files.unstar("画.ora");
  await b.visit();
  const wa = a.watch();
  await until(() => wa.item("画.ora") != null && !("starred" in wa.item("画.ora")!), "甲同步到撤星");
  eq((await a.store.file("画.ora", { mode: "existing" }).trash()).status, "trashed");
  w.un(); wa.un();
});

test("[marks] 重开（同一台设备的本机缓存）星还在：不等云端", async () => {
  const provider = createMockProvider(), local = createMockLocal(), kv = kvRaw();
  const a = rig({ marks: true, provider, local, kv });
  await a.store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await a.store.files.star("画.ora");
  await a.store.dispose();
  const b = rig({ marks: true, provider, local, kv });
  await throwsStarred(() => b.store.file("画.ora", { mode: "existing" }).trash(), "重开后第一件事就是删：照样拦");
});

test("[marks] 没变的不写：重复加星 / 给没有记号的撤星不产生改动", async () => {
  const { store, watch } = rig({ marks: true });
  await store.file("画.ora", { mode: "new" }).save(enc("V1"), { tryPush: true });
  await store.files.unstar("画.ora"); await store.files.unfold("画.ora");        // 本来就没有
  await store.files.star("画.ora"); await store.files.star("画.ora");
  const w = watch();
  await until(() => w.item("画.ora")?.starred === true, "有星");
  w.un();
});
