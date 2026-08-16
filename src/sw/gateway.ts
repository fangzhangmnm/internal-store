// ⚠ 实验期模块（A2b spike，2026-08-15 user 拍板 ad hoc 踩坑）——**跑在 Service Worker 上下文**。
//   正式 exports 门牌（`./sw`）未开：spike 消费方经构建期直接从 src 打包；收敛期再 human 拍板门牌。
//
// SW 流式网关 —— 把 `<audio src="…/stream/<name>">` 的 HTTP Range 请求答成 206：
//   字节来源三级：staging 分片（IDB，与页面 download-session **同 schema 共享**）→ 现拉云端 range（tee 回 staging）。
//   身份解析：dir-index-cache 的 files[].id（零 Graph 往返）→ 兜底 Graph getItemByPath（凭 sw-bridge token）。
//   凭据：SW 跑不了 MSAL → 页面经 sw/bridge.ts 定期把 access token 写进 IDB `sw-bridge/` 分区（三层堵洞第①层）。
//
// 纪律：
//   · store 内容盲保持：MIME 由 app 注入 contentType 回调（网关不认音频格式）。
//   · staging schema 与 download-session 完全一致（meta:/chunk:、chunkBytes 对齐）→ 页面先播 pin 只补缺口的
//     账本两个上下文通用。写账 best-effort（竞态/坏库只损失复用，不损正确性）。
//   · 只读：网关绝不写 files/collections/云端，唯一副作用 = staging tee。
//   · 开放式 Range（bytes=a-）答 ReadableStream 顺序分片：播放器要多少拉多少（开多久拉多久），cancel 即停。
import { createPartitionedBlobStore, type PartitionView } from "../blob-partition.ts";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const CHUNK_DEFAULT = 2 * 1024 * 1024;

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
  const bridge: PartitionView = bs.partition("sw-bridge");
  const urlCache = new Map<string, string>();           // name → downloadUrl（SW 存活期内存缓存；过期 401/403 重申请）
  const resolveCache = new Map<string, Resolved>();     // name → item（SW 存活期）

  async function getToken(): Promise<string | null> {
    try {
      const r = await bridge.get("token");
      if (!r) return null;
      const p = JSON.parse(await r.blob.text()) as { v?: number; token?: string };
      return p?.v === 1 && typeof p.token === "string" ? p.token : null;
    } catch { return null; }
  }

  const encodePath = (p: string): string => p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
  async function graphJson(path: string): Promise<Record<string, unknown> | null> {
    const token = await getToken();
    if (!token) return null;
    const r = await fetch(`${GRAPH_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    return await r.json() as Record<string, unknown>;
  }

  // 身份解析：dir-index-cache（本地、零往返）优先，Graph getItemByPath 兜底。
  async function resolve(name: string): Promise<Resolved | null> {
    const hit = resolveCache.get(name);
    if (hit) return hit;
    try {
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
    const j = await graphJson(`/me/drive/special/approot:/${encodePath(name)}?$select=id,size,eTag,@microsoft.graph.downloadUrl`);
    if (!j || typeof j.id !== "string") { slog(`解析 ${name} 失败（Graph 兜底也没拿到；token=${(await getToken()) ? "有" : "无"}）`); return null; }
    slog(`解析 ${name} ← Graph（size=${j.size}）`);
    const r = { id: j.id, size: (j.size as number) ?? 0, eTag: (j.eTag as string) ?? "" };
    if (typeof j["@microsoft.graph.downloadUrl"] === "string") urlCache.set(name, j["@microsoft.graph.downloadUrl"] as string);
    resolveCache.set(name, r);
    return r;
  }

  async function freshUrl(name: string, id: string): Promise<string | null> {
    const j = await graphJson(`/me/drive/items/${id}?$select=id,@microsoft.graph.downloadUrl`);
    const u = j?.["@microsoft.graph.downloadUrl"];
    if (typeof u !== "string") return null;
    urlCache.set(name, u);
    return u;
  }

  // 取一个分片：staging 命中秒答；缺 → downloadUrl range 现拉（401/403/过期 → 换新 URL 重试一次）→ tee 回 staging。
  const inflight = new Map<string, Promise<Uint8Array>>();
  function getChunk(name: string, item: Resolved, i: number): Promise<Uint8Array> {
    const key = `${name}:${i}`;
    const existing = inflight.get(key);
    if (existing) return existing;
    const job = (async (): Promise<Uint8Array> => {
      try { const c = await staging.get(`chunk:${name}:${i}`); if (c) { slog(`分片 ${i} ← staging`); return new Uint8Array(await c.blob.arrayBuffer()); } } catch { /* staging 坏 → 直连 */ }
      const off = i * chunkBytes;
      const len = Math.min(chunkBytes, item.size - off);
      const doFetch = async (url: string): Promise<Response> => fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
      let url = urlCache.get(name) ?? await freshUrl(name, item.id);
      if (!url) throw new Error(`无凭据/取不到 downloadUrl（token=${(await getToken()) ? "有" : "无"}）：${name}`);
      let resp = await doFetch(url);
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {   // URL 过期/失效 → 换新重试一次
        url = await freshUrl(name, item.id);
        if (!url) throw new Error(`downloadUrl 续期失败：${name}`);
        resp = await doFetch(url);
      }
      if (!resp.ok && resp.status !== 206) throw new Error(`range 拉取失败 ${resp.status}：${name}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      slog(`分片 ${i} ← 云端（${bytes.length}B，HTTP ${resp.status}）`);
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
    //   · 本地/云端**同一条路**，唯一分叉点 = 字节源（本地 blob.slice / 云端分片组装）——双路径无红利即屎山。
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
