// 0.15.2 回归：「保存」和「推 / 拉」撞在一起时，库自己要守得住。created 2026-09-29 by Claude Fable 5.1
//   起因：WXHW 两台设备端到端测试（2026-09-29）顺藤摸到库里一个洞——编辑游标（substrate.edits）拆库之后**没有任何人推进过**，
//   于是两处靠它的保护是空的：
//     I1  推送期间又保存了一次 → 推完把 dirty 清掉（dirtyAfter 恒 false）→ 本地躺着没推的字节却显示「已同步」，
//         随后的干净快进 / 腾空间会把它们无备份地吃掉。
//     I2  干净快进（或冲突面选了云端）下载途中又保存了一次 → 下载完照样覆盖本地并清 dirty，刚保存的字节没了、也不在备份箱。
//   user 2026-09-29「同步库的一个洞 修」。宿主（WXHW v2.1.15）已经在自己那层绕开了能碰到的路径；这里是库这一层自己承重。
//   断言按数据安全词典序写：①云端赢家没被静默覆盖 ②本地刚保存的字节还在（在原位或在备份箱）③dirty / 谱系诚实。
import { test, todo, eq, assert } from "./runner.mjs";
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

// ── 2.3.2（家族周账 F-238 = F-188 的复现；设计稿 = 家族根 ai-docs/20261110-design-store-save-gen-fix.md；2026-11-10 Claude Opus 5.5）──
//   宣布「这份文件已经和网盘一致」（清待传 / 把网盘版本号记成基准）的那一刻，盘上必须就是我对过 / 推过 / 写下的那一份，而且没有发出了还没落盘的保存。
//   以前靠「保存过几次」近似：那个数在保存**发出**时就加了，字节过一会儿才落盘——中间这一下进来的推送拿着旧字节、看见数没变，就宣布一致。
//   I3 三段原是复现脚本 test/repro/f188-dirty-cleared-before-bytes-land.repro.ts（Fable 5.2 2026-11-10 写的，已删）。I4–I9 是设计稿第三节读代码推的时序。
//   断言照旧按数据安全词典序：①网盘赢家没被静默覆盖 ②本机刚保存的字节还在（原位或备份箱）③待传 / 谱系诚实（没传完就不许说传完了）。

/** I3–I9 的架子：在 rig() 之上多几道门。opts.gateLocal / opts.gateEnc 不开时一层包装都不加——I3 的时序就是「多一个微任务都不复现」那么窄。 */
function rig2(o: { gateLocal?: boolean; gateEnc?: boolean; password?: () => string | null; maxAttempts?: number } = {}) {
  const up = gate(), down = gate(), userWrite = gate(), sealGate = gate(), packGate = gate();
  const provider = createMockProvider({ hook: async (op: string) => { if (op === "upload") await up.pass(); } });
  const origDownload = provider.download.bind(provider);
  provider.download = async (id: string) => { await down.pass(); return origDownload(id); };
  const local = createMockLocal();
  const ctl = {
    choice: (_occasion: string): "keepMine" | "takeCloud" | "cancel" | Promise<"keepMine" | "takeCloud" | "cancel"> => "cancel",
    failNextUserSave: null as Error | null,
    holdSealOf: null as string | null,   // 封装（looksEncryptedContainer）碰到这份内容时停在 sealGate（只停一次）
    holdNextPack: false,                 // 下一次 packContainer 停在 packGate（只停一次）
  };
  if (o.gateLocal) {
    const origSave = local.save.bind(local);
    local.save = (async (n: string, b: never, h: never, g?: "user-save") => {
      if (g) { await userWrite.pass(); if (ctl.failNextUserSave) { const e = ctl.failNextUserSave; ctl.failNextUserSave = null; throw e; } }
      return origSave(n, b, h, g as never);
    }) as never;
  }
  const encryption = createMockEncryption();
  if (o.gateEnc) {
    const origLooks = encryption.looksEncryptedContainer.bind(encryption), origPack = encryption.packContainer.bind(encryption);
    encryption.looksEncryptedContainer = async (b: Blob | Uint8Array) => { if (ctl.holdSealOf != null && (await asStr(b)) === ctl.holdSealOf) { ctl.holdSealOf = null; await sealGate.pass(); } return origLooks(b); };
    encryption.packContainer = async (x: Parameters<typeof origPack>[0]) => { if (ctl.holdNextPack) { ctl.holdNextPack = false; await packGate.pass(); } return origPack(x); };
  }
  const conflicts: string[] = [];
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ occasion }: { occasion: string }) => { conflicts.push(occasion); return await ctl.choice(occasion); },
    reportError: () => {},
  } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption, persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local,
    isOnline: () => true, signedIn: () => true, skipMigration: true,
    crypt: { getPassword: o.password ?? (() => null) },
    ...(o.maxAttempts ? { pushRetry: { maxAttempts: o.maxAttempts } } : {}),
  });
  const cloudText = async (name: string) => { const it = await provider.getItemByPath(name); return it ? asStr(await origDownload(it.ref)) : null; };
  const backups = async () => Promise.all(((local.listBackup ? await local.listBackup() : []) as Array<{ trashKey: string }>).map(async (b) => asStr(await (local as unknown as { get(k: string): Promise<Blob | null> }).get(b.trashKey))));
  const dirty = () => store.files.dirty.count();
  const here = async (name: string) => asStr(await local.get(name));
  return { provider, local, store, encryption, conflicts, ctl, up, down, userWrite, sealGate, packGate, cloudText, backups, dirty, here };
}
/** 本机比网盘新，却算都传完了 = 这一组测试要拦的那一个错。 */
const notLying = (cloud: string | null, mine: string | null, dirty: number) => assert(!(cloud !== mine && dirty === 0), `本机比网盘新却算都传完了：网盘=${cloud} 本机=${mine} 待传=${dirty}`);

