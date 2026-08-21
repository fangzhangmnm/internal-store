// 回归（20260820 事故，红线「冲突必 surface」/ ADR-0016 后半 / ADR-0009）：
//   gallery 点开 dirty ∧ 云端动过的文件必须**当场**弹冲突 sheet，而不是静默打开陈旧本地、等保存 412 才弹。
//   缺陷 A = create-store makeRaw.open() 没给 fresh.open 接 onNewer（freshness 默认 "cancel" = 静默留本地）；
//   缺陷 B = freshness 把 !base（谱系丢失/从未 synced）误判 in-sync。两案侦察与修复方向见
//   WeebPaint ai-docs/20260820-open-time-conflict-surface-handoff.md。此处走真 createStore（事故同款调用链）。
import { test, eq, assert } from "./runner.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";

const enc = (s: string) => new TextEncoder().encode(s);
async function asStr(x: unknown): Promise<string | null> {
  if (x == null) return null;
  if (x instanceof Blob) return await x.text();
  if (x instanceof Uint8Array) return new TextDecoder().decode(x);
  return new TextDecoder().decode(new Uint8Array(x as ArrayBuffer));
}
function kvRaw() {
  const m = new Map<string, string>();
  return { get: (k: string) => (m.has(k) ? m.get(k)! : null), set: (k: string, v: string) => { m.set(k, String(v)); }, remove: (k: string) => { m.delete(k); }, keys: () => [...m.keys()] };
}

// rig：真 createStore + spy ui（resolveConflict 记录每次弹窗并按参数作答）。
function rig(choice: () => "keepMine" | "takeCloud" | "cancel") {
  const provider = createMockProvider();
  const local = createMockLocal();
  const conflicts: string[] = [];
  const errors: unknown[] = [];
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ name }: { name: string }) => { conflicts.push(name); return choice(); },
    reportError: (e: unknown) => { errors.push(e); },
  } as never;
  const store = createStore({
    appId: "wp", provider, ui, validateAdopt: () => true, kv: kvRaw(), local,
    fileName: (n: string) => n, isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { provider, local, store, conflicts, errors };
}

test("[open-conflict] 事故同款：synced → 外部更新云端 → 本地又编辑(dirty) → open 当场弹；takeCloud=拉云端+本地备份", async () => {
  const { provider, local, store, conflicts } = rig(() => "takeCloud");
  const f = store.file("夏音线稿.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });          // 建谱系：push 成功 → synced（base=云 etag）
  provider._seed("夏音线稿.ora", "CLOUD-NEW");          // 外部写入方（OneDrive 桌面客户端）更新云端 → etag 变
  await f.save(enc("MINE-DIRTY"), { tryPush: false }); // 本机又编辑，只落本地 → dirty ∧ cloudMoved
  const blob = await f.open();
  eq(conflicts.length, 1, "gallery 点开必须当场 surface（修前 0 次、等保存 412 才弹）");
  eq(await asStr(blob), "CLOUD-NEW", "takeCloud → open 返回云端新字节");
  const backups = local.listBackup ? await local.listBackup() : [];
  assert(backups.length >= 1, "dirty 被覆盖前必须先进 .backup（红线：绝不丢字节）");
});

test("[open-conflict] cancel → 留本地 dirty（弹过再留，不是没弹；后续 push 412 仍会 surface）", async () => {
  const { provider, store, conflicts } = rig(() => "cancel");
  const f = store.file("a.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("a.ora", "CLOUD-NEW");
  await f.save(enc("MINE-DIRTY"), { tryPush: false });
  const blob = await f.open();
  eq(conflicts.length, 1, "必须弹过");
  eq(await asStr(blob), "MINE-DIRTY", "cancel → 留本地");
});

test("[open-conflict] clean ∧ 云端动过 → 静默快进（ADR-0016 前半不回归，不弹）", async () => {
  const { provider, store, conflicts } = rig(() => "cancel");
  const f = store.file("b.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });          // synced、clean
  provider._seed("b.ora", "CLOUD-NEW");
  const blob = await f.open();
  eq(conflicts.length, 0, "clean 不弹");
  eq(await asStr(blob), "CLOUD-NEW", "clean → 快进拉云端");
});

test("[open-conflict] 缺陷 B 端到端：从未 synced(!base) ∧ 云端同名 → open 也弹（不再误判 in-sync）", async () => {
  const { provider, store, conflicts } = rig(() => "cancel");
  const f = store.file("c.ora", { isZip: false, mode: "existing" });
  await f.save(enc("MINE"), { tryPush: false });       // 只落本地：seenBase 恒 null
  provider._seed("c.ora", "CLOUD");                    // 云端被外部放了同名文件
  const blob = await f.open();
  eq(conflicts.length, 1, "!base ∧ dirty ∧ 云端有 → 必弹");
  eq(await asStr(blob), "MINE", "cancel → 留本地");
});

test("[open-conflict] in-sync 不弹不拉（无谓冲突不回归）", async () => {
  const { store, conflicts } = rig(() => "cancel");
  const f = store.file("d.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  const blob = await f.open();
  eq(conflicts.length, 0, "云端没动 → 不弹");
  eq(await asStr(blob), "V1", "读本地");
});
