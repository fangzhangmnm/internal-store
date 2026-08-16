// ⚠ 使用前必读 README.md + CONTEXT.md。store 内部深模块——app 经 createStore 的 store.listAllItems，**不 deep import**。
//
// listing（深模块）—— 虚拟文件系统的**统一列举**。把 local(IDB) ∪ cloud 收成一份 Item[]，
//   每项带解析好的 syncState（8-badge）。**offline-first 是结构性的**：云那半拿不到（离线/登出/抛错）
//   → items 仍从本地 appKeys 产出，**绝不返空、绝不 throw**。
//
// ★ 旧 app 层的 mergeLocalCloud（本地 ∪ 云端 union）**收进这里**。理由（store/CONTEXT.md §反-duplicate）：
//   「什么在本地」是 store 独占职责，app 拿不到 etag/dirty/online→喂不到 union 的输入。两个前身宿主
//   各自在 app 层重推过一次 union = 越狱，其一还漏了本地那半 = 登出/离线看不了本地文件的根因。收进库后不可能再漏。
//
// 纯分类器 classifySyncState 可穷举单测（对齐 reconcile.classifyCloudGone 的纪律）。
import type { CloudSync, LocalCache } from "./types.ts";
import type { LocalHead } from "./local-head.ts";
import { isHidden } from "./is-hidden.ts";   // 末段 dot = 隐藏（.trash/.backup/.<appId>/任意 dot 项不进列举）
import { reportStoreError } from "./error-handling.ts";   // 全接但分级：静默 swallow 也 funnel（不改控制流）

//   （单一 Residency 太薄——这是「sync state 更复杂」的落地。8 值对齐 PWAPatterns state-machine.md 的 badge。）
/** syncState = residency(住哪) ⟂ sync-status(clean/dirty/conflict/gone) 两轴的 derived 投影（8-badge）。 */
export type SyncState =
  | "cloud-only"        // 有云 etag、无本地副本（唯一「不在本地」态）
  | "synced"            // bound ∧ clean ∧ 云没动
  | "unpushed"          // bound ∧ dirty ∧ 云没动（↑ 有未推枝）
  | "newer-on-cloud"    // bound ∧ clean ∧ cloudMoved（⟳ 云有新版待 pull）
  | "conflict"          // bound ∧ dirty ∧ cloudMoved（⚠ 两端都动）
  | "ghost"             // dirty ∧ cloudGone（👻 云端没了但有未推字节，绝不删）
  | "pendingGone"       // clean ∧ cloudGone ∧ 在防抖 grace 内（曾 synced、云端刚没了；照常显示 + badge；跨 grace 才 send trash）
  | "float"             // ¬bound ∧ dirty（纯本地、从没 synced、有编辑）
  | "local-only";       // 本地、从没 synced、clean（真本地文件）

/** 统一列举的一项（local ∪ cloud 归并后）。 */
export interface Item {
  /** 身份 = approot 相对路径。格式无关 + provider 无关（唯一跨后端 key；itemId/内容哈希均否决）。 */
  path: string;
  /** 按 ListContext 解析好的 badge —— Item 上就这一个状态字段（防下游 AI 重推导越狱）。 */
  syncState: SyncState;
  /** 字节大小（云端 authoritative，否则本地缓存记录）。 */
  size?: number;
  /** sort-by-date 用（epoch ms）。 */
  lastModified?: number;
}

/** 列举上下文：syncState 的可解析度由它决定（用户拍板：store 吃 ctx、返解析好的 badge）。 */
export interface ListContext {
  /** 登录与否。 */
  signedIn: boolean;
  /** 在线与否。 */
  online: boolean;
}

// 便利判定：**单一来源=syncState**，纯函数，**别在 Item 上加 cached/dirty 字段**（多一个字段=多一条下游越狱路径）。
/** 有本地副本 → 离线可读。 */
export function isCached(s: SyncState): boolean { return s !== "cloud-only"; }
/** 有未推本地编辑 → 永不被驱逐。 */
export function isDirty(s: SyncState): boolean {
  return s === "unpushed" || s === "conflict" || s === "float" || s === "ghost";
}

