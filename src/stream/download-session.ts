// ⚠ store 内部深模块。app 不直接 import——经 createStore 的 file().openStream() / keepOffline()。
//
// download-session（A1，2026-08-15 user 批）—— 大文件的**分片下载会话** + `staging/` 暂存区 + 全局调度。
//   一个会话 = 「某文件某 eTag 版」的按需分片拉取：分片落 staging（tee），读取优先从 staging 答；
//   收尾二选一：promote（补齐缺口 → 升格为正式本地副本，= keepOffline 完成）或弃置（分片留在 staging，
//   受全局字节上限 FIFO 兜底——先播后 pin 不重下的关键）。
//
// 纪律（对齐计划 v2 + §A 红线）：
//   · staging **只装云端拉来的字节**（re-fetchable by construction），永远不装 dirty/用户唯一副本
//     → staging 的任何清理都绝不丢用户数据（与「无 LRU」教义不冲突：这是 scratch，不是缓存治理复辟）。
//   · promote 绝不覆盖既有本地副本：本地已有（用户其间正常 open 过）→ 直接收摊；dirty 更是碰都不碰。
//   · 调度（2.0.0 起住 chunk-scheduler.ts）：读取（播放）优先；投机（prefetch / 补缺口）同时在飞 ≤ lanes（不传 = 1 = 严格串行，
//     user 显式钉死），且播放有分片在飞/在等时投机不开新分片（分片粒度让路，不杀请求）。
//   · eTag 钉版：会话开在某一版上；promote 前重验 fetchMeta，版变 → 清本 name staging + 抛 EtagChangedError。
//   · 时间戳（meta.touched）只用于 scratch 清理排序，绝不参与任何内容/版本决策（no-timestamps 红线）。
//
// 2.0.0（2026-10-17 Claude Fable 5.1；user「你现在是fable了，开始做涉及库的改动」）——`streaming` 显式开关（不传 = 0.18 行为）：
//   · lanes：投机车道数；stallMs：卡住判定（播放对冲 / 投机让道）——政策全在 chunk-scheduler.ts。
//   · prefetch() 在 streaming 模式下失败如实 reject（预取方要靠它学「这片没拉到」）；0.18 模式照旧只 log。
//   · mirrors：替代来源（本机文件 / 局域网 / Tailscale），身份仍归云端 item：开会话时按名字 + 尺寸问镜像有没有 →
//     有就排在云端前面；出错 / 卡住回落云端、镜像进冷却（30 s 起翻倍，封顶 10 min）；镜像给的片**抽样和云端比字节**
//     （第 1 片必比，之后每 16 片比 1 片）——不一样 = 这份文件这一版不再用它，它给的没验过的片一并清掉（staging 里哪些片
//     来自镜像记在 meta.mirrored）。云端够不着而 staging 账上有这份（eTag / 尺寸已知）且镜像有 → 只用镜像开会话（离线也能播）。
//   · 0.18 的一个互等修了（chunk-scheduler 头注释），不分模式。
//
// staging 分区 key 形（schema v1，2026-08-15 user 过目改名定稿：陌生人开 DevTools 一眼可懂）：
//   `meta:<name>`     → JSON { v:1, eTag, totalBytes, chunkBytes, chunks:[分片号…], touchedAt, mirrored?:[分片号…] }
//                       （会话元信息 + 已持有分片账；mirrored = 2.0.0 加的可选字段：来自镜像、还没和云端比过的片）
//   `chunk:<name>:<i>`→ 分片字节 blob（i 十进制；name 不含 ":"——Windows 非法字符已被文件名护栏挡在门外）
import { reportStoreError } from "../base/error-handling.ts";
import { createChunkScheduler, type ChunkSource, type RangeOpts, type SchedulerStatus } from "./chunk-scheduler.ts";
export { StreamStallError } from "./chunk-scheduler.ts";
export type { SchedulerStatus } from "./chunk-scheduler.ts";
export type { RangeOpts } from "../base/types.ts";

