// Microsoft Graph wrapper — 所有路径锚在 /me/drive/special/approot 沙盒。
// AppFolder 沙盒 = `Apps/<应用注册名>/`（文件夹名由 Azure 应用注册决定），即使 token 泄漏也只能碰本 app 的目录。
//
// 本库用得着的 Graph 子集：
//   - listChildren()            列 approot 下文件
//   - getItemByPath(path)       拿 metadata（含 eTag）
//   - downloadItemBlob(id)      取二进制（atlas zip）
//   - uploadFileToApproot()     PUT zip blob，支持 If-Match 防冲突
//   - deleteItem(id)            清理
//
// 关键陷阱：
//   - body 必须接受 TypedArray —— 没有 ArrayBuffer.isView 检查会把 Uint8Array
//     JSON.stringify 成 10× 膨胀。webxiaoheiwu 踩过坑。
//   - @microsoft.graph.conflictBehavior 在 URL 查询串，不是 header（@ 在 header 非法）。
//   - 大于 4MB 走 createUploadSession 分块上传。atlas zip 大概率超 4MB。


// ── token-source 接缝（2026-08-20 收敛；**2026-08-28 实例化**：per-account pin 打扫轮）──────────
//   graph 层不绑 MSAL：页面 = createOneDriveProvider 注入 auth.getToken/getTokenFor；SW = 凭据桥读端。
//   旧形 = 模块级 configureGraphTokenSource 单例 + 模块级 approot/subfolder/downloadUrl 缓存——
//   第二个 provider 会覆盖第一个的 token 源，且**跨账号缓存互相投毒**（A 账号的 approot id 配 B 账号
//   token = 打错盘）。createGraph(tokenSource) 起，token 源与全部缓存 per-instance，双库双账号并联安全。
import { CloudNetworkError } from "../errors.ts";
import { anySignal, readBody } from "./range-body.ts";

// ---- 实际读到的 Graph JSON 形状（只声明本文件真正访问的字段，其余 Graph 字段忽略）。----
// driveItem 的 file/folder facet 二选一区分文件/文件夹；@ 前缀字段是 Graph 注解。
interface GraphDriveItem {
  id: string;
  name?: string;
  size?: number;
  eTag?: string;
  createdDateTime?: string;
  lastModifiedDateTime?: string;
  file?: unknown;
  folder?: unknown;
  parentReference?: { id?: string };
  downloadUrl?: string;
  "@microsoft.graph.downloadUrl"?: string;
}
// children / list 分页响应。
interface GraphListResponse {
  value?: GraphDriveItem[];
  "@odata.nextLink"?: string;
}
// createUploadSession 响应；GET uploadUrl 查会话进度时也带 nextExpectedRanges（"<from>-<to>" / "<from>-"）。
interface GraphUploadSession {
  uploadUrl: string;
  nextExpectedRanges?: string[];
}

