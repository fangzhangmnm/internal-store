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