// ── 纯分类器（零 IO，可穷举单测）：一个 path 的原始事实 → syncState ──────────────────────
//   authoritative 分两级（对齐 reconcile 的失败-fetch 守卫）：
//     cloudReachable      = 拿到了云列表（在线 ∧ 登录 ∧ listAll 没抛错）——决定「云轴可不可解析」
//     absenceAuthoritative= 且 complete=true——决定「没看到=真没了」是否可信（partial 里缺失≠云端真没了，绝不据此判 gone）
export function classifySyncState(f: {
  hasLocal: boolean;
  hasCloud: boolean;           // 云列表里有（hasCloud=true 永远可信；=false 仅 absenceAuthoritative 时可信）
  everSynced: boolean;         // seenBase != null（有已知云版）
  cloudMoved: boolean;         // hasCloud ∧ cloudEtag ≠ seenBase
  dirty: boolean;              // head.isDirty
  cloudReachable: boolean;
  absenceAuthoritative: boolean;
  pendingGone?: boolean;       // clean cloud-gone 孤儿被 reconcile 标了 candidate-gone（防抖 grace 内）→ 显 pendingGone 而非 local-only
}): SyncState {
  if (!f.hasLocal) return "cloud-only";                 // union 保证：到这一定 hasCloud
  // ── 本地有副本 ────────────────────────────────────────────────
  if (!f.cloudReachable) {                              // 离线/登出：云轴不可知 → 塌到本地视角（用户在场也别谎报 synced）
    if (f.dirty) return f.everSynced ? "unpushed" : "float";
    return "local-only";
  }
  // ── cloudReachable ───────────────────────────────────────────
  if (f.hasCloud) {                                     // 云端确实有（可信，无关 complete）
    const moved = f.cloudMoved || !f.everSynced;        // 没 baseline(!everSynced 却撞上云端同名) 也当「云端有别的版本」
    if (moved) return f.dirty ? "conflict" : "newer-on-cloud";
    return f.dirty ? "unpushed" : "synced";
  }
  // ── 云列表里没有 ──────────────────────────────────────────────
  if (!f.everSynced) return f.dirty ? "float" : "local-only";   // 从没 synced = 真本地新文件，云端本就没有
  if (!f.absenceAuthoritative) return f.dirty ? "unpushed" : "synced";  // partial：没看到≠没了 → 保守显示「仍在」
  // 真 cloud-gone：dirty→👻ghost（绝不删）；clean 孤儿→防抖 grace 内显 pendingGone、grace 后被 reconcile trash 掉即从列表消失，否则 local-only。
  if (f.dirty) return "ghost";
  return f.pendingGone ? "pendingGone" : "local-only";
}

// ── 编排：union(cloud.listAll, local.appKeys) ⋈ local-head → Item[] ─────────────────────
export interface ListingCfg {
  cloud: Pick<CloudSync, "listAll" | "listFolder" | "getETag">;
  local: Pick<LocalCache, "appKeys"> & Partial<Pick<LocalCache, "stat">>;   // stat 选填：给本地项填 size/updatedAt（老 mock 无 stat → 跳过）
  head: Pick<LocalHead, "seenBase" | "isDirty">;
  pendingFolders?: () => string[];   // 离线建、尚未确认上云的空文件夹（folder-registry；并进 folders 让它离线可见）
  isPendingGone?: (path: string) => boolean;   // clean cloud-gone 孤儿在防抖 grace 内（pending-gone 深模块）→ 显 pendingGone badge
  pendingFolderDeletions?: () => string[];   // 离线排队待删的已上云空夹（全路径）→ **从 folders 减去**（回线 drain 前先隐藏，不再 list）
}

/** 单夹 snapshot（watchFolder 每次回调的形状）——**只这一夹的直属子项**（非递归）。 */
export interface FolderSnapshot {
  /** 本夹路径（订阅方 sanity-check 用：emit 错乱把别夹推来时可断言丢弃）。 */
  path: string;
  /** 直属文件项。 */
  items: Item[];
  /** immediate 子夹全路径。 */
  folders: string[];
  /** false → 该夹列举失败、不权威。 */
  complete: boolean;
  /** true → 本帧掺了 dir-index-cache 的「上次云端所见」（A3 冷首帧）：cloud-only 项可能已过时，
   *  等云端帧纠偏。stale 帧恒 complete:false（不权威，别据此做任何删/收敛判断）。 */
  stale?: true;
}

// ── listFolder 的可选预取/快照注入（A3）─────────────────────────────────────────────
/** 现场云帧预取（修双拉）：调用方已拉好 cloud.listFolder 结果 → 传进来复用，undefined=listing 自取，null=云不可达。 */
export interface CloudFolderPrefetch { files: { name: string; eTag: string; size: number; lastModifiedDateTime?: string | number; id?: string }[]; folders: string[]; complete: boolean }
/** 「上次云帧」目录索引缓存（dir-index-cache 分区解析后，非 SSoT）：**只用于给本地帧追加 cloud-only 缺项**，
 *  绝不参与本地项的 badge 分类（否则保存后旧 eTag 会闪假 newer-on-cloud）、绝不喂 reconcile（红线）。 */