// ── 请求超时（0.17.1，2026-10-15 Claude Fable 5.1）──
//   iOS 锁屏 / 切后台后在途的 fetch 常常既不成功也不报错、永远挂着（KudsRocket 10-15「多锁几次，全卡死了」）：
//   每个请求都带 AbortSignal.timeout，挂死的变成 CloudNetworkError → 上层按网络错误重试 / 留 dirty 续推。
//   meta = 元数据 / 列举 / 会话创建；chunk = 一块 5 MiB 的 PUT（100 KB/s 的上行也够）；range = 一片 byte-range；blob = 整文件下载。
//   AbortSignal.timeout 老浏览器没有（iOS < 16）→ 不带 signal，行为同 0.17.0。
export interface GraphTimeouts { meta: number; chunk: number; range: number; blob: number }
/** 推荐值（KudsRocket 在用）：消费方显式传给 createOneDriveProvider({ transport: { timeouts } }) 才生效。 */
export const DEFAULT_GRAPH_TIMEOUTS: GraphTimeouts = { meta: 30_000, chunk: 120_000, range: 60_000, blob: 15 * 60_000 };
/** 0.17.2（user 2026-10-15「行为变更默认关、消费方显式开」）：传输层的行为开关。不传 = 0.17.0 的行为（无超时、单块失败整份重试、提交前不核）。 */
export interface GraphTransportOptions {
  /** 每种请求的超时（ms）；不传 = 不设超时。 */
  timeouts?: Partial<GraphTimeouts>;
  /** 分块上传单块失败：问会话传到哪了、退避、接着传（不传 = 整份失败交上层重试）。 */
  chunkResume?: boolean;
  /** 分块上传提交最后一块前再核一次 eTag（多一个 GET；不传 = 只在开会话时核）。 */
  verifyChunkedCommit?: boolean;
  /** 测试用：退避的 sleep。 */
  sleep?: (ms: number) => Promise<void>;
}
let graphTimeouts: GraphTimeouts | null = null;
let graphChunkResume = false;
let graphVerifyCommit = false;
let graphSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const timed = (kind: keyof GraphTimeouts): AbortSignal | undefined => {
  if (!graphTimeouts) return undefined;
  const ms = graphTimeouts[kind];
  return typeof AbortSignal !== "undefined" && typeof (AbortSignal as { timeout?: unknown }).timeout === "function" ? AbortSignal.timeout(ms) : undefined;
};
// 分块上传：单块失败不从零重传——问会话传到哪了、退避、接着传（0.17.1）。
const CHUNK_RETRY_MAX = 5;
const chunkBackoffMs = (attempt: number): number => Math.min(1000 * 2 ** (attempt - 1), 16_000);   // 1 / 2 / 4 / 8 / 16 s
// graphFetch 抛的错带 HTTP status/body（caller 用 status 判 404 等）。
interface GraphError extends Error {
  status?: number;
  body?: string;
}

// graphFetch 的请求体：字符串/二进制走原样，其余对象 JSON.stringify。
type GraphBody = string | ArrayBuffer | ArrayBufferView | Blob | Record<string, unknown> | null;
interface GraphFetchOpts {
  headers?: Record<string, string>;
  body?: GraphBody;
}

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SIMPLE_UPLOAD_LIMIT = 4 * 1024 * 1024;

function encodeSeg(name: string): string {
  return encodeURIComponent(name).replace(/'/g, "%27");
}

export function encodeApprootPath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeSeg).join("/");
}

function _rangeHeader(offset: number | null, length: number): string {
  return (offset == null)
    ? `bytes=-${length}`
    : `bytes=${offset}-${offset + length - 1}`;
}

/** 0.19：一片 byte-range 的旁路——signal = 调度层中止（对冲输了 / 投机卡住让道），onProgress = 累计到了多少字节（卡住判定靠它）。
 *  形状同 chunk-scheduler.ts 的 RangeOpts（graph 不 import 上层类型）。 */
export interface RangeFetchOpts { signal?: AbortSignal; onProgress?: (bytesSoFar: number) => void }

// 直接打已知 CDN URL 的 byte-range（省掉每个 peek 的 metadata RTT）
// caller 处理 401/403 = downloadUrl 过期，重申请 getDownloadUrl 重试一次
export async function downloadRangeFromUrl(downloadUrl: string, offset: number | null, length: number, opts: RangeFetchOpts = {}): Promise<ArrayBuffer> {
  let r: Response;
  try { r = await fetch(downloadUrl, { headers: { Range: _rangeHeader(offset, length) }, signal: anySignal([timed("range"), opts.signal]) }); }
  catch (e) { throw new CloudNetworkError(`range download: network fetch failed (${String(e)})`, e); }
  if (!r.ok && r.status !== 206) {
    const err: GraphError = new Error(`range download failed ${r.status}`);
    err.status = r.status;
    throw err;
  }
  // 按流读 + 报进度（只在 caller 要进度时；否则一口 arrayBuffer，= 0.18）。读体中途断 / 被中止 → 网络错（和 fetch 自身 throw 同一类）。
  try { return await readBody(r, opts.onProgress); }
  catch (e) { throw new CloudNetworkError(`range download: body failed (${String(e)})`, e); }
}

