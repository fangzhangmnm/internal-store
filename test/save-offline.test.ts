// save-offline —— file.save 在 isOnline=false 时一条网都不打（2.2.6；MoonSinger 工单 H4 查出；user 2026-11-04「库自己守同意」）。
// created 2026-11-04 by Claude Fable 5.1
// 以前 save（默认 tryPush）不看 isOnline，直接 pushMod.push → fetchMeta / upload 必失败才回 reason；宿主选了「离线继续」照样走网，
//   MoonSinger 只能在自己的 store 接缝把 tryPush 改假。闸门设计稿「库离线一条网都不打」要对 file.save 也成立。
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

function kvRaw() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] };
}
function rig(online: boolean) {
  const ops: string[] = [];
  const provider = createMockProvider({ hook: (op) => { ops.push(op); } });
  const local = createMockLocal();
  const ui = { busy: <T>(_l: string, fn: () => Promise<T>) => fn(), resolveConflict: async () => "cancel", reportError: () => {} } as never;
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local, isOnline: () => online, signedIn: () => true, skipMigration: true });
  return { ops, store };
}
const bytes = (s: string) => new TextEncoder().encode(s);

test("[save-offline] isOnline=false：save（默认 tryPush）→ 本地落了、pushed:false reason:offline、云端零请求、文件留脏", async () => {
  const r = rig(false);
  const res = await r.store.file("a.dat", { mode: "new" }).save(bytes("hello"));
  eq(res.pushed, false, "没推");
  eq(res.reason, "offline", "原因是离线，不是 error");
  eq(r.ops.length, 0, "云端零请求（以前这里会 getItemByPath / upload）：" + r.ops.join(","));
  eq(await r.store.files.dirty.count(), 1, "留脏：回来补推 / 问一次");
  const back = await r.store.file("a.dat", { mode: "existing" }).open();
  assert(back != null && (await back.text()) === "hello", "本地那份读得回");
});

test("[save-offline] 对照：isOnline=true 同一动作会碰云端（证明守卫真在起作用）", async () => {
  const r = rig(true);
  const res = await r.store.file("a.dat", { mode: "new" }).save(bytes("hello"));
  eq(res.pushed, true, "在线推上去了");
  assert(r.ops.some((o) => o === "upload" || o === "uploadStream"), "请求日志里有上传：" + r.ops.join(","));
});
