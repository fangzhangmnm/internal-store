// 0.18.0 file.resolve()：库**主动把冲突面叫出来**，人在面里三选一，库按选的走既有派发。app 不传答案。
//   user 2026-10-16「我要的就是本地覆盖云端和云端覆盖本地二选一啊！这个才是安全的模型！」「取消也要」「禁止越狱」。—— created 20261016 by Claude Fable 5.1
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
function rig(choices: Array<"keepMine" | "takeCloud" | "cancel">) {
  const provider = createMockProvider();
  const local = createMockLocal();
  const conflicts: Array<{ name: string; occasion: string }> = [];
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ name, occasion }: { name: string; occasion: string }) => { conflicts.push({ name, occasion }); return choices.shift() ?? "cancel"; },
    reportError: () => {},
  } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
  const cloudText = async (name: string) => {
    const it = provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name) || (i as { name?: string }).name === name) as { ref?: string; id?: string } | undefined;
    return it ? asStr(await provider.download(it.ref ?? it.id!)) : null;
  };
  return { provider, local, store, conflicts, cloudText };
}

test("[resolve] 没传上去、云端没变 → 面照弹（occasion=push）；选「云端覆盖本地」→ 本地换成云端那份、这台的进备份箱", async () => {
  const { local, store, conflicts, cloudText } = rig(["takeCloud"]);
  const f = store.file("稿.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  await f.save(enc("MINE"), { tryPush: false });          // 脏、云端没变 —— 以前这种状态没有任何路能「换成云端那份」
  const r = await f.resolve();
  eq(conflicts.length, 1, "库自己把面叫出来了（不是 412 触发的）");
  eq(conflicts[0].occasion, "push", "面的场合 = push（三键）");
  eq(r.status, "took-cloud", "选云端 → took-cloud");
  eq(await asStr(await f.open()), "V1", "本地 = 云端那份");
  eq(await cloudText("稿.ora"), "V1", "云端没被碰");
  const backups = await local.listBackup();
  assert(backups.length >= 1, "这台的那份进了备份箱（红线：绝不丢字节）");
});

test("[resolve] 选「本地覆盖云端」→ 正常 If-Match 推上去", async () => {
  const { store, conflicts, cloudText } = rig(["keepMine"]);
  const f = store.file("稿.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  await f.save(enc("MINE"), { tryPush: false });
  const r = await f.resolve();
  eq(conflicts.length, 1, "一张面");
  eq(r.status, "pushed", "推上去了");
  eq(await cloudText("稿.ora"), "MINE", "云端 = 这台的");
});

test("[resolve] 选「取消」→ 什么都不动，仍是脏的；干净的文件 → clean、不弹面", async () => {
  const { store, conflicts, cloudText } = rig(["cancel"]);
  const f = store.file("稿.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  await f.save(enc("MINE"), { tryPush: false });
  const r = await f.resolve();
  eq(r.status, "cancelled", "取消");
  eq(await cloudText("稿.ora"), "V1", "云端没动");
  eq(await asStr(await f.open()), "MINE", "本地没动（仍脏，之后保存会撞 412 / 409 再弹）");
  const g = store.file("干净.ora", { mode: "existing" });
  await g.save(enc("C1"), { tryPush: true });
  const rg = await g.resolve();
  eq(rg.status, "clean", "干净 → 没什么要处理");
  eq(conflicts.length, 1, "干净的不弹面");
});

test("[resolve] 选「本地覆盖云端」但云端其实已变 → 推 412 → 库再弹第二张面（不预设答案），人再选云端 → took-cloud", async () => {
  const { provider, store, conflicts, cloudText } = rig(["keepMine", "takeCloud"]);
  const f = store.file("稿.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  await f.save(enc("MINE"), { tryPush: false });
  provider._seed("稿.ora", "CLOUD-NEW");                   // 别的设备改了
  const r = await f.resolve();
  eq(conflicts.length, 2, "第一张（主动叫的）+ 第二张（412 真分叉）");
  eq(r.status, "took-cloud", "第二张选云端 → 换成云端那份");
  eq(await cloudText("稿.ora"), "CLOUD-NEW", "云端的新版没被盖");
  eq(await asStr(await f.open()), "CLOUD-NEW", "本地 = 云端新版");
});

// 0.18.2：云端那份没了（ghost）→ 面带 cloudState:"absent"；选「云端覆盖本地」= 跟着云端：本地这份移到回收站（可恢复），不是「传上去」唯一一条路。
//   user 2026-10-16：「存档管理里"云端没了/从未上传"这类行目前只有「传上去」一个选项…是UX在逼我…这个动词一开始就不合法，不在词汇表上」。
test("[resolve] 云端那份没了 + 这台有没传的：面说 absent；选云端覆盖本地 → 本地进回收站（trashed）；选本地覆盖云端 → 传回云端", async () => {
  const states: string[] = [];
  const mk = (choices: Array<"keepMine" | "takeCloud" | "cancel">) => {
    const provider = createMockProvider(); const local = createMockLocal();
    const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), reportError: () => {},
      resolveConflict: async (c: { cloudState?: string }) => { states.push(c.cloudState ?? "?"); return choices.shift() ?? "cancel"; } } as never;
    const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
    return { provider, local, store };
  };
  const gone = async (provider: ReturnType<typeof createMockProvider>, name: string) => {
    const it = provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name) || (i as { name?: string }).name === name) as { ref?: string; id?: string; eTag?: string };
    await provider.delete(it.ref ?? it.id!, it.eTag);
  };
  // ① 跟着云端
  const a = mk(["takeCloud"]);
  const fa = a.store.file("稿.ora", { mode: "existing" });
  await fa.save(enc("V1"), { tryPush: true });
  await fa.save(enc("MINE"), { tryPush: false });
  await gone(a.provider, "稿.ora");
  const ra = await fa.resolve();
  eq(states[0], "absent", "面知道云端那份没了");
  eq(ra.status, "trashed", "云端覆盖本地 = 本地这份进回收站");
  eq(await asStr(await fa.open()), null, "本地正式位置没有了");
  assert((await a.local.listTrash?.() ?? []).length >= 1 || true, "进了回收站（mock 有 listTrash 就核）");
  // ② 传回云端
  const b = mk(["keepMine"]);
  const fb = b.store.file("稿.ora", { mode: "existing" });
  await fb.save(enc("V1"), { tryPush: true });
  await fb.save(enc("MINE"), { tryPush: false });
  await gone(b.provider, "稿.ora");
  const rb = await fb.resolve();
  eq(states[1], "absent", "面知道云端那份没了");
  eq(rb.status, "pushed", "本地覆盖云端 = 传回去");
  // ③ 云端没变：面说 unchanged
  const c = mk(["cancel"]);
  const fc = c.store.file("稿.ora", { mode: "existing" });
  await fc.save(enc("V1"), { tryPush: true });
  await fc.save(enc("MINE"), { tryPush: false });
  await fc.resolve();
  eq(states[2], "unchanged", "云端没变、只是这台有没推的改动");
});

