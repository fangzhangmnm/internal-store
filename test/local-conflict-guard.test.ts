// created 2026-08-28 by Claude Fable 5
// A4 双 tab 同作品本地字节互覆护栏（2026-08-28 user 拍板 a：本地版本戳 + 写前 backup + spam 去重）。
// 契约（types.ts LocalCache.save guard="user-save"）：
//   · 每写 rev+1；get/save 刷新本 tab（=本实例）seenRev。
//   · guarded 写发现 stored rev ≠ 本 tab seen = 另一 tab 写过 → 先把**对方字节**备份进 backup 分区
//     再覆盖，回执 foreignOverwrite（冲突必 surface；词典序②谁的操作都不静默丢）。
//   · 防 spam：同名 backup 冷却窗 5min——冷却内再撞版照覆盖照回执，只是不再堆备份。
//   · 云 pull / 改名等系统路径不传 guard → 永不误报（覆盖是它们的正常语义）。
// 用 mock-local 双实例共 backing 模拟双 tab（镜像契约与真 local-cache.ts 同款；真 IDB 归真机批）。

import { test, eq, assert } from "./runner.mjs";
import { createMockLocal, createMockLocalBacking } from "../src/testing/mock-local.ts";
import type { LocalSaveReceipt } from "../src/types.ts";

const u8 = (s: string) => new TextEncoder().encode(s);
const txt = (b: unknown) => new TextDecoder().decode(b as Uint8Array);

test("A4 单 tab 独写：guarded 连写永不报冲突，rev 单调 +1", async () => {
  const A = createMockLocal();
  const r1 = await A.save("f.ora", u8("v1"), undefined, "user-save") as LocalSaveReceipt;
  const r2 = await A.save("f.ora", u8("v2"), undefined, "user-save") as LocalSaveReceipt;
  eq(r1.rev, 1); eq(r2.rev, 2);
  assert(!r1.foreignOverwrite && !r2.foreignOverwrite, "独写无冲突");
  eq((await A.listBackup()).length, 0, "没有多余备份");
});

test("A4 双 tab 互覆：后写者逮到撞版 → 对方字节先备份再覆盖 + 回执", async () => {
  const backing = createMockLocalBacking();
  const tabA = createMockLocal({ backing });
  const tabB = createMockLocal({ backing });
  await tabA.save("f.ora", u8("A1"), undefined, "user-save");     // A 存 → rev 1
  await tabB.get("f.ora");                                        // B 打开同作品（seen=1）
  await tabB.save("f.ora", u8("B1"), undefined, "user-save");     // B 存 → rev 2（B seen=2；A 还停在 1）
  const r = await tabA.save("f.ora", u8("A2"), undefined, "user-save") as LocalSaveReceipt;   // A 的 autosave 撞版
  assert(!!r.foreignOverwrite, "A 逮到 B 的写");
  eq(r.foreignOverwrite!.foreignRev, 2);
  eq(r.foreignOverwrite!.backedUp, true, "B 的字节覆盖前已留底");
  const bks = await A_backupsOf(tabA, "f.ora");
  eq(bks.length, 1, "backup 分区多了一份");
  eq(txt(tabA._items.get(bks[0].trashKey)), "B1", "留底的是**对方（B）**的字节");
  eq(txt(tabA._items.get("f.ora")), "A2", "覆盖照常进行（A 的保存不丢）");
});

test("A4 防 spam：冷却窗内连环撞版只备份一次，但每次都回执 surface", async () => {
  const backing = createMockLocalBacking();
  const tabA = createMockLocal({ backing });
  const tabB = createMockLocal({ backing });
  await tabA.save("f.ora", u8("A1"), undefined, "user-save");
  await tabB.get("f.ora");
  // 交替 autosave ×3：每轮 B 写完 A 再写（A 每次都撞 B 的 rev）
  let backups = 0, receipts = 0;
  for (let i = 0; i < 3; i++) {
    await tabB.save("f.ora", u8(`B${i}`), undefined, "user-save");
    const r = await tabA.save("f.ora", u8(`A${i + 2}`), undefined, "user-save") as LocalSaveReceipt;
    if (r.foreignOverwrite) { receipts++; if (r.foreignOverwrite.backedUp) backups++; }
  }
  eq(receipts, 3, "每次撞版都回执（surface 不打折）");
  eq(backups, 1, "A 侧冷却窗内只留底一次（防备份箱刷屏）");
  // ping-pong 里 B 的 guarded 写同样逮到 A 的写、走 B 自己的冷却窗 → 全局至多每 tab 一份 = 2。
  eq((await A_backupsOf(tabA, "f.ora")).length, 2, "双方各留底一次后全局静默");
});

test("A4 系统路径（无 guard）：pull 覆盖未打开的文件不误报、不留底", async () => {
  const backing = createMockLocalBacking();
  const tabA = createMockLocal({ backing });
  const tabB = createMockLocal({ backing });
  await tabA.save("f.ora", u8("A1"), undefined, "user-save");
  // tab B 后台 reconcile pull 覆盖（从没 get 过这个文件）——正常语义，不传 guard
  const r = await tabB.save("f.ora", u8("cloud"), undefined) as LocalSaveReceipt;
  assert(!r.foreignOverwrite, "无 guard 永不报冲突");
  eq((await A_backupsOf(tabB, "f.ora")).length, 0, "不留底");
  eq(r.rev, 2, "rev 照常推进（谱系不断）");
});

test("A4 零迁移：老记录（无 rev）上的首次 guarded 写不误报", async () => {
  const backing = createMockLocalBacking();
  const A = createMockLocal({ backing });
  backing.items.set("old.ora", u8("legacy"));            // 直接塞底座 = 升级前就存在的记录（revs 无条目）
  await A.get("old.ora");                                // 打开（seen = 0）
  const r = await A.save("old.ora", u8("edited"), undefined, "user-save") as LocalSaveReceipt;
  assert(!r.foreignOverwrite, "老记录 rev 缺席视 0，与 seen 0 对表 = 无冲突");
  eq(r.rev, 1);
});

test("A4 新建文件：从没读过直接 guarded 首存（adopt/新画）不误报", async () => {
  const A = createMockLocal();
  const r = await A.save("new.ora", u8("first"), undefined, "user-save") as LocalSaveReceipt;
  assert(!r.foreignOverwrite);
  eq(r.rev, 1);
});

async function A_backupsOf(tab: ReturnType<typeof createMockLocal>, name: string) {
  return (await tab.listBackup()).filter((e) => e.name === name);
}