/** staging 分区的注入端口（prod = blob-partition 的 "staging" 分区；测试 = 内存 map）。 */
export interface StagingStore {
  get(key: string): Promise<Blob | null>;
  put(key: string, blob: Blob): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 会话打开时钉住的云端元信息（fetchMeta 的窄投影 + provider 直连所需的 item 句柄）。 */
export interface SessionMeta { etag: string; size: number; item: unknown }

/** 镜像给某份文件的句柄（mirror.ts 的 createFileMirror / createHttpMirror 造；宿主也可以自己实现）。 */
export interface MirrorHandle { read(offset: number, length: number, opts?: RangeOpts): Promise<Uint8Array> }
/** 替代来源：按云端文件名 + 尺寸问「你有没有这份」。 */
export interface MirrorSource {
  /** 给人看的名字（状态 / 日志）。 */
  label: string;
  /** 有 → 句柄；没有 / 尺寸不符 / 够不着 → null（不抛）。 */
  open(name: string, size: number): Promise<MirrorHandle | null>;
}

/** 2.0.0 流式面的行为开关（user 2026-10-15「行为变更默认关、消费方显式开」）：createStore({ streaming }) 传了才生效；不传 = 0.18 行为。 */
export interface StreamingOptions {
  /** 投机（prefetch / keep 补缺口）同时在飞的分片数，全 store 一个调度域。不传 = 1（= 0.18 的 pin 严格串行）。播放不限、不占车道。 */
  lanes?: number;
  /** 卡住判定：一路连续 stallMs 没到一个字节。播放的读 → 再开一路对冲（先到的赢、输的中止）；投机 → 中止让道（这次 prefetch 以 StreamStallError 失败）。
   *  不传 = 不判（只靠传输层超时）。 */
  stallMs?: number;
  /** 替代来源（本机文件 / 局域网 / Tailscale 镜像），按偏好排序；每次开会话取一次。 */
  mirrors?: () => MirrorSource[];
}
export type MirrorState = "none" | "ok" | "down" | "rejected";
/** 流式句柄的零网络快照（状态条：「有请求卡着」比实时 KB 更要紧——user 10-17）。 */
export interface StreamStatus extends SchedulerStatus {
  /** 这会话的镜像：none 没有 / ok 在用 / down 出过错在冷却（走云端）/ rejected 字节和云端不一样、这一版不再用。 */
  mirror: MirrorState;
  mirrorLabel?: string;
  /** 云端够不着、只靠镜像 + staging 开的会话（没法和云端比字节）。 */
  cloudless: boolean;
}

export interface DownloadSessionsCfg {
  staging: StagingStore;
  /** 云端元信息（开会话钉版 + promote 前重验）。 */
  fetchMeta: (name: string) => Promise<SessionMeta | null>;
  /** 按 item 句柄 byte-range 拉（**不**每分片重走 metadata 往返——JRP 抱怨过的 per-open 冗余 GET）。opts 可选：中止 + 进度（2.0.0）。 */
  range: (item: unknown, offset: number, length: number, opts?: RangeOpts) => Promise<Uint8Array>;
  /** promote 落地（create-store 注入：serialize 锁内 local.save + head.markSynced，对齐 acquire 语义）。
   *  返 false = 本地已有副本/不可落（session 直接收摊，不覆盖）。 */
  adoptLocal: (name: string, blob: Blob, etag: string) => Promise<boolean>;
  chunkSize?: number;          // 默认 2MiB（分片粒度 = pin 给播放让路的粒度）
  capBytes?: number;           // staging 全局字节上限（默认 256MiB）；超限 FIFO 清最旧 touched 的整组
  now?: () => number;          // 测试注入
  /** 2.0.0 行为开关；不传 = 0.18 行为。 */
  streaming?: StreamingOptions;
}

/** staging 覆盖快照（A5 透明面，2026-08-18 user 批「关键是透明清晰」）——只读 staging 账本，
 *  **零网络、离线可用**。app 拿它画徽章三态（已钉走 isKeptOffline / 完整缓存 / 部分缓存）+ 离线起播
 *  护栏（complete 才起播——防「头部在缓存先响了、播到洞静默卡死」）+ 离线边界接曲决策（headBytes）。
 *  注意：反映的是账上那一版（eTag 在案），不上网验云端当下版。 */
export interface StagingCoverage {
  totalBytes: number;
  /** 已持有字节（按分片账算，不打网络）。 */
  bytes: number;
  /** 从文件头起**连续**已持有的字节数（「头部备好没」）。 */
  headBytes: number;
  /** 全部分片在账 = 离线可完整播。 */
  complete: boolean;
  eTag: string;
}

/** eTag 钉版失效：云端在会话期间换了版。caller 清障后可重开会话。 */
export class EtagChangedError extends Error {
  constructor(name: string) { super(`云端文件已更新，下载会话失效：${name}`); this.name = "EtagChangedError"; }
}

interface StagingMeta { v: 1; eTag: string; totalBytes: number; chunkBytes: number; chunks: number[]; touchedAt: number; mirrored?: number[] }

const CHUNK_DEFAULT = 2 * 1024 * 1024;
const CAP_DEFAULT = 256 * 1024 * 1024;
const VERIFY_EVERY = 16;                    // 镜像给的片：第 1 片必比，之后每 16 片抽 1 片和云端比
const MIRROR_COOLDOWN_MS = 30_000;          // 镜像出错后的冷却，连续出错翻倍
const MIRROR_COOLDOWN_MAX_MS = 10 * 60_000;

const mKey = (name: string): string => `meta:${name}`;
const cKey = (name: string, i: number): string => `chunk:${name}:${i}`;

export interface DownloadSession {
  name: string;
  totalSize: number;
  eTag: string;
  /** 读一段（播放优先级）：staging 有就秒答，缺的现拉现存（tee）。越界自动钳；会话已关 → 抛。 */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** 低优先预拉一段进 staging（下一曲头部预拉等）；不返字节。
   *  0.18 模式：失败只 log、永不 reject。streaming 模式：没拉到如实 reject（含 StreamStallError）。 */
  prefetch(offset: number, length: number): Promise<void>;
  /** 已持有字节数（进度显示；≈ got.length × chunk，不打网络）。 */
  havedBytes(): number;
  /** 补齐全部缺口（投机优先级，≤ lanes 路并行）+ 升格正式本地副本 + 清本 name staging。
   *  eTag 已变 → 清 staging 抛 EtagChangedError；本地已有副本 → 只清 staging（不覆盖）。 */
  promote(opts?: { onProgress?: (doneBytes: number, totalBytes: number) => void }): Promise<void>;
  /** 零网络快照：在飞 / 卡住 / 镜像状态。 */
  status(): StreamStatus;
  /** 关会话（staging 留着，受全局 cap FIFO 兜底——先播后 pin 不重下）。 */
  close(): void;
}

interface MirrorHealth { failures: number; downUntil: number }

export function createDownloadSessions(cfg: DownloadSessionsCfg) {
  const { staging, fetchMeta, range, adoptLocal } = cfg;
  const chunkSize = cfg.chunkSize ?? CHUNK_DEFAULT;
  const capBytes = cfg.capBytes ?? CAP_DEFAULT;
  const now = cfg.now ?? ((): number => Date.now());
  const streaming = cfg.streaming;                         // undefined = 0.18 行为
  const lanes = Math.max(1, Math.floor(streaming?.lanes ?? 1));

  // ── 调度（模块级 = 全 store 一个调度域）─────────────────────────────────────────
  const scheduler = createChunkScheduler({ lanes, stallMs: streaming?.stallMs, now });
  const activeSessions = new Set<string>();               // cap 清理绝不动在用会话的组
  const liveMeta = new Map<string, StagingMeta>();        // 在用会话的内存账（coverage 看它：字节一到账就对，不等落盘）
  const mirrorHealth = new Map<MirrorSource, MirrorHealth>();   // 每个镜像一份（store 实例级、内存）
  const mirrorRejected = new Set<string>();               // `${name}@${eTag}@${label}`：字节和云端不一样，这一版不再用

  // ── staging 记账（**全部 best-effort**：staging 是加速器不是正确性依赖——IDB 坏了/配额满，
  //   会话照样直连云端流字节，promote 组装缺片直接重拉补）─────────────────────────────────
  const sGet = async (k: string): Promise<Blob | null> => { try { return await staging.get(k); } catch (e) { reportStoreError(e, "log"); return null; } };
  const sPut = async (k: string, b: Blob): Promise<void> => { try { await staging.put(k, b); } catch (e) { reportStoreError(e, "log"); } };
  const sDel = async (k: string): Promise<void> => { try { await staging.del(k); } catch (e) { reportStoreError(e, "log"); } };
  async function readMeta(name: string): Promise<StagingMeta | null> {
    try {
      const b = await sGet(mKey(name));
      if (!b) return null;
      const p = JSON.parse(await b.text()) as StagingMeta;
      return p?.v === 1 && typeof p.eTag === "string" && Array.isArray(p.chunks) ? p : null;
    } catch (e) { reportStoreError(e, "log"); return null; }
  }
  async function writeMeta(name: string, m: StagingMeta): Promise<void> {
    await sPut(mKey(name), new Blob([JSON.stringify(m)], { type: "application/json" }));
  }
  /** 清某 name 的整组 staging（meta + 全部分片）。 */
  async function purgeName(name: string): Promise<void> {
    try {
      const prefix = `chunk:${name}:`;
      for (const k of await staging.keys()) if (k === mKey(name) || k.startsWith(prefix)) await staging.del(k);
    } catch (e) { reportStoreError(e, "log"); }   // 清理 best-effort（staging 坏了不拦主流程）
  }
  // 全局 cap 兜底：估算占用（got.length×chunk），超限清 touched 最旧的整组（scratch FIFO；跳过在用会话）。
  async function enforceCap(): Promise<void> {
    try {
      const metas: { name: string; meta: StagingMeta }[] = [];
      for (const k of await staging.keys()) {
        if (!k.startsWith("meta:")) continue;
        const name = k.slice(5);
        const meta = await readMeta(name);
        if (meta) metas.push({ name, meta });
      }
      let total = metas.reduce((s, x) => s + x.meta.chunks.length * x.meta.chunkBytes, 0);
      if (total <= capBytes) return;
      metas.sort((a, b) => a.meta.touchedAt - b.meta.touchedAt);   // 只排 scratch 清理顺序，非内容决策
      for (const { name, meta } of metas) {
        if (total <= capBytes) break;
        if (activeSessions.has(name)) continue;
        await purgeName(name);
        total -= meta.chunks.length * meta.chunkBytes;
      }
    } catch (e) { reportStoreError(e, "log"); }   // cap 清理失败无害（下次再清）；绝不影响主流程
  }

  /** 覆盖快照（只读账本，零网络）。无残片 → null。 */
  async function coverage(name: string): Promise<StagingCoverage | null> {
    const m = liveMeta.get(name) ?? await readMeta(name);
    if (!m) return null;
    const nChunks = Math.max(1, Math.ceil(m.totalBytes / m.chunkBytes));
    const got = new Set(m.chunks);
    const sizeOf = (i: number): number => Math.min(m.chunkBytes, m.totalBytes - i * m.chunkBytes);
    let bytes = 0;
    for (const i of got) if (i >= 0 && i < nChunks) bytes += sizeOf(i);
    let headBytes = 0;
    for (let i = 0; i < nChunks && got.has(i); i++) headBytes += sizeOf(i);
    return { totalBytes: m.totalBytes, bytes, headBytes, complete: headBytes === m.totalBytes, eTag: m.eTag };
  }

  /** 离线升格（A6，2026-08-19 user 批）：staging 账**完整**时零网络组装落地，谱系记账上的 eTag。
   *  红线分析：等价于「早先拉过该版、云端其后又动」的正常 clean 陈旧态——回线后 freshness/pull
   *  照常校验收敛；adoptLocal 原有护栏不变（已有副本/dirty 绝不覆盖，false 也照样收摊清账）。
   *  账没有 → "none"；缺片/尺寸不符 → "incomplete"（**不清账**——残片仍有复用价值，caller 报人话）。 */
  async function promoteFromStaging(name: string): Promise<"done" | "none" | "incomplete"> {
    const m = await readMeta(name);
    if (!m) return "none";
    const nChunks = Math.max(1, Math.ceil(m.totalBytes / m.chunkBytes));
    const parts: Blob[] = [];
    let size = 0;
    for (let i = 0; i < nChunks; i++) {
      const c = await sGet(cKey(name, i));
      if (!c) return "incomplete";
      parts.push(c); size += c.size;
    }
    if (size !== m.totalBytes) return "incomplete";   // 账/字节不符：宁可报不完整也绝不落错尺寸副本
    await adoptLocal(name, new Blob(parts), m.eTag);
    await purgeName(name);
    return "done";
  }

  // ── 镜像健康（store 实例级）──────────────────────────────────────────────────────
  const healthOf = (src: MirrorSource): MirrorHealth => { let h = mirrorHealth.get(src); if (!h) mirrorHealth.set(src, (h = { failures: 0, downUntil: 0 })); return h; };
  const mirrorUp = (src: MirrorSource): boolean => now() >= healthOf(src).downUntil;
  const mirrorFailed = (src: MirrorSource): void => {
    const h = healthOf(src);
    h.failures++;
    h.downUntil = now() + Math.min(MIRROR_COOLDOWN_MS * 2 ** (h.failures - 1), MIRROR_COOLDOWN_MAX_MS);
  };
  const mirrorOk = (src: MirrorSource): void => { const h = healthOf(src); h.failures = 0; h.downUntil = 0; };
  const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  // ── 会话 ────────────────────────────────────────────────────────────────────────
  async function open(name: string): Promise<DownloadSession | null> {
    // 云端元信息：钉版事实。够不着时（2.0.0 streaming 模式）看 staging 账 + 镜像能不能撑起一个「无云」会话。
    let cm0: SessionMeta | null = null, cloudErr: unknown = null;
    try { cm0 = await fetchMeta(name); } catch (e) { cloudErr = e; }
    const prev = await readMeta(name);
    const mirrorList = streaming?.mirrors?.() ?? [];
    let etag: string, size: number, item: unknown | null;
    if (cm0) { ({ etag, size, item } = cm0); }
    else if (prev && mirrorList.length > 0) { etag = prev.eTag; size = prev.totalBytes; item = null; }   // 无云会话：身份 = 账上那一版
    else { if (cloudErr) throw cloudErr; return null; }
    // staging 里若有**别的版**的残片 → 清（eTag 钉版）；同版 → 续用（先播后 pin 不重下的另一半：跨会话续）。
    if (prev && prev.eTag !== etag) await purgeName(name);
    const meta: StagingMeta = (prev && prev.eTag === etag)
      ? { ...prev, touchedAt: now() }
      : { v: 1, eTag: etag, totalBytes: size, chunkBytes: chunkSize, chunks: [], touchedAt: now() };
    const got = new Set<number>(meta.chunks);
    const mirrored = new Set<number>(meta.mirrored ?? []);
    await writeMeta(name, meta);
    const nChunks = Math.max(1, Math.ceil(size / chunkSize));
    let closed = false;

    // 镜像：第一个「健康、没被拒、有这份（同名同尺寸）」的。无云会话：镜像是唯一来源，冷却不算（没别的可退）。
    let mirror: { src: MirrorSource; handle: MirrorHandle } | null = null;
    let mirrorState: MirrorState = "none";
    for (const src of mirrorList) {
      if (mirrorRejected.has(`${name}@${etag}@${src.label}`)) { mirrorState = "rejected"; continue; }
      if (item !== null && !mirrorUp(src)) { mirrorState = "down"; continue; }
      let handle: MirrorHandle | null = null;
      try { handle = await src.open(name, size); } catch (e) { reportStoreError(e, "log"); }
      if (handle) { mirror = { src, handle }; mirrorState = "ok"; break; }
    }
    if (item === null && !mirror) { if (cloudErr) throw cloudErr; return null; }   // 无云又无镜像：诚实
    activeSessions.add(name);
    liveMeta.set(name, meta);
    let mirrorChunks = 0;                                    // 这会话从镜像交出去的片数（抽样节拍）
    let firstOk = false;                                     // 镜像的第一片已和云端比过、一样
    let firstCheck: Promise<"same" | "differs" | "unknown"> | null = null;   // 并发的头几片共用一次核对（不每片都打云端）
    const verified = new Set<number>();                      // 这会话里已和云端比过、一样的镜像片（arrived 不再记进 mirrored）

    const chunkOff = (i: number): number => i * chunkSize;
    const chunkLen = (i: number): number => Math.min(chunkSize, size - chunkOff(i));

    /** 镜像字节和云端不一样：这一版不再用它；它给的、还没验过的片全部清掉（在内存账和 staging 里一起删）。 */
    async function rejectMirror(reason: string): Promise<void> {
      if (!mirror) return;
      const { src } = mirror;
      mirror = null; mirrorState = "rejected";
      mirrorRejected.add(`${name}@${etag}@${src.label}`);
      const bad = [...mirrored];
      for (const i of bad) { got.delete(i); mirrored.delete(i); await sDel(cKey(name, i)); }
      meta.chunks = [...got]; meta.mirrored = [];
      await writeMeta(name, meta);
      reportStoreError(new Error(`mirror "${src.label}" served different bytes for "${name}" (${reason}); dropped it for this version and purged ${bad.length} unverified chunk(s)`), "warning");
    }
    /** 抽样核对（事后、异步）：镜像给的每 VERIFY_EVERY 片比 1 片。云端够不着 → 没结论（不动）。
     *  一样 → 这片从「没验过」里划掉；不一样 → 拒掉镜像、清它没验过的片（这片已经交出去了——同尺寸、只有中段不同的文件只能靠抽样，残余风险如实记在发版说明）。
     *  seq = 这片是镜像交出的第几片，**在到达那一刻定**（2.1.3 修：以前在 await 落 staging 之后才看计数，三路并发时第 16 片醒来计数已是 17、18 → 抽样被系统性跳过；
     *  test/download-session「并发下也按节拍抽」钉着）。 */
    async function sampleVerify(i: number, bytes: Uint8Array, seq: number): Promise<void> {
      if (item === null || !mirror || verified.has(i)) return;
      if (seq % VERIFY_EVERY !== 0) return;
      let ref: Uint8Array | null = null;
      try { ref = await range(item, chunkOff(i), chunkLen(i)); } catch (e) { reportStoreError(e, "log"); return; }
      if (!mirror) return;                                   // 其间已被别的核对拒掉
      if (sameBytes(ref, bytes)) {
        verified.add(i);
        if (mirrored.delete(i)) { meta.mirrored = mirrored.size ? [...mirrored] : undefined; await writeMeta(name, meta); }
      } else await rejectMirror(`chunk ${i}`);
    }

    /** 字节到了（赢家 / 输家 / 晚到的都来）：先记内存账（同步——调度器在 resolve 之前叫它，等字节的人醒来时账已经对），
     *  再落 staging、再写 meta（先片后账：崩在中间也不会账上有片、盘上没片）。落盘失败只 log——staging 是加速器不是正确性依赖。 */
    async function arrived(i: number, bytes: Uint8Array, origin: string): Promise<void> {
      if (origin === "mirror" && !mirror) return;             // 镜像已被拒：它晚到的字节不要
      let changed = false;
      if (!got.has(i)) { got.add(i); changed = true; }
      if (origin === "mirror" && !verified.has(i) && !mirrored.has(i)) { mirrored.add(i); changed = true; }
      if (changed) { meta.chunks = [...got]; meta.mirrored = mirrored.size ? [...mirrored] : undefined; meta.touchedAt = now(); }
      const seq = origin === "mirror" ? ++mirrorChunks : 0;   // 抽样节拍在到达那一刻定（2.1.3）
      await sPut(cKey(name, i), new Blob([bytes as BlobPart]));
      if (changed) await writeMeta(name, meta);
      void enforceCap();
      if (origin === "mirror") void sampleVerify(i, bytes, seq);
    }

    /** 这一片的来源（按偏好）：健康的镜像在前、云端在后。镜像的成败回写健康表。
     *  镜像给的**第一片先和云端比过再交出去**（错盘 / 换过密钥的旧容器一个字节都不交）：不一样 → 拒掉镜像、这路以错失败 → 调度器回落云端。
     *  云端那一下够不着 → 这片不算核对过（下一片再比），字节照交——镜像在、云端不在，诚实的最好结果。 */
    function sourcesFor(i: number): ChunkSource[] {
      const off = chunkOff(i), len = chunkLen(i);
      const list: ChunkSource[] = [];
      if (mirror && (item === null || mirrorUp(mirror.src))) {   // 无云会话：镜像是唯一来源，冷却不算
        const m = mirror;
        list.push({
          origin: "mirror",
          fetch: async (o) => {
            try {
              const b = await m.handle.read(off, len, o);
              if (b.length !== len) throw new Error(`mirror "${m.src.label}": chunk ${i} returned ${b.length} bytes, wanted ${len}`);
              if (!firstOk && item !== null && mirror === m) {
                let checker = false;
                if (!firstCheck) { checker = true; firstCheck = range(item, off, len).then((ref) => (sameBytes(ref, b) ? "same" : "differs"), (e) => { reportStoreError(e, "log"); return "unknown"; }); }
                const r = await firstCheck;
                if (r === "differs") { if (checker) await rejectMirror(`chunk ${i}`); throw new Error(`mirror "${m.src.label}": chunk ${i} differs from cloud`); }
                if (r === "same") { firstOk = true; if (checker) verified.add(i); }
                else if (checker) firstCheck = null;          // 云端够不着：没结论，下一片再比；字节照交
              }
              mirrorOk(m.src);
              return b;
            } catch (e) {
              if (!o.signal?.aborted && mirror === m) { mirrorFailed(m.src); mirrorState = "down"; reportStoreError(e, "log"); }   // 我们自己中止的不算它的错；已拒的不再记
              throw e;
            }
          },
        });
      }
      if (item !== null) list.push({ origin: "cloud", fetch: (o) => range(item, off, len, o) });
      return list;
    }
    // 拉一个分片（去重 / 让路 / 车道 / 对冲全在 scheduler）：staging 有就秒答；拉到即落 staging + 记账。
    const fetchChunk = (i: number, prio: "playback" | "pin"): Promise<Uint8Array> => scheduler.request({
      key: `${name}:${i}`, prio,
      preflight: async () => { const c = await sGet(cKey(name, i)); return c ? new Uint8Array(await c.arrayBuffer()) : null; },
      sources: sourcesFor(i),
      arrived: (bytes, origin) => arrived(i, bytes, origin),
    });
    const playbackChunk = (i: number): Promise<Uint8Array> => fetchChunk(i, "playback");
    const pinChunk = (i: number): Promise<Uint8Array> => fetchChunk(i, "pin");

    const clampRange = (offset: number, length: number): { i0: number; i1: number; off: number; len: number } => {
      const off = Math.max(0, Math.min(offset, size));
      const len = Math.max(0, Math.min(length, size - off));
      return { i0: Math.floor(off / chunkSize), i1: len === 0 ? -1 : Math.floor((off + len - 1) / chunkSize), off, len };
    };
    const havedBytes = (): number => [...got].reduce((s, i) => s + chunkLen(i), 0);

    return {
      name, totalSize: size, eTag: etag,
      async read(offset, length) {
        if (closed) throw new Error(`会话已关闭：${name}`);
        const { i0, i1, off, len } = clampRange(offset, length);
        if (len === 0) return new Uint8Array(0);
        const chunks = await Promise.all(Array.from({ length: i1 - i0 + 1 }, (_, k) => playbackChunk(i0 + k)));
        const out = new Uint8Array(len);
        let written = 0;
        for (let i = i0; i <= i1; i++) {
          const c = chunks[i - i0]!;
          const chunkStart = chunkOff(i);
          const from = Math.max(off, chunkStart) - chunkStart;
          const to = Math.min(off + len, chunkStart + c.length) - chunkStart;
          out.set(c.subarray(from, to), written);
          written += to - from;
        }
        return out;
      },
      async prefetch(offset, length) {
        if (closed) return;
        const { i0, i1 } = clampRange(offset, length);
        for (let i = i0; i <= i1; i++) {
          if (streaming) await pinChunk(i);                                                   // 2.0.0：没拉到如实 reject
          else { try { await pinChunk(i); } catch (e) { reportStoreError(e, "log"); } }      // 0.18：best-effort，失败只 log
        }
      },
      havedBytes,
      async promote(opts) {
        if (closed) throw new Error(`会话已关闭：${name}`);
        // 补缺口（投机优先级、≤ lanes 路并行；已持有的分片直接命中 staging——先播后 pin 只下缺口）
        const missing = Array.from({ length: nChunks }, (_, i) => i).filter((i) => !got.has(i));
        let next = 0;
        const worker = async (): Promise<void> => {
          while (next < missing.length) { await pinChunk(missing[next++]!); opts?.onProgress?.(havedBytes(), size); }
        };
        await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, missing.length)) }, worker));
        opts?.onProgress?.(havedBytes(), size);
        // eTag 重验（TOCTOU：下载可长达分钟级，promote 是**持久化落地**动作，必须拿当下事实做）
        const nowMeta = await fetchMeta(name);
        if (!nowMeta || nowMeta.etag !== etag) { await purgeName(name); throw new EtagChangedError(name); }
        // 组装 → 落正式本地副本（adoptLocal 内：serialize 锁 + 已有副本/dirty 不覆盖 + markSynced，对齐 acquire）
        const parts: BlobPart[] = [];
        for (let i = 0; i < nChunks; i++) {
          const c = await sGet(cKey(name, i));
          parts.push(c ?? new Blob([await pinChunk(i) as BlobPart]));   // staging 缺/坏 → 直接重拉这一片补上（正确性不依赖 staging）
        }
        const asmSize = parts.reduce((s, p) => s + (p as Blob).size, 0);
        if (asmSize !== size) { await purgeName(name); throw new Error(`staging 组装尺寸不符（${name}：${asmSize}≠${size}），已清重下`); }
        await adoptLocal(name, new Blob(parts), etag);   // false（本地已有）也照样收摊——绝不覆盖
        await purgeName(name);                          // 已升格 → staging 清账
      },
      status(): StreamStatus {
        const s = scheduler.status(`${name}:`);
        const state: MirrorState = mirror ? (item === null || mirrorUp(mirror.src) ? "ok" : "down") : mirrorState;
        return { ...s, mirror: state, mirrorLabel: mirror?.src.label, cloudless: item === null };
      },
      close() { closed = true; activeSessions.delete(name); if (liveMeta.get(name) === meta) liveMeta.delete(name); },
    };
  }

  return { open, coverage, promoteFromStaging, purgeName, _enforceCap: enforceCap, _scheduler: scheduler };
}
