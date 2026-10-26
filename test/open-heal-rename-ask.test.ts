// 2.2.2：① open 时的回执丢失自愈（脏 ∧ 云端版本号不同 → 先拉云端逐字节比，一样就认领、不弹面；慢网可被「跳过到离线」打断）
//        ② 改名撞上谱系不明 / 分叉 → 动字节之前先问人「搬走旧的（进回收站）/ 留着旧的 / 取消」（ui.resolveRenameOld；不给 = 2.2.1 行为）。
//   user 2026-10-26「批，库出 2.2.2」「同意，反正不删就行了」「要保证慢网不会卡死没法切离线」。—— created 20261026 by Claude Fable 5.1
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
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
function device(opts: { renameAnswer?: "trash" | "keep" | "cancel" | null; escapeOn?: "download" | "immediate" | null; hook?: (op: string) => void } = {}) {
  let skip: (() => void) | null = null;
  const provider = createMockProvider({ hook: (op) => { opts.hook?.(op); if (opts.escapeOn === "download" && op === "download") skip?.(); } });
  const local = createMockLocal(); const kv = kvRaw(); const st = { signedIn: true };
  const sheets: string[] = []; const asks: string[] = [];
  const ui = {
    busy: <T,>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async (c: { occasion: string; cloudState?: string }) => { sheets.push(`${c.occasion}:${c.cloudState ?? "-"}`); return "cancel"; },
    reportError: () => {},
    ...(opts.escapeOn ? { offlineEscape: () => { const probe = new Promise<void>((res) => { skip = res; }); if (opts.escapeOn === "immediate") skip!(); return { probe, settle: () => {} }; } } : {}),
    ...(opts.renameAnswer !== undefined && opts.renameAnswer !== null ? { resolveRenameOld: async (c: { reason: string }) => { asks.push(c.reason); return opts.renameAnswer!; } } : {}),
  } as never;
  const page = () => createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none", appId: "catsup", provider, ui, validateAdopt: () => true, kv, local, isOnline: () => true, signedIn: () => st.signedIn, skipMigration: true } as never);
  const cloudFiles = () => provider._dump().filter((i) => !(i as { isFolder?: boolean }).isFolder && !/\.trash\//.test((i as { path: string }).path)).map((i) => (i as { path: string }).path).sort();
  const cloudTrash = () => provider._dump().filter((i) => !(i as { isFolder?: boolean }).isFolder && /\.trash\//.test((i as { path: string }).path)).length;
  const cloudText = async (name: string) => { const it = provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name)) as { ref?: string; id?: string } | undefined; return it ? asStr(await provider.download(it.ref ?? it.id!)) : null; };
  return { provider, local, kv, st, page, sheets, asks, cloudFiles, cloudTrash, cloudText };
}
/** 回执丢失：V1 推上去了；V2 落了本机、上传也落了云，但页面在回执回来之前死了 → 本机脏、基准还是 V1 的、云端已是 V2（同字节）。
 *  （mock 里 upload 的 lostResponse 会被 cloud-sync 自己的 H7 兜底当场认领，模拟不出「页面死了」，所以直接把云端种成同字节。） */
async function lostReceipt(d: ReturnType<typeof device>) {
  const s1 = d.page(); const f1 = s1.file("歌.glb", { mode: "existing" });
  eq((await f1.save(enc("V1"), { tryPush: true })).pushed, true, "V1 推上去");
  await f1.save(enc("V2"), { tryPush: false });   // 落本机、脏
  d.provider._seed("歌.glb", "V2");               // 上传其实落了云（同字节），回执没回来
  eq(await d.cloudText("歌.glb"), "V2", "云端已是 V2");
  eq(await s1.files.dirty.count(), 1, "本机脏");
  await s1.dispose();
}

test("[open-heal] 回执丢了之后从歌库再开这首：open 拉云端比字节、一样 → 自愈，不弹面、脏标清了（MoonSinger 10-08 的假面；以前要靠开歌前批量推）", async () => {
  const d = device(); await lostReceipt(d);
  const s2 = d.page(); const f2 = s2.file("歌.glb", { mode: "existing" });
  const bytes = await f2.open();
  eq(await asStr(bytes), "V2", "开的是本机那份（= 云端那份）");
  eq(d.sheets.length, 0, "零面");
  eq(await s2.files.dirty.count(), 0, "脏标清了（自愈 = markSynced）");
});

test("[open-heal] 云端真的不一样（别的设备又推了 V3）→ 自愈比不出 → 照旧弹 open 面（changed）、本地照读", async () => {
  const d = device(); await lostReceipt(d);
  d.provider._seed("歌.glb", "V3");
  const s2 = d.page(); const f2 = s2.file("歌.glb", { mode: "existing" });
  eq(await asStr(await f2.open()), "V2", "cancel = 打开本地");
  eq(d.sheets.length, 1, "一张面"); assert(d.sheets[0].startsWith("open:"), "open 场合");
  eq(await s2.files.dirty.count(), 1, "仍脏");
});

test("[open-heal] 慢网：自愈下载途中点了「跳过到离线」→ 不弹面、读本机、不卡住（创世承诺：切得了离线）", async () => {
  const d = device({ escapeOn: "download" }); await lostReceipt(d);
  const s2 = d.page(); const f2 = s2.file("歌.glb", { mode: "existing" });
  const bytes = await Promise.race([f2.open(), new Promise<"hung">((r) => setTimeout(() => r("hung"), 3000))]);
  assert(bytes !== "hung", "open 没卡住");
  eq(await asStr(bytes), "V2", "读的是本机那份");
  eq(d.sheets.length, 0, "跳过 = 不弹面");
});