for (const [label, between] of [["同一刻", async () => {}], ["隔一个微任务", async () => { await Promise.resolve(); }]] as const) {
  test(`[edit-race] I3-a 自动保存（只落本机）撞上自动续推（dirty.pushAll），${label} → 续推排在保存后面，推的就是后存的那份`, async () => {
    const { store, cloudText, dirty, here } = rig2();
    const f = store.file("稿.txt", { mode: "existing" });
    await f.save(enc("V0"), { tryPush: true });
    await f.save(enc("V1"), { tryPush: false });        // 上一次自动保存：待传 = 1
    const p2 = f.save(enc("V2"), { tryPush: false });   // 又一次自动保存（不等）
    await between();
    const pa = store.files.dirty.pushAll();             // 回前台 / 回线 / 登录后的自动续推
    await p2; await pa;
    notLying(await cloudText("稿.txt"), await here("稿.txt"), await dirty());
    eq(await here("稿.txt"), "V2");
    eq(await cloudText("稿.txt"), "V2", "推上去的就是 V2");
    eq(await dirty(), 0);
  });
}

test("[edit-race] I3-b 存并推紧跟一次只落本机的保存 → 推的是前一份，推完仍算待传；下一次推把后一份推上去，谱系不断", async () => {
  const { store, cloudText, dirty, here, conflicts } = rig2();
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  const p1 = f.save(enc("V1"), { tryPush: true });
  const p2 = f.save(enc("V2"), { tryPush: false });
  await p1; await p2;
  notLying(await cloudText("稿.txt"), await here("稿.txt"), await dirty());
  eq(await here("稿.txt"), "V2", "盘上 = 后存的那份");
  eq(await cloudText("稿.txt"), "V1", "推上去的是 V1（那次保存自己的字节）");
  eq(await dirty(), 1, "V2 还没上云 → 待传 = 1（修前 = 0）");
  const r3 = await f.save(enc("V2"), { tryPush: true });
  eq(r3.pushed, true, "下一次推送把 V2 推上去（If-Match = V1 的版本号）");
  eq(await cloudText("稿.txt"), "V2");
  eq(await dirty(), 0);
  eq(conflicts.length, 0, "一张面都没弹");
});

test("[edit-race] I3-c 前一次保存的写盘卡了 0.3 秒，期间来了后一次保存；之后别的设备改了网盘 → 不快进、后一份不被吃掉", async () => {
  const { store, local, provider, cloudText, dirty, here } = rig2();
  let calls = 0, waiting = false, open: (() => void) | null = null;
  const hold = new Promise<void>((r) => { open = r; });
  const origSave = local.save.bind(local);
  local.save = (async (n: string, b: never, h: never, g?: "user-save") => { calls++; if (g && calls === 2) { waiting = true; await hold; } return origSave(n, b, h, g as never); }) as never;
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  const p1 = f.save(enc("V1"), { tryPush: true });
  while (!waiting) await tick(1);
  await tick(300);                                      // 这一次写盘卡了 0.3 秒（大文件 / 加密）
  const p2 = f.save(enc("V2"), { tryPush: false });     // 这期间来了一次自动保存
  await tick(5); open!();
  await p1; await p2;
  notLying(await cloudText("稿.txt"), await here("稿.txt"), await dirty());
  eq(await dirty(), 1, "V2 没上云 → 待传 = 1");
  provider._seed("稿.txt", "CLOUD-NEW");               // 别的设备改了网盘
  const r = await f.pullIfClean();
  assert(r.status !== "fast-forwarded", `有没传上去的字节，不许干净快进（实得 ${r.status}）`);
  eq(await here("稿.txt"), "V2", "V2 还在（修前：被 CLOUD-NEW 换掉、也没留底）");
  eq(await cloudText("稿.txt"), "CLOUD-NEW", "网盘赢家没被动");
});

