// ⚠ SW 流式网关（A2b 起家的实验模块，2026-08-20 收敛：手搓 Graph 件退役，共用 providers/graph 实现，
//   token 走 token-source 接缝——SW 上下文注入凭据桥读端）。**跑在 Service Worker 上下文**。
//
// 把 `<audio src="…/stream/<name>">` 的 HTTP Range 请求答成 206：
//   字节来源三级：本地正式副本（files 分区，绝不打云）→ staging 分片（与页面 download-session 同 schema
//   共享账本）→ 现拉云端 range（tee 回 staging）。
//   身份解析：dir-index-cache 的 files[].id（零 Graph 往返）→ 兜底 graph.getItemByPath。
//
// 纪律：
//   · store 内容盲保持：MIME 由 app 注入 contentType 回调（网关不认音频格式）。
//   · staging schema 与 download-session 完全一致（meta:/chunk:、chunkBytes 对齐）→ 页面先播 pin
//     只补缺口的账本两个上下文通用。写账 best-effort（竞态/坏库只损失复用，不损正确性）。
//   · **陈分片守卫（2026-08-20 收敛落地）**：staging 账上 eTag ≠ 当前解析 eTag → 旧版残片**整组清**再拉，
//     绝不新旧混出（页面侧会话开门有钉版清理，SW 侧此前没有——2026-08-19 登记的暗雷）。
//   · 只读：网关绝不写 files/collections/云端，唯一副作用 = staging tee / 陈分片清理。
//   · 响应协议 = 窗口式有界 206 真字节体（2026-08-15 user grill 收敛，spike-4/5 战例：Chrome 媒体管线
//     拒 SW 自定义 default-stream 响应）；本地/云端同一条路，唯一分叉点 = 字节源接缝。
import { createPartitionedBlobStore, type PartitionView } from "../blob-partition.ts";
import { createGraph } from "../providers/graph.ts";
import { createBridgeTokenSource } from "./bridge.ts";

const CHUNK_DEFAULT = 2 * 1024 * 1024;

/** 网关消费的云端最小面（token-source/URL 续期都在实现内部；测试/自定义 provider 可注入替身）。 */
export interface SwGatewayCloud {
  getItemByPath(path: string): Promise<{ id: string; size?: number; eTag?: string } | null>;
  downloadItemRange(itemId: string, offset: number | null, length: number): Promise<ArrayBuffer>;
}

export interface SwGatewayCfg {
  /** 页面 store 的 IDB 库名（`${appId}.${databaseId}`，如 "br-spike.defaultStore"）。 */
  dbName: string;
  /** 流 URL 前缀（如 "/background-radio/v2-spike/stream/"）；其后为 encodeURIComponent 的文件全名。 */
  streamPrefix: string;
  /** 必须与页面 stagingChunkBytes 一致（默认 2MiB），否则分片账对不上。 */
  chunkBytes?: number;
  /** app 注入的 MIME 判定（store 内容盲）；不给 → application/octet-stream。 */
  contentType?: (name: string) => string;
  /** 调试仪表：网关把每步（请求/解析来源/分片拉取/错误）回调出去（sw 侧通常 postMessage 给页面日志区）。 */
  onLog?: (msg: string) => void;
  /** 云端实现注入（默认 = providers/graph + 凭据桥 token-source；测试传替身）。 */
  cloud?: SwGatewayCloud;
}

interface Resolved { id: string; size: number; eTag: string }

/** 解析 HTTP Range 头。null=无/不认识（当 bytes=0- 处理）。 */
export function parseRange(h: string | null, size: number): { start: number; end: number | null } | null {
  if (!h) return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(h.trim());
  if (!m) return null;
  const start = Math.min(Number(m[1]), Math.max(0, size - 1));
  const end = m[2] === "" ? null : Math.min(Number(m[2]), size - 1);
  return { start, end };
}

