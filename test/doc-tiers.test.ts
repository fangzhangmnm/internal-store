// 2.1.0 公民等级进表（2026-10-17 深夜 Claude Fable 5.1；user「能kind和等级绑定吗（允许一kind多等级？)然后ctor的时候传死」「做」）。
// 验：
//   · 表：tier 不传 = work；同一后缀按 stem 形拆几行几等（KudsRocket 的 .crumb：手动格一等、-a/-h 自动格二等）；非法 tier / 两行都不带 stem / g 旗 → 当场抛。
//   · 一等（默认）：行为 = 2.0——412 弹面，输家进备份箱。
//   · 二等自动备份：412 不弹面、这台的赢、输的那份不进 .backup；resolve() 不弹面。
//   · 三等资源：save / delete / tryMove 抛 ReadOnlyFilesError；open 不留本地副本（autoCacheOpenedFile:true 也不留）；keepOffline / offload 照常；resolve() 恒 clean；
//     云端没了 → 本地缓存直接丢、不进回收站（reconcile.drop）。
//   · 每种文档自己的 validate：云端坏字节只拦那一种。
import { test, eq, assert } from "./runner.mjs";
import { createIdentifiers, validateDocKinds, type DocKind } from "../src/base/identifiers.ts";
import { createStore, ReadOnlyFilesError } from "../src/create-store.ts";
import { createReconcile } from "../src/works/reconcile.ts";
import { createPendingGone } from "../src/works/pending-gone.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Blob) return await x.text();
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}
function kvRaw() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] };
}
/** KudsRocket 形状的表：手动格一等、自动 / 历史格二等（同后缀按 stem 拆）、盘三等、带自己验真的笔记。 */
const KINDS: DocKind[] = [
  { kind: "snap", suffix: ".crumb", container: "raw" },
  { kind: "snap", suffix: ".crumb", container: "raw", tier: "auto-backup", stem: /-[ah]\d+$/ },
  { kind: "asset", suffix: ".pack", container: "raw", tier: "resource" },
  { kind: "note", suffix: ".txt", container: "raw", validate: async (b) => (await b.text()).startsWith("ok") },
  { kind: "memo", suffix: ".md", container: "raw" },
];

