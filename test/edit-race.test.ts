// 0.15.2 回归：「保存」和「推 / 拉」撞在一起时，库自己要守得住。created 2026-09-29 by Claude Fable 5.1
//   起因：WXHW 两台设备端到端测试（2026-09-29）顺藤摸到库里一个洞——编辑游标（substrate.edits）拆库之后**没有任何人推进过**，
//   于是两处靠它的保护是空的：
//     I1  推送期间又保存了一次 → 推完把 dirty 清掉（dirtyAfter 恒 false）→ 本地躺着没推的字节却显示「已同步」，
//         随后的干净快进 / 腾空间会把它们无备份地吃掉。
//     I2  干净快进（或冲突面选了云端）下载途中又保存了一次 → 下载完照样覆盖本地并清 dirty，刚保存的字节没了、也不在备份箱。
//   user 2026-09-29「同步库的一个洞 修」。宿主（WXHW v2.1.15）已经在自己那层绕开了能碰到的路径；这里是库这一层自己承重。
//   断言按数据安全词典序写：①云端赢家没被静默覆盖 ②本地刚保存的字节还在（在原位或在备份箱）③dirty / 谱系诚实。
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
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/** 可以按住的门：hold() 之后经过它的操作都等着，release() 放行。 */
function gate() {
  let p: Promise<void> | null = null, open: (() => void) | null = null, waiting = 0;
  return {
    hold() { p = new Promise<void>((r) => { open = r; }); },
    release() { const o = open; p = null; open = null; o?.(); },
    async pass() { if (p) { waiting++; try { await p; } finally { waiting--; } } },
    waiting: () => waiting,
  };
}
function rig(choice: () => "keepMine" | "takeCloud" | "cancel" = () => "cancel") {
  const up = gate(), down = gate(), localWrite = gate();
  const provider = createMockProvider({ hook: async (op: string) => { if (op === "upload") await up.pass(); } });
  const origDownload = provider.download.bind(provider);
  provider.download = async (id: string) => { await down.pass(); return origDownload(id); };
  const local = createMockLocal();
  const origSave = local.save.bind(local);
  // 只按住**系统路径**的本地写（云字节覆盖本地那一下，不带 guard）；用户保存（guard="user-save"）照常
  local.save = (async (n: string, b: never, h: never, g?: "user-save") => { if (!g) await localWrite.pass(); return origSave(n, b, h, g as never); }) as never;
  const conflicts: string[] = [];
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ occasion }: { occasion: string }) => { conflicts.push(occasion); return choice(); },
    reportError: () => {},
  } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local,
    isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  const cloudText = async (name: string) => { const it = await provider.getItemByPath(name); return it ? asStr(await origDownload(it.ref)) : null; };
  const backups = async () => Promise.all(((local.listBackup ? await local.listBackup() : []) as Array<{ trashKey: string }>).map(async (b) => asStr(await (local as unknown as { getTrash?: (k: string) => Promise<Blob | null>; get(k: string): Promise<Blob | null> }).get(b.trashKey))));
  return { provider, local, store, conflicts, up, down, localWrite, cloudText, backups };
}

test("[edit-race] I1 推送期间又保存了一次 → 推完仍 dirty（那一次保存的字节还没上云）", async () => {
  const { store, up, cloudText, local } = rig();
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  up.hold();
  const p1 = f.save(enc("V1"), { tryPush: true });            // 上传被按住
  while (!up.waiting()) await tick(1);
  const p2 = f.save(enc("V2"), { tryPush: false });            // 上传途中又保存（只落本地）
  await tick(5);
  up.release();
  const r1 = await p1; await p2;
  eq(r1.pushed, true, "V1 推上去了");
  eq(await cloudText("稿.txt"), "V1", "云端 = V1");
  eq(await asStr(await local.get("稿.txt")), "V2", "本地 = V2（后一次保存）");
  eq(await store.files.dirty.count(), 1, "V2 还没上云 → 必须仍算 dirty（修前 = 0：显示已同步，实际有未推字节）");
  const r3 = await f.save(enc("V2"), { tryPush: true });
  eq(r3.pushed, true, "下一次推送把 V2 推上去（If-Match = V1 的 etag，谱系没断）");
  eq(await cloudText("稿.txt"), "V2");
  eq(await store.files.dirty.count(), 0);
});

