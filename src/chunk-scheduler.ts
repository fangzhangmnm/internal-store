// ⚠ store 内部深模块。app 不直接 import——经 createStore 的 file().openStream()。
//
// chunk-scheduler（2.0.0，2026-10-17 Claude Fable 5.1；user 10-17「你现在是fable了，开始做涉及库的改动」）
//   「一个 key（某文件某分片）拿一次字节」的全部调度政策。download-session 把 staging（preflight）、云端、镜像装进来；
//   这里不认识文件、不碰存储、不知道字节是什么。
//
//   · 同 key 去重：播放 / 投机 / pin 撞同片只拉一次。播放加入投机的 job = **升格**：它在排车道 / 等让路 → 立刻放行。
//     （0.18 这里会互等：pin 在 playbackIdle() 等播放清零，播放却在等这个 pin 的 job，永远不醒。10-17 探针坐实：
//       播放 A 在飞、pin B 等让路、播放也读 B、A 完成 → B 的 range 永远不发。）
//   · 播放优先：播放分片在飞时投机不开新分片（分片粒度让路，不杀请求）。播放不限、不占车道。
//   · 车道：投机同时在飞 ≤ lanes（不传 = 1，= 0.18 的「pin 严格串行」，user 2026-08 钉死「不要 spike 炸」；多车道由消费方显式开）。
//   · 卡住（stallMs，不传 = 不判）：一路连续 stallMs **没到一个字节**（不按请求年龄：慢而不停的链路不会被误对冲）。
//       播放 → 再开一路对冲（先换下一个来源，没有就同源；先到的赢、输的中止；一片最多 3 路）；
//       投机 → 中止、让道（还有没试过的来源就换着试；否则这片以 StreamStallError 失败，车道还给别人）。
//   · 来源顺序 = 偏好：[0] 先试；一路**出错**（不是卡住）且没别的路在飞 → 换下一个来源；都试过 → 以最后那个错失败。
//   · 字节到了就交 arrived()（落 staging）——包括输了的那路和放弃后晚到的：拉回来的字节不浪费。job 留在表里直到 arrived 做完，
//     其间同片的读加入它直接拿字节，不会扑空 staging 再拉一次。

import type { RangeOpts } from "./types.ts";
export type { RangeOpts } from "./types.ts";
export type ChunkPriority = "playback" | "pin";
/** 一个来源拉这一片的一路。origin 只是记账用的名字（"cloud" / "mirror"）。 */
export interface ChunkSource { origin: string; fetch: (opts: RangeOpts) => Promise<Uint8Array> }
export interface ChunkRequest {
  key: string;
  prio: ChunkPriority;
  /** 先看本机（staging）：有 → 直接用，不上网。 */
  preflight?: () => Promise<Uint8Array | null>;
  /** 按偏好排序的来源（镜像在前、云端在后）。 */
  sources: ChunkSource[];
  /** 字节到了（赢家 / 输家 / 放弃后晚到的都算）：落 staging。 */
  arrived?: (bytes: Uint8Array, origin: string) => void | Promise<void>;
}
export interface SchedulerStatus {
  /** 在飞的播放片数（有读在等）。 */
  demand: number;
  /** 上了网的投机片数（prefetch / keep 补缺口）。 */
  speculative: number;
  /** 还没上网的投机片数（在排车道 / 等播放让路）。 */
  queued: number;
  /** 最老那片上网多久了（ms）；没有在飞的 → 0。 */
  oldestMs: number;
  /** 判定卡住的片数（每一路都 stallMs 没到字节）；没开 stallMs → 恒 0。 */
  stalled: number;
}
export interface SchedulerCfg { lanes?: number; stallMs?: number; now?: () => number }

/** 投机的一片卡住、又没有别的来源可换 → 这片以它失败（prefetch 以它 reject，让预取方学到「这片没拉到」）。 */
export class StreamStallError extends Error {
  constructor(key: string) { super(`chunk stalled (no bytes within the stall window): ${key}`); this.name = "StreamStallError"; }
}

const MAX_ATTEMPTS = 3;

