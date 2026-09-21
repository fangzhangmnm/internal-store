// getHead（0.15.0）：RawFile 头片 peek——文件开头 n 字节，格式盲、不整份下载、不落本地、加密件 null、source 路由同 getPeek。
//   起因 = CatsUp `.glb` 封面（glTF 2.1 asset.thumbnail 在 BIN 首段；zip 尾片 getPeek 对「头在前」格式无用）。
//   escalate 记录：ai-docs/20260920-request-head-peek.md。created 2026-09-20 by Claude Fable 5.1
import { test, eq, assert } from "./runner.mjs";
import { memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createStore } from "../src/create-store.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

const mkStore = (provider: ReturnType<typeof createMockProvider>, online = true) => createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
  appId: "test", provider,
  ui: { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} } as never,
  validateAdopt: () => true, kv: memKv(), local: createMockLocal(),
  isOnline: () => online, signedIn: () => true, skipMigration: true,
});
const seq = (n: number, base = 0): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (base + i) & 0xff);
const bytesEq = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i]);
const u8 = async (b: Blob): Promise<Uint8Array> => new Uint8Array(await b.arrayBuffer());
/** 记录 provider.downloadRange 调用（mock 无 hook；直接包一层）。 */
function spyRange(provider: ReturnType<typeof createMockProvider>): { calls: { offset: number | null; length: number }[] } {
  const calls: { offset: number | null; length: number }[] = [];
  const orig = provider.downloadRange.bind(provider);
  (provider as { downloadRange: typeof orig }).downloadRange = async (id: string, offset: number | null, length: number) => { calls.push({ offset, length }); return orig(id, offset, length); };
  return { calls };
}

test("[getHead] 纯云端 → pullRange(0,n) 取头片；不整份下载、不落本地", async () => {
  const provider = createMockProvider();
  provider._seed("scene.glb", seq(5000));
  const spy = spyRange(provider);
  const store = mkStore(provider);
  const f = store.file("scene.glb", { isZip: false, mode: "existing" });
  const head = await f.getHead({ bytesLength: 64, source: "local" });
  assert(!!head, "纯云端应经 byte-range 取到头片");
  assert(bytesEq(await u8(head!), seq(64)), "头片 = 文件前 64 字节");
  eq(spy.calls.length, 1, "恰一次 range 请求");
  eq(spy.calls[0].offset, 0, "range 起点 0"); eq(spy.calls[0].length, 64, "range 长 64");
  eq(await f.isKeptOffline(), false, "头片 peek 不落本地副本");
});

test("[getHead] 本地有副本 → Blob.slice（零网络）", async () => {
  const provider = createMockProvider();
  const spy = spyRange(provider);
  const store = mkStore(provider);
  const f = store.file("local.glb", { isZip: false, mode: "new" });
  await f.save(seq(3000, 7), { tryPush: false });
  const head = await f.getHead({ bytesLength: 100, source: "local" });
  assert(!!head && bytesEq(await u8(head), seq(100, 7)), "本地路径：前 100 字节");
  eq(spy.calls.length, 0, "本地有 → 不碰网络");
});

test("[getHead] source:\"cloud\" 本地有也只看云端（绝不落回本地）；source:\"local\" 本地优先", async () => {
  const provider = createMockProvider();
  provider._seed("both.glb", seq(2000, 100));   // 云端版
  const store = mkStore(provider);
  const f = store.file("both.glb", { isZip: false, mode: "existing" });
  await f.save(seq(2000, 200), { tryPush: false });   // 本地版（未推）
  const cloud = await f.getHead({ bytesLength: 16, source: "cloud" });
  const local = await f.getHead({ bytesLength: 16, source: "local" });
  assert(!!cloud && bytesEq(await u8(cloud), seq(16, 100)), "cloud → 云端字节");
  assert(!!local && bytesEq(await u8(local), seq(16, 200)), "local → 本地字节");
});

test("[getHead] bytesLength 超过文件 → 整份；0 → 空 Blob", async () => {
  const provider = createMockProvider();
  provider._seed("tiny.glb", seq(40));
  const store = mkStore(provider);
  const f = store.file("tiny.glb", { isZip: false, mode: "existing" });
  const all = await f.getHead({ bytesLength: 1 << 20, source: "local" });
  assert(!!all && bytesEq(await u8(all), seq(40)), "越界钳到文件末");
  const none = await f.getHead({ bytesLength: 0, source: "local" });
  assert(!!none && none.size === 0, "0 字节 → 空 Blob（不是 null：文件存在）");
});

test("[getHead] 加密件 → null（云端加密名 / 本地密文容器都拒）", async () => {
  const provider = createMockProvider();
  provider._seed("secret.glb.zip", seq(500));   // 薄默认 encFileName = 追加 .zip → _find 命中 enc:true
  const store = mkStore(provider);
  const f = store.file("secret.glb", { isZip: false, mode: "existing" });
  eq(await f.getHead({ bytesLength: 64, source: "local" }), null, "云端命中加密容器名 → null");
  eq(await f.getHead({ bytesLength: 64, source: "cloud" }), null, "cloud 视角同样 null");
});

test("[getHead] 云端没有且无本地 → null；离线且无本地 → null（不打云腿）", async () => {
  const provider = createMockProvider();
  const spy = spyRange(provider);
  eq(await mkStore(provider).file("ghost.glb", { isZip: false, mode: "existing" }).getHead({ bytesLength: 64, source: "local" }), null, "两边都没有 → null");
  provider._seed("offline.glb", seq(100));
  eq(await mkStore(provider, false).file("offline.glb", { isZip: false, mode: "existing" }).getHead({ bytesLength: 64, source: "cloud" }), null, "离线 → null");
  eq(spy.calls.length, 0, "离线不打 range");
});

test("[getHead] ZipFile 也有 getHead（RawFile 面继承）", async () => {
  const provider = createMockProvider();
  provider._seed("a.ora", seq(10));
  const z = mkStore(provider).file("a.ora", { isZip: true, mode: "existing" });
  eq(typeof z.getHead, "function");
  const h = await z.getHead({ bytesLength: 4, source: "local" });
  assert(!!h && bytesEq(await u8(h), seq(4)));
});