test("[edit-race] I4 两次保存叠着、先发出的那次封装慢 → 盘上最后是后发出的那份（落盘顺序 = 发出顺序）", async () => {
  const { store, ctl, sealGate, cloudText, dirty, here } = rig2({ gateEnc: true });
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  sealGate.hold(); ctl.holdSealOf = "V1";
  const p1 = f.save(enc("V1"), { tryPush: false });
  while (!sealGate.waiting()) await tick(1);
  const p2 = f.save(enc("V2"), { tryPush: false });
  await tick(20);
  sealGate.release();
  await p1; await p2;
  eq(await here("稿.txt"), "V2", "后发出的 V2 是最后一份（修前 = V1：封装快的 V2 先落、慢的 V1 后落把它盖掉）");
  eq(await dirty(), 1);
  eq(await cloudText("稿.txt"), "V0");
});

test("[edit-race] I5 一次保存发出了还没落盘时，冲突面选了「云端覆盖本地」→ 那次保存先落盘、进备份箱，再被网盘那版覆盖", async () => {
  const { store, provider, ctl, userWrite, dirty, here, backups } = rig2({ gateLocal: true });
  ctl.choice = () => "takeCloud";
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed("稿.txt", "CLOUD-NEW");
  await f.save(enc("MINE-1"), { tryPush: false });     // 本机有没推的改动 → 打开时撞冲突面
  userWrite.hold();
  const p2 = f.save(enc("MINE-2"), { tryPush: false }); // 发出了，写盘被按住
  while (!userWrite.waiting()) await tick(1);
  const opening = f.open();                             // 冲突面 → 云端覆盖本地 → 先备份 → 拉 → 覆盖
  await tick(30);
  userWrite.release();
  const blob = await opening; await p2;
  eq(await asStr(blob), "CLOUD-NEW", "人选了云端：打开的是云端版");
  eq(await here("稿.txt"), "CLOUD-NEW");
  const bk = await backups();
  assert(bk.includes("MINE-1"), `第一份留底在（${JSON.stringify(bk)}）`);
  assert(bk.includes("MINE-2"), `还没落盘的那次保存也留底了（修前没有：它落盘之后被直接覆盖）（${JSON.stringify(bk)}）`);
  eq(await dirty(), 0, "本机 = 网盘版，干净");
});