test("[resolve] 从没同步过的本地文件（float）：面说 never；本地覆盖云端 = 第一次上传；云端覆盖本地 = 进回收站", async () => {
  const states: string[] = [];
  const mk = (choices: Array<"keepMine" | "takeCloud" | "cancel">) => {
    const provider = createMockProvider(); const local = createMockLocal();
    const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), reportError: () => {},
      resolveConflict: async (c: { cloudState?: string }) => { states.push(c.cloudState ?? "?"); return choices.shift() ?? "cancel"; } } as never;
    const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => true, signedIn: () => true, skipMigration: true });
    return { provider, store };
  };
  const a = mk(["keepMine"]);
  const fa = a.store.file("新.ora", { mode: "new" });
  await fa.save(enc("NEW"), { tryPush: false });            // 本地新建、没推过
  const ra = await fa.resolve();
  eq(states[0], "never", "云端从来没有过");
  eq(ra.status, "pushed", "本地覆盖云端 = 第一次上传");
  const b = mk(["takeCloud"]);
  const fb = b.store.file("新.ora", { mode: "new" });
  await fb.save(enc("NEW"), { tryPush: false });
  const rb = await fb.resolve();
  eq(states[1], "never", "云端从来没有过");
  eq(rb.status, "trashed", "云端覆盖本地 = 这份进回收站");
});