function rig(choices: Array<"keepMine" | "takeCloud" | "cancel"> = []) {
  const provider = createMockProvider();
  const local = createMockLocal();
  const conflicts: Array<{ name: string; occasion: string }> = [];
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ name, occasion }: { name: string; occasion: string }) => { conflicts.push({ name, occasion }); return choices.shift() ?? "cancel"; },
    reportError: () => {},
  } as never;
  const store = createStore({ docKinds: KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "kr", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
  const cloudText = async (name: string) => {
    const it = provider._dump().find((i) => (i as { path?: string }).path === name || (i as { name?: string }).name === name) as { ref?: string; id?: string } | undefined;
    return it ? asStr(await provider.download(it.ref ?? it.id!)) : null;
  };
  const cloudBackups = () => provider._dump().filter((i) => ((i as { path?: string }).path ?? "").includes(".backup/") && !(i as { isFolder?: boolean }).isFolder).length;
  return { provider, local, store, conflicts, cloudText, cloudBackups };
}

test("[tier] 表：tier 不传 = work；同后缀按 stem 拆几行几等；rowOf 带回 validate；非法声明当场抛", () => {
  const ids = createIdentifiers(KINDS);
  eq(ids.parse("crumbs/abcd-s1.crumb")!.tier, "work", "手动格 = 一等（默认）");
  eq(ids.parse("crumbs/abcd-a2.crumb")!.tier, "auto-backup", "自动格 = 二等（stem 形命中）");
  eq(ids.parse("crumbs/abcd-h1700000000.crumb")!.tier, "auto-backup", "历史份 = 二等");
  eq(ids.parse("crumbs/abcd-a2.crumb")!.kind, "snap", "kind 不变：一 kind 两等");
  eq(ids.parse("asset.pack")!.tier, "resource");
  assert(typeof ids.rowOf("n.txt")!.validate === "function", "rowOf 带回这一种的 validate");
  eq(ids.rowOf("x.md")!.validate, undefined);
  eq(ids.parse("nothing.bin"), null);
  const bad = (rows: unknown, re: RegExp) => { let err: unknown = null; try { validateDocKinds(rows as DocKind[]); } catch (e) { err = e; } assert(err && re.test(String((err as Error).message)), `应抛 ${re}：${String((err as Error)?.message)}`); };
  bad([{ kind: "a", suffix: ".x", container: "raw", tier: "gold" }], /tier must be/);
  bad([{ kind: "a", suffix: ".x", container: "raw" }, { kind: "b", suffix: ".x", container: "raw", tier: "resource" }], /declared twice/);
  bad([{ kind: "a", suffix: ".x", container: "raw", stem: /z/g }], /g \/ y flags/);
  validateDocKinds([{ kind: "a", suffix: ".x", container: "raw" }, { kind: "a", suffix: ".x", container: "raw", stem: /^auto-/, tier: "auto-backup" }]);   // 合法：一行带 stem 一行不带
});

test("[tier] 一等（默认）= 2.0：412 弹面；选本地覆盖云端 → 输家进备份箱", async () => {
  const { provider, store, conflicts, cloudText, cloudBackups } = rig(["keepMine"]);
  const f = store.file("k-s1.crumb", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("k-s1.crumb", "OTHER");                 // 别的设备改了
  const r = await f.save(enc("MINE"), { tryPush: true });
  eq(conflicts.length, 1, "一等：弹面");
  eq(r.resolution, "keepMine");
  eq(await cloudText("k-s1.crumb"), "MINE");
  eq(cloudBackups(), 1, "输家（OTHER）进了 .backup");
});

test("[tier] 二等自动备份：412 不弹面、这台的赢、输家不进备份箱；resolve() 也不问人", async () => {
  const { provider, store, conflicts, cloudText, cloudBackups } = rig([]);
  const f = store.file("k-a1.crumb", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("k-a1.crumb", "OTHER");
  const r = await f.save(enc("MINE"), { tryPush: true });
  eq(conflicts.length, 0, "★二等：永不弹面");
  assert(r.pushed, `推上去了（${r.reason ?? ""}）`);
  eq(await cloudText("k-a1.crumb"), "MINE", "这台的赢");
  eq(cloudBackups(), 0, "★输家不进 .backup（机器可以丢它）");
  await f.save(enc("MINE2"), { tryPush: false });
  provider._seed("k-a1.crumb", "OTHER2");
  const rr = await f.resolve();
  eq(conflicts.length, 0, "resolve() 也不问人");
  eq(rr.status, "pushed");
  eq(await cloudText("k-a1.crumb"), "MINE2");
});

test("[tier] 三等资源：写面全抛 ReadOnlyFilesError；open 过路不留本地；keepOffline / offload 照常；resolve 恒 clean", async () => {
  const { provider, local, store } = rig();
  provider._seed("asset.pack", "ASSET-BYTES");
  const f = store.file("asset.pack", { mode: "existing" });
  for (const [op, fn] of [["save", () => f.save(enc("x"))], ["trash", () => f.trash()], ["tryMove", () => f.tryMove("a2.pack")]] as const) {
    let err: unknown = null;
    try { await fn(); } catch (e) { err = e; }
    assert(err instanceof ReadOnlyFilesError && /三等资源/.test((err as Error).message), `${op} → ReadOnlyFilesError（实得 ${String((err as Error)?.message)}）`);
  }
  eq(await asStr(await f.open()), "ASSET-BYTES", "能读");
  eq(await f.isKeptOffline(), false, "★open 过路：不留本地副本（autoCacheOpenedFile 默认 true 也不留）");
  await f.keepOffline();
  eq(await f.isKeptOffline(), true, "显式留离线可以");
  eq((await f.resolve()).status, "clean", "resolve 恒 clean");
  await f.offload();
  eq(await f.isKeptOffline(), false, "offload 照常");
  void local;
});

test("[tier] 三等资源云端没了 → 本地缓存直接丢（不进回收站）；作品照旧进回收站", async () => {
  const trashed: string[] = [], dropped: string[] = [];
  let clock = 1;
  const pending = createPendingGone(kvRaw(), 0);
  const cloud = { listAll: async () => ({ complete: true, files: [{ name: "keep.md", path: "keep.md" }] }), listFolder: async () => ({ complete: true, files: [] }), clearState: () => {} };
  const local = { appKeys: async () => ["keep.md", "gone.pack", "gone.md"], trash: async (n: string) => { trashed.push(n); }, hardDelete: async (n: string) => { dropped.push(n); } };
  const head = { seenBase: () => "e1", isDirtyAnywhere: () => false, forget: () => {} };
  const ids = createIdentifiers(KINDS);
  const { reconcile } = createReconcile({ cloud: cloud as never, local: local as never, head: head as never, pending, now: () => clock, isOnline: () => true, drop: (n) => ids.parse(n)?.tier === "resource" });
  await reconcile();                                       // 第一次见 gone：只标 candidate
  eq(trashed.length + dropped.length, 0);
  clock = 2;
  const r = await reconcile();                             // 跨 grace 第二次 → 收敛
  eq(r.demoted.sort().join(","), "gone.md,gone.pack");
  eq(dropped.join(","), "gone.pack", "★三等：直接丢");
  eq(trashed.join(","), "gone.md", "一等：进回收站");
});

test("[tier] 每种文档自己的 validate：云端坏字节只拦那一种（别的种类用全局 validateAdopt）", async () => {
  const { provider, store } = rig();
  const n = store.file("n.txt", { mode: "existing" });
  const m = store.file("m.md", { mode: "existing" });
  await n.save(enc("ok-1"), { tryPush: true });
  await m.save(enc("whatever"), { tryPush: true });
  provider._seed("n.txt", "bad bytes");                    // 不以 ok 开头 → note 的 validate 拦
  provider._seed("m.md", "new md");                        // memo 没有自己的 validate → 全局（恒 true）放行
  await n.pullIfClean();
  await m.pullIfClean();
  eq(await asStr(await n.open()), "ok-1", "★坏字节没覆盖本地");
  eq(await asStr(await m.open()), "new md", "别的种类正常快进");
});

test("[tier] 2.1.2 列举行带 kind / tier（user「带」）：自动格 auto-backup、大资源 resource、不是文档的名字只有 tier work", async () => {
  const { provider, store } = rig();
  provider._seed("k-a1.crumb", "A");
  provider._seed("k-s1.crumb", "S");
  provider._seed("asset.pack", "D");
  provider._seed("misc.bin", "?");
  const seen: Array<{ identifier: string; kind?: string; tier: string }> = [];
  const off = store.files.watchFolder("", (snap: { items: Array<{ identifier: string; kind?: string; tier: string }>; complete?: boolean }) => { seen.splice(0, seen.length, ...snap.items); });
  for (let i = 0; i < 100 && !seen.some((x) => x.identifier === "misc.bin"); i++) await new Promise((r) => setTimeout(r, 5));
  off();
  const by = (id: string) => seen.find((x) => x.identifier === id)!;
  assert(by("misc.bin"), `云端帧到了（${seen.map((x) => x.identifier).join(",")}）`);
  eq(by("k-a1.crumb").tier, "auto-backup"); eq(by("k-a1.crumb").kind, "snap");
  eq(by("k-s1.crumb").tier, "work"); eq(by("k-s1.crumb").kind, "snap");
  eq(by("asset.pack").tier, "resource"); eq(by("asset.pack").kind, "asset");
  eq(by("misc.bin").tier, "work"); eq("kind" in by("misc.bin"), false, "不是文档：没有 kind 字段");
});
