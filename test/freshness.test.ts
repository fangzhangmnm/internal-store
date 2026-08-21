import { test, eq, assert } from "./runner.mjs";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";
import { createLocalHead } from "../src/local-head.ts";
import { createSafeResolve } from "../src/safe-resolve.ts";
import { createFreshness } from "../src/freshness.ts";

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
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const { open, refresh } = createFreshness({ cloud, head, safeResolve });
  return { cloud, local, head, open, refresh };
}

test("open in-sync：seenBase == 云端 etag → 不动", async () => {
  const { cloud, head, open } = rig();
  await cloud.push("f", enc("V1"));
  head.markSeen("f", cloud.getETag("f"));
  const r = await open("f");
  eq(r.reason, "in-sync", "in-sync");
});

test("open in-sync 重捕 _base：reload 后 dirty(内存 _base/_parent 空)→ markSeen 闭合误报 collision 窗口（backlog）", async () => {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  await cloud.push("f", enc("V1"));
  const etag = cloud.getETag("f");
  // 模拟 reload：新建 head 但 kv 预置 dirty=1（durable 跨 reload），内存 _base/_parent 全空（从没 recordEdit/markSeen）。
  const headKv = memKv();
  headKv.set("head.dirty:f", "1");
  const head = createLocalHead({ kv: headKv, getCloudEtag: (n: string) => cloud.getETag(n) });
  const local = createMockLocal();
  await local.save("f", enc("MINE"));
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const { open } = createFreshness({ cloud, head, safeResolve });
  assert(head.isDirtyThisTab("f"), "reload 后仍 dirty(kv durable)");
  // 修前：open in-sync 不 markSeen → _base/_parent 空 → ifMatchFor 走 no-base(null) → 推送 fail → 误报 collision。
  // 修后：open in-sync(云端 etag===seenBase 回退值)→ markSeen 重捕 _base + _parent。
  const r = await open("f");
  eq(r.reason, "in-sync", "云端没动 → in-sync");
  eq(head.ifMatchFor("f"), etag, "markSeen 后 push 的 If-Match = 当前云版 etag(不再 no-base 误报 collision)");
});

test("open clean → 静默快进（fast-forwarded，本地变云端版；已知谱系不 spam .backup）", async () => {
  const { cloud, local, head, open } = rig();
  await cloud.push("f", enc("CLOUD"));
  head.markSeen("f", "OLD");                       // base 陈旧 ≠ 云端（谱系已知）
  const r = await open("f");
  eq(r.source, "fast-forwarded", "clean → 快进");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版");
  const backups = local.listBackup ? await local.listBackup() : [];
  eq(backups.length, 0, "clean ∧ 谱系已知 → 不备份（ADR-0016 不 spam）");
});

test("open dirty + takeCloud → pulled（先备份本地）", async () => {
  const { cloud, local, head, open } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("MINE")); head.markSeen("f", "OLD"); head.recordEdit("f");
  const r = await open("f", { onNewer: () => "takeCloud" });
  eq(r.source, "pulled", "takeCloud → 拉");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版（MINE 已备份）");
});

test("open dirty + cancel → 留本地（kept）", async () => {
  const { cloud, local, head, open } = rig();
  await cloud.push("f", enc("CLOUD"));
  await local.save("f", enc("MINE")); head.markSeen("f", "OLD"); head.recordEdit("f");
  const r = await open("f", { onNewer: () => "cancel" });
  eq(r.reason, "kept", "cancel → 留本地");
  eq(await asStr(await local.get("f")), "MINE", "本地没动");
});

test("refresh dirty → dirty-skip（事件里绝不弹 sheet）", async () => {
  const { cloud, head, refresh } = rig();
  await cloud.push("f", enc("CLOUD")); head.markSeen("f", "OLD"); head.recordEdit("f");
  const r = await refresh("f");
  eq(r.status, "dirty-skip", "dirty → 跳过");
});

test("refresh clean 动过 → fast-forwarded", async () => {
  const { cloud, local, head, refresh } = rig();
  await cloud.push("f", enc("CLOUD")); head.markSeen("f", "OLD");
  const r = await refresh("f");
  eq(r.status, "fast-forwarded", "clean 动过 → 快进");
  eq(await asStr(await local.get("f")), "CLOUD", "本地更新");
});

