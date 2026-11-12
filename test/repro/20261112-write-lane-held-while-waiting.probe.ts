// 探针（**不在 test/run.mjs 里**）：同一份文件的写队，在等人回答、等网络的时候被占着——后面的保存落不了盘。
// created 2026-11-12 by Claude Fable 5.2（小黑屋维修线统筹；重审「小黑屋连不上云端」那天写的，原来只在临时目录里，留底搬进来）
//   家族周账 F-268；安全模型 `ai-docs/20261016-data-safety-model.md` 第三节 F1 / F4；
//   小黑屋仓 `ai-docs/20261112-content-download-failure-repair-plan.md` 第六节。
// 用法：node test/repro/20261112-write-lane-held-while-waiting.probe.ts
//   退出码 1 = 第一段还能复现（库这一头没改，是记着的结构问题）；0 = 第一段不再复现。
//   第二段是回归用的：下载不通时三个钮各按三次，两边字节必须都在——哪一项不对也退出 1。
//
// 第一段在说什么：
//   推送（doPush）整个站在同名串行段里；推送撞了冲突要问人，`await ui.resolveConflict(...)` 也在这一段里。
//   save() 的本机写入排在同一条串行段上。所以冲突面亮着的时候，这份文件后面的每一次保存（包括 tryPush:false 只落本机的）
//   都排在它后面。面要是一直没人回答（宿主的面被别的面盖掉了、界面出错没画出来），这些保存永远落不了盘：
//   字只在宿主的内存里，关页面就没了，库和宿主的界面上都看不出来。
//   小黑屋 v3.0.21 在宿主这一头修了「面被盖掉」（问人的面排队、一个不丢）。库这一头没动：
//   等人的时候不该占着写队——同理，上传在飞的那段时间里后面的保存也都排着（慢网上可以是几十秒到几分钟）。
//   这是设计题（0.15.2 把「核对 + 覆盖本地 + 提交谱系」和用户保存的本机写放在同一条队上是有原因的），
//   下一次动冲突或保存这条路之前先出设计，不要顺手改。
import { createStore } from "../../src/create-store.ts";
import { createMockProvider } from "../../src/testing/mock-provider.ts";
import { createMockEncryption } from "../../src/testing/mock-encryption.ts";
import { createMockLocal } from "../../src/testing/mock-local.ts";
import { TEST_KINDS } from "../kinds.mjs";

const enc = (s: string) => new TextEncoder().encode(s);
const str = async (x: unknown): Promise<string | null> =>
  x == null ? null : x instanceof Blob ? await x.text() : new TextDecoder().decode(x instanceof Uint8Array ? x : new Uint8Array(x as ArrayBuffer));
const kvRaw = () => {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] };
};
const HUNG = Symbol("hung");
const within = <T,>(p: Promise<T>, ms: number): Promise<T | typeof HUNG> => Promise.race([p, new Promise<typeof HUNG>((r) => setTimeout(() => r(HUNG), ms))]);

function rig(answer: (ctx: unknown) => Promise<string>) {
  const provider = createMockProvider();
  const local = createMockLocal();
  let blocked = false;
  const origDownload = provider.download.bind(provider);
  provider.download = (ref: string) => (blocked ? Promise.reject(new TypeError("Failed to fetch")) : origDownload(ref));
  const ui = { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: answer, reportError: () => {} } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
  return { provider, local, store, block: (v: boolean) => { blocked = v; } };
}
async function cloudState(provider: ReturnType<typeof createMockProvider>): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (folder: string): Promise<void> => {
    for (const it of await provider.list(folder).catch(() => [])) {
      const p = (folder ? folder + "/" : "") + it.name;
      if (it.isFolder) await walk(p); else out[p] = (await str(await provider.download(it.ref))) ?? "";
    }
  };
  await walk(""); await walk(".backup");
  return out;
}
const localBytes = async (local: ReturnType<typeof createMockLocal>, name: string) => str(await local.get(name));
const localBackups = async (local: ReturnType<typeof createMockLocal>) => (local.listBackup ? (await local.listBackup()).length : -1);

let reproduced = 0, broken = 0;
const say = (ok: boolean, label: string, detail: string) => console.log(`${ok ? "✓ 没问题" : "✗"}  ${label}：${detail}`);

// ── 第一段：冲突面永远没人回答 → 这份文件后面的保存落不落盘 ──
{
  const r = rig(() => new Promise<string>(() => {}));   // 永不回答
  const f = r.store.file("日记.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  r.provider._seed("日记.ora", "CLOUD-NEW");
  const s1 = f.save(enc("弹面之前打的字"), { tryPush: true });                 // → 412 → 弹面 → 没人回答
  const first = await within(s1, 1500);
  const s2 = f.save(enc("弹面之后打的字"), { tryPush: false });                // 宿主之后每一次只落本机的保存
  const second = await within(s2, 3000);
  const disk = await localBytes(r.local, "日记.ora");
  const held = first === HUNG && second === HUNG && disk === "弹面之前打的字";
  if (held) reproduced++;
  say(!held, "冲突面没人回答时，之后只落本机的保存", held
    ? `3 秒内没有返回，本机盘上还是「${disk}」 ← 之后打的字只在内存里（还能复现）`
    : `返回了，本机盘上是「${disk}」`);
}

// ── 第二段：下载不通时三个钮各按三次，两边字节 ──
for (const choice of ["takeCloud", "keepMine", "cancel"] as const) {
  const r = rig(async () => choice);
  const f = r.store.file("日记.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  r.provider._seed("日记.ora", "CLOUD-NEW");
  await f.save(enc("MINE"), { tryPush: false });
  r.block(true);
  for (let i = 0; i < 3; i++) { try { await within(f.save(enc("MINE"), { tryPush: true }), 3000); } catch { /* 抛错也算一种结局，下面看字节 */ } }
  r.block(false);
  const disk = await localBytes(r.local, "日记.ora");
  const backups = await localBackups(r.local);
  const cloud = await cloudState(r.provider);
  const cloudBackups = Object.entries(cloud).filter(([k]) => k.startsWith(".backup/")).map(([, v]) => v);
  let ok: boolean, detail: string;
  if (choice === "takeCloud") {
    ok = disk === "MINE" && cloud["日记.ora"] === "CLOUD-NEW" && backups >= 1;
    detail = `没换成：本机「${disk}」、网盘「${cloud["日记.ora"]}」、本机留底 ${backups} 份`;
  } else if (choice === "keepMine") {
    ok = disk === "MINE" && cloud["日记.ora"] === "MINE" && cloudBackups.includes("CLOUD-NEW");
    detail = `换成了：网盘「${cloud["日记.ora"]}」、被换下的在网盘备份箱里 = ${cloudBackups.includes("CLOUD-NEW")}`;
  } else {
    ok = disk === "MINE" && cloud["日记.ora"] === "CLOUD-NEW" && cloudBackups.length === 0;
    detail = `两边没动：本机「${disk}」、网盘「${cloud["日记.ora"]}」`;
  }
  if (!ok) broken++;
  say(ok, `下载不通时「${choice}」按三次`, detail);
}

console.log(reproduced ? `\n第一段还能复现（库这一头没改；周账 F-268）` : `\n第一段不再复现：把它搬进 test/ 当回归`);
if (broken) console.log(`第二段有 ${broken} 项不对 ← 这是回归，不是已知问题`);
process.exit(reproduced || broken ? 1 : 0);