test("[open-heal] 干净副本 / 云端没动的路零变化：干净 ∧ 云端新版照旧静默快进", async () => {
  const d = device(); const s1 = d.page(); const f1 = s1.file("歌.glb", { mode: "existing" });
  await f1.save(enc("V1"), { tryPush: true }); await s1.dispose();
  d.provider._seed("歌.glb", "V5");
  const s2 = d.page(); eq(await asStr(await s2.file("歌.glb", { mode: "existing" }).open()), "V5", "干净 → 快进到 V5"); eq(d.sheets.length, 0, "零面");
});

/** 改名前置：本机脏 + 云端被别的设备改过（diverged）。 */
async function divergedForRename(d: ReturnType<typeof device>) {
  const s1 = d.page(); const f1 = s1.file("a.glb", { mode: "existing" });
  await f1.save(enc("V1"), { tryPush: true }); await f1.save(enc("MINE"), { tryPush: false }); await s1.dispose();
  d.provider._seed("a.glb", "THEIRS");
  return d.page();
}
test("[rename-ask] 分叉 → 先问人；选「搬走旧的」→ 新名推上去、云端旧名进回收站（可恢复）、一份", async () => {
  const d = device({ renameAnswer: "trash" }); const s = await divergedForRename(d);
  const r = await s.file("a.glb", { mode: "existing" }).tryMove("b.glb");
  eq(d.asks.join(), "diverged", "问了一次，原因 = diverged");
  assert(r.ok, "改名成功");
  eq(JSON.stringify(d.cloudFiles()), '["b.glb"]', "云端只剩 b"); eq(d.cloudTrash(), 1, "旧的 a 在回收站（THEIRS 那版没丢）");
  eq(await d.cloudText("b.glb"), "MINE", "b = 这台的");
});
test("[rename-ask] 选「留着旧的」→ 两份，tryMove 返 oldKeptByUser（宿主说「照你的意思留着」）", async () => {
  const d = device({ renameAnswer: "keep" }); const s = await divergedForRename(d);
  const r = await s.file("a.glb", { mode: "existing" }).tryMove("b.glb");
  assert(r.ok && r.oldKept && r.oldKeptByUser, "oldKept + oldKeptByUser：" + JSON.stringify(r));
  eq(JSON.stringify(d.cloudFiles()), '["a.glb","b.glb"]', "两份"); eq(d.cloudTrash(), 0, "没进回收站");
});
test("[rename-ask] 选「取消」→ 一个字节不动：本机还叫 a、云端 a 还是 THEIRS、没有 b", async () => {
  const d = device({ renameAnswer: "cancel" }); const s = await divergedForRename(d);
  const r = await s.file("a.glb", { mode: "existing" }).tryMove("b.glb");
  eq(r.ok, false, "没改"); eq((r as { reason?: string }).reason, "cancelled", "reason = cancelled");
  assert(await d.local.exists("a.glb"), "本机还叫 a"); assert(!(await d.local.exists("b.glb")), "本机没有 b");
  eq(JSON.stringify(d.cloudFiles()), '["a.glb"]', "云端只有 a"); eq(await d.cloudText("a.glb"), "THEIRS", "云端 a 没动");
});
test("[rename-ask] 宿主没给回调 → 2.2.1 行为：默认留着 + oldKept（oldKeptByUser 为假）", async () => {
  const d = device(); const s = await divergedForRename(d);
  const r = await s.file("a.glb", { mode: "existing" }).tryMove("b.glb");
  assert(r.ok && r.oldKept && !r.oldKeptByUser, JSON.stringify(r)); eq(d.cloudFiles().length, 2, "两份");
});
test("[rename-ask] 谱系明确（干净 / 脏但云端没动）不问：照旧 move，零面", async () => {
  const d = device({ renameAnswer: "cancel" }); const s1 = d.page(); const f1 = s1.file("a.glb", { mode: "existing" });
  await f1.save(enc("V1"), { tryPush: true }); await f1.save(enc("V2"), { tryPush: false }); await s1.dispose();
  const s2 = d.page(); const r = await s2.file("a.glb", { mode: "existing" }).tryMove("b.glb");
  assert(r.ok, "改名成功"); eq(d.asks.length, 0, "没问"); eq(JSON.stringify(d.cloudFiles()), '["b.glb"]', "一份");
});
test("[rename-ask] 本机 etag 记录丢了 + 脏 → 原因 = unknown-lineage", async () => {
  const d = device({ renameAnswer: "trash" }); const s1 = d.page(); const f1 = s1.file("a.glb", { mode: "existing" });
  await f1.save(enc("V1"), { tryPush: true }); await f1.save(enc("V2"), { tryPush: false }); await s1.dispose();
  for (const k of d.kv.keys()) if (/etag/.test(k)) d.kv.remove(k);
  const s2 = d.page(); const r = await s2.file("a.glb", { mode: "existing" }).tryMove("b.glb");
  eq(d.asks.join(), "unknown-lineage", "原因 = unknown-lineage"); assert(r.ok, "改名成功"); eq(d.cloudTrash(), 1, "旧的进回收站");
});