//   "replace" 默认覆盖；"fail" 同名拒收（用于 sibling-copy）。
interface UploadFileOpts {
  conflictBehavior?: string;
  eTag?: string | null;
  /** 0.17.0：上传进度（done / total 字节）。 */
  onProgress?: (done: number, total: number) => void;
}
/** 0.17.0：流式上传的字节来源（types.ts ByteSource 同形；graph 不 import 上层类型）。 */
interface ChunkSource { readonly size: number; read(offset: number, length: number): Promise<Uint8Array> }
//   trash / restore 用 "fail" 保护数据，caller 自己 fallback 改名
interface MoveItemOpts {
  eTag?: string | null;
  newName?: string | null;
  conflictBehavior?: string;
}

/** Graph 实例（per-provider：token 源 + 全部缓存实例私有）。返回面 = GraphTransport 超集。 */
export function createGraph(tokenSource: () => Promise<string>, opts: GraphTransportOptions = {}) {
  // 模块级开关（最后一个 createGraph 说了算；同页多 provider 共用一套传输政策）：不传 = 0.17.0 行为
  graphTimeouts = opts.timeouts ? { ...DEFAULT_GRAPH_TIMEOUTS, ...opts.timeouts } : null;
  graphChunkResume = !!opts.chunkResume;
  graphVerifyCommit = !!opts.verifyChunkedCommit;
  if (opts.sleep) graphSleep = opts.sleep;
  const getToken = (): Promise<string> => {
    if (!tokenSource) throw new Error("graph token source missing (page: createOneDriveProvider; SW: createGraph(createBridgeTokenSource(dbName)))");
    return tokenSource();
  };

async function graphFetch(method: string, pathOrUrl: string, { headers = {}, body = null }: GraphFetchOpts = {}): Promise<Response> {
  const token = await getToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${GRAPH_BASE}${pathOrUrl}`;
  const init: RequestInit & { headers: Record<string, string> } = { method, headers: { Authorization: `Bearer ${token}`, ...headers }, signal: timed("meta") };
  if (body != null) {
    if (
      typeof body === "string" ||
      body instanceof ArrayBuffer ||
      ArrayBuffer.isView(body) ||
      body instanceof Blob
    ) {
      init.body = body;
    } else {
      init.body = JSON.stringify(body);
      if (!init.headers["Content-Type"]) init.headers["Content-Type"] = "application/json";
    }
  }
  // 网络层 throw（断网/DNS/iOS 网络切换，Safari 报裸 `TypeError: Load failed`）→ 翻成类型化
  //   CloudNetworkError（status 恒 undefined = 仍可重试）。只在 fetch 自身 throw 处包装——这里的
  //   TypeError 必是网络层；上层泛判 instanceof TypeError 会把自家 bug 误装成「网络问题」，禁止。
  let response: Response;
  try { response = await fetch(url, init); }
  catch (e) { throw new CloudNetworkError(`Graph ${method} ${pathOrUrl}: network fetch failed (${String(e)})`, e); }
  if (!response.ok) {
    let detail = "";
    try { detail = await response.text(); } catch (_) {}
    const err: GraphError = new Error(`Graph ${method} ${pathOrUrl} → ${response.status}: ${detail}`);
    err.status = response.status;
    err.body = detail;
    throw err;
  }
  return response;
}

// ----- listing -----
async function listChildren(subfolder = ""): Promise<GraphDriveItem[]> {
  const pathPart = subfolder ? `:/${encodeApprootPath(subfolder)}:` : "";
  const items: GraphDriveItem[] = [];
  // @microsoft.graph.downloadUrl：1h 短效 CDN URL，加进 $select 让 list 一次性带回
  // → 后续 byte-range 直接打 CDN，省掉每个 peek 的 metadata RTT
  // 过期后 caller 拿 401/403 → 重新走 getDownloadUrl 申请
  let next: string | null = `/me/drive/special/approot${pathPart}/children?$top=200&$select=id,name,size,eTag,createdDateTime,lastModifiedDateTime,file,folder,@microsoft.graph.downloadUrl`;
  while (next) {
    let response;
    try { response = await graphFetch("GET", next); }
    catch (e) { if ((e as GraphError).status === 404 && subfolder) return []; throw e; }
    const page = await response.json() as GraphListResponse;
    items.push(...(page.value ?? []));
    next = page["@odata.nextLink"] ?? null;
  }
  return items;
}

// ----- 单 item metadata -----
async function getItemByPath(path: string): Promise<GraphDriveItem | null> {
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(path)}?$select=id,name,size,eTag,lastModifiedDateTime,folder,@microsoft.graph.downloadUrl`,
    );
    return await r.json() as GraphDriveItem;
  } catch (e) {
    if ((e as GraphError).status === 404) return null;
    throw e;
  }
}

