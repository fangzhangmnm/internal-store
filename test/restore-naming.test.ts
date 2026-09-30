// 0.16.0：从回收站 / 备份箱取回时撞名的命名走 docKinds 表（戳插在后缀之前），两条腿一致。created 2026-09-29 by Claude Fable 5.1
//   起因：WXHW 要接备份箱。取回备份时原名必然被占（活着的那一份就叫这个名字），库在名字里插戳；0.15.2 只认最后一个点，
//   WXHW 的书 `X.webxiaoheiwu.zip` 被恢复成 `X.webxiaoheiwu [戳].zip`，云端腿更是 `X.webxiaoheiwu.zip [戳]`——宿主认不出那是一本书。
import { test, eq, assert } from "./runner.mjs";
import { restoreTargetName } from "../src/move-aside.ts";
import { createIdentifiers } from "../src/identifiers.ts";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { TEST_KINDS } from "./kinds.mjs";

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
const STAMPED = /^(.*) \[(\d{8}-\d{6})(-\d+)?\](.*)$/;
const WXHW = createIdentifiers([{ kind: "book", suffix: ".webxiaoheiwu.zip", container: "zip" }, { kind: "draft", suffix: ".txt", container: "raw" }]);

test("[restore-naming] restoreTargetName：原名空闲 → 原名；被占 → 戳插在后缀之前；再占补 -2；非文档按最后一个点", async () => {
  const taken = new Set(["书.webxiaoheiwu.zip", "书 [20260929-143200].webxiaoheiwu.zip", "稿.txt", "pic.png", "README"]);
  const occ = (n: string) => taken.has(n);
  eq(await restoreTargetName("新.webxiaoheiwu.zip", occ, "20260929143200", 0, WXHW), "新.webxiaoheiwu.zip");
  eq(await restoreTargetName("书.webxiaoheiwu.zip", occ, "20260929143200", 0, WXHW), "书 [20260929-143200-2].webxiaoheiwu.zip", "戳也被占 → -2");
  eq(await restoreTargetName("稿.txt", occ, "20260929143200", 0, WXHW), "稿 [20260929-143200].txt");
  eq(await restoreTargetName("夹/稿.txt", (n) => n === "夹/稿.txt", "20260929143200", 0, WXHW), "夹/稿 [20260929-143200].txt", "文件夹保留");
  eq(await restoreTargetName("pic.png", occ, "20260929143200", 0, WXHW), "pic [20260929-143200].png", "非文档：最后一个点之前");
  eq(await restoreTargetName("README", occ, "20260929143200", 0, WXHW), "README [20260929-143200]", "非文档没有点：末尾");
});

function rig(choice: () => "keepMine" | "takeCloud" | "cancel") {
  const provider = createMockProvider();
  const local = createMockLocal({ identifiers: WXHW });
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => choice(), reportError: () => {} } as never;
  const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "xhw", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, docKinds: WXHW.kinds,
    isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { provider, local, store };
}
const BOOK = "樱川.webxiaoheiwu.zip";

