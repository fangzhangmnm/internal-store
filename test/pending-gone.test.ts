// pending-gone 深模块（云端防抖 candidate-gone）+ listing.classifySyncState 的 pendingGone 分支。
import { test, eq, assert } from "./runner.mjs";
import { createPendingGone } from "../src/pending-gone.ts";
import { classifySyncState } from "../src/listing.ts";

function memKv() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, _map: m };
}

test("[pending-gone] 第一次 seenGone → 只标记（返 false）；isPending 为真", () => {
  const p = createPendingGone(memKv(), 1000);
  eq(p.seenGone("a", 100), false, "首次不动手");
  assert(p.isPending("a"), "标了 candidate");
});

test("[pending-gone] grace 内第二次 → 仍 false；跨 grace → true（动手）", () => {
  const p = createPendingGone(memKv(), 1000);
  p.seenGone("a", 100);
  eq(p.seenGone("a", 100 + 500), false, "grace 内不动手");
  eq(p.seenGone("a", 100 + 1000), true, "跨 grace → 动手");
});

test("[pending-gone] clear：清标记（重现/编辑取消/收尾）", () => {
  const p = createPendingGone(memKv(), 1000);
  p.seenGone("a", 100);
  p.clear("a");
  assert(!p.isPending("a"), "清掉");
  eq(p.seenGone("a", 100 + 5000), false, "清后重记又是首次（不会立即动手）");
});

test("[pending-gone] 持久：跨实例（kv）保留标记与 firstSeenGoneAt", () => {
  const kv = memKv();
  createPendingGone(kv, 1000).seenGone("a", 100);
  const p2 = createPendingGone(kv, 1000);   // 新实例读同 kv（模拟 reload）
  assert(p2.isPending("a"), "跨实例保留 candidate");
  eq(p2.seenGone("a", 100 + 2000), true, "firstSeenGoneAt 也保留 → 跨 grace 直接动手");
});

test("[pending-gone] names()：列当前 candidate", () => {
  const p = createPendingGone(memKv(), 1000);
  p.seenGone("a", 1); p.seenGone("b", 1);
  eq(p.names().sort().join(","), "a,b", "两个 candidate");
});

// ── classifySyncState 的 pendingGone 分支 ──
const base = { hasLocal: true, hasCloud: false, everSynced: true, cloudMoved: false, cloudReachable: true, absenceAuthoritative: true };
test("[classify] clean cloud-gone + pendingGone → 'pendingGone'（grace 内显 badge）", () => {
  eq(classifySyncState({ ...base, dirty: false, pendingGone: true }), "pendingGone", "防抖内");
});
test("[classify] clean cloud-gone + 非 pendingGone → 'local-only'（老行为）", () => {
  eq(classifySyncState({ ...base, dirty: false, pendingGone: false }), "local-only", "非 candidate");
});
test("[classify] dirty cloud-gone → 'ghost'（未推字节永不删，pendingGone 不影响）", () => {
  eq(classifySyncState({ ...base, dirty: true, pendingGone: true }), "ghost", "dirty 走 ghost");
});

// ── classifySyncState 离线分支（2026-08-19 user 拍板：谱系在案离线显 synced，BR 真机战报打回旧「一律 local-only」）──
const off = { hasLocal: true, hasCloud: false, cloudMoved: false, cloudReachable: false, absenceAuthoritative: false };
test("[classify] 离线 + everSynced∧clean → 'synced'（=已留离线语义，回线纠偏）", () => {
  eq(classifySyncState({ ...off, everSynced: true, dirty: false }), "synced", "拍板 2026-08-19");
});
test("[classify] 离线 + 从没上过云 clean → 'local-only'（真本地文件不变）", () => {
  eq(classifySyncState({ ...off, everSynced: false, dirty: false }), "local-only");
});
test("[classify] 离线 + dirty → unpushed/float 不变", () => {
  eq(classifySyncState({ ...off, everSynced: true, dirty: true }), "unpushed");
  eq(classifySyncState({ ...off, everSynced: false, dirty: true }), "float");
});
