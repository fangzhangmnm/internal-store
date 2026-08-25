import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";
import { createLocalHead } from "../src/local-head.ts";
import { createSafeResolve } from "../src/safe-resolve.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  if (x instanceof Blob) return await x.text();
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}

function rig() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  return { cloud, local, head };
}

test("safePull dirty → 先备份再覆盖（backupName 有）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));          // 云端有 CLOUD
  await local.save("f", enc("OLD"));            // 本地旧版
  head.recordEdit("f");                         // 标脏 → 必须备份
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const r = await sr.safePull("f");
  assert(r.ok, "safePull ok");
  assert(!!(r.ok && r.backupName), "dirty → 有备份");
  eq(await asStr(await local.get("f")), "CLOUD", "本地被覆盖为云端版");
});

test("safePull clean → 跳备份（backupName 无）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("OLD"));            // clean（没 recordEdit）
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const r = await sr.safePull("f");
  assert(r.ok && !r.backupName, "clean → 不备份（ADR-0016）");
});

test("safePull validate 失败 → 拒绝，本地不覆盖（N2）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("BADHTML"));
  await local.save("f", enc("GOOD"));
  head.recordEdit("f");
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => false });
  const r = await sr.safePull("f");
  assert(!r.ok && r.reason === "invalid-cloud-bytes", "坏字节被拒");
  eq(await asStr(await local.get("f")), "GOOD", "本地一份好副本没被覆盖");
});

test("tryHeal：云端字节==本地推的 → 自愈 true + 清脏（B5）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("B"));
  head.recordEdit("f");
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  assert(await sr.tryHeal("f", enc("B")), "字节相等 → 自愈");
  assert(!head.isDirtyThisTab("f"), "自愈后清脏");
  assert(!(await sr.tryHeal("f", enc("C"))), "字节不等 → 不自愈");
});

test("weakOverride（keepMine）：force-push 本地，云端变本地版", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  await sr.weakOverride("f", enc("MINE"));
  const pulled = await cloud.pull("f");
  eq(await asStr(pulled?.blob), "MINE", "云端被 force 成本地版");
});

// 2026-08-25（案卷 20260825-cloud-override-adopt-noop-case.md）：takeCloud=换世界线 → 无条件 backup（user 拍板）；
//   keepMine 落地未确认 → deferred（F0 同款护栏）。added by Claude Fable 5.
test("takeCloud 即使 clean+谱系已知 → 也无条件备份（换世界线）；直接 safePull 仍跳备份（ADR-0016 不动）", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("V1"));
  await local.save("f", enc("V1"));
  head.markSynced("f", cloud.getETag("f"));     // clean + base 已知（= 旧版会跳备份的形状）
  await cloud.push("f", enc("V2"));             // 云端前进 → 分歧
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });

  const ff = await sr.safePull("f");            // 静默快进路径：不传 forceBackup → ADR-0016 照旧跳备份
  assert(ff.ok && !ff.backupName, "快进 clean → 仍不备份（不 spam .backup）");

  await cloud.push("f", enc("V3"));             // 再制造一次分歧
  const r = await sr.resolveConflict("f", "takeCloud");
  eq(r.status, "resolved", "takeCloud 化解");
  assert(!!r.backupName, "takeCloud → clean 也必进 .backup（当前世界线快照）");
  eq(await asStr(await local.get("f")), "V3", "本地已是云端版");
});

test("keepMine 落地未确认（provider 没回 eTag）→ unresolved/deferred，dirty/base 原样保住", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("V1"));
  await local.save("f", enc("V1"));
  head.markSynced("f", cloud.getETag("f"));
  const base0 = head.seenBase("f");
  await local.save("f", enc("MINE")); head.recordEdit("f");   // 本地 dirty
  // 模拟丢响应：weakOverride 的 item 被吞（分块响应/代理吞 body）
  const cloudLossy = { ...cloud, weakOverride: async (n: string, b: Uint8Array, o?: { encrypted?: boolean }) => ({ ...(await cloud.weakOverride(n, b, o)), item: null }) };
  const sr = createSafeResolve({ cloud: cloudLossy, local, head, validateAdopt: () => true });
  const r = await sr.resolveConflict("f", "keepMine", { bytes: enc("MINE") });
  eq(r.status, "unresolved", "落地未确认 ≠ 已化解");
  eq(r.reason, "deferred", "reason=deferred");
  assert(head.isDirtyThisTab("f"), "dirty 保住（重试武装着）");
  eq(head.seenBase("f"), base0, "base 不被清（绝不 markSynced(null)）");
});

test("resolveConflict 派发：takeCloud/keepMine/cancel", async () => {
  const { cloud, local, head } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("MINE"));
  head.recordEdit("f");
  const sr = createSafeResolve({ cloud, local, head, validateAdopt: () => true });

  const cancel = await sr.resolveConflict("f", "cancel");
  eq(cancel.status, "cancelled", "cancel 什么都不动");
  assert(head.isDirtyThisTab("f"), "cancel 后仍 dirty");

  const take = await sr.resolveConflict("f", "takeCloud");
  eq(take.resolution, "takeCloud", "takeCloud → safePull");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版");

  await local.save("f", enc("MINE2")); head.recordEdit("f");
  const keep = await sr.resolveConflict("f", "keepMine", { bytes: enc("MINE2") });
  eq(keep.resolution, "keepMine", "keepMine → weakOverride");
  eq(await asStr((await cloud.pull("f"))?.blob), "MINE2", "云端变本地版");
});
