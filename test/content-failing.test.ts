// 冲突面的 contentFailing（2.3.3，2026-11-12）：「文件内容最近下载不下来」这件事实递给宿主，让面说实话。
// created 2026-11-12 by Claude Opus 5.5（小黑屋维修线施工单第 3 条；规矩 = 统筹 Claude Fable 5.2）
//   起因：小黑屋 11-12 办公室那台机器下载文件内容连着失败，user 点离线继续后弹「保留哪一边」，主按钮是「云端覆盖本地」——
//   那一下现在根本完不成（要下载）。规矩：库只记一个事实（这个页面里最近一次下载文件内容失败了、之后还没成功过），
//   叫面时多给一个可选字段；库的派发、先备份再覆盖的顺序一个字不动。
import { readFileSync } from "node:fs";
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createContentHealth } from "../src/works/content-health.ts";
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
type Sheet = { name: string; occasion: string; contentFailing?: boolean; hasKey: boolean };
// rig：真 createStore；provider.download 可以切成「下载不下来」（模拟办公室网络拦了发文件的服务器）。
function rig(choices: Array<"keepMine" | "takeCloud" | "cancel"> = []) {
  const provider = createMockProvider();
  const local = createMockLocal();
  const sheets: Sheet[] = [];
  let blocked = false;
  const origDownload = provider.download.bind(provider);
  provider.download = (ref: string) => (blocked ? Promise.reject(new TypeError("Failed to fetch")) : origDownload(ref));
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async (ctx: { name: string; occasion: string; contentFailing?: boolean }) => {
      sheets.push({ name: ctx.name, occasion: ctx.occasion, contentFailing: ctx.contentFailing, hasKey: "contentFailing" in ctx });
      return choices.shift() ?? "cancel";
    },
    reportError: () => {},
  } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
  return { provider, local, store, sheets, block: (v: boolean) => { blocked = v; } };
}

test("[contentFailing] 下载失败之后弹面 → 真；之后成功下载一次再弹 → 假（开文件那条路）", async () => {
  const { provider, store, sheets, block } = rig();
  const a = store.file("甲.ora", { mode: "existing" });
  const b = store.file("乙.ora", { mode: "existing" });
  await a.save(enc("V1"), { tryPush: true });
  await b.save(enc("V1"), { tryPush: true });
  provider._seed("甲.ora", "CLOUD-NEW-A");             // 别的设备改了两份
  provider._seed("乙.ora", "CLOUD-NEW-B");
  await a.save(enc("MINE-DIRTY"), { tryPush: false }); // 这台也改了甲（大小不同 → 不走比字节的自愈，直接弹面）

  block(true);
  eq(await asStr(await b.open()), "V1", "乙是干净的、云端有新版 → 想快进但下载不下来 → 本地那份照旧打开（不丢、不卡）");
  eq(sheets.length, 0, "乙不弹面");
  await a.open();
  eq(sheets.length, 1, "甲当场弹面");
  eq(sheets[0].occasion, "open", "开文件的场合");
  eq(sheets[0].contentFailing, true, "最近一次下载文件内容失败、之后还没成功 → contentFailing = 真");

  block(false);
  eq(await asStr(await b.open()), "CLOUD-NEW-B", "网通了：乙快进成功（下载成功一次）");
  await a.open();
  eq(sheets.length, 2, "甲还脏、云端还是新版 → 再弹");
  eq(sheets[1].contentFailing, false, "成功下载过一次 → 清掉 → contentFailing = 假");
});

test("[contentFailing] 和出事那天最像：开稿时为了比字节去拉云端，这一拉就下载不下来 → 面上 contentFailing = 真，本机字节不动", async () => {
  const { provider, store, sheets, block } = rig(["cancel"]);
  const a = store.file("日记.ora", { mode: "existing" });
  await a.save(enc("V1"), { tryPush: true });
  provider._seed("日记.ora", "CLOUD-22");              // 别的设备的新版
  await a.save(enc("LOCAL-22"), { tryPush: false });   // 同样大小 → open 先拉云端逐字节比（回执丢失自愈）
  block(true);
  const got = await a.open();
  eq(sheets.length, 1, "比不成 → 照旧弹面（不静默）");
  eq(sheets[0].contentFailing, true, "自愈那一拉失败了 → 面上说实话");
  eq(await asStr(got), "LOCAL-22", "取消 → 本机那份原样打开");
});

test("[contentFailing] 「处理…」（file.resolve）叫的面也带上；从没下载失败过 → 假", async () => {
  const { store, sheets, block } = rig(["cancel", "cancel"]);
  const a = store.file("稿.ora", { mode: "existing" });
  await a.save(enc("V1"), { tryPush: true });
  await a.save(enc("MINE"), { tryPush: false });
  await a.resolve();
  eq(sheets.length, 1, "面弹出来");
  eq(sheets[0].occasion, "push", "push 场合（三键）");
  assert(sheets[0].hasKey, "字段一直给（真或假），不省略");
  eq(sheets[0].contentFailing, false, "这个页面里从没下载失败过 → 假");

  const b = store.file("别的.ora", { mode: "existing" });
  await b.save(enc("X"), { tryPush: true });
  await b.offload();                                   // 本机副本挪掉（云端还在）→ 再开就得下载
  block(true);
  await b.open().catch(() => null);                    // 试图下载一份（本地没有就得下载）——失败
  await a.resolve();
  eq(sheets.length, 2, "再叫一次面");
  eq(sheets[1].contentFailing, true, "中间有一次下载失败 → 真");
});

test("[contentFailing] 记录本身：失败记上、成功清掉；结果和错误原样透传", async () => {
  const h = createContentHealth();
  eq(h.failing(), false, "开始 = 没失败过");
  const boom = new TypeError("Failed to fetch");
  let got: unknown = null;
  try { await h.track(() => Promise.reject(boom)); } catch (e) { got = e; }
  assert(got === boom, "错误原样抛出（同一个对象）");
  eq(h.failing(), true, "失败 → 记上");
  try { await h.track(() => { throw boom; }); } catch { /* 同步抛也算 */ }
  eq(h.failing(), true, "同步抛的也记上");
  eq(await h.track(() => Promise.resolve(42)), 42, "结果原样返回");
  eq(h.failing(), false, "成功一次 → 清掉");
});

test("[contentFailing·守卫] create-store 里每一处叫 ui.resolveConflict 都递 contentFailing", () => {
  const src = readFileSync(new URL("../src/create-store.ts", import.meta.url), "utf8");
  const calls = src.split("\n").filter((l) => /ui\.resolveConflict\(\{/.test(l) && !l.trim().startsWith("//") && !l.trim().startsWith("/**") && !l.trim().startsWith("*"));
  assert(calls.length >= 3, `至少三处（开文件 / 推送撞冲突 / 云端没了），实得 ${calls.length}`);
  const missing = calls.filter((l) => !l.includes("contentFailing: contentHealth.failing()"));
  eq(missing.length, 0, `这几处没递 contentFailing：\n${missing.join("\n")}`);
});
