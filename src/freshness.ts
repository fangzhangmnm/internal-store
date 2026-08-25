// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// freshness（深模块）—— 进入/事件时的"云端动没动 → clean 快进 / dirty surface"。单一职责 =
//   freshness gate（ADR-0016）：比 seenBase vs 云端 etag；clean 且动过 → 静默无损快进；
//   dirty 且动过 → 交 ui 选（绝不静默覆盖 dirty）。编排 local-head.seenBase/isDirty + safe-resolve.safePull。
//   open = 开 session 的 gate（probe 可跳到离线）；refresh = 事件驱动(focus/visibility/online)的纯干净快进。
import { reportStoreError } from "./error-handling.ts";   // 全接但分级：静默 swallow 也 funnel（不改控制流）
import type { CloudSync, FetchMetaResult } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import type { SafeResolve, ResolveChoice } from "./safe-resolve.ts";

import type { Busy } from "./types.ts";
const passBusy: Busy = (_l, fn) => fn();
import type { AdoptFn } from "./types.ts";

export interface FreshnessCfg {
  cloud: Pick<CloudSync, "fetchMeta">;
  head: Pick<LocalHead, "seenBase" | "isDirtyAnywhere" | "markSeen">;
  safeResolve: Pick<SafeResolve, "safePull">;
  busy?: Busy;
}

export interface OpenOpts {
  isOnline?: () => boolean;
  probe?: Promise<unknown> | unknown;            // E8：与 metadata race，先到先得（无硬超时）
  onNewer?: (ctx: { name: string; cloudEtag: string; baseEtag: string | null; cloudTime: string | number }) => ResolveChoice | Promise<ResolveChoice>;
  adopt?: AdoptFn;
  localDirty?: () => boolean;
  busy?: Busy;
}
/** refresh（事件驱动的纯干净快进）的选项。 */
export interface RefreshOpts {
  /** 在线判定注入。 */
  isOnline?: () => boolean;
  /** 采纳验真回调。 */
  adopt?: AdoptFn;
  /** 本地 dirty 判定注入。 */
  localDirty?: () => boolean;
  /** N10：真要拉内容（动过+clean）才触发，app 给非阻塞 status。 */
  onReplaceStart?: () => void;
  /** 逃生 probe（对齐 open 的 E8，user 即超时）：与快进下载 race，probe 先到 → 返 {status:"escaped"}，
   *  本地/谱系分毫不动（换字节/markSynced 全在 safePull 尾段，逃生时还没发生）。语义（2026-08-25 拍板）：
   *  逃生 = 用户 consent **显式分叉**（换世界线不等待），app 据 "escaped" 把当前画面另存新身份；
   *  迟到完成的下载 = 原名缓存的静默刷新（无 adopt，画布不碰），无害且有益。 */
  probe?: Promise<unknown>;
  /** busy 遮罩注入。 */
  busy?: Busy;
}
/** open / refresh 的终态。 */
export interface FreshResult {
  /** 内容来源串。 */
  source?: string;
  /** 终态串。 */
  status?: string;
  /** 原因串。 */
  reason?: string;
  /** 覆盖前留底的备份名。 */
  backupName?: string;
  /** 原始异常。 */
  error?: unknown }