// ----- 二进制下载 -----
async function downloadItemBlob(itemId: string): Promise<Blob> {
  // 优先 @microsoft.graph.downloadUrl（短期签名 CDN）；没有就走 /content
  const dl = await getDownloadUrl(itemId);
  if (dl) {
    let r: Response;
    try { r = await fetch(dl, { signal: timed("blob") }); }
    catch (e) { throw new CloudNetworkError(`downloadUrl: network fetch failed (${String(e)})`, e); }
    if (!r.ok) throw new Error(`downloadUrl failed ${r.status}`);
    return await r.blob();
  }
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`);
  return await r.blob();
}

// byte-range 下载
//   offset = null + length 给 suffix range "bytes=-N"（取最后 N 字节）
//   offset 给 prefix range "bytes=OFFSET-OFFSET+LEN-1"
//   走 downloadUrl 拿 CDN signed URL（支持 Range header），fallback /content
// downloadUrl 内存缓存（SW 网关手搓件合流，2026-08-20）：分片流播每 2MB 一个 range，
// 不该每片重走一次 getDownloadUrl 往返；过期/失效（401/403/404 或 fetch throw——iOS 切网后遗症
// 会以 throw 现形）→ 清缓存重申请一次。
const _dlUrlCache = new Map<string, string>();
async function downloadItemRange(itemId: string, offset: number | null, length: number, opts: RangeFetchOpts = {}): Promise<ArrayBuffer> {
  let url = _dlUrlCache.get(itemId) ?? await getDownloadUrl(itemId);
  if (url) {
    _dlUrlCache.set(itemId, url);
    try { return await downloadRangeFromUrl(url, offset, length, opts); }
    catch (e) {
      if (opts.signal?.aborted) throw e;                 // 0.19：是调度层中止的（对冲输了 / 卡住让道）→ 不重申请、不重试
      _dlUrlCache.delete(itemId);
      url = await getDownloadUrl(itemId);
      if (url) { _dlUrlCache.set(itemId, url); return await downloadRangeFromUrl(url, offset, length, opts); }
    }
  }
  const r = await graphFetch("GET", `/me/drive/items/${itemId}/content`, { headers: { Range: _rangeHeader(offset, length) } });
  return await r.arrayBuffer();
}

// 拿一个新的 1h 短效 downloadUrl（过期重申请用）
// ⚠ 裸 GET 不带 $select（2026-08-16 spike-7 战例）：downloadUrl 是 instance annotation，
//   `$select=id,@microsoft.graph.downloadUrl` 会返回 200 却**丢掉该字段**。此前 listChildren 批量带回
//   downloadUrl 把这条 refresh 路径遮着没炸；SW 网关手搓版先踩雷，同修回库（双实现 drift 的现世报）。
async function getDownloadUrl(itemId: string): Promise<string | null> {
  const r = await graphFetch("GET", `/me/drive/items/${itemId}`);
  const j = await r.json() as GraphDriveItem;
  return j["@microsoft.graph.downloadUrl"] || null;
}

// ----- 上传 -----
// path 相对 approot。eTag 给 If-Match（拿冲突检测）。conflictBehavior:
async function uploadFileToApproot(path: string, blob: Blob, contentType = "application/octet-stream", { conflictBehavior = "replace", eTag = null, onProgress }: UploadFileOpts = {}): Promise<GraphDriveItem | null> {
  // 【运行时护栏，user 2026-08-25 拍板「全库以后只能用 If-Match」】盲覆盖在最深处不可表示：
  //   replace 必须带 If-Match eTag（CAS 覆盖）；新建走 conflictBehavior:"fail"（不存在才准建，CAS 等价物）。
  //   配套语法检测 = test/ifmatch-guard.test.ts（扫源码裸 replace）。深模块强制，UI/调用方守不守都拦得住。
  if (conflictBehavior === "replace" && !eTag) throw new Error(`[graph] blind overwrite forbidden: conflictBehavior:"replace" requires If-Match eTag (${path})`);
  const headers: Record<string, string> = { "Content-Type": contentType };
  if (eTag) headers["If-Match"] = eTag;
  if (blob.size <= SIMPLE_UPLOAD_LIMIT) {
    onProgress?.(0, blob.size);
    const r = await graphFetch(
      "PUT",
      `/me/drive/special/approot:/${encodeApprootPath(path)}:/content?@microsoft.graph.conflictBehavior=${conflictBehavior}`,
      { headers, body: blob },
    );
    onProgress?.(blob.size, blob.size);
    return r.json() as Promise<GraphDriveItem>;
  }
  // 大文件分块：Blob 当「按 slice 取块」的来源（分块路径和流式上传共用一条）
  return uploadChunked(path, { size: blob.size, read: async (o, n) => new Uint8Array(await blob.slice(o, o + n).arrayBuffer()) }, conflictBehavior, eTag, onProgress);
}

/** 0.17.0：流式上传——永远走上传会话（哪怕很小），按 source.read 逐块取、逐块传；整份永不进内存。护栏同 uploadFileToApproot。 */
async function uploadStreamToApproot(path: string, source: ChunkSource, _contentType = "application/octet-stream", { conflictBehavior = "fail", eTag = null, onProgress }: UploadFileOpts = {}): Promise<GraphDriveItem | null> {
  if (conflictBehavior === "replace" && !eTag) throw new Error(`[graph] blind overwrite forbidden: conflictBehavior:"replace" requires If-Match eTag (${path})`);
  return uploadChunked(path, source, conflictBehavior, eTag, onProgress);
}

// 上传会话 + 分块 PUT（Graph：每块是 320 KiB 的倍数、≤ 60 MiB；最后一块落地才成文件，中途断了云端没有半成品）。
// 0.17.1（2026-10-15 Claude Fable 5.1）：
//   · 每块 PUT 带超时；网络错 / 429 / 5xx / 416 → GET uploadUrl 问「传到哪了」（nextExpectedRanges），退避 1/2/4/8/16 s，从那里接着传——
//     一次网络抖动不再整份重传（KudsRocket iPad 10-14：6.8 MB 快照第二块 Load failed 就从头来）。会话没了（404）→ 抛网络错，上层整份重试。
//   · If-Match 只在 createUploadSession 时核；最后一块落地是无条件的 → 两台设备同时覆盖同一格时有一个「上传那几十秒」的窗口。
//     现在提交最后一块前再 GET 一次 item 比 eTag：动了就撤会话、抛 412（上层翻成冲突面）。窗口缩到最后一块那几秒。
async function uploadChunked(path: string, source: ChunkSource, conflictBehavior: string, eTag: string | null, onProgress?: (done: number, total: number) => void): Promise<GraphDriveItem | null> {
  const sessR = await graphFetch(
    "POST",
    `/me/drive/special/approot:/${encodeApprootPath(path)}:/createUploadSession`,
    {
      body: {
        item: {
          "@microsoft.graph.conflictBehavior": conflictBehavior,
          name: path.split("/").pop(),
        },
      },
      headers: eTag ? { "If-Match": eTag } : undefined,
    },
  );
  const { uploadUrl } = await sessR.json() as GraphUploadSession;
  const CHUNK = 5 * 1024 * 1024;
  const total = source.size;
  let offset = 0;
  let last: GraphDriveItem | null = null;
  let failures = 0;   // 连续失败次数（成功一块就归零）
  // 问会话传到哪了；退避后返回下一块该从哪开始。会话没了 / 问不到 → 抛（上层按网络错整份重试）。
  const resumeFrom = async (why: string): Promise<number> => {
    failures++;
    if (failures > CHUNK_RETRY_MAX) throw new CloudNetworkError(`Graph chunked upload ${path}: gave up after ${CHUNK_RETRY_MAX} retries at ${offset}/${total} (${why})`);
    await graphSleep(chunkBackoffMs(failures));
    let st: Response;
    try { st = await fetch(uploadUrl, { signal: timed("meta") }); }
    catch (e) { throw new CloudNetworkError(`Graph upload session status: network fetch failed (${String(e)})`, e); }
    if (!st.ok) throw new CloudNetworkError(`Graph upload session ${path}: gone (${st.status}) after ${why}`);
    const j = await st.json().catch(() => null) as GraphUploadSession | null;
    const next = j?.nextExpectedRanges?.[0]?.split("-")[0];
    const at = next != null ? Number(next) : NaN;
    if (!Number.isFinite(at) || at < 0 || at > total) throw new CloudNetworkError(`Graph upload session ${path}: no usable nextExpectedRanges after ${why}`);
    return at;
  };
  const cancelSession = async (): Promise<void> => { try { await fetch(uploadUrl, { method: "DELETE", signal: timed("meta") }); } catch (_) { /* best effort */ } };
  onProgress?.(0, total);
  while (offset < total) {
    const end = Math.min(offset + CHUNK, total) - 1;
    if (graphVerifyCommit && end === total - 1 && eTag) {   // 提交前核 eTag（显式开；见头注释）；查不到（网络）→ 抛，上层整份重试
      const cur = await getItemByPath(path);
      if (cur && cur.eTag && cur.eTag !== eTag) {
        await cancelSession();
        const err: GraphError = new Error(`chunked upload ${path}: item changed during upload (If-Match ${eTag} ≠ ${cur.eTag})`);
        err.status = 412;
        throw err;
      }
    }
    const chunk = await source.read(offset, end - offset + 1);
    if (chunk.length !== end - offset + 1) throw new Error(`[graph] chunk source short read at ${offset}: wanted ${end - offset + 1}, got ${chunk.length}`);
    let r: Response;
    try {
      r = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${end}/${total}`,
        },
        body: chunk as BodyInit,
        signal: timed("chunk"),
      });
    } catch (e) {   // 分块 PUT 打的是 uploadUrl（不走 graphFetch）→ 网络层：开了 chunkResume 就问会话接着传，否则同 0.17.0 整份失败
      if (!graphChunkResume) throw new CloudNetworkError(`Graph chunked upload PUT (${offset}-${end}/${total}): network fetch failed (${String(e)})`, e);
      offset = await resumeFrom(`network: ${String(e)}`);
      continue;
    }
    if (!r.ok && r.status !== 202) {
      if (graphChunkResume && (r.status === 429 || r.status === 416 || (r.status >= 500 && r.status <= 599))) { offset = await resumeFrom(`http ${r.status}`); continue; }
      const err: GraphError = new Error(`chunked upload failed ${r.status}`);
      err.status = r.status;
      throw err;
    }
    failures = 0;
    last = await r.json().then((j) => j as GraphDriveItem).catch(() => null);
    offset = end + 1;
    onProgress?.(offset, total);
  }
  return last;
}

