// files.uploadStream（0.17.0）：流式新建纯云端文件——不落本地、不写谱系、撞名一个字节不传、离线抛、进度单调。
//   起因 = KudsRocket「边加密边上传、不留本地副本」（上 GB 的媒体文件，整份进内存 / IDB 都不行）。created 2026-10-14 by Claude Fable 5.1
import { test, eq, assert } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createStore } from "../src/create-store.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

const mkStore = (provider: ReturnType<typeof createMockProvider>, online = true) => createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
  appId: "test", provider,
  ui: { busy: (_l: string, fn: () => Promise<unknown>) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} } as never,
  validateAdopt: () => true, kv: memKv(), local: createMockLocal(),
  isOnline: () => online, signedIn: () => true, skipMigration: true,
});
const seq = (n: number): Uint8Array => Uint8Array.from({ length: n }, (_, i) => (i * 7) & 0xff);
/** 按需读的来源：记下每次 read，证明库没有一口气要整份。 */
function source(bytes: Uint8Array) {
  const reads: number[] = [];
  return { reads, src: { size: bytes.length, read: async (o: number, n: number) => { reads.push(n); return bytes.subarray(o, o + n); } } };
}

test("[uploadStream] 新建：逐块读、云端成文件、本地无副本、谱系空、进度单调到 total", async () => {
  const provider = createMockProvider();
  const store = mkStore(provider);
  const bytes = seq(200_000);
  const { reads, src } = source(bytes);
  const progress: number[] = [];
  const r = await store.files.uploadStream("shelf/big.dat", src, { onProgress: (d) => progress.push(d) });
  eq(r.status, "uploaded", "status"); eq(r.size, bytes.length, "size");
  assert(reads.length > 1 && Math.max(...reads) < bytes.length, "分块读，没有一口气要整份");
  const cloud = await provider.getItemByPath("shelf/big.dat");
  assert(!!cloud && cloud.size === bytes.length, "云端成文件、大小对");
  const f = store.file("shelf/big.dat", { mode: "existing" });
  eq(await f.isKeptOffline(), false, "不落本地副本");
  eq(progress[0], 0, "进度从 0 起"); eq(progress[progress.length - 1], bytes.length, "进度收在 total");
  for (let i = 1; i < progress.length; i++) assert(progress[i] >= progress[i - 1], "进度单调");
  // 之后照常 open：acquire 拉下来、字节一致
  const got = await f.open();
  assert(!!got, "open 能拉到");
  const back = new Uint8Array(await got!.arrayBuffer());
  assert(back.length === bytes.length && back.every((v, i) => v === bytes[i]), "字节一致");
});

test("[uploadStream] 撞名（云端已有同名）→ CloudNameCollisionError，一个字节不读不传", async () => {
  const provider = createMockProvider();
  provider._seed("shelf/big.dat", seq(10));
  const store = mkStore(provider);
  const { reads, src } = source(seq(5000));
  let err: unknown = null;
  try { await store.files.uploadStream("shelf/big.dat", src); } catch (e) { err = e; }
  eq((err as Error | null)?.name, "CloudNameCollisionError", "撞名错误族");
  eq(reads.length, 0, "一个字节没读");
  const cloud = await provider.getItemByPath("shelf/big.dat");
  eq(cloud?.size, 10, "云端那份原样");
});

test("[uploadStream] 本地已占（同名本地文件）→ 也是 CloudNameCollisionError（身份唯一面 = nameOccupied）", async () => {
  const provider = createMockProvider();
  const store = mkStore(provider);
  await store.file("shelf/x.dat", { mode: "new" }).save(seq(3));
  let err: unknown = null;
  try { await store.files.uploadStream("shelf/x.dat", source(seq(9)).src); } catch (e) { err = e; }
  eq((err as Error | null)?.name, "CloudNameCollisionError", "本地占用也挡");
});

test("[uploadStream] 离线 → 抛（没有本地字节可排队，不假装成功）", async () => {
  const provider = createMockProvider();
  const store = mkStore(provider, false);
  const { reads, src } = source(seq(100));
  let err: unknown = null;
  try { await store.files.uploadStream("shelf/y.dat", src); } catch (e) { err = e; }
  assert(!!err, "离线抛"); eq(reads.length, 0, "一个字节没读");
});

test("[save onProgress] 普通 save 的上传进度透传到 provider（0 … total）", async () => {
  const provider = createMockProvider();
  const store = mkStore(provider);
  const progress: [number, number][] = [];
  const r = await store.file("shelf/p.dat", { mode: "new" }).save(seq(1234), { onProgress: (d, t) => progress.push([d, t]) });
  eq(r.pushed, true, "推上去了");
  assert(progress.length >= 2, "至少报了起止");
  eq(progress[0][0], 0, "起 0"); eq(progress[progress.length - 1][0], 1234, "止 total"); eq(progress[0][1], 1234, "total 对");
});