test("[edit-race] I2 干净快进的下载途中又保存了一次 → 不覆盖、不清 dirty；之后推送照常撞冲突面", async () => {
  const { store, provider, down, cloudText, local, conflicts, backups } = rig(() => "cancel");
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed("稿.txt", "CLOUD-NEW");                       // 别的设备改了云端
  down.hold();
  const pulling = f.pullIfClean();
  while (!down.waiting()) await tick(1);
  await f.save(enc("MINE"), { tryPush: false });               // 下载途中本机保存
  down.release();
  const r = await pulling;
  assert(r.status !== "fast-forwarded", `下载途中有了本地改动，这次快进必须作罢（实得 ${r.status}）`);
  eq(await asStr(await local.get("稿.txt")), "MINE", "本地刚保存的字节原样还在（修前被 CLOUD-NEW 覆盖，且不在备份箱）");
  eq(await store.files.dirty.count(), 1, "仍 dirty");
  eq(await cloudText("稿.txt"), "CLOUD-NEW", "云端没动");
  const r2 = await f.save(enc("MINE"), { tryPush: true });
  eq(conflicts.filter((o) => o === "push").length, 1, "推送撞 412 → 冲突面（谱系还是 V0 那一版，不会静默盖掉 CLOUD-NEW）");
  eq(r2.pushed, false);
  eq(await cloudText("稿.txt"), "CLOUD-NEW", "选了取消：云端仍是对方的版本");
  void backups;
});

test("[edit-race] I2 冲突面选了云端、下载途中又保存了一次 → 那一次保存的字节也进备份箱，再换成云端版", async () => {
  const { store, provider, down, local, backups } = rig(() => "takeCloud");
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed("稿.txt", "CLOUD-NEW");
  await f.save(enc("MINE-1"), { tryPush: false });             // 本机有未推改动 → 打开时撞冲突面
  down.hold();
  const opening = f.open();                                    // 冲突面 → takeCloud → 先备份 MINE-1 → 下载（被按住）
  while (!down.waiting()) await tick(1);
  await f.save(enc("MINE-2"), { tryPush: false });             // 下载途中又保存
  down.release();
  const blob = await opening;
  eq(await asStr(blob), "CLOUD-NEW", "用户选了云端：打开的是云端版");
  eq(await asStr(await local.get("稿.txt")), "CLOUD-NEW");
  const bk = await backups();
  assert(bk.includes("MINE-1"), `第一份留底在（${JSON.stringify(bk)}）`);
  assert(bk.includes("MINE-2"), `下载途中保存的那一份也留底了（修前没有：MINE-2 被直接覆盖）（${JSON.stringify(bk)}）`);
  eq(await store.files.dirty.count(), 0, "本地 = 云端版，干净");
});

test("[edit-race] I2 云字节正在落盘的那一下又保存了一次 → 不标干净；后写的那份留在本地，推送撞冲突面", async () => {
  const { store, provider, localWrite, cloudText, local, conflicts } = rig(() => "cancel");
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed("稿.txt", "CLOUD-NEW");
  localWrite.hold();
  const pulling = f.pullIfClean();                             // 下载完、进了临界段、云字节落盘被按住
  while (!localWrite.waiting()) await tick(1);
  const saving = f.save(enc("MINE"), { tryPush: false });      // 这一下保存排在它后面落盘
  await tick(5);
  localWrite.release();
  const r = await pulling; await saving;
  assert(r.status !== "fast-forwarded", `落盘途中有了本地改动，不能报快进成功（实得 ${r.status}）`);
  eq(await asStr(await local.get("稿.txt")), "MINE", "后写的那份（用户的）留在本地");
  eq(await store.files.dirty.count(), 1, "仍 dirty（修前 = 0：本地是旧世界 + 新改动，却标成干净且谱系指向云端新版 → 下次推送静默盖掉 CLOUD-NEW）");
  await f.save(enc("MINE"), { tryPush: true });
  eq(conflicts.filter((o) => o === "push").length, 1, "推送撞冲突面");
  eq(await cloudText("稿.txt"), "CLOUD-NEW", "云端赢家没被静默覆盖");
});

test("[edit-race] 没有撞车时一切照旧：干净快进成功、推送后干净", async () => {
  const { store, provider, local } = rig();
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  eq(await store.files.dirty.count(), 0);
  provider._seed("稿.txt", "CLOUD-NEW");
  const r = await f.pullIfClean();
  eq(r.status, "fast-forwarded");
  eq(await asStr(await local.get("稿.txt")), "CLOUD-NEW");
  eq(await store.files.dirty.count(), 0);
  const again = await f.pullIfClean();
  eq(again.status, "in-sync");
});
