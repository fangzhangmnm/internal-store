// resolve-heal —— 「处理…」（file.resolve()）在弹面之前先做回执丢失自愈（2.2.3，家族周账 F-142，2026-11-03）。
// created 2026-11-03 by Claude Fable 5.1
// 场景 = MoonSinger 工单 A2 的 e2e 抓到的假面：V1 推上去了；V2 落了本机、上传也落了云，但回执没回来 → 本机脏、基准还是 V1 的、
//   云端已是 V2（同字节）。10-26 撤掉登录后批量推以后，「处理…」是唯一入口，以前它不比字节、直接弹「云端和本机各有一版新改动」。
//   （mock 的 upload lostResponse 会被 cloud-sync 当场兜底认领、模拟不出「页面死了」，所以照 open-heal 的做法直接把云端种成同字节。）
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
  const conflicts: Array<{ name: string; occasion: string; cloudState?: string }> = [];
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ name, occasion, cloudState }: { name: string; occasion: string; cloudState?: string }) => { conflicts.push({ name, occasion, cloudState }); return choices.shift() ?? "cancel"; },
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
/** 回执丢失：V1 推上去；V2 落本机（脏）；云端其实也已是 V2（同字节、新版本号），回执没回。 */
async function lostReceipt(r: ReturnType<typeof rig>) {
  const f = r.store.file("稿.ora", { mode: "existing" });
  eq((await f.save(enc("V1"), { tryPush: true })).pushed, true, "V1 推上去");
  await f.save(enc("V2"), { tryPush: false });
  r.provider._seed("稿.ora", "V2");
  eq(await r.cloudText("稿.ora"), "V2", "云端已是 V2");
  eq(await r.store.files.dirty.count(), 1, "本机脏");
  return f;
}

test("[resolve-heal] 回执丢了（云端字节 = 本机字节、版本号不同）→「处理…」先比字节、一样就认领：零面、pushed、脏标清、再按 = clean", async () => {
  const r = rig(["cancel"]);
  const f = await lostReceipt(r);
  const out = await f.resolve();
  eq(r.conflicts.length, 0, "零面（以前这里会弹「云端和本机各有一版新改动」）");
  eq(out.status, "pushed", "和 push 路 healed 的映射一致");
  eq(await r.store.files.dirty.count(), 0, "脏标清了（自愈 = markSynced）");
  eq(await r.cloudText("稿.ora"), "V2", "云端没被碰");
  eq(await asStr(await f.open()), "V2", "本机照旧");
  eq((await f.resolve()).status, "clean", "再按一次 = 没有要处理的");
});

test("[resolve-heal] 云端真不一样（别的设备又推了 V3）→ 比不出 → 照旧弹面（cloudState=changed）；取消 = 两边都不动、仍脏", async () => {
  const r = rig(["cancel"]);
  const f = await lostReceipt(r);
  r.provider._seed("稿.ora", "V3");
  const out = await f.resolve();
  eq(r.conflicts.length, 1, "一张面");
  eq(r.conflicts[0].cloudState, "changed", "面上说的是真的：云端真的变了");
  eq(out.status, "cancelled", "取消");
  eq(await r.store.files.dirty.count(), 1, "仍脏");
  eq(await r.cloudText("稿.ora"), "V3", "云端没被碰");
  eq(await asStr(await f.open()), "V2", "本机没被碰");
});

test("[resolve-heal] 云端没变（版本号 = 基准）、本机脏 → 不比字节、照旧弹面（unchanged）；选本地 → 正常推上去", async () => {
  const r = rig(["keepMine"]);
  const f = r.store.file("稿.ora", { mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  await f.save(enc("MINE"), { tryPush: false });
  const out = await f.resolve();
  eq(r.conflicts.length, 1, "一张面");
  eq(r.conflicts[0].cloudState, "unchanged", "云端没动");
  eq(out.status, "pushed", "推上去了");
  eq(await r.cloudText("稿.ora"), "MINE", "云端 = 这台的");
  assert((await r.store.files.dirty.count()) === 0, "推完不脏");
});