export function createFreshness(cfg: FreshnessCfg) {
  const { cloud, head, safeResolve, busy: _busy = passBusy } = cfg;

  // safePull 失败原因 → 用户能懂的短语（喂 reportStoreError；技术 reason 原样兜底）。
  const pullFailText = (reason: string): string =>
    reason === "invalid-cloud-bytes" ? "云端内容没通过校验，可能是公共 Wi-Fi 登录页劫持或文件损坏"
    : reason === "cloud-vanished" ? "云端文件刚刚被移动或删除"
    : reason === "backup-failed" ? "本地留底失败，为保数据没有覆盖"
    : reason;

  async function open(name: string, opts: OpenOpts = {}): Promise<FreshResult> {
    const { isOnline = () => true, probe, onNewer, adopt, localDirty, busy = passBusy } = opts;
    if (!isOnline()) return { source: "local", reason: "offline" };
    return busy("cloud.checking", async () => {
      let meta: FetchMetaResult | null;
      if (probe) {
        const raced = await Promise.race([
          cloud.fetchMeta(name).then((m) => ({ k: "meta" as const, m }), (e) => ({ k: "err" as const, e })),
          Promise.resolve(probe).then(() => ({ k: "skip" as const })),
        ]);
        if (raced.k === "skip") return { source: "local", reason: "skipped" };
        if (raced.k === "err") return { source: "local", reason: "cloud-error" };
        meta = raced.m;
      } else {
        try { meta = await cloud.fetchMeta(name); } catch (e) { reportStoreError(e, "log"); return { source: "local", reason: "cloud-error" }; }
      }
      if (!meta) return { source: "local", reason: "cloud-absent" };
      const base = head.seenBase(name);
      if (base != null && meta.etag === base) {
        // 云端 === 本 tab 已见 base（没动）→ in-sync。reload 后内存 _base 空（seenBase 回退共享 etag），
        //   此时 markSeen 重捕 _base（dirty 还顺带重捕 _parent，local-head.ts:82）→ 闭合「dirty 但 _base 空 →
        //   下次推走 no-base fail → 误报 CloudNameCollisionError」窗口。只在 meta.etag===base（云端没动）调=安全：
        //   云端动过会落到下面 dirty→surface 路径，绝不在这里前推 parent（防 B1 silent-overwrite）。
        head.markSeen(name, meta.etag);
        return { source: "local", reason: "in-sync" };
      }
      // !base（无 baseline：从未 synced 的血统 / 谱系丢失）∧ 云端有文件 → 按「云端有别的版本」处理，
      //   对齐 listing.classifySyncState 的 `moved = cloudMoved || !everSynced`（同一事实不许两种结论）。
      //   旧版把 !base 判 in-sync = 静默保留陈旧本地（缺陷 B，20260820-open-time-conflict-surface-handoff）。
      const dirty = head.isDirtyAnywhere(name) || (localDirty ? localDirty() : false);// 全局问题用 isDirtyAnywhere（2026-08-21：别 tab 的未推字节 per-tab 视角看不见）
      if (!dirty) {                                       // clean → 静默快进（无 sheet；safePull 因 clean 跳备份——!base 例外，谱系未知必备份）
        const r = await safeResolve.safePull(name, { adopt });
        // 快进没承诺过什么 → 失败只 info（状态栏，不 banner；captive portal 下每次 open 都会走到这里）。
        if (!r.ok) reportStoreError(new Error(`「${name}」云端有新版本但暂时取不到（${pullFailText(r.reason)}），已打开本地版本`), "info");
        return r.ok ? { source: "fast-forwarded", backupName: r.backupName } : { source: "local", reason: r.reason, error: r.error };
      }
      // dirty 分叉 → 交 ui（takeCloud=拉 / keepMine|cancel=留本地）
      const choice = onNewer ? await onNewer({ name, cloudEtag: meta.etag, baseEtag: base, cloudTime: meta.lastModified }) : "cancel";
      if (choice === "takeCloud") {
        const r = await safeResolve.safePull(name, { adopt });
        // 用户显式选了「用云端」却没成 → warning（banner）：绝不让用户以为打开的是云端版（反煤气灯）。
        if (!r.ok) reportStoreError(new Error(`「${name}」未能取回云端版本（${pullFailText(r.reason)}），本次打开的仍是本地版本`), "warning");
        return r.ok ? { source: "pulled", backupName: r.backupName } : { source: "local", reason: r.reason, backupName: r.backupName, error: r.error };
      }
      return { source: "local", reason: "kept" };
    });
  }

  // 事件驱动干净快进：dirty → no-op（绝不在事件里弹 sheet；后续 push 的 412 会 surface 真分叉）。
  async function refresh(name: string, opts: RefreshOpts = {}): Promise<FreshResult> {
    const { isOnline = () => true, adopt, localDirty, onReplaceStart, probe, busy = passBusy } = opts;
    if (!isOnline()) return { status: "offline" };
    if (head.isDirtyAnywhere(name) || (localDirty && localDirty())) return { status: "dirty-skip" };   // anywhere：快进覆盖的是**共享**本地字节，别 tab 的未推编辑也要挡
    return busy("cloud.checking", async () => {
      let meta: FetchMetaResult | null;
      try { meta = await cloud.fetchMeta(name); } catch (e) { reportStoreError(e, "log"); return { status: "cloud-error" }; }
      if (!meta) return { status: "cloud-absent" };
      const base = head.seenBase(name);
      // !base ∧ 云端有 → 同 open：按 moved 处理（对齐 listing；clean-only 路径 → 直接快进采纳云端）。
      if (base != null && meta.etag === base) return { status: "in-sync" };
      if (head.isDirtyAnywhere(name) || (localDirty && localDirty())) return { status: "dirty-skip" };   // anywhere：快进覆盖的是**共享**本地字节，别 tab 的未推编辑也要挡  // fetchMeta 期间用户动了笔 → 放弃
      if (onReplaceStart) onReplaceStart();
      // 逃生 race（2026-08-25）：probe 先到 → "escaped"（分叉 consent）。safePull 继续在后台跑完 = 原名
      //   缓存静默刷新（这里没传 adopt 时画布不碰；错误 funnel 到 log，不打扰已走人的用户）。
      const pulling = safeResolve.safePull(name, { adopt });
      if (probe) {
        const winner = await Promise.race([pulling.then((r) => ({ r })), Promise.resolve(probe).then(() => null)]);
        if (winner == null) { pulling.catch((e) => reportStoreError(e, "log")); return { status: "escaped" }; }
        return winner.r.ok ? { status: "fast-forwarded" } : { status: "ff-failed", reason: winner.r.reason };
      }
      const r = await pulling;
      return r.ok ? { status: "fast-forwarded" } : { status: "ff-failed", reason: r.reason };
    });
  }

  return { open, refresh };
}