export function createSwStreamGateway(cfg: SwGatewayCfg) {
  const chunkBytes = cfg.chunkBytes ?? CHUNK_DEFAULT;
  const slog = (m: string): void => { try { cfg.onLog?.(m); } catch { /* 日志绝不影响主流程 */ } };
  const bs = createPartitionedBlobStore(cfg.dbName);
  const staging: PartitionView = bs.partition("staging");
  const dirIdx: PartitionView = bs.partition("dir-index-cache");
  let cloud = cfg.cloud;
  if (!cloud) {
    // token-source 接缝：SW = 凭据桥（2026-08-28 实例化：graph 缓存/token 源 per-gateway，不再模块单例）
    const g = createGraph(createBridgeTokenSource(cfg.dbName));
    cloud = { getItemByPath: g.getItemByPath, downloadItemRange: g.downloadItemRange };
  }
  const resolveCache = new Map<string, Resolved>();     // name → item（SW 存活期）
  const etagVerified = new Map<string, string>();       // name → 已做过陈分片核对的 eTag（SW 存活期，防每片重读 meta）

  // 身份解析：dir-index-cache（本地、零往返）优先，graph.getItemByPath 兜底。
  //   skipIndex（0.4.0，id→ref 拍板配套「SW 网关失效重解析」）：ref 失效（range 404）重解析时
  //   跳过 dir-index-cache（那正是陈 ref 的来源）直接走 Graph 按名重查。
  async function resolve(name: string, opts?: { skipIndex?: boolean }): Promise<Resolved | null> {
    const hit = resolveCache.get(name);
    if (hit) return hit;
    if (!opts?.skipIndex) try {
      const folder = name.includes("/") ? name.slice(0, name.lastIndexOf("/")) : "";
      const rec = await dirIdx.get(folder);
      if (rec) {
        const p = JSON.parse(await rec.blob.text()) as { v?: number; files?: { name: string; id?: string; size?: number; eTag?: string }[] };
        const f = p?.v === 1 ? p.files?.find((x) => x.name === name) : undefined;
        if (f?.id && typeof f.size === "number" && f.eTag) {
          const r = { id: f.id, size: f.size, eTag: f.eTag };
          resolveCache.set(name, r);
          slog(`解析 ${name} ← dir-index-cache（id=${f.id.slice(0, 8)}… size=${f.size}）`);
          return r;
        }
        slog(`dir-index-cache 有夹记录但无 ${name} 条目 → 走 Graph`);
      }
    } catch { /* 索引缓存坏 → 走 Graph 兜底 */ }
    let j: { id: string; size?: number; eTag?: string } | null = null;
    try { j = await cloud!.getItemByPath(name); }
    catch (e) { slog(`Graph 解析异常：${String((e as Error)?.message ?? e).slice(0, 160)}`); return null; }
    if (!j?.id) { slog(`解析 ${name} 失败（Graph 兜底也没拿到）`); return null; }
    slog(`解析 ${name} ← Graph（size=${j.size}）`);
    const r = { id: j.id, size: j.size ?? 0, eTag: j.eTag ?? "" };
    resolveCache.set(name, r);
    return r;
  }

  /** 陈分片守卫：staging 账上是别的版 → 整组清（绝不新旧混出）。每 name 每 eTag 只核一次。 */
  async function ensureStagingFresh(name: string, item: Resolved): Promise<void> {
    if (etagVerified.get(name) === item.eTag) return;
    try {
      const mrec = await staging.get(`meta:${name}`);
      if (mrec) {
        const m = JSON.parse(await mrec.blob.text()) as { eTag?: string };
        if (m?.eTag && m.eTag !== item.eTag) {
          const prefix = `chunk:${name}:`;
          for (const k of await staging.keys()) if (k === `meta:${name}` || k.startsWith(prefix)) await staging.del(k);
          slog(`陈分片守卫：${name} staging 是旧版（${m.eTag.slice(0, 8)}…≠${item.eTag.slice(0, 8)}…）→ 整组已清`);
        }
      }
    } catch { /* 守卫 best-effort：读不了账就当没有（tee 写账时还会按 eTag 重置） */ }
    etagVerified.set(name, item.eTag);
  }

  // 取一个分片：staging 命中秒答；缺 → downloadItemRange（downloadUrl 缓存/续期在 graph 层内部）→ tee 回 staging。
  const inflight = new Map<string, Promise<Uint8Array>>();
  function getChunk(name: string, item: Resolved, i: number): Promise<Uint8Array> {
    const key = `${name}:${i}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const job = (async (): Promise<Uint8Array> => {
      await ensureStagingFresh(name, item);
      try { const c = await staging.get(`chunk:${name}:${i}`); if (c) { slog(`分片 ${i} ← staging`); return new Uint8Array(await c.blob.arrayBuffer()); } } catch { /* staging 坏 → 直连 */ }
      const off = i * chunkBytes;
      const len = Math.min(chunkBytes, item.size - off);
      let bytes: Uint8Array;
      try { bytes = new Uint8Array(await cloud!.downloadItemRange(item.id, off, len)); }
      catch (e) {
        // ref 失效重解析（0.4.0 拍板配套）：404 = 这张牌指的东西已不在（dir-index 陈 ref / 文件被改名移动）。
        //   丢 resolve 缓存 → 跳过 dir-index 按名走 Graph 重查一张 → 同片重试一次；还不行才真失败。
        if ((e as { status?: number })?.status !== 404) throw e;
        slog(`分片 ${i} 404：ref 失效 → 按名重解析一次`);
        resolveCache.delete(name); etagVerified.delete(name);
        const again = await resolve(name, { skipIndex: true });
        if (!again) throw e;
        await ensureStagingFresh(name, again);   // 新版本 → 陈分片整组清
        item = again;
        bytes = new Uint8Array(await cloud!.downloadItemRange(item.id, off, Math.min(chunkBytes, item.size - off)));
      }
      slog(`分片 ${i} ← 云端（${bytes.length}B）`);
      // tee 回 staging + 记账（best-effort；schema 与 download-session 一致）
      try {
        await staging.put(`chunk:${name}:${i}`, { blob: new Blob([bytes as unknown as BlobPart]), updatedAt: Date.now() });
        const mrec = await staging.get(`meta:${name}`);
        let m: { v: 1; eTag: string; totalBytes: number; chunkBytes: number; chunks: number[]; touchedAt: number } | null = null;
        if (mrec) { try { m = JSON.parse(await mrec.blob.text()); } catch { m = null; } }
        if (!m || m.eTag !== item.eTag) m = { v: 1, eTag: item.eTag, totalBytes: item.size, chunkBytes, chunks: [], touchedAt: Date.now() };
        if (!m.chunks.includes(i)) m.chunks.push(i);
        m.touchedAt = Date.now();
        await staging.put(`meta:${name}`, { blob: new Blob([JSON.stringify(m)]), updatedAt: Date.now() });
      } catch { /* 记账失败只损失复用 */ }
      return bytes;
    })();
    inflight.set(key, job);
    job.finally(() => inflight.delete(key)).catch(() => {});
    return job;
  }

  function matches(url: URL): boolean { return url.pathname.startsWith(cfg.streamPrefix); }

  async function handle(req: Request): Promise<Response> {
    try { return await handleInner(req); }
    catch (e) {
      const msg = String((e as Error)?.message ?? e);
      slog(`🛑 网关错误：${msg}`);
      return new Response(`网关错误：${msg}`, { status: 502 });
    }
  }
  async function handleInner(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const name = decodeURIComponent(url.pathname.slice(cfg.streamPrefix.length));
    slog(`请求 ${name}（Range: ${req.headers.get("Range") ?? "无"}）`);
    // ★本地正式副本（files 分区）**优先且不做任何云端解析**——keepOffline 过的 / 播种的本地文件，
    //   离线、未登录、云端不可达都必须照播（spike-1 曾把 resolve 放前面 → 未登录连本地文件都 404，已修）。
    let full: Blob | null = null;
    try { const r = await bs.partition("files").get(name); if (r) full = r.blob; } catch { /* 分区读失败 → 走云端 */ }
    if (full) slog(`${name} ← 本地正式副本（${full.size}B）`);
    const item = full ? null : await resolve(name);
    if (!full && !item) { slog(`🛑 ${name} 404：本地无副本且解析失败`); return new Response("未找到（未登录或云端无此文件）", { status: 404 }); }
    const size = full ? full.size : item!.size;
    const ct = cfg.contentType?.(name) ?? "application/octet-stream";
    const baseHeaders: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Type": ct, "Cache-Control": "no-store" };
    const range = parseRange(req.headers.get("Range"), size) ?? { start: 0, end: null };

    // ── **单一响应协议：窗口式有界 206 真字节体**（2026-08-15 user grill 收敛，spike-4/5 战例）────────
    //   · 有界请求（Safari bytes=0-1 探针等）→ 精确答；开放式（bytes=a- / 无 Range）→ 答 ≤WINDOW_CHUNKS
    //     分片对齐的一窗，播放器消费到窗尾自动续发下一段 Range（= 开多久拉多久，分片粒度）。
    //   · 为什么不用自定义 ReadableStream：spike-4 真机战例——Chrome 媒体管线对 SW 构造的
    //     default-stream 响应直接拒（pull 从未被调、秒 code=4）。真字节体零流类型依赖。
    const WINDOW_CHUNKS = 2;
    const start = range.start;
    const end = range.end ?? Math.min(size - 1, (Math.floor(start / chunkBytes) + WINDOW_CHUNKS) * chunkBytes - 1);
    // 字节源接缝：这一窗 [start..end] 的字节从哪来（唯一的本地/云端分叉点）。
    const readWindow = async (): Promise<Uint8Array> => {
      if (full) return new Uint8Array(await full.slice(start, end + 1).arrayBuffer());
      const i0 = Math.floor(start / chunkBytes), i1 = Math.floor(end / chunkBytes);
      const buf = new Uint8Array(end - start + 1);
      let w = 0;
      for (let i = i0; i <= i1; i++) {
        const c = await getChunk(name, item!, i);
        const cs = i * chunkBytes;
        const from = Math.max(start, cs) - cs, to = Math.min(end + 1, cs + c.length) - cs;
        buf.set(c.subarray(from, to), w); w += to - from;
      }
      return buf;
    };
    const body = await readWindow();
    slog(`答 206：bytes ${start}-${end}/${size}（${body.length}B，${full ? "本地" : "云端"}）`);
    return new Response(body as unknown as BodyInit, {
      status: 206,
      headers: { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(body.length) },
    });
  }

  return { matches, handle };
}
