// 2.2.1：谱系丢了的脏副本，推之前先问云端（PushCfg.recaptureLineage，默认开）+ 面上的 cloudState 按真相填 + dirty.pushAll 失败带原因。
//   复现的是 CatsUp 2026-10-26「正常编辑几乎每天弹『云端有新版本』，云端其实没人动」（家族根 ai-docs/20261026-cloud-conflict-ux-postmortem.md §3）：
//   昨天登录态存推 V1 → 刷新前 30 s 内改了一笔（flushForHide 只落本机）→ 刷新：本地恢复先于登录（open 的云端核对没跑成；0.18.0 只给干净副本接谱系）
//   → 登录落地 → ① pushAll ② 自动保存 ③ 图库「处理…」。修前：① 报 failed ② 弹面且说 changed ③ 要按两次。—— created 20261026 by Claude Fable 5.1
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
type Sheet = { occasion: string; cloudState?: string; step: string };
/** 一台设备：provider / local / kv 是磁盘，store 是一个页面（刷新 = dispose 再建）。 */
function device(opts: { recapture?: boolean } = {}) {
  const provider = createMockProvider(); const local = createMockLocal(); const kv = kvRaw();
  const sheets: Sheet[] = []; const errors: string[] = [];
  const st = { step: "", choice: "cancel" as "keepMine" | "takeCloud" | "cancel", signedIn: true };
  const ui = {
    busy: <T,>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async (ctx: { occasion: string; cloudState?: string }) => { sheets.push({ occasion: ctx.occasion, cloudState: ctx.cloudState, step: st.step }); return st.choice; },
    reportError: (e: unknown) => { errors.push(String((e as Error)?.message ?? e)); },
  } as never;
  const page = () => createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "catsup", provider, ui, validateAdopt: () => true, kv, local, isOnline: () => true, signedIn: () => st.signedIn, skipMigration: true,
    ...(opts.recapture === undefined ? {} : { recaptureLineageOnPush: opts.recapture }) });
  const cloudEtag = (name: string) => (provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name) || (i as { name?: string }).name === name) as { eTag?: string } | undefined)?.eTag ?? null;
  const cloudText = async (name: string) => { const it = provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name)) as { ref?: string; id?: string } | undefined; return it ? asStr(await provider.download(it.ref ?? it.id!)) : null; };
  return { provider, local, kv, sheets, errors, st, page, cloudEtag, cloudText };
}
/** 共用前半：昨天推上 V1，刷新前改成 V2 只落本机，刷新后未登录恢复，再登录。返回第二个页面的 store。 */
async function reloadedDirty(d: ReturnType<typeof device>) {
  const s1 = d.page(); const f1 = s1.file("模型.glb", { mode: "existing" });
  eq((await f1.save(enc("V1"), { tryPush: true })).pushed, true, "V1 推上去了");
  await f1.save(enc("V2"), { tryPush: false });   // 刷新前 30 s 内改了一笔 → flushForHide 只落本机
  await s1.dispose();
  d.st.signedIn = false;
  const s2 = d.page(); const f2 = s2.file("模型.glb", { mode: "existing" });
  assert(await f2.open(), "未登录时本地恢复成功");
  d.st.signedIn = true;                            // 登录落地（CatsUp：refreshOpenDoc 看到脏就跳过，谱系没人补）
  return { s2, f2 };
}

test("[recapture] 云端没人动：登录后 pushAll 直接推上去（修前报 failed『云端已有同名』）", async () => {
  const d = device(); const { s2 } = await reloadedDirty(d);
  const r = await s2.files.dirty.pushAll();
  eq(r.pushed, 1, "推上去"); eq(r.failed.length, 0, "零失败"); eq(r.failures.length, 0, "零失败条目");
  eq(await d.cloudText("模型.glb"), "V2", "云端 = 本机那份");
  eq(d.sheets.length, 0, "零面");
  assert(d.errors.length === 0, "没有报错：" + d.errors.join(" | "));
});

test("[recapture] 云端没人动：自动保存不弹面、直接同步（修前弹『云端和本机各有一版新改动』假面）", async () => {
  const d = device(); const { f2 } = await reloadedDirty(d);
  d.st.step = "autosave";
  const r = await f2.save(enc("V3"), { tryPush: true });
  eq(r.pushed, true, "推上去了"); eq(d.sheets.length, 0, "零面");
  eq(await d.cloudText("模型.glb"), "V3", "云端 = V3");
});

