// files.usageBreakdown 验收（2026-08-21）——宿主要如实交代「本机被占了多少」，
//   而 usage() 只报 files 分区，trash/backup 同样吃浏览器配额却在 UI 上看不见。
// 真的分区分桶跑在 IDB 上（idb-store.usageAll，node 测不到 → 真机/浏览器夹具验）；
//   这里守的是**降级分支**：LocalCache 没实现 usageBreakdown（老 mock / 注入式）时，
//   必须退回「只报 files 一桶」而不是抛错或返空 —— 宿主据此无需写分支。
import { test, eq, assert } from "./runner.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

function memKv() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, v); }, remove: (k: string) => { m.delete(k); } };
}
const mkStore = (local: ReturnType<typeof createMockLocal>) => createStore({
  appId: "usage-test", provider: createMockProvider(), local, kv: memKv(),
  ui: { reportError: () => {} },
});

test("usageBreakdown · mock 未实现 → 退回只报 files 一桶（不抛、不空）", async () => {
  const local = createMockLocal();
  const store = mkStore(local);
  await store.file("a.ora", { isZip: true, mode: "new" }).save(new Uint8Array(1000), { tryPush: false });
  const b = await store.files.usageBreakdown();
  assert(b && typeof b === "object", "必须返对象");
  assert(b.files != null, "必须有 files 桶");
  const direct = await store.files.usage();
  eq(b.files.bytes, direct.bytes, "files 桶字节 = usage() 字节");
  eq(b.files.count, direct.count, "files 桶件数 = usage() 件数");
});

test("usageBreakdown · LocalCache 实现了就原样透传（分区口径不被 create-store 改写）", async () => {
  const local = createMockLocal() as ReturnType<typeof createMockLocal> & { usageBreakdown?: () => Promise<Record<string, { bytes: number; count: number }>> };
  local.usageBreakdown = async () => ({ files: { bytes: 7, count: 1 }, trash: { bytes: 11, count: 2 }, backup: { bytes: 13, count: 3 } });
  const store = mkStore(local);
  const b = await store.files.usageBreakdown();
  eq(b.trash.bytes, 11, "trash 桶原样透传");
  eq(b.backup.count, 3, "backup 桶原样透传");
  eq(Object.keys(b).sort().join(","), "backup,files,trash", "桶集合原样，不被补齐/裁剪");
});