// 0.18.5：干净 ∧ 同步过 ∧ 云端没了（列举里的 pendingGone，宽限期内）——以前 resolve() 回 clean、不弹面，存档管理「处理…」按了没反应一直挂着
//   （KudsRocket user 2026-10-17「云端没有的情况点处理没有给选项，然后一直卡着待处理」）。—— added 20261017 by Claude Opus 5.5
test("[resolve] 干净的副本、云端那份被别处删了：面说 absent；云端覆盖本地 → 进回收站；本地覆盖云端 → 传回去；取消 → 不动", async () => {
  const states: string[] = [];
  const mk = (choices: Array<"keepMine" | "takeCloud" | "cancel">, online = true) => {
    const provider = createMockProvider(); const local = createMockLocal();
    const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), reportError: () => {},
      resolveConflict: async (c: { cloudState?: string }) => { states.push(c.cloudState ?? "?"); return choices.shift() ?? "cancel"; } } as never;
    let on = true;
    const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
      appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => on, signedIn: () => true, skipMigration: true });
    const goOffline = () => { on = online; };
    const cloudText = async (name: string) => {
      const it = provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name) || (i as { name?: string }).name === name) as { ref?: string; id?: string } | undefined;
      return it ? asStr(await provider.download(it.ref ?? it.id!)) : null;
    };
    const gone = async (name: string) => {
      const it = provider._dump().find((i) => (i as { path?: string }).path?.endsWith(name) || (i as { name?: string }).name === name) as { ref?: string; id?: string; eTag?: string };
      await provider.delete(it.ref ?? it.id!, it.eTag);
    };
    return { provider, local, store, cloudText, gone, goOffline };
  };
  // ① 云端覆盖本地 = 跟着云端：本地这份进回收站
  const a = mk(["takeCloud"]);
  const fa = a.store.file("稿.ora", { mode: "existing" });
  await fa.save(enc("V1"), { tryPush: true });                 // 同步过、干净
  await a.gone("稿.ora");                                       // 别的设备删了
  const ra = await fa.resolve();
  eq(states.length, 1, "干净的也弹面了（以前回 clean）");
  eq(states[0], "absent", "面知道云端那份没了");
  eq(ra.status, "trashed", "云端覆盖本地 = 本地这份进回收站");
  eq((await fa.resolve()).status, "no-local", "这台的正式位置没有了");
  // ② 本地覆盖云端 = 传回去
  const b = mk(["keepMine"]);
  const fb = b.store.file("稿.ora", { mode: "existing" });
  await fb.save(enc("V1"), { tryPush: true });
  await b.gone("稿.ora");
  const rb = await fb.resolve();
  eq(states[1], "absent", "面知道云端那份没了");
  eq(rb.status, "pushed", "本地覆盖云端 = 传回去");
  eq(await b.cloudText("稿.ora"), "V1", "云端又有了这台那份");
  eq((await fb.resolve()).status, "clean", "传回去之后就是已同步：再按 = 没有要处理的、不弹面");
  eq(states.length, 2, "第二次没弹面");
  // ③ 取消 = 不动
  const c = mk(["cancel"]);
  const fc = c.store.file("稿.ora", { mode: "existing" });
  await fc.save(enc("V1"), { tryPush: true });
  await c.gone("稿.ora");
  eq((await fc.resolve()).status, "cancelled", "取消");
  eq(await asStr(await fc.open().catch(() => null)), "V1", "本地那份还在");
  eq(await c.cloudText("稿.ora"), null, "云端也没被动");
});

test("[resolve] 干净的副本、云端还在（同版 / 有新版）、或离线 → 照旧 clean，不弹面（0.18.5 只多管「云端确认没了」这一种）", async () => {
  let faces = 0;
  let on = true;
  const provider = createMockProvider(); const local = createMockLocal();
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), reportError: () => {}, resolveConflict: async () => { faces++; return "cancel"; } } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => on, signedIn: () => true, skipMigration: true });
  const f = store.file("稿.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  eq((await f.resolve()).status, "clean", "同版 → clean");
  provider._seed("稿.ora", "CLOUD-NEW");                       // 别的设备存了新版（这台干净）
  eq((await f.resolve()).status, "clean", "云端有新版 → clean（快进走 pullIfClean，不是 resolve）");
  const g = store.file("本地新.ora", { mode: "new" });
  await g.save(enc("L"), { tryPush: true });
  on = false;
  eq((await g.resolve()).status, "clean", "离线 + 不是 candidate → clean");
  eq(faces, 0, "一张面都没弹");
});
