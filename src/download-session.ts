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
//   · 调度：读取（播放）优先；**pin 队列严格串行**（同时最多 1 个分片在飞，user 显式钉死），且播放
//     有分片在飞/在等时 pin 不开新分片（分片粒度让路，不杀请求）。
//   · eTag 钉版：会话开在某一版上；promote 前重验 fetchMeta，版变 → 清本 name staging + 抛 EtagChangedError。
//   · 时间戳（meta.touched）只用于 scratch 清理排序，绝不参与任何内容/版本决策（no-timestamps 红线）。
//
// staging 分区 key 形（schema v1，2026-08-15 user 过目改名定稿：陌生人开 DevTools 一眼可懂）：
//   `meta:<name>`     → JSON { v:1, eTag, totalBytes, chunkBytes, chunks:[分片号…], touchedAt }（会话元信息 + 已持有分片账）
//   `chunk:<name>:<i>`→ 分片字节 blob（i 十进制；name 不含 ":"——Windows 非法字符已被文件名护栏挡在门外）
import { reportStoreError } from "./error-handling.ts";

/** staging 分区的注入端口（prod = blob-partition 的 "staging" 分区；测试 = 内存 map）。 */
export interface StagingStore {
  get(key: string): Promise<Blob | null>;
  put(key: string, blob: Blob): Promise<void>;
  del(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** 会话打开时钉住的云端元信息（fetchMeta 的窄投影 + provider 直连所需的 item 句柄）。 */
export interface SessionMeta { etag: string; size: number; item: unknown }

export interface DownloadSessionsCfg {
  staging: StagingStore;
  /** 云端元信息（开会话钉版 + promote 前重验）。 */
  fetchMeta: (name: string) => Promise<SessionMeta | null>;
  /** 按 item 句柄 byte-range 拉（**不**每分片重走 metadata 往返——JRP 抱怨过的 per-open 冗余 GET）。 */
  range: (item: unknown, offset: number, length: number) => Promise<Uint8Array>;
  /** promote 落地（create-store 注入：serialize 锁内 local.save + head.markSynced，对齐 acquire 语义）。
   *  返 false = 本地已有副本/不可落（session 直接收摊，不覆盖）。 */
  adoptLocal: (name: string, blob: Blob, etag: string) => Promise<boolean>;
  chunkSize?: number;          // 默认 2MiB（分片粒度 = pin 给播放让路的粒度）
  capBytes?: number;           // staging 全局字节上限（默认 256MiB）；超限 FIFO 清最旧 touched 的整组
  now?: () => number;          // 测试注入
}

/** eTag 钉版失效：云端在会话期间换了版。caller 清障后可重开会话。 */
export class EtagChangedError extends Error {
  constructor(name: string) { super(`云端文件已更新，下载会话失效：${name}`); this.name = "EtagChangedError"; }
}

interface StagingMeta { v: 1; eTag: string; totalBytes: number; chunkBytes: number; chunks: number[]; touchedAt: number }

const CHUNK_DEFAULT = 2 * 1024 * 1024;
const CAP_DEFAULT = 256 * 1024 * 1024;

const mKey = (name: string): string => `meta:${name}`;
const cKey = (name: string, i: number): string => `chunk:${name}:${i}`;

export interface DownloadSession {
  name: string;
  totalSize: number;
  eTag: string;
  /** 读一段（播放优先级）：staging 有就秒答，缺的现拉现存（tee）。越界自动钳；会话已关 → 抛。 */
  read(offset: number, length: number): Promise<Uint8Array>;
  /** 低优先预拉一段进 staging（下一曲头部预拉等）；不返字节。 */
  prefetch(offset: number, length: number): Promise<void>;
  /** 已持有字节数（进度显示；≈ got.length × chunk，不打网络）。 */
  havedBytes(): number;
  /** 补齐全部缺口（pin 优先级，严格串行）+ 升格正式本地副本 + 清本 name staging。
   *  eTag 已变 → 清 staging 抛 EtagChangedError；本地已有副本 → 只清 staging（不覆盖）。 */
  promote(opts?: { onProgress?: (doneBytes: number, totalBytes: number) => void }): Promise<void>;
  /** 关会话（staging 留着，受全局 cap FIFO 兜底——先播后 pin 不重下）。 */
  close(): void;
}

export function createDownloadSessions(cfg: DownloadSessionsCfg) {
  const { staging, fetchMeta, range, adoptLocal } = cfg;
  const chunkSize = cfg.chunkSize ?? CHUNK_DEFAULT;
  const capBytes = cfg.capBytes ?? CAP_DEFAULT;
  const now = cfg.now ?? ((): number => Date.now());

  // ── 调度状态（模块级 = 全 store 一个调度域）─────────────────────────────────────────
  let playbackBusy = 0;                                   // 在飞/在等的播放分片数（>0 时 pin 不开新分片）
  let playbackIdleWaiters: (() => void)[] = [];
  const playbackIdle = (): Promise<void> => playbackBusy === 0 ? Promise.resolve() : new Promise((r) => playbackIdleWaiters.push(r));
  function playbackDone(): void {
    playbackBusy--;
    if (playbackBusy === 0) { const ws = playbackIdleWaiters; playbackIdleWaiters = []; for (const w of ws) w(); }
  }
  let pinChain: Promise<unknown> = Promise.resolve();     // pin 严格串行链（同时最多 1 个分片在飞——user 钉死）
  const inflight = new Map<string, Promise<Uint8Array>>();   // `${name}:${i}` → 同分片去重（播放/预拉/pin 撞同片只拉一次）
  const activeSessions = new Set<string>();               // cap 清理绝不动在用会话的组

  // ── staging 记账（**全部 best-effort**：staging 是加速器不是正确性依赖——IDB 坏了/配额满，
  //   会话照样直连云端流字节，promote 组装缺片直接重拉补）─────────────────────────────────
  const sGet = async (k: string): Promise<Blob | null> => { try { return await staging.get(k); } catch (e) { reportStoreError(e, "log"); return null; } };
  const sPut = async (k: string, b: Blob): Promise<void> => { try { await staging.put(k, b); } catch (e) { reportStoreError(e, "log"); } };
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

  // ── 会话 ────────────────────────────────────────────────────────────────────────
  async function open(name: string): Promise<DownloadSession | null> {
    const cm0 = await fetchMeta(name);
    if (!cm0) return null;
    const { etag, size, item } = cm0;   // 解构出钉版事实（function 声明闭包里 TS 不保 narrowing，用具体量）
    // staging 里若有**别的版**的残片 → 清（eTag 钉版）；同版 → 续用（先播后 pin 不重下的另一半：跨会话续）。
    const prev = await readMeta(name);
    if (prev && prev.eTag !== etag) await purgeName(name);
    const meta: StagingMeta = (prev && prev.eTag === etag)
      ? { ...prev, touchedAt: now() }
      : { v: 1, eTag: etag, totalBytes: size, chunkBytes: chunkSize, chunks: [], touchedAt: now() };
    const got = new Set<number>(meta.chunks);
    await writeMeta(name, meta);
    const nChunks = Math.max(1, Math.ceil(size / chunkSize));
    let closed = false;
    activeSessions.add(name);

    // 拉一个分片（带去重）：拉到即落 staging + 记账（tee）。prio 只决定「排不排队让路」，字节路径同一条。
    function fetchChunk(i: number, prio: "playback" | "pin"): Promise<Uint8Array> {
      const key = `${name}:${i}`;
      const existing = inflight.get(key);
      if (existing) return existing;
      const job = (async (): Promise<Uint8Array> => {
        const cached = await sGet(cKey(name, i));
        if (cached) return new Uint8Array(await cached.arrayBuffer());
        if (prio === "pin") await playbackIdle();          // 播放有活 → pin 分片不开工（分片粒度让路）
        const off = i * chunkSize;
        const len = Math.min(chunkSize, size - off);
        const bytes = await range(item, off, len);
        // tee：落 staging + 记账（失败只 log——staging 是加速器不是正确性依赖，read 仍返回字节）
        await sPut(cKey(name, i), new Blob([bytes as BlobPart]));
        if (!got.has(i)) { got.add(i); meta.chunks = [...got]; meta.touchedAt = now(); await writeMeta(name, meta); }
        void enforceCap();
        return bytes;
      })();
      inflight.set(key, job);
      job.finally(() => inflight.delete(key)).catch(() => {});
      return job;
    }
    // 播放优先级包装：进出记账 playbackBusy（pin 据此让路）。
    function playbackChunk(i: number): Promise<Uint8Array> {
      playbackBusy++;
      return fetchChunk(i, "playback").finally(playbackDone);
    }
    // pin 串行链：全局同刻只一个 pin 分片在飞（user 钉死「不要 spike 炸」）。
    function pinChunk(i: number): Promise<Uint8Array> {
      const job = pinChain.then(() => fetchChunk(i, "pin"));
      pinChain = job.catch(() => {});
      return job;
    }

    const clampRange = (offset: number, length: number): { i0: number; i1: number; off: number; len: number } => {
      const off = Math.max(0, Math.min(offset, size));
      const len = Math.max(0, Math.min(length, size - off));
      return { i0: Math.floor(off / chunkSize), i1: len === 0 ? -1 : Math.floor((off + len - 1) / chunkSize), off, len };
    };
    const havedBytes = (): number => [...got].reduce((s, i) => s + Math.min(chunkSize, size - i * chunkSize), 0);

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
          const c = chunks[i - i0];
          const chunkStart = i * chunkSize;
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
        for (let i = i0; i <= i1; i++) { try { await pinChunk(i); } catch (e) { reportStoreError(e, "log"); } }   // 预拉 best-effort：失败只 log
      },
      havedBytes,
      async promote(opts) {
        if (closed) throw new Error(`会话已关闭：${name}`);
        // 补缺口（pin 串行；已持有的分片直接命中 staging——先播后 pin 只下缺口）
        for (let i = 0; i < nChunks; i++) {
          if (!got.has(i)) await pinChunk(i);
          opts?.onProgress?.(havedBytes(), size);
        }
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
      close() { closed = true; activeSessions.delete(name); },
    };
  }

  return { open, purgeName, _enforceCap: enforceCap };
}