// ── 缺陷 B（20260820-open-time-conflict-surface-handoff）：!base（无 baseline）∧ 云端有文件 ≠ in-sync。
//   rig 区别：云端文件用 provider._seed 放（外部写入方）→ 本机 cloud kv 无 etag → seenBase 真 null
//   （rig() 里 cloud.push 会写 durable etag，造不出 !base）。判法对齐 listing 的 moved = cloudMoved || !everSynced。
function rigExternalCloud() {
  const provider = createMockProvider();
  const cloud = createCloudSync({ provider, kv: memKv(), fileName: (n: string) => n });
  const local = createMockLocal();
  const head = createLocalHead({ kv: memKv(), getCloudEtag: (n: string) => cloud.getETag(n) });
  const safeResolve = createSafeResolve({ cloud, local, head, validateAdopt: () => true });
  const { open, refresh } = createFreshness({ cloud, head, safeResolve });
  return { provider, cloud, local, head, open, refresh };
}

test("open dirty ∧ !base ∧ 云端有 → 必弹（onNewer 被调；takeCloud 拉云端）", async () => {
  const { provider, local, head, open } = rigExternalCloud();
  provider._seed("f", "CLOUD");
  await local.save("f", enc("MINE")); head.recordEdit("f");
  let asked = 0;
  const r = await open("f", { onNewer: () => { asked++; return "takeCloud"; } });
  eq(asked, 1, "!base 也必须 surface（修前被判 in-sync 静默留本地）");
  eq(r.source, "pulled", "takeCloud → 拉");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版（MINE 已备份）");
});

test("open dirty ∧ !base ∧ 云端有 + cancel → 留本地（kept，不静默）", async () => {
  const { provider, local, head, open } = rigExternalCloud();
  provider._seed("f", "CLOUD");
  await local.save("f", enc("MINE")); head.recordEdit("f");
  let asked = 0;
  const r = await open("f", { onNewer: () => { asked++; return "cancel"; } });
  eq(asked, 1, "弹过再留，不是没弹");
  eq(r.reason, "kept", "cancel → 留本地");
  eq(await asStr(await local.get("f")), "MINE", "本地没动");
});

test("open clean ∧ !base ∧ 云端有 → 静默快进不弹；谱系未知覆盖前必 .backup", async () => {
  const { provider, local, open } = rigExternalCloud();
  provider._seed("f", "CLOUD");
  await local.save("f", enc("STALE"));                 // clean 陈旧副本（谱系丢失场景）
  let asked = 0;
  const r = await open("f", { onNewer: () => { asked++; return "cancel"; } });
  eq(asked, 0, "clean 不弹");
  eq(r.source, "fast-forwarded", "clean → 快进");
  eq(await asStr(await local.get("f")), "CLOUD", "本地变云端版");
  // QA fix1（2026-08-20）：!base 时「clean」不可信（durable dirty 可能与 etag 同批丢失，如 localStorage
  //   被清而 IDB 幸存）→ safePull 必须先 move-aside，绝不无备份覆盖出身不明的本地字节（§A）。
  const backups = local.listBackup ? await local.listBackup() : [];
  eq(backups.length, 1, "谱系未知 → 覆盖前必备份");
});

test("refresh clean ∧ !base ∧ 云端有 → 快进（对齐 open）", async () => {
  const { provider, local, refresh } = rigExternalCloud();
  provider._seed("f", "CLOUD");
  await local.save("f", enc("STALE"));
  const r = await refresh("f");
  eq(r.status, "fast-forwarded", "!base 不再误判 in-sync");
  eq(await asStr(await local.get("f")), "CLOUD", "本地更新");
});

test("open 离线 → 秒开本地（不弹、不碰 fetchMeta）不回归", async () => {
  const { provider, local, head, open } = rigExternalCloud();
  provider._seed("f", "CLOUD");
  await local.save("f", enc("MINE")); head.recordEdit("f");
  let asked = 0;
  const r = await open("f", { isOnline: () => false, onNewer: () => { asked++; return "takeCloud"; } });
  eq(asked, 0, "离线不弹");
  eq(r.reason, "offline", "离线直读本地");
  eq(await asStr(await local.get("f")), "MINE", "本地没动");
});
