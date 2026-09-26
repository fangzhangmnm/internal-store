// 0.4.0 批契约测试（2026-08-25 user 拍板，ai-docs/20260825-localfile-knight-store-round.md §1.2/1.3/§4）：
//   dispose（拒后续 + drain）· dirty facet（count/pushAll）· CloudStaleRefError（ref 失效 404 错误族）。
// created 2026-08-26 by Claude Fable 5 (claude-fable-5)
import { test, eq, assert } from "./runner.mjs";
import { createStore, StoreDisposedError } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createSubstrate } from "../src/substrate.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";

function dumpKv() {
  const m = new Map<string, string>();
  return {
    get: (k: string) => (m.has(k) ? m.get(k)! : null),
    set: (k: string, v: string) => { m.set(k, String(v)); },
    remove: (k: string) => { m.delete(k); },
    keys: () => [...m.keys()],
  };
}
const STUB_UI = { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => "cancel", reportError: () => {} } as never;
function mkStore(provider = createMockProvider()) {
  const kv = dumpKv();
  const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui: STUB_UI,
    validateAdopt: () => true, kv, local: createMockLocal(),
    fileName: (n: string) => n, isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { provider, store, kv };
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

// ── substrate.drain：等 in-flight 链尾（含链上接力的后续）收敛 ─────────────────────────────
test("[drain] substrate.drain 等 in-flight serialize 链（含 drain 开始后接力挂上的同名后续）", async () => {
  const sub = createSubstrate();
  const done: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  void sub.serialize("a", async () => { await gate; done.push("first"); });
  void sub.serialize("a", async () => { done.push("second"); });   // 链上排队的接力
  const drained = sub.drain().then(() => done.push("drained"));
  release();
  await drained;
  eq(done.join(","), "first,second,drained", "drain 必须晚于链上全部工作");
});

// ── dispose：拒后续调用（含 dispose 前已握着的 file 对象）+ 幂等 ─────────────────────────────
test("[dispose] dispose 后一切面抛 StoreDisposedError（新调用 + 旧句柄都拒）；幂等", async () => {
  const { store } = mkStore();
  const held = store.file("旧句柄.ora", { isZip: false, mode: "existing" });   // dispose **前**拿到的对象
  await store.file("a.ora", { isZip: false, mode: "existing" }).save(enc("x"), { tryPush: false });
  await store.dispose();
  await store.dispose();                                       // 幂等：第二次静默通过
  for (const fn of [
    () => store.file("b.ora", { isZip: false, mode: "existing" }),
    () => store.collection("prefs"),
    () => store.files.nameOccupied("a.ora"),
    () => store.files.watchFolder("", () => {}),
    () => store.files.dirty.count(),
    () => held.save(enc("y")),                                 // 旧句柄同样拒（检查在调用时刻）
    () => held.open(),
  ]) {
    try { fn(); assert(false, "dispose 后调用必须抛"); }
    catch (e) { assert(e instanceof StoreDisposedError, `应为 StoreDisposedError，实际 ${(e as Error)?.name}`); }
  }
});

// ── dirty facet：count 只返标量；pushAll 推上并清账；失败留 dirty 报名字 ─────────────────────
test("[dirty] save(tryPush:false) → count=1；pushAll 推上 → count=0、云端字节在", async () => {
  const { store, provider } = mkStore();
  await store.file("画.ora", { isZip: false, mode: "existing" }).save(enc("bytes-v1"), { tryPush: false });
  eq(await store.files.dirty.count(), 1, "未推账 =1");
  const r = await store.files.dirty.pushAll();
  eq(`${r.pushed}/${r.failed.length}`, "1/0", "推上 1、失败 0");
  eq(await store.files.dirty.count(), 0, "账清");
  assert(await provider.getItemByPath("画.ora"), "云端确有其件");
});

test("[dirty] pushAll 推不上（云端 5xx 耗尽重试）→ failed 报名字、dirty 账**不清**（绝不谎报）", async () => {
  const { store } = mkStore(createMockProvider().injectFault({ op: "upload", kind: "error", status: 500, times: 99 }));
  await store.file("困.ora", { isZip: false, mode: "existing" }).save(enc("bytes"), { tryPush: false });
  const r = await store.files.dirty.pushAll();
  eq(r.pushed, 0, "没推上");
  eq(r.failed.join(","), "困.ora", "failed 返名字（错误报告）");
  eq(await store.files.dirty.count(), 1, "dirty 账还在 —— 绿灯门以 count===0 为准");
});

// ── CloudStaleRefError：restore/purge 拿失效 ref（404）→「已被别处动过」错误族 ────────────────
test("[stale-ref] cloud.restore/purge 对失效 ref → CloudStaleRefError（预存小洞：list→点击窗口别处已动）", async () => {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  for (const p of [cloud.restore("id-不存在", "x.ora"), cloud.purge("id-不存在", "e1")]) {
    try { await p; assert(false, "失效 ref 必须抛"); }
    catch (e) { eq((e as Error).name, "CloudStaleRefError", `404 必须收敛进错误族，实际 ${(e as Error)?.name}: ${(e as Error)?.message}`); }
  }
});

// ── 0.15.1：加密件推送不要密码——本地 at-rest 字节直推（WXHW user 2026-09-26「为什么推加密件需要密码。不就是二进制吗」）──
test("[dirty] 加密件、锁着（getPassword=null）：pushAll 照推 → pushed=1、云端字节 = 本地容器逐位相同、账清", async () => {
  let pw: string | null = "pw"; let online = false;
  const kv = dumpKv(); const local = createMockLocal(); const provider = createMockProvider();
  const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "wp", provider, ui: STUB_UI, crypt: { ext: "txt", getPassword: () => pw },
    validateAdopt: () => true, kv, local,
    fileName: (n: string) => n, isOnline: () => online, signedIn: () => online, skipMigration: true,
  });
  await store.file("密.txt", { isZip: false, mode: "new" }).save(enc("SECRET-v1"), { tryPush: false });   // 登出态落盘（tryPush:false 不进离线上传队列）
  const r0 = await store.file("密.txt", { isZip: false, mode: "existing" }).encrypt({ isOnline: () => online });   // 有密码时封（离线：云腿 deferred）
  assert(r0.status !== "locked" && r0.status !== "offline", `encrypt offline on a never-synced file: ${r0.status}`);
  const atRest = await local.get("密.txt"); assert(atRest, "本地有字节");
  const atRestU8 = atRest instanceof Blob ? new Uint8Array(await atRest.arrayBuffer()) : new Uint8Array(atRest as Uint8Array);
  assert(await createMockEncryption().looksEncryptedContainer(atRestU8), "本地 at-rest 已是容器");
  eq(await store.files.dirty.count(), 1, "未推账 =1");
  pw = null; online = true;   // reload 后密码没了 + 登录回线
  const r = await store.files.dirty.pushAll();
  eq(`${r.pushed}/${r.failed.length}`, "1/0", "锁着照推：推上 1、失败 0（以前 = locked 失败留 dirty）");
  eq(await store.files.dirty.count(), 0, "账清");
  const item = await provider.getItemByPath("密.txt.zip"); assert(item, "云端有容器（at-rest 名 .zip）");
  const cloudBytes = new Uint8Array(await (await provider.download(item.ref ?? item.id, { path: "密.txt.zip" })).arrayBuffer());
  eq(cloudBytes.length, atRestU8.length, "云端字节长度 = 本地容器");
  assert(cloudBytes.every((b, i) => b === atRestU8[i]), "★云端 = 本地 at-rest 容器逐位相同（没解壳、没重封）");
});