// ----- 删除 -----
// eTag（选填）：If-Match 前置——只在项未变时删（删空夹 best-effort 收 TOCTOU：child-add 若 bump folder eTag 则 412）。
//   收不严（Graph 不保证 folder eTag 随 child 变）但零成本；文件硬删不传 = 无条件（旧行为）。
async function deleteItem(itemId: string, eTag?: string | null): Promise<void> {
  await graphFetch("DELETE", `/me/drive/items/${itemId}`, eTag ? { headers: { "If-Match": eTag } } : {});
}

// ----- approot + 子文件夹 ensure / 移动 -----（trash + folder feature 用）

let _approotIdCache: string | null = null;
const _subfolderIdCache = new Map<string, string>();

function clearFolderCaches(): void { _approotIdCache = null; _subfolderIdCache.clear(); _dlUrlCache.clear(); }

async function getApprootId(): Promise<string> {
  if (_approotIdCache) return _approotIdCache;
  const r = await graphFetch("GET", "/me/drive/special/approot?$select=id");
  _approotIdCache = (await r.json() as GraphDriveItem).id;
  return _approotIdCache;
}

// 确保 approot 下有指定子文件夹（name 单段或多段 "a/b/c"），返 folder id。
// 加缓存：第一次拉 / 建，之后 reuse。
async function ensureSubfolder(name: string): Promise<string> {
  if (!name) return getApprootId();
  const cached = _subfolderIdCache.get(name);
  if (cached !== undefined) return cached;
  // 先试拿现有
  try {
    const r = await graphFetch(
      "GET",
      `/me/drive/special/approot:/${encodeApprootPath(name)}?$select=id,name,folder`,
    );
    const item = await r.json() as GraphDriveItem;
    if (item.folder) {
      _subfolderIdCache.set(name, item.id);
      return item.id;
    }
    throw new Error(`${name} 已存在但不是文件夹`);
  } catch (e) {
    if ((e as GraphError).status !== 404) throw e;
  }
  // 不存在 → 逐段建。多段路径用 children POST 每段。
  const segments = name.split("/").filter(Boolean);
  let parentId = await getApprootId();
  let cumulative = "";
  for (const seg of segments) {
    cumulative = cumulative ? `${cumulative}/${seg}` : seg;
    const cachedSeg = _subfolderIdCache.get(cumulative);
    if (cachedSeg !== undefined) { parentId = cachedSeg; continue; }
    try {
      const r = await graphFetch(
        "GET",
        `/me/drive/special/approot:/${encodeApprootPath(cumulative)}?$select=id,folder`,
      );
      const it = await r.json() as GraphDriveItem;
      if (it.folder) { parentId = it.id; _subfolderIdCache.set(cumulative, parentId); continue; }
    } catch (e) { if ((e as GraphError).status !== 404) throw e; }
    const r = await graphFetch("POST", `/me/drive/items/${parentId}/children`, {
      body: {
        name: seg,
        folder: {},
        "@microsoft.graph.conflictBehavior": "fail",
      },
    });
    const it = await r.json() as GraphDriveItem;
    parentId = it.id;
    _subfolderIdCache.set(cumulative, parentId);
  }
  return parentId;
}

