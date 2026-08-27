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

// rig：真 createStore + spy ui（resolveConflict 记录每次弹窗上下文并按参数作答；reportError 记 level；
//   provider.download 计数 = 云端内容拉取次数）。
function rig(choice: () => "keepMine" | "takeCloud" | "cancel", opts: { validateAdopt?: () => boolean } = {}) {
  const provider = createMockProvider();
  const local = createMockLocal();
  const conflicts: Array<{ name: string; cloud: Blob | null; occasion: string }> = [];
  const errors: Array<{ e: unknown; level?: string }> = [];
  const origDownload = provider.download.bind(provider);
  let downloads = 0;
  provider.download = (id: string) => { downloads++; return origDownload(id); };
  const ui = {
    busy: <T>(_l: string, fn: () => Promise<T>) => fn(),
    resolveConflict: async ({ name, cloud, occasion }: { name: string; cloud: Blob | null; occasion: string }) => { conflicts.push({ name, cloud, occasion }); return choice(); },
    reportError: (e: unknown, level?: string) => { errors.push({ e, level }); },
  } as never;
  const store = createStore({ persistence: "none",
    appId: "wp", provider, ui, validateAdopt: opts.validateAdopt ?? (() => true), kv: kvRaw(), local,
    fileName: (n: string) => n, isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { provider, local, store, conflicts, errors, downloadCount: () => downloads };
}

test("[open-conflict] 事故同款：synced → 外部更新云端 → 本地又编辑(dirty) → open 当场弹；takeCloud=拉云端+本地备份", async () => {
  const { provider, local, store, conflicts, downloadCount } = rig(() => "takeCloud");
  const f = store.file("夏音线稿.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });          // 建谱系：push 成功 → synced（base=云 etag）
  provider._seed("夏音线稿.ora", "CLOUD-NEW");          // 外部写入方（OneDrive 桌面客户端）更新云端 → etag 变
  await f.save(enc("MINE-DIRTY"), { tryPush: false }); // 本机又编辑，只落本地 → dirty ∧ cloudMoved
  const blob = await f.open();
  eq(conflicts.length, 1, "gallery 点开必须当场 surface（修前 0 次、等保存 412 才弹）");
  eq(conflicts[0].occasion, "open", "打开路径的弹窗带 occasion='open'（宿主据此换按钮集，grill 2026-08-21）");
  eq(conflicts[0].cloud, null, "sheet 前不预拉云端 blob（QA fix4：宿主不渲染 blob，预拉=双倍下载）");
  eq(await asStr(blob), "CLOUD-NEW", "takeCloud → open 返回云端新字节");
  eq(downloadCount(), 1, "全程云端内容只拉一次（safePull 拉最新；无 sheet 前预拉）");
  const backups = local.listBackup ? await local.listBackup() : [];
  assert(backups.length >= 1, "dirty 被覆盖前必须先进 .backup（红线：绝不丢字节）");
});

test("[open-conflict] takeCloud 拉取失败（云端字节校验不过）→ warning surface + 本地保留（反煤气灯）", async () => {
  const { provider, store, conflicts, errors } = rig(() => "takeCloud", { validateAdopt: () => false });
  const f = store.file("e.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("e.ora", "PORTAL-HTML");              // captive portal / 损坏云副本
  await f.save(enc("MINE-DIRTY"), { tryPush: false });
  const blob = await f.open();
  eq(conflicts.length, 1, "弹过 sheet");
  eq(await asStr(blob), "MINE-DIRTY", "拉取被校验拒绝 → 本地保留（绝不采纳坏字节）");
  assert(errors.some((x) => x.level === "warning"), "用户选了 takeCloud 却没成 → 必须 warning surface（绝不让用户以为拿到云端版）");
});

test("[open-conflict] clean 快进拉取失败 → info（状态栏级，不 banner spam）+ 本地保留", async () => {
  const { provider, store, conflicts, errors } = rig(() => "cancel", { validateAdopt: () => false });
  const f = store.file("g.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });          // synced、clean
  provider._seed("g.ora", "PORTAL-HTML");
  const blob = await f.open();
  eq(conflicts.length, 0, "clean 不弹");
  eq(await asStr(blob), "V1", "坏字节不采纳 → 本地保留");
  assert(errors.some((x) => x.level === "info"), "快进失败 → info（captive portal 下每次 open 不该 banner）");
  assert(!errors.some((x) => x.level === "warning" || x.level === "error"), "不升 warning/error");
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

test("[open-conflict] 保存路径 412 弹窗带 occasion='push'（keepMine=立即本地覆盖云端的那套按钮）", async () => {
  const { provider, store, conflicts } = rig(() => "cancel");
  const f = store.file("h.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("h.ora", "CLOUD-NEW");                // 云端被外部动过 → 下次 push If-Match 412
  await f.save(enc("MINE-2"), { tryPush: true });      // 保存并上传 → 412 → 弹
  assert(conflicts.length >= 1, "push 412 必弹");
  eq(conflicts[conflicts.length - 1].occasion, "push", "保存路径 occasion='push'");
});

test("[open-conflict] in-sync 不弹不拉（无谓冲突不回归）", async () => {
  const { store, conflicts } = rig(() => "cancel");
  const f = store.file("d.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  const blob = await f.open();
  eq(conflicts.length, 0, "云端没动 → 不弹");
  eq(await asStr(blob), "V1", "读本地");
});

// ── 保存路径的化解结果透传（2026-08-25 案卷 20260825-cloud-override-adopt-noop-case.md §1）──
//   事故根因：save 途中 takeCloud 化解后，resolution 被吞成 pushed=true → 调用方不知道 IDB 已换成
//   云端版本 → 画布陈旧 + UI 报 synced → 下次保存把用户选择保留的云端版本静默覆写回去。
//   added by Claude Fable 5, 2026-08-25.
test("[save-resolution] 保存 412 → takeCloud：save 返回 resolution='takeCloud' + 本地=云端版 + 备份必在", async () => {
  const { provider, local, store } = rig(() => "takeCloud");
  const f = store.file("wl.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("wl.ora", "CLOUD-NEW");               // 外部更新云端
  const r = await f.save(enc("MINE"), { tryPush: true });   // 保存 → 412 → sheet → takeCloud
  eq(r.pushed, true, "takeCloud 化解后两端一致 → pushed=true（无待推）");
  eq(r.resolution, "takeCloud", "resolution 必须透传（修前被吞 = 事故根因）");
  eq(await asStr(await local.get("wl.ora")), "CLOUD-NEW", "本地 IDB 已是云端版（≠内存画布，调用方须重载）");
  const backups = local.listBackup ? await local.listBackup() : [];
  assert(backups.length >= 1, "换世界线 → 被换掉的本地版本必进 .backup");
});

test("[save-resolution] 保存 412 → keepMine：resolution='keepMine'（本地胜，无需重载）", async () => {
  const { provider, store } = rig(() => "keepMine");
  const f = store.file("km.ora", { isZip: false, mode: "existing" });
  await f.save(enc("V1"), { tryPush: true });
  provider._seed("km.ora", "CLOUD-NEW");
  const r = await f.save(enc("MINE"), { tryPush: true });
  eq(r.pushed, true, "keepMine 强推落地 → pushed=true");
  eq(r.resolution, "keepMine", "resolution 透传（调用方判定无需重载）");
});
