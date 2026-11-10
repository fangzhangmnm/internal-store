// 复现（**不在 test/run.mjs 里**——库修好之前它是红的；修的时候把它搬进 edit-race.test.ts 当回归）。
// created 2026-11-10 by Claude Fable 5.2 —— 家族周账 F-188「dirty.count() 在上传落地前归零，要在库里复现」。只读审计：库的源码一行没动。
// 用法：node test/repro/f188-dirty-cleared-before-bytes-land.repro.ts      退出码 1 = 还能复现；0 = 修好了。
//
// 现象：本机盘上的字节比网盘新，待传记号却被清掉（dirty.count() = 0、图库显示「已同步」）。
//   之后别的设备改了网盘 → 这台「干净快进」把本机那份直接换掉，没留底（下面第 3 段跑给你看）。
// 时序：一次保存发出之后、它的字节落到本机之前，有一次推送进了同名串行段。
//   ① save() 一进来就 head.recordEdit(name)（保存计数 +1），然后才 toU8 / seal / 排进串行段写本机；
//   ② 推送（doPush）在串行段里开头记 e0 = 保存计数——这时已经是 +1 之后的数；它手里的字节却是上一份
//      （save 自己那份闭包里的 sealed，或 pushLocalBytes 读到的盘上旧字节）；
//   ③ 推完 editedSince() = 计数没变 = false → onPushed(etag, dirtyAfter=false) 清掉待传；随后那次保存的字节才落本机。
//   test/edit-race.test.ts 的 I1 只盖了「上传**开始之后**又保存」（那时计数在 e0 之后才涨，是对的）。
// 被违反的不变量：清掉待传记号的那一刻，网盘上那一版必须和本机盘上的字节是同一份。
// 修法方向（没做，改库要先问 user）：每次保存在**发出时**同步拿一个号并占好同名串行段的位置（落本机的顺序 = 发出的顺序）；
//   字节落本机时记下「盘上现在是几号」；推送记下它手里那份字节是几号（save 自己的号 / 读盘时盘上的号）；
//   清待传的条件 = 推上去的号 == 最新发出的号。
import { TEST_KINDS } from "../kinds.mjs";
import { createStore } from "../../src/create-store.ts";
import { createMockProvider } from "../../src/testing/mock-provider.ts";
import { createMockEncryption } from "../../src/testing/mock-encryption.ts";
import { createMockLocal } from "../../src/testing/mock-local.ts";

const enc = (s: string) => new TextEncoder().encode(s);
const asStr = async (x: unknown): Promise<string | null> => x == null ? null : x instanceof Blob ? await x.text() : new TextDecoder().decode(x instanceof Uint8Array ? x : new Uint8Array(x as ArrayBuffer));
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
function kvRaw() { const m = new Map<string, string>(); return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] }; }
function rig(slowLocal?: { until: () => Promise<void>; onCall: (n: number) => boolean }) {
  const provider = createMockProvider({});
  const origDownload = provider.download.bind(provider);
  const local = createMockLocal();
  if (slowLocal) {
    const origSave = local.save.bind(local); let calls = 0;
    local.save = (async (n: string, b: never, h: never, g?: "user-save") => { calls++; if (g && slowLocal.onCall(calls)) await slowLocal.until(); return origSave(n, b, h, g as never); }) as never;
  }
  const ui = { busy: <T,>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => "cancel", reportError: () => {} } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none", appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
  const cloudText = async (name: string) => { const it = await provider.getItemByPath(name); return it ? asStr(await origDownload(it.ref)) : null; };
  return { store, local, provider, cloudText };
}
let reproduced = 0;
const verdict = (label: string, cloud: string | null, loc: string | null, dirty: number): boolean => {
  const bad = cloud !== loc && dirty === 0; if (bad) reproduced++;
  console.log(`${bad ? "✗ 复现" : "✓ 没问题"}  ${label}：网盘=${cloud} 本机=${loc} 待传计数=${dirty}${bad ? "  ← 本机比网盘新，却算都传完了" : ""}`);
  return bad;
};

// 1. 自动保存（只落本机）撞上自动续推（回前台 / 回线 / 登录后的 dirty.pushAll）。app 没有叠着发两次保存。
for (const [label, between] of [["同一刻", async () => {}], ["隔一个微任务", async () => { await Promise.resolve(); }], ["隔 0 ms 定时器（对照：这个时序是对的）", async () => { await tick(0); }]] as const) {
  const { store, local, cloudText } = rig();
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  await f.save(enc("V1"), { tryPush: false });        // 上一次自动保存：待传 = 1
  const p2 = f.save(enc("V2"), { tryPush: false });   // 又一次自动保存（不等）
  await between();
  const pa = store.files.dirty.pushAll();             // 自动续推
  await p2; await pa;
  verdict(`① 自动保存 + 自动续推，${label}`, await cloudText("稿.txt"), await asStr(await local.get("稿.txt")), await store.files.dirty.count());
}

// 2. 「存并推」紧跟一次「只落本机」的保存（app 自己叠着发了两次）。
{
  const { store, local, cloudText } = rig();
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  const p1 = f.save(enc("V1"), { tryPush: true });
  const p2 = f.save(enc("V2"), { tryPush: false });
  await p1; await p2;
  verdict("② 存并推 + 紧跟一次只落本机的保存", await cloudText("稿.txt"), await asStr(await local.get("稿.txt")), await store.files.dirty.count());
}

// 3. 真实情况：第一次保存的本机写入要花时间（大文件 / 加密）。窗口 = 整段写入时间。再看后果。
{
  let open: (() => void) | null = null, waiting = false;
  const hold = new Promise<void>((r) => { open = r; });
  const { store, local, provider, cloudText } = rig({ onCall: (n) => n === 2, until: async () => { waiting = true; await hold; } });
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  const p1 = f.save(enc("V1"), { tryPush: true });
  while (!waiting) await tick(1);
  await tick(300);                                     // 这一次本机写入卡了 0.3 秒
  const p2 = f.save(enc("V2"), { tryPush: false });    // 这期间来了一次自动保存
  await tick(5); open!();
  await p1; await p2;
  const bad = verdict("③ 第一次保存的本机写入花了 0.3 秒，这期间来了第二次保存", await cloudText("稿.txt"), await asStr(await local.get("稿.txt")), await store.files.dirty.count());
  if (bad) {
    provider._seed("稿.txt", "CLOUD-NEW");             // 别的设备改了网盘
    const r = await f.pullIfClean();
    const after = await asStr(await local.get("稿.txt"));
    const bk = (local.listBackup ? await local.listBackup() : []) as unknown[];
    console.log(`   后果：别的设备改了网盘、这台去核对 → ${r.status}；本机现在=${after}；备份箱 ${bk.length} 份${after !== "V2" && bk.length === 0 ? "  ← V2 没了，也没留底" : ""}`);
  }
}
console.log(reproduced ? `\n还能复现（${reproduced} 处）` : "\n修好了：把这份搬进 edit-race.test.ts 当回归");
process.exit(reproduced ? 1 : 0);