// 把 item 移到指定 parent folder。atomic at server side（PATCH parentReference）
// eTag 给 If-Match 防覆盖；newName 不传保持原 name
// conflictBehavior: "fail" | "replace" | "rename" —— 默认 "fail"（防误覆盖目标位置同名）
async function moveItemToFolder(itemId: string, targetFolderId: string, { eTag = null, newName = null, conflictBehavior = "fail" }: MoveItemOpts = {}): Promise<GraphDriveItem> {
  const headers: Record<string, string> = {};
  if (eTag) headers["If-Match"] = eTag;
  const body: Record<string, unknown> = {
    parentReference: { id: targetFolderId },
    "@microsoft.graph.conflictBehavior": conflictBehavior,
  };
  if (newName) body.name = newName;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, { headers, body });
  return r.json() as Promise<GraphDriveItem>;
}

// 改名 only（不移动）
// 服务端复制（O3 copy-then-replace 原语，2026-08-25）：源原位不动，复制一份到目标文件夹。
//   Graph copy 是**异步任务**：POST 返 202 + Location 监控 URL，轮询到 completed 再按 resourceId 取回 item。
//   监控 URL 是预授权的（带 Authorization 反而可能 401）→ 裸 fetch，网络层 throw 同款翻 CloudNetworkError。
//   conflictBehavior 显式钉 fail：目标同名 → 409（绝不静默覆盖 .backup 里的既有备份）。
async function copyItemToFolder(itemId: string, targetFolderId: string, newName: string): Promise<GraphDriveItem> {
  const res = await graphFetch(
    "POST",
    `/me/drive/items/${itemId}/copy?@microsoft.graph.conflictBehavior=fail`,
    { body: { parentReference: { id: targetFolderId }, name: newName } },
  );
  const monitor = res.headers.get("Location");
  if (!monitor) {   // 罕见：个别实现同步完成直接回 item
    const j = await res.json().catch(() => null) as GraphDriveItem | null;
    if (j && j.id) return j;
    throw new Error(`Graph copy ${itemId}: 202 without Location monitor`);
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  // 轮询预算 ~5min（250ms 起步、封顶 2s；慢网 RTT 自然拉长，无妨）——copy 是**服务端内部复制**，
  //   字节不走用户带宽，轮询本身每次几百字节；预算随手放宽是免费的（completed 即退），只兜病态情形。
  //   大文件时代（background upload 规划）服务端 copy 耗时随体积涨，30s 不够（2026-08-25 user review 放宽）。
  //   超时仍安全：抛在 replace 之前，原位原版完好、dirty 保住可重试（弃单 copy 迟到完成 = .backup 无害赘份）。
  for (let attempt = 1; attempt <= 170; attempt++) {
    let mr: Response;
    try { mr = await fetch(monitor, { signal: timed("meta") }); }
    catch (e) { throw new CloudNetworkError(`Graph copy monitor: network fetch failed (${String(e)})`, e); }
    const j = await mr.json().catch(() => null) as { status?: string; resourceId?: string; id?: string } | null;
    if (j?.status === "failed") throw new Error(`Graph copy ${itemId}: server reported failed`);
    const rid = j?.resourceId ?? (j?.status === "completed" ? j?.id : null);
    if (rid) {
      const ir = await graphFetch("GET", `/me/drive/items/${rid}`);
      return await ir.json() as GraphDriveItem;
    }
    await sleep(Math.min(250 * attempt, 2000));
  }
  throw new Error(`Graph copy ${itemId}: monitor timeout (~5min)`);
}

async function renameItem(itemId: string, newName: string, eTag: string | null = null): Promise<GraphDriveItem> {
  const headers: Record<string, string> = {};
  if (eTag) headers["If-Match"] = eTag;
  const r = await graphFetch("PATCH", `/me/drive/items/${itemId}`, {
    headers,
    body: { name: newName },
  });
  return r.json() as Promise<GraphDriveItem>;
}

  return {
    listChildren, getItemByPath, downloadItemBlob, downloadItemRange, getDownloadUrl,
    uploadFileToApproot, uploadStreamToApproot, deleteItem, clearFolderCaches, getApprootId, ensureSubfolder,
    moveItemToFolder, copyItemToFolder, renameItem,
  };
}

/** createGraph 返回面（sw/gateway 等消费者的类型口）。 */
export type GraphInstance = ReturnType<typeof createGraph>;
