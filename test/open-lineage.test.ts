// 0.18.0：open 的云端核对没跑成（离线 / 未登录 / 云端出错 / 用户跳过）时，干净副本 ∧ 有 durable etag → 记为本 tab 的 base。
//   复现的是 WXHW 2026-10-16 的单设备根因：页面被回收重开 → 登录前开稿（open 跳过）→ 打字 → recordEdit 捕到 parent=null → 推不带 If-Match →
//   409 → 冤枉的冲突面。修后：第一次推带上次同步到的 etag。脏的 / 没 durable etag 的 / 开关关掉的一律不动。—— created 20261016 by Claude Fable 5.1
import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";
import { createLocalHead } from "../src/local-head.ts";
import { createSafeResolve } from "../src/safe-resolve.ts";
import { createFreshness } from "../src/freshness.ts";

const enc = (s: string) => new TextEncoder().encode(s);

/** 一台设备：cloud / local / headKv 是磁盘（跨 reload 活着）；head + freshness 是一个 tab（reload = 重建）。 */
function device() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const headKv = memKv();
  const tab = (opts: { lineageFromDurable?: boolean; cloudError?: boolean } = {}) => {
    const head = createLocalHead({ kv: headKv, getCloudEtag: (n: string) => cloud.getETag(n) });
    let seen = 0;
    const spy = { ...head, markSeen: (n: string, e: string | null) => { seen++; head.markSeen(n, e); } };
    const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
    const c = opts.cloudError ? { ...cloud, fetchMeta: async () => { throw new Error("boom"); } } : cloud;
    const { open } = createFreshness({ cloud: c, head: spy, safeResolve, lineageFromDurable: opts.lineageFromDurable });
    return { head, open, seen: () => seen };
  };
  return { provider, cloud, local, tab };
}

test("[open-lineage] 已同步的干净稿，reload 后离线 open → base = 上次同步的 etag → 第一次推带 If-Match（不再是 null）", async () => {
  const d = device();
  const t1 = d.tab();
  await d.cloud.push("f", enc("V1"));                    // 上次同步：durable etag = E1、dirty=false
  await d.local.save("f", enc("V1"));
  t1.head.markSeen("f", d.cloud.getETag("f"));
  const e1 = d.cloud.getETag("f");
  assert(e1 != null, "有 durable etag");
  const t2 = d.tab();                                     // reload：内存谱系全丢
  const r = await t2.open("f", { isOnline: () => false });
  eq(r.reason, "offline", "离线分支");
  eq(t2.seen(), 1, "干净 ∧ 有 durable etag → markSeen 一次");
  t2.head.recordEdit("f");                                 // 登录前打字
  eq(t2.head.ifMatchFor("f"), e1, "第一次推的 If-Match = 上次同步到的那一版（修前 = null → 409 面）");
});

test("[open-lineage] 云端核对抛错（登录前 fetchMeta 不可用）同样接血统；用户跳过（probe 先到）同样", async () => {
  const d = device();
  await d.cloud.push("f", enc("V1")); await d.local.save("f", enc("V1"));
  const t2 = d.tab({ cloudError: true });
  const r = await t2.open("f", { isOnline: () => true });
  eq(r.reason, "cloud-error", "cloud-error 分支");
  eq(t2.seen(), 1, "cloud-error → markSeen");
  const t3 = d.tab();
  const r3 = await t3.open("f", { isOnline: () => true, probe: Promise.resolve() });
  eq(r3.reason, "skipped", "probe 先到 = 跳过");
  eq(t3.seen(), 1, "skipped → markSeen");
});

test("[open-lineage] 脏的不动：别的 tab 有未推字节 → 离线 open 不 markSeen（parent 只能由 recordEdit / 云端确认给）", async () => {
  const d = device();
  const t1 = d.tab();
  await d.cloud.push("f", enc("V1")); await d.local.save("f", enc("V1"));
  t1.head.markSeen("f", d.cloud.getETag("f"));
  t1.head.recordEdit("f");                                 // durable dirty = 1
  const t2 = d.tab();
  await t2.open("f", { isOnline: () => false });
  eq(t2.seen(), 0, "dirty anywhere → 不标");
});

test("[open-lineage] 从没同步过（无 durable etag）→ 不标；开关关掉（lineageFromDurable:false）→ 不标", async () => {
  const d = device();
  await d.local.save("g", enc("NEW"));                     // 只有本地，没推过
  const t = d.tab();
  await t.open("g", { isOnline: () => false });
  eq(t.seen(), 0, "无 durable etag → 不标（真·新文件首推不带 If-Match，conflictBehavior:fail 护栏照旧）");
  await d.cloud.push("f", enc("V1")); await d.local.save("f", enc("V1"));
  const off = d.tab({ lineageFromDurable: false });
  await off.open("f", { isOnline: () => false });
  eq(off.seen(), 0, "开关关 = 0.17.2 行为");
  off.head.recordEdit("f");
  eq(off.head.ifMatchFor("f"), null, "关掉时第一次推仍无 If-Match（旧行为，供对照）");
});
