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
          return r;
        }
      }
    } catch { /* 索引缓存坏 → 走 Graph 兜底 */ }
    const j = await graphJson(`/me/drive/special/approot:/${encodePath(name)}?$select=id,size,eTag,@microsoft.graph.downloadUrl`);
    if (!j || typeof j.id !== "string") return null;
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
      try { const c = await staging.get(`chunk:${name}:${i}`); if (c) return new Uint8Array(await c.blob.arrayBuffer()); } catch { /* staging 坏 → 直连 */ }
      const off = i * chunkBytes;
      const len = Math.min(chunkBytes, item.size - off);
      const doFetch = async (url: string): Promise<Response> => fetch(url, { headers: { Range: `bytes=${off}-${off + len - 1}` } });
      let url = urlCache.get(name) ?? await freshUrl(name, item.id);
      if (!url) throw new Error(`无凭据/取不到 downloadUrl：${name}`);
      let resp = await doFetch(url);
      if (resp.status === 401 || resp.status === 403 || resp.status === 404) {   // URL 过期/失效 → 换新重试一次
        url = await freshUrl(name, item.id);
        if (!url) throw new Error(`downloadUrl 续期失败：${name}`);
        resp = await doFetch(url);
      }
      if (!resp.ok && resp.status !== 206) throw new Error(`range 拉取失败 ${resp.status}：${name}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
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
    const url = new URL(req.url);
    const name = decodeURIComponent(url.pathname.slice(cfg.streamPrefix.length));
    const item = await resolve(name);
    if (!item) return new Response("未找到（未登录或云端无此文件）", { status: 404 });
    // 若本地有正式副本（files 分区，keepOffline 过）→ 直接从它答（离线也能播）。
    let full: Blob | null = null;
    try { const r = await bs.partition("files").get(name); if (r) full = r.blob; } catch { /* 走云端 */ }
    const size = full ? full.size : item.size;
    const ct = cfg.contentType?.(name) ?? "application/octet-stream";
    const baseHeaders: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Type": ct, "Cache-Control": "no-store" };
    const range = parseRange(req.headers.get("Range"), size) ?? { start: 0, end: null };

    // 有界小段（Safari 的 bytes=0-1 探针等）→ 精确组装
    if (range.end != null) {
      const start = range.start, end = range.end;
      let body: Uint8Array;
      if (full) body = new Uint8Array(await full.slice(start, end + 1).arrayBuffer());
      else {
        const i0 = Math.floor(start / chunkBytes), i1 = Math.floor(end / chunkBytes);
        const parts: Uint8Array[] = [];
        for (let i = i0; i <= i1; i++) parts.push(await getChunk(name, item, i));
        const buf = new Uint8Array(end - start + 1);
        let w = 0;
        for (let i = i0; i <= i1; i++) {
          const c = parts[i - i0], cs = i * chunkBytes;
          const from = Math.max(start, cs) - cs, to = Math.min(end + 1, cs + c.length) - cs;
          buf.set(c.subarray(from, to), w); w += to - from;
        }
        body = buf;
      }
      return new Response(body as unknown as BodyInit, {
        status: 206,
        headers: { ...baseHeaders, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
      });
    }

    // 开放式（bytes=a- / 无 Range）→ 206/200 + 顺序分片 ReadableStream（播放器 cancel 即停 = 开多久拉多久）
    const start = range.start;
    if (full) {
      const sliced = full.slice(start);
      return new Response(sliced.stream() as unknown as BodyInit, {
        status: start > 0 || req.headers.get("Range") ? 206 : 200,
        headers: start > 0 || req.headers.get("Range")
          ? { ...baseHeaders, "Content-Range": `bytes ${start}-${size - 1}/${size}`, "Content-Length": String(size - start) }
          : { ...baseHeaders, "Content-Length": String(size) },
      });
    }
    let i = Math.floor(start / chunkBytes);
    let skip = start - i * chunkBytes;
    const nChunks = Math.max(1, Math.ceil(size / chunkBytes));
    const stream = new ReadableStream<Uint8Array>({
      pull: async (controller) => {
        if (i >= nChunks) { controller.close(); return; }
        const c = await getChunk(name, item, i);
        controller.enqueue(skip > 0 ? c.subarray(skip) : c);
        skip = 0; i++;
      },
      // cancel：播放器不要了（seek 走了/暂停够久）→ 停拉。已 tee 的分片留在 staging。
      cancel: () => { /* pull 不再被调即停；无需清理 */ },
    });
    const isRange = !!req.headers.get("Range");
    return new Response(stream as unknown as BodyInit, {
      status: isRange ? 206 : 200,
      headers: isRange
        ? { ...baseHeaders, "Content-Range": `bytes ${start}-${size - 1}/${size}`, "Content-Length": String(size - start) }
        : { ...baseHeaders, "Content-Length": String(size) },
    });
  }

  return { matches, handle };
}