test("[recapture] 云端没人动：图库「处理…」选本地覆盖云端只弹一张面、面说 unchanged（修前两张，第二张说 changed）", async () => {
  const d = device(); const { f2 } = await reloadedDirty(d);
  d.st.step = "resolve"; d.st.choice = "keepMine";
  const r = await f2.resolve();
  eq(r.status, "pushed", "推上去了");
  eq(d.sheets.length, 1, "一张面"); eq(d.sheets[0].cloudState, "unchanged", "面说的是真话：云端还是上次同步的那一版");
});

test("[recapture] 云端真动过（别的设备推了 V9）：不盲推撞 409，直接一张真话的面（changed）；选云端覆盖本地 → 本机那份进备份箱", async () => {
  const d = device(); const { f2 } = await reloadedDirty(d);
  d.provider._seed("模型.glb", "V9");   // 别的设备
  d.st.step = "autosave"; d.st.choice = "takeCloud";
  const r = await f2.save(enc("V3"), { tryPush: true });
  eq(d.sheets.length, 1, "一张面"); eq(d.sheets[0].cloudState, "changed", "面说真话：云端动过");
  eq(r.resolution, "takeCloud", "换世界线透出去（app 据此整份重载）");
  eq(await asStr(await f2.open()), "V9", "本地 = 云端 V9");
  assert((await d.local.listBackup()).length >= 1, "本机那份进了备份箱（永不丢字节）");
});

test("[recapture] 云端真动过 + 选取消：留脏不动，云端不碰；pushAll 的失败条目原因 = conflict", async () => {
  const d = device(); const { s2, f2 } = await reloadedDirty(d);
  d.provider._seed("模型.glb", "V9");
  d.st.choice = "cancel";
  const sv = await f2.save(enc("V3"), { tryPush: true });
  eq(sv.pushed, false, "没推"); eq(await d.cloudText("模型.glb"), "V9", "云端没被碰");
  const pa = await s2.files.dirty.pushAll();
  eq(pa.failed.length, 1, "pushAll 失败 1"); eq(pa.failures[0]?.reason, "conflict", "原因 = conflict（去 resolve）");
  eq(await asStr(await f2.open()), "V3", "本地仍是自己的 V3（open 时弹的面选 cancel = 打开本地）");
});

test("[recapture] 真·新文件撞名（从没同步过，云端已有别的设备建的同名）：护栏不变——mode:new 抛 collision；pushAll 原因 = collision", async () => {
  const d = device();
  d.provider._seed("新.glb", "THEIRS");
  const s = d.page();
  const f = s.file("新.glb", { mode: "new" });
  let threw = "";
  try { await f.save(enc("MINE"), { tryPush: true }); } catch (e) { threw = (e as Error).name; }
  eq(threw, "CloudNameCollisionError", "新建撞名照旧抛（两份都留）");
  // 另一条路：mode:existing 但从没同步过（float）→ 没有 durable etag → 不重捕 → 走 surfaceCollision 面（这是 0.18 的既有行为）
  const g = s.file("浮.glb", { mode: "existing" });
  await g.save(enc("MINE"), { tryPush: false });
  d.provider._seed("浮.glb", "THEIRS");
  const pa = await s.files.dirty.pushAll();
  eq(pa.failures.find((x) => x.name === "浮.glb")?.reason, "collision", "pushAll：撞名的原因 = collision");
  eq(await d.cloudText("浮.glb"), "THEIRS", "云端那份一个字节没动");
});

test("[recapture] 云端问不到（fetchMeta 抛）→ 照旧盲推（撞了由上层 surface，不据此下结论）；开关关掉 → 2.2.0 行为（pushAll 报 failed）", async () => {
  const d = device({ recapture: false }); const { s2 } = await reloadedDirty(d);
  const pa = await s2.files.dirty.pushAll();
  eq(pa.failed.length, 1, "关掉 = 旧行为：盲推撞 409 → failed"); eq(pa.failures[0]?.reason, "collision", "旧行为的原因字 = collision");
});

test("[cloudState] 412 的面：云端确实动过 → changed（真话，不是写死的）", async () => {
  const d = device(); const s = d.page(); const f = s.file("稿.glb", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  d.provider._seed("稿.glb", "V2");          // 别的设备动过 → 下次推 412
  d.st.choice = "cancel";
  await f.save(enc("MINE"), { tryPush: true });
  eq(d.sheets[0]?.cloudState, "changed", "412 → changed（云端确实动过）");
});