interface Attempt { sourceIdx: number; ctrl: AbortController | null; lastAt: number; timer: ReturnType<typeof setTimeout> | null; running: boolean }
interface Job {
  key: string; req: ChunkRequest;
  demand: boolean;
  startedAt: number;              // 第一路发出的时刻；-1 = 还没上网（在 preflight / 排车道 / 等让路）
  attempts: Attempt[];
  settled: boolean;
  hasLane: boolean;
  wake: (() => void) | null;      // 在排车道 / 等让路时的唤醒口（升格用）
  promise: Promise<Uint8Array>;
  resolve: (b: Uint8Array) => void;
  reject: (e: unknown) => void;
}

export function createChunkScheduler(cfg: SchedulerCfg = {}) {
  const lanes = Math.max(1, Math.floor(cfg.lanes ?? 1));
  const stallMs = cfg.stallMs !== undefined && cfg.stallMs > 0 ? cfg.stallMs : null;
  const now = cfg.now ?? ((): number => Date.now());
  const jobs = new Map<string, Job>();
  let playbackBusy = 0;
  const idleWaiters = new Set<() => void>();
  let laneFree = lanes;
  const laneQueue: Job[] = [];
  const stats = { hedges: 0, stallAborts: 0, fallbacks: 0 };

  function playbackDone(): void {
    playbackBusy--;
    if (playbackBusy === 0) { const ws = [...idleWaiters]; idleWaiters.clear(); for (const w of ws) w(); }
  }

  function request(req: ChunkRequest): Promise<Uint8Array> {
    let job = jobs.get(req.key);
    const fresh = !job;
    if (job) { if (req.prio === "playback") promote(job); }
    else { job = newJob(req); jobs.set(req.key, job); }
    if (req.prio === "playback") { playbackBusy++; job.promise.then(playbackDone, playbackDone); }
    if (fresh) void run(job);
    return job.promise;
  }

  function newJob(req: ChunkRequest): Job {
    let resolve!: (b: Uint8Array) => void, reject!: (e: unknown) => void;
    const promise = new Promise<Uint8Array>((res, rej) => { resolve = res; reject = rej; });
    promise.catch(() => {});   // 没人等的投机失败不冒 unhandled rejection（等的人自己拿到同一个 reject）
    return { key: req.key, req, demand: req.prio === "playback", startedAt: -1, attempts: [], settled: false, hasLane: false, wake: null, promise, resolve, reject };
  }

  /** 播放加入了一个投机 job：不再让路、不再排车道；已经卡着的那路现在就对冲。 */
  function promote(job: Job): void {
    if (job.demand) return;
    job.demand = true;
    job.wake?.();
    if (stallMs !== null) {
      const t = now();
      const a = job.attempts.find((x) => x.running && t - x.lastAt >= stallMs);
      if (a) onStall(job, a);
    }
  }

  async function run(job: Job): Promise<void> {
    try {
      if (job.req.preflight) {
        const pre = await job.req.preflight();
        if (pre) { settleOk(job, pre, null); return; }
      }
      if (!job.demand) {
        await acquireLane(job);
        while (!job.demand && playbackBusy > 0) await yieldToPlayback(job);
      }
      if (job.req.sources.length === 0) throw new Error(`no source for chunk ${job.key}`);
      launch(job);
    } catch (e) { settleErr(job, e); }
  }

  function acquireLane(job: Job): Promise<void> {
    if (job.demand) return Promise.resolve();
    if (laneFree > 0) { laneFree--; job.hasLane = true; return Promise.resolve(); }
    return new Promise<void>((r) => {
      job.wake = () => { job.wake = null; r(); };
      laneQueue.push(job);
    });
  }
  function releaseLane(job: Job): void {
    if (!job.hasLane) return;
    job.hasLane = false; laneFree++;
    while (laneQueue.length) {
      const j = laneQueue.shift()!;
      if (j.wake && !j.demand) { laneFree--; j.hasLane = true; j.wake(); return; }   // 被升格 / 已醒的跳过
    }
  }
  function yieldToPlayback(job: Job): Promise<void> {
    return new Promise<void>((r) => {
      const w = (): void => { idleWaiters.delete(w); job.wake = null; r(); };
      job.wake = w; idleWaiters.add(w);
    });
  }

  const unusedSource = (job: Job): number => {
    const used = new Set(job.attempts.map((a) => a.sourceIdx));
    for (let i = 0; i < job.req.sources.length; i++) if (!used.has(i)) return i;
    return -1;
  };
  const finish = (a: Attempt): void => { a.running = false; if (a.timer) { clearTimeout(a.timer); a.timer = null; } };

  function launch(job: Job): void {
    const idx = unusedSource(job) >= 0 ? unusedSource(job) : job.attempts[job.attempts.length - 1]!.sourceIdx;   // 都试过：同源再来一路
    const src = job.req.sources[idx]!;
    const a: Attempt = { sourceIdx: idx, ctrl: typeof AbortController === "function" ? new AbortController() : null, lastAt: now(), timer: null, running: true };
    job.attempts.push(a);
    if (job.startedAt < 0) job.startedAt = a.lastAt;
    const arm = (): void => { if (stallMs === null) return; if (a.timer) clearTimeout(a.timer); a.timer = setTimeout(() => onStall(job, a), stallMs); };
    arm();
    let p: Promise<Uint8Array>;
    try { p = src.fetch({ signal: a.ctrl?.signal, onProgress: () => { a.lastAt = now(); arm(); } }); }
    catch (e) { p = Promise.reject(e); }
    p.then(
      (bytes) => { finish(a); settleOk(job, bytes, src.origin); },
      (err) => {
        const wasRunning = a.running;
        finish(a);
        if (job.settled || !wasRunning) return;                   // 已有结果 / 是我们自己中止的：这路的错不算
        if (job.attempts.some((x) => x.running)) return;          // 还有别的路在飞：等它
        if (unusedSource(job) >= 0 && job.attempts.length < MAX_ATTEMPTS) { stats.fallbacks++; launch(job); return; }
        settleErr(job, err);
      });
  }

  function onStall(job: Job, a: Attempt): void {
    if (!a.running || job.settled) return;
    if (job.demand) {
      const running = job.attempts.filter((x) => x.running).length;
      if (running < 2 && job.attempts.length < MAX_ATTEMPTS) { stats.hedges++; launch(job); }
      return;
    }
    stats.stallAborts++;
    finish(a);                 // 不再算在飞（车道的意义就在这）；字节真到了 settleOk 照样交 arrived
    a.ctrl?.abort();
    if (job.attempts.some((x) => x.running)) return;
    if (unusedSource(job) >= 0 && job.attempts.length < MAX_ATTEMPTS) { stats.fallbacks++; launch(job); return; }
    settleErr(job, new StreamStallError(job.key));
  }

  function settleOk(job: Job, bytes: Uint8Array, origin: string | null): void {
    const first = !job.settled;
    if (first) {
      job.settled = true;
      for (const x of job.attempts) if (x.running) { finish(x); x.ctrl?.abort(); }   // 输的那路中止（省流量）
    }
    // 先叫 arrived（同步跑到它第一个 await：内存账先记上），再 resolve——等字节的人醒来时账已经对了；落盘不挡字节。
    let tee: Promise<void> = Promise.resolve();
    if (origin !== null && job.req.arrived) {
      try { tee = Promise.resolve(job.req.arrived(bytes, origin)).then(() => {}, () => {}); } catch { /* arrived 同步抛：当没落盘 */ }
    }
    if (first) { job.resolve(bytes); void tee.then(() => close(job)); }
  }
  function settleErr(job: Job, err: unknown): void {
    if (job.settled) return;
    job.settled = true;
    for (const x of job.attempts) if (x.running) { finish(x); x.ctrl?.abort(); }
    job.reject(err);
    close(job);
  }
  function close(job: Job): void {
    if (jobs.get(job.key) === job) jobs.delete(job.key);
    releaseLane(job);
  }

  /** 零网络快照（状态条用）：prefix 只看某文件的（key 以它开头）。 */
  function status(prefix?: string): SchedulerStatus {
    const t = now();
    let demand = 0, speculative = 0, queued = 0, oldest = 0, stalled = 0;
    for (const j of jobs.values()) {
      if (j.settled || (prefix !== undefined && !j.key.startsWith(prefix))) continue;
      if (j.demand) demand++; else if (j.startedAt >= 0) speculative++; else queued++;
      if (j.startedAt >= 0) oldest = Math.max(oldest, t - j.startedAt);
      const running = j.attempts.filter((a) => a.running);
      if (stallMs !== null && running.length > 0 && running.every((a) => t - a.lastAt >= stallMs)) stalled++;
    }
    return { demand, speculative, queued, oldestMs: oldest, stalled };
  }

  return { request, status, stats, lanes, stallMs };
}