export interface StaleCloudView { files: { name: string; size?: number; lastModified?: number }[]; folders: string[] }

export const toMs = (v: string | number | undefined): number | undefined => {
  if (v == null) return undefined;
  if (typeof v === "number") return v;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : undefined;
};

export function createListing(cfg: ListingCfg) {
  const { cloud, local, head, pendingFolders, isPendingGone, pendingFolderDeletions } = cfg;

  // 一个 path 的原始事实 → Item（cloud/local 两轴 + head → classifier）。listAllItems 与 listFolder 共用。
  function classifyPath(
    path: string,
    cf: { eTag: string; size: number; lastModified?: number } | undefined,
    hasLocal: boolean,
    cloudReachable: boolean,
    absenceAuthoritative: boolean,
    localStat?: { size: number; updatedAt: number } | null,
  ): Item {
    const hasCloud = cf != null;
    const seen = head.seenBase(path);
    const everSynced = seen != null;
    const cloudMoved = hasCloud && cf!.eTag !== seen;
    const syncState = classifySyncState({
      hasLocal, hasCloud, everSynced, cloudMoved,
      dirty: head.isDirty(path),
      cloudReachable, absenceAuthoritative,
      pendingGone: isPendingGone?.(path),
    });
    // size/时间：云端有就用云端（authoritative），否则用本地缓存记录 → 离线 / 云端帧到达前也不显 0B/1970。
    return { path, syncState, size: cf?.size ?? localStat?.size, lastModified: cf?.lastModified ?? localStat?.updatedAt };
  }

  // 本地项的轻量元信息（size+updatedAt），批量取 → classifyPath 给本地项填尺寸/时间。stat 缺（老 mock）→ 跳过。
  async function statLocal(keys: Iterable<string>): Promise<Map<string, { size: number; updatedAt: number }>> {
    const m = new Map<string, { size: number; updatedAt: number }>();
    if (!local.stat) return m;
    await Promise.all([...keys].map(async (k) => { const s = await local.stat!(k); if (s) m.set(k, s); }));
    return m;
  }

  // 单夹列举（**非递归**）——watchFolder 的每次快照。**per-folder 权威**：只列该夹直属子项、只判该夹内 path。
  //   guardrail（红线）：绝不据本夹的 listing 判**别夹**文件 cloud-gone——因为压根不看别夹的 local key（下面 startsWith(prefix) 门）。
  //   absenceAuthoritative = 这一夹 list() 没抛错（cloudRes.complete）；离线/登出 → cloudReachable=false → 塌到本地视角。
  //   opts（A3）：cloudPrefetched=复用调用方已拉的现场云帧（修「一次订阅打两遍 Graph」）；
  //   staleCloud=dir-index-cache 的上次云帧——**只追加 cloud-only 缺项 + 子夹**，不碰既有项的分类。
  async function listFolder(folder: string, ctx: ListContext, opts?: { cloudPrefetched?: CloudFolderPrefetch | null; staleCloud?: StaleCloudView | null }): Promise<FolderSnapshot> {
    const cloudRes = opts?.cloudPrefetched !== undefined
      ? opts.cloudPrefetched
      : (ctx.online && ctx.signedIn) ? await cloud.listFolder(folder).catch((e) => { reportStoreError(e, "log"); return null; }) : null;
    const cloudReachable = cloudRes != null;
    const absenceAuthoritative = cloudReachable && cloudRes!.complete === true;

    const prefix = folder ? `${folder}/` : "";
    const cloudMap = new Map<string, { eTag: string; size: number; lastModified?: number }>();
    // 身份 = **全名（c.name = toName(云端文件名)）**：明文 X.dat 恒等、加密 X.dat.zip 去尾 .zip → 都归一到 X.dat。
    //   本地 key（appKeys / 迁移后）也是全名 X.dat → 两轴按同一 key 归一；否则 cloud 与 local 分裂成两项、open 对不上
    //   （=0B/打开空白的根因，v390）。app 在边界用 sessionFileName 把裸 session 名转全名；encFileName 负责加密件的 .zip 追加。
    for (const c of cloudRes?.files ?? []) { if (isHidden(c.name)) continue; cloudMap.set(c.name, { eTag: c.eTag, size: c.size, lastModified: toMs(c.lastModifiedDateTime) }); }

    // 本地：只看本夹前缀下的 key；直属文件 → 参与列举，更深的 → 记 immediate 子夹。隐藏项（末段 dot）全跳。
    const localDirect = new Set<string>();
    const subfolders = new Set<string>();
    for (const k of await local.appKeys()) {
      if (folder && !k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      if (!rest) continue;
      const slash = rest.indexOf("/");
      if (slash >= 0) { const sub = prefix + rest.slice(0, slash); if (!isHidden(sub)) subfolders.add(sub); }
      else if (!isHidden(k)) localDirect.add(k);
    }
    for (const f of cloudRes?.folders ?? []) { if (!isHidden(f)) subfolders.add(f); }   // 云端 immediate 子夹（含空夹）
    for (const p of pendingFolders?.() ?? []) {                   // 离线建的空夹：取本夹下的 immediate 段
      if (folder && !p.startsWith(prefix)) continue;
      const rest = folder ? p.slice(prefix.length) : p;
      const seg = rest.includes("/") ? rest.slice(0, rest.indexOf("/")) : rest;
      if (seg && !isHidden(seg)) subfolders.add(prefix + seg);
    }
    const paths = new Set<string>([...cloudMap.keys(), ...localDirect]);
    const localStats = await statLocal(localDirect);
    const items: Item[] = [];
    for (const path of paths) items.push(classifyPath(path, cloudMap.get(path), localDirect.has(path), cloudReachable, absenceAuthoritative, localStats.get(path)));

    // ── stale 快照追加（A3，本地帧专用）：只补「两轴都没见过」的 cloud-only 缺项 + 子夹。────────
    //   既有项（本地有/现场云帧有）**绝不被 stale 数据改写分类**——保存后快照里的旧 eTag 若参与分类，
    //   会闪假 newer-on-cloud badge。追加项 badge 恒 cloud-only（上次所见如此；过时由云端帧纠偏）。
    //   直属 scope 守卫与 localDirect 同纪律（快照损坏/串夹也进不来别夹的项）。
    const stale = opts?.staleCloud != null;
    if (opts?.staleCloud) {
      for (const f of opts.staleCloud.files) {
        if (paths.has(f.name) || isHidden(f.name)) continue;
        const rest = folder ? (f.name.startsWith(prefix) ? f.name.slice(prefix.length) : "") : f.name;
        if (!rest || rest.includes("/")) continue;   // 越界/非直属 → 丢
        items.push({ path: f.name, syncState: "cloud-only", size: f.size, lastModified: f.lastModified });
      }
      for (const sf of opts.staleCloud.folders) if (!isHidden(sf)) subfolders.add(sf);
    }
    // **post-union 减去**离线排队待删的空夹（否则 remote frame / stale 快照每次把它从 folders 闪回）。
    for (const d of pendingFolderDeletions?.() ?? []) subfolders.delete(d);

    const snap: FolderSnapshot = { path: folder, items, folders: [...subfolders], complete: absenceAuthoritative };
    if (stale) snap.stale = true;
    return snap;
  }

  async function listAllItems(ctx: ListContext): Promise<{ items: Item[]; folders: string[]; complete: boolean }> {
    // 云那半：仅在线 ∧ 登录才取；抛错 → null（优雅降级，绝不 throw、绝不据此清本地）。
    const cloudRes = (ctx.online && ctx.signedIn) ? await cloud.listAll().catch((e) => { reportStoreError(e, "log"); return null; }) : null;
    const cloudReachable = cloudRes != null;
    const absenceAuthoritative = cloudReachable && cloudRes!.complete === true;

    const cloudMap = new Map<string, { eTag: string; size: number; lastModified?: number }>();
    for (const c of cloudRes?.files ?? []) {
      if (isHidden(c.name)) continue;
      cloudMap.set(c.name, { eTag: c.eTag, size: c.size, lastModified: toMs(c.lastModifiedDateTime) });   // 身份=session name（裸），见 listFolder 同处注释
    }
    const localSet = new Set((await local.appKeys()).filter((k) => !isHidden(k)));

    const paths = new Set<string>();
    for (const p of cloudMap.keys()) paths.add(p);
    for (const p of localSet) paths.add(p);

    const localStats = await statLocal(localSet);
    const items: Item[] = [];
    for (const path of paths) items.push(classifyPath(path, cloudMap.get(path), localSet.has(path), cloudReachable, absenceAuthoritative, localStats.get(path)));

    // folders = 云 folders(可达时) ∪ 本地 pending 空夹（离线建的）。去重 + 隐藏项（末段 dot）跳过。
    const folderSet = new Set<string>();
    for (const f of cloudRes?.folders ?? []) if (!isHidden(f)) folderSet.add(f);
    for (const p of pendingFolders?.() ?? []) if (!isHidden(p)) folderSet.add(p);
    for (const d of pendingFolderDeletions?.() ?? []) folderSet.delete(d);   // post-union 减去待删空夹

    return { items, folders: [...folderSet], complete: cloudReachable ? cloudRes!.complete : false };
  }

  return { listAllItems, listFolder };
}
