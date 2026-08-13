// graphToCloudProvider —— 把 Graph transport（graph.js）翻成 lib 的 CloudProvider。
// 原始 Graph item（file/folder facet、@microsoft.graph.downloadUrl）→ CloudItem。
// 纯：graph **必传**（测试传 graphFromProvider(MockCloudProvider)）。
//   graphToCloudProvider ∘ graphFromProvider ≈ 恒等 → 完整 Mock 验适配正确性。
// 完整的「config 驱动 OneDriveProvider」在 providers/index.js（wire auth+graph+本适配器）。

import type { CloudItem, CloudProvider, UploadOpts, MoveOpts, Bytes } from "./types.ts";
import { deleteEmptyFolderVia } from "./folder-delete.ts";

/** OneDrive Graph transport 契约（graphToCloudProvider 消费的最小面）。
 *  providers/index 传真 graph.ts 模块、测试传 graphFromProvider(Mock)——结构满足即可（自定义 transport 同理）。 */
export interface GraphTransport {
  /** 列举子夹的直属子项（原始 Graph item）。 */
  listChildren(subfolder?: string): Promise<RawGraphItem[]>;
  /** 按路径取 item；缺 → null。 */
  getItemByPath(path: string): Promise<RawGraphItem | null>;
  /** 下载文件内容。 */
  downloadItemBlob(itemId: string): Promise<Blob>;
  /** byte-range 下载；offset=null 取末尾 length 字节。 */
  downloadItemRange(itemId: string, offset: number | null, length: number): Promise<ArrayBuffer>;
  /** 上传到 approot 相对路径。 */
  uploadFileToApproot(path: string, blob: Blob, contentType?: string, opts?: { conflictBehavior?: "replace" | "fail" | "rename"; eTag?: string | null }): Promise<RawGraphItem | null>;
  /** 硬删 item。 */
  deleteItem(itemId: string, eTag?: string | null): Promise<void>;
  /** 移动到目标文件夹。 */
  moveItemToFolder(itemId: string, targetFolderId: string, opts?: { eTag?: string | null; newName?: string | null; conflictBehavior?: "replace" | "fail" | "rename" }): Promise<RawGraphItem>;
  /** 改名。 */
  renameItem(itemId: string, newName: string, eTag?: string | null): Promise<RawGraphItem>;
  /** 取 approot 文件夹 id。 */
  getApprootId(): Promise<string>;
  /** 确保子夹存在，返其 id。 */
  ensureSubfolder(name: string): Promise<string>;
}

/** graph item 的原始形状（含 file/folder facet、path、downloadUrl 注解；transport 契约的条目面）。
 *  比 graph.ts 内部形状放宽（测试 mock 带 path）。 */
export interface RawGraphItem {
  /** 云端 item id。 */
  id: string;
  /** 文件名。 */
  name?: string;
  /** 字节大小。 */
  size?: number;
  /** 版本 etag。 */
  eTag?: string;
  /** 最后修改时间。 */
  lastModifiedDateTime?: string | number;
  /** folder facet（Graph: file facet vs folder facet）；有 = 文件夹。 */
  folder?: unknown;
  /** 云端路径。 */
  path?: string;
  /** 下载 URL。 */
  downloadUrl?: string;
  /** Graph 直传的下载 URL 注解。 */
  "@microsoft.graph.downloadUrl"?: string;
}

function toItem(it: RawGraphItem | null | undefined): CloudItem | null {
  if (!it) return null;
  return {
    id: it.id,
    name: it.name as string,
    size: it.size || 0,
    eTag: it.eTag as string,
    lastModifiedDateTime: it.lastModifiedDateTime as string | number,
    isFolder: !!it.folder,                                   // Graph: file facet vs folder facet
    path: it.path as string,
    downloadUrl: it["@microsoft.graph.downloadUrl"] || it.downloadUrl,
  } as CloudItem;
}

/** 把 Graph transport（graph.ts）翻成库的 CloudProvider（原始 Graph item → CloudItem）。
 *  纯：graph **必传**（测试传 graphFromProvider(MockCloudProvider)，与 graphToCloudProvider 复合 ≈ 恒等）。 */
export function graphToCloudProvider(graph: GraphTransport): CloudProvider {
  if (!graph) throw new Error("graphToCloudProvider: graph transport 必传");
  const list = async (folder = ""): Promise<CloudItem[]> => (await graph.listChildren(folder)).map(toItem) as CloudItem[];
  const getItemByPath = async (path: string): Promise<CloudItem | null> => toItem(await graph.getItemByPath(path));
  return {
    list,
    getItemByPath,
    download: (id: string) => graph.downloadItemBlob(id),
    downloadRange: (id: string, offset: number, length: number) => graph.downloadItemRange(id, offset, length),
    // graph.js 是 Blob 原生（按 .size 选简单/分块路径、用 .slice 切块）；lib 把字节归一成 Uint8Array。
    // 必须在这道接缝转回 Blob——Uint8Array.size===undefined → undefined<=4MB 为 false → 永远走分块、
    // while(0<undefined) 一个 chunk 都不传 → 上传 0 字节占位还回 etag（postmortem 2026-06-05 根因）。
    upload: (path: string, blob: Bytes | Blob, { contentType = "application/octet-stream", eTag = null, conflictBehavior = "replace" }: UploadOpts = {}) => {
      const body = blob instanceof Blob ? blob : new Blob([blob], { type: contentType });
      return graph.uploadFileToApproot(path, body, contentType, { conflictBehavior, eTag }).then(toItem) as Promise<CloudItem>;
    },
    delete: (id: string) => graph.deleteItem(id),   // 文件硬删（无条件）
    // 删空夹（唯一文件夹删除面）：护栏在 folder-delete 深模块，If-Match folder etag best-effort。
    deleteEmptyFolder: (path: string) => deleteEmptyFolderVia(getItemByPath, list, (id, etag) => graph.deleteItem(id, etag), path),
    ensureFolder: (path: string) => graph.ensureSubfolder(path),
    move: (id: string, folderId: string, opts: MoveOpts = {}) => graph.moveItemToFolder(id, folderId, opts).then(toItem) as Promise<CloudItem>,
    rename: (id: string, newName: string, eTag?: string | null) => graph.renameItem(id, newName, eTag).then(toItem) as Promise<CloudItem>,
    getApprootId: () => graph.getApprootId(),
  };
}