test("[restore-naming] 冲突选云端 → 输家在本机备份箱 → 取回：落成一本认得出的书（戳在后缀之前），字节 = 输家那一版，活着的那本不动", async () => {
  const { provider, local, store } = rig(() => "takeCloud");
  const f = store.file(BOOK, { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed(BOOK, "THEIRS");
  await f.save(enc("MINE"), { tryPush: true });                 // 412 → takeCloud：MINE 进本机备份箱，本地 = THEIRS
  const box = await store.files.listBackup();
  eq(box.length, 1, "备份箱里一件"); eq(box[0]!.identifier, BOOK); eq(box[0]!.side, "local");
  const r = await store.files.restoreTrash({ trashKey: box[0]!.localKey, fromCloud: false, cloudRef: null, targetName: BOOK, encrypted: false });
  const m = STAMPED.exec(String(r.name));
  assert(!!m && m[1] === "樱川" && m[4] === ".webxiaoheiwu.zip", `取回的名字 = 樱川 [戳].webxiaoheiwu.zip（实得 ${r.name}）`);
  eq(store.identifiers.parse(String(r.name))?.kind, "book", "取回的仍是一本书");
  eq(await asStr(await local.get(String(r.name))), "MINE", "取回的是输家那一版");
  eq(await asStr(await local.get(BOOK)), "THEIRS", "活着的那本没被动");
  eq((await store.files.listBackup()).length, 0, "取回之后备份箱里没有它了");
});

test("[restore-naming] 冲突选本地 → 输家在云端 .backup 夹 → 取回：云端落成 `樱川 [戳].webxiaoheiwu.zip`", async () => {
  const { provider, store } = rig(() => "keepMine");
  const f = store.file(BOOK, { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed(BOOK, "THEIRS");
  await f.save(enc("MINE"), { tryPush: true });                 // 412 → keepMine：THEIRS 进云端 .backup
  const box = await store.files.listBackup();
  eq(box.length, 1); eq(box[0]!.side, "cloud");
  await store.files.restoreTrash({ trashKey: null, fromCloud: true, cloudRef: box[0]!.cloudRef, targetName: BOOK, encrypted: false });
  const names = (await provider.list("")).map((i) => i.name).filter((n) => n !== BOOK && !n.startsWith("."));
  eq(names.length, 1, `云端根多出一件（${JSON.stringify(names)}）`);
  const m = STAMPED.exec(names[0]!);
  assert(!!m && m[1] === "樱川" && m[4] === ".webxiaoheiwu.zip", `云端名 = 樱川 [戳].webxiaoheiwu.zip（实得 ${names[0]}）`);
});

test("[restore-naming] txt 稿云端腿取回：`稿 [戳].txt`（0.15.2 是 `稿.txt [戳]`）", async () => {
  const { provider, store } = rig(() => "keepMine");
  const f = store.file("稿.txt", { mode: "existing" });
  await f.save(enc("V0"), { tryPush: true });
  provider._seed("稿.txt", "THEIRS");
  await f.save(enc("MINE"), { tryPush: true });
  const box = await store.files.listBackup();
  await store.files.restoreTrash({ trashKey: null, fromCloud: true, cloudRef: box[0]!.cloudRef, targetName: "稿.txt", encrypted: false });
  const names = (await provider.list("")).map((i) => i.name).filter((n) => n !== "稿.txt" && !n.startsWith("."));
  assert(/^稿 \[\d{8}-\d{6}\]\.txt$/.test(names[0] ?? ""), `实得 ${JSON.stringify(names)}`);
});

test("[restore-naming] store.zip()：非文档 / raw 种类都抛；store.file() 对旧的 isZip 多余字段不理", () => {
  const { store } = rig(() => "cancel");
  let msg = ""; try { store.zip("pic.png", { mode: "existing" }); } catch (e) { msg = String((e as Error).message); }
  assert(/not a document/.test(msg), msg);
  msg = ""; try { store.zip("稿.txt", { mode: "existing" }); } catch (e) { msg = String((e as Error).message); }
  assert(/container is "raw"/.test(msg), msg);
  assert(typeof store.zip(BOOK, { mode: "existing" }).getPeek === "function");
  const legacy = (store.file as unknown as (n: string, o: unknown) => { save: unknown; getPeek?: unknown }).call(store, "稿.txt", { isZip: true, mode: "existing" });
  assert(typeof legacy.save === "function" && legacy.getPeek === undefined, "多传 isZip：当普通 file() 处理，不多不少");
});

test("[restore-naming] 只有声明过种类的文档才能加密：非文档 encrypt 响亮抛", async () => {
  const { store } = rig(() => "cancel");
  await store.file("pic.png", { mode: "existing" }).save(enc("PNG"), { tryPush: false });
  let msg = ""; try { await store.file("pic.png", { mode: "existing" }).encrypt(); } catch (e) { msg = String((e as Error).message); }
  assert(/cannot be encrypted/.test(msg), msg);
});

test("[restore-naming] createStore 拒绝有歧义的 docKinds 表（当场抛，不带病跑）", () => {
  let msg = "";
  try {
    createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none", appId: "x", provider: createMockProvider(), ui: { busy: (_l: string, fn: () => unknown) => fn(), resolveConflict: async () => "cancel", reportError: () => {} } as never,
      validateAdopt: () => true, kv: kvRaw(), local: createMockLocal(), docKinds: [{ kind: "a", suffix: ".a", container: "raw" }, { kind: "b", suffix: ".a.zip", container: "zip" }], skipMigration: true });
  } catch (e) { msg = String((e as Error).message); }
  assert(/ambiguous/.test(msg), msg);
});