test("[edit-race] I6 一次保存发出了还没落盘时「加密这篇」→ 盘上是加密容器（不是明文），那次保存的字节仍算待传", async () => {
  let pw: string | null = "pw";
  const { store, encryption, ctl, packGate, local, dirty } = rig2({ gateEnc: true, password: () => pw });
  const f = store.file("密.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  packGate.hold(); ctl.holdNextPack = true;
  const pe = f.encrypt();                               // 进了队、打包被按住（还没写盘）
  while (!packGate.waiting()) await tick(1);
  const ps = f.save(enc("V1"), { tryPush: false });     // 这一下发出的保存
  await tick(20);
  packGate.release();
  const re = await pe; await ps;
  eq(re.status, "swapped");
  const atRest = await local.get("密.txt");
  assert(atRest && await encryption.looksEncryptedContainer(atRest instanceof Blob ? atRest : new Blob([atRest as BlobPart])), "盘上是加密容器（修前 = 明文 V1：保存按「还没加密」封好、在加密之后才落盘）");
  const opened = await encryption.unpackContainer(atRest as Blob, "pw");
  eq(await asStr(opened.dataBlob), "V1", "容器里是 V1");
  eq(await dirty(), 1, "V1 没上云 → 待传 = 1（修前 = 0：加密那一步把待传清了）");
  void pw;
});

test("[edit-race] I7 推送撞冲突、人选了「本地覆盖云端」，问的时候又来一次保存 → 推完仍算待传；下一次推照常", async () => {
  const { store, provider, ctl, cloudText, dirty, here, conflicts } = rig2();
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed("稿.txt", "CLOUD-NEW");
  let p2: Promise<unknown> | null = null;
  ctl.choice = (occ) => { if (occ === "push" && !p2) p2 = f.save(enc("MINE-2"), { tryPush: false }); return "keepMine"; };
  const r1 = await f.save(enc("MINE-1"), { tryPush: true });
  await p2;
  eq(r1.resolution, "keepMine");
  eq(await cloudText("稿.txt"), "MINE-1", "人选了本地覆盖云端：网盘 = MINE-1");
  eq(await here("稿.txt"), "MINE-2");
  notLying(await cloudText("稿.txt"), await here("稿.txt"), await dirty());
  eq(await dirty(), 1, "MINE-2 没上云（修前 = 0）");
  const r3 = await f.save(enc("MINE-2"), { tryPush: true });
  eq(r3.pushed, true); eq(await cloudText("稿.txt"), "MINE-2"); eq(await dirty(), 0);
  eq(conflicts.filter((x) => x === "push").length, 1, "只问过一次");
});

test("[edit-race] I8-a 上传回执丢了，之后发出一次保存、紧接着自动续推 → 推的是后存的那份；比不上就留着待传，不认领", async () => {
  const { store, provider, cloudText, dirty, here } = rig2({ maxAttempts: 1 });
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider.injectFault({ op: "upload", kind: "lostResponse" });
  await f.save(enc("V1"), { tryPush: true });           // 网盘收到了 V1，回执没回来：这台以为没推成
  eq(await cloudText("稿.txt"), "V1"); eq(await dirty(), 1);
  const p2 = f.save(enc("V2"), { tryPush: false });
  const pa = store.files.dirty.pushAll();
  await p2; await pa;
  notLying(await cloudText("稿.txt"), await here("稿.txt"), await dirty());
  eq(await here("稿.txt"), "V2");
  eq(await dirty(), 1, "V2 没上云（修前 = 0：续推拿着 V1 去比、比上了就认领，随后 V2 落盘）");
  eq(await cloudText("稿.txt"), "V1", "网盘没被盲盖");
});

test("[edit-race] I8-b 上传回执丢了、重推时自愈（逐字节一样）的那一下又来一次保存 → 认领那一版，但仍算待传；下一次推照常", async () => {
  const { store, provider, down, cloudText, dirty, here, conflicts } = rig2({ maxAttempts: 1 });
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider.injectFault({ op: "upload", kind: "lostResponse" });
  await f.save(enc("V1"), { tryPush: true });
  down.hold();
  const pa = store.files.dirty.pushAll();               // 推本机 V1 → 412 → 拉网盘逐字节比（被按住）
  while (!down.waiting()) await tick(1);
  const p2 = f.save(enc("V2"), { tryPush: false });
  await tick(5); down.release();
  const ra = await pa; await p2;
  eq(ra.pushed, 1, "V1 认领了（自愈）");
  eq(await cloudText("稿.txt"), "V1"); eq(await here("稿.txt"), "V2");
  eq(await dirty(), 1, "V2 没上云");
  const r3 = await f.save(enc("V2"), { tryPush: true });
  eq(r3.pushed, true, "谱系接在 V1 上，直接推上去"); eq(await cloudText("稿.txt"), "V2"); eq(await dirty(), 0);
  eq(conflicts.length, 0);
});

test("[edit-race] I9 保存没落成（写盘抛错 / 锁着封不上）→ 不会永远卡在待传：之后的推送照常宣布一致", async () => {
  let pw: string | null = "pw";
  const { store, ctl, cloudText, dirty, here } = rig2({ gateLocal: true, password: () => pw });
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  ctl.failNextUserSave = Object.assign(new Error("mock: quota"), { name: "QuotaExceededError" });
  let threw = "";
  try { await f.save(enc("V1"), { tryPush: true }); } catch (e) { threw = (e as Error).name; }
  eq(threw, "QuotaExceededError", "写盘抛的错照样从 save() 抛给调用方");
  const r = await f.save(enc("V2"), { tryPush: true });
  eq(r.pushed, true); eq(await cloudText("稿.txt"), "V2"); eq(await here("稿.txt"), "V2");
  eq(await dirty(), 0, "没落成的那次不算在路上（修错了的样子 = 待传永远不归零）");
  // 锁着封不上：加密稿没口令时保存抛 LockedError，同样不卡住后面的
  const g = store.file("锁.txt", { mode: "existing" });
  await g.save(enc("L0"), { tryPush: true });
  eq((await g.encrypt()).status, "swapped");
  pw = null;
  threw = "";
  try { await g.save(enc("L1"), { tryPush: true }); } catch (e) { threw = (e as Error).name; }
  eq(threw, "LockedError");
  pw = "pw";
  const r2 = await g.save(enc("L2"), { tryPush: true });
  eq(r2.pushed, true);
  eq(await dirty(), 0);
});
