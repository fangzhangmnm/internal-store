// ⚠ 使用前必读 README.md。store 内部模块，app 经 createFolderProvider 拿 CloudProvider。
// created 2026-08-26 by Claude Fable 5 (claude-fable-5)
//
// folder provider ——「folder 就是另一朵云」（user 2026-08-25 拍板，ai-docs/20260825-localfile-knight-store-round.md
//   §2 契约纪律 + §3 12 方法映射 + §4 方案 A path-as-id + §5 缓存姿态）：本地文件夹（File System Access
//   目录句柄）实现 CloudProvider，引擎零特判——IDB 本地腿、freshness、If-Match 家规全部照常。
//
// 契约要点（§2，全部已拍板）：
//   · **eTag = `${mtime}-${size}`**；懒仲裁 hash（粗粒度 mtime 平台的可疑差异仲裁）= post-v1 旋钮，永不升格身份。
//   · **eTag 回采**：每个 mutation 返回新 item，mtime 必须在 `writable.close()` **之后**重读
//     （mtime 在 close 时刻才定；提前读=回采旧值=谱系中毒假冲突，2026-06 改名 bug 同族）。
//   · **If-Match 等价物 = 读-比-写**；TOCTOU 毫秒窗 = 已知失败（唯一并发写手=云盘桌面客户端），不掩盖。
//   · **ref = path**（§4 方案 A）：文件 ref=approot 相对路径，改名/移动即换 ref（行李牌语义，types.ts）；
//     文件夹 ref 与文件 ref 同命名空间（ensureFolder/getApprootRef 返回值可当 move/copy 目标），根 = "/"。
//   · **大小写护栏**：路径解析统一**不敏感**口径（Windows/OneDrive 不敏感、Linux 敏感——取最保守交集，
//     与 appfolder 大小写案对齐）；命中即用磁盘上的真实大小写，绝不静默新建同名异案文件。
//   · **move 平台矩阵真机验**：native `handle.move()` 有就用；缺（跨目录不支持的平台）退
//     **copy-先-验-后-删源**（方向永远=先保住字节：目标写完、字节数核对过，才删源）。
//   · 列举 = 目录迭代 + per-file getFile()（本地微秒级）；过滤 desktop.ini/.DS_Store 类 OS 垃圾。
//     `.trash`/`.backup` 等 dot 项**不在本层滤**——上层 isHidden 纪律（listing.ts）是既有唯一滤点，
//     本层照返，listTrash 才能列 `.trash` 内部。
//   · 权限中途过期（NotAllowedError）原样上抛（无 status → push 按可重试处理后 surface）；
//     re-request 只准用户手势，属 app 层，本层绝不弹授权。
//   · 错误形状与 Graph 对齐：`.status` = 404（不在了）/ 409（撞名）/ 412（读-比-写不符），
//     上层（cloud-sync/push/mock 对齐的全部判定）零改动直接工作。
//
// ⚠ 浏览器专用（FSA）；node 测试注入结构化 fake（test/folder-provider.contract.test.ts）。
//   真机矩阵待验项：native move 支持面 / move 后 mtime 是否保留（本实现 move 后重读目标回采，不假设）。

import type { Bytes, CloudItem, CloudProvider, MoveOpts, UploadOpts } from "../types.ts";

// ── 结构化最小句柄面（浏览器 FileSystemDirectoryHandle/FileSystemFileHandle 天然满足；node fake 照此实现）──
//   刻意不用 lib.dom 的 FSA 类型：异步迭代器/move 在 TS dom lib 覆盖不全，且测试要注入 fake。
/** getFile() 的返回（浏览器 = File，本身是 Blob）。 */
export interface FolderFile extends Blob {
  readonly lastModified: number;
}
/** 文件句柄最小面。move 可选（平台矩阵；缺 → copy-验-删源退路）。 */
export interface FolderFileHandle {
  readonly kind: "file";
  readonly name: string;
  getFile(): Promise<FolderFile>;
  createWritable(): Promise<{ write(data: Blob | Uint8Array): Promise<void>; close(): Promise<void> }>;
  /** native move（Chromium：同目录改名 move(name)；跨目录 move(dir, name?) 支持面待真机矩阵）。 */
  move?(...args: unknown[]): Promise<void>;
}
/** 目录句柄最小面。 */
export interface FolderDirHandle {
  readonly kind: "directory";
  readonly name: string;
  getDirectoryHandle(name: string, opts?: { create?: boolean }): Promise<FolderDirHandle>;
  getFileHandle(name: string, opts?: { create?: boolean }): Promise<FolderFileHandle>;
  removeEntry(name: string, opts?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<FolderFileHandle | FolderDirHandle>;
}

// 错误形状对齐 Graph（caller 用 .status 判 404/409/412；见 providers/graph.ts 同款）。
interface StatusError extends Error { status?: number }
function statusError(status: number, message: string): StatusError {
  const e: StatusError = new Error(message);
  e.status = status;
  return e;
}
const isNotFound = (e: unknown): boolean => (e as { name?: string } | null)?.name === "NotFoundError";
// TypeMismatchError = 名字在、但用错了 accessor（getFileHandle 撞上文件夹/反之）——对「按名找条目」而言
//   等价于「这个 accessor 没找到」，落到另一 accessor / 迭代兜底。
const isMismatch = (e: unknown): boolean => (e as { name?: string } | null)?.name === "TypeMismatchError";

// OS 垃圾（云端从不会出现的本地噪音；列举滤掉、判空时视作可清）。
const OS_JUNK = new Set(["desktop.ini", ".ds_store", "thumbs.db"]);
const isJunk = (name: string): boolean => OS_JUNK.has(name.toLowerCase()) || name.toLowerCase().startsWith("~$");

const ROOT_REF = "/";
const eTagOf = (f: { lastModified: number; size: number }): string => `${f.lastModified}-${f.size}`;
const joinPath = (folder: string, name: string): string => (folder && folder !== ROOT_REF ? `${folder}/${name}` : name);
const splitPath = (path: string): { folder: string; base: string } => {
  const i = path.lastIndexOf("/");
  return i < 0 ? { folder: "", base: path } : { folder: path.slice(0, i), base: path.slice(i + 1) };
};

/** 本地文件夹 → CloudProvider（「folder 就是另一朵云」）。root = 用户 picker 授权的目录句柄（approot）。
 *  浏览器专用；auth/权限生命周期（句柄持久化、re-request 手势）归 app 层。 */
export function createFolderProvider(root: FolderDirHandle): CloudProvider {
  if (!root || root.kind !== "directory") throw new Error("createFolderProvider: root 目录句柄必传");

  // ── 大小写不敏感解析（§2 护栏）：先按给定名直取（快路径，命中=大小写全同），miss 再迭代配不敏感。──
  //   命中即用磁盘真实名字继续；不敏感也 miss 才算真不存在。
  async function childByName(dir: FolderDirHandle, name: string): Promise<FolderFileHandle | FolderDirHandle | null> {
    try { return await dir.getFileHandle(name); } catch (e) { if (!isNotFound(e) && !isMismatch(e)) throw e; }
    try { return await dir.getDirectoryHandle(name); } catch (e) { if (!isNotFound(e) && !isMismatch(e)) throw e; }
    const lower = name.toLowerCase();
    for await (const h of dir.values()) if (h.name.toLowerCase() === lower) return h;
    return null;
  }
  /** 逐段解析目录（不建）。missing → null。path=""/"/" → root。 */
  async function resolveDir(path: string): Promise<FolderDirHandle | null> {
    if (!path || path === ROOT_REF) return root;
    let dir: FolderDirHandle = root;
    for (const seg of path.split("/")) {
      const h = await childByName(dir, seg);
      if (!h || h.kind !== "directory") return null;
      dir = h;
    }
    return dir;
  }
  /** 解析任意 ref → 句柄 + 其父目录 + 磁盘真实 path（**逐段**采真实大小写，不只 basename）。missing → null。 */
  async function resolveRef(ref: string): Promise<{ handle: FolderFileHandle | FolderDirHandle; parent: FolderDirHandle; path: string } | null> {
    if (!ref || ref === ROOT_REF) return null;                       // 根不是可操作条目
    const segs = ref.split("/");
    let parent: FolderDirHandle = root;
    const real: string[] = [];
    for (const seg of segs.slice(0, -1)) {
      const h = await childByName(parent, seg);
      if (!h || h.kind !== "directory") return null;
      parent = h;
      real.push(h.name);                                             // 夹段也用磁盘真实大小写
    }
    const handle = await childByName(parent, segs[segs.length - 1]);
    if (!handle) return null;
    real.push(handle.name);
    return { handle, parent, path: real.join("/") };
  }

  async function fileItem(handle: FolderFileHandle, path: string): Promise<CloudItem> {
    const f = await handle.getFile();
    return { ref: path, name: handle.name, path, size: f.size, eTag: eTagOf(f), lastModifiedDateTime: f.lastModified, isFolder: false };
  }
  function dirItem(handle: FolderDirHandle, path: string): CloudItem {
    // 文件夹无 mtime 语义（FSA 拿不到），eTag 恒 "0"——deleteEmptyFolder 的 If-Match best-effort 在本 provider
    //   退化为无操作（判空护栏才是真护栏，与 Graph 版同纪律）。
    return { ref: path, name: handle.name, path, size: 0, eTag: "0", lastModifiedDateTime: 0, isFolder: true };
  }

  /** 读-比-写（If-Match 等价物，§2）：expected 给了就比当前 eTag，不符 → 412。TOCTOU 毫秒窗=已知失败。 */
  async function assertMatch(handle: FolderFileHandle, expected: string | null | undefined, path: string): Promise<void> {
    if (expected == null) return;
    const cur = eTagOf(await handle.getFile());
    if (cur !== expected) throw statusError(412, `folder-provider: eTag mismatch on ${path} (expected ${expected}, found ${cur})`);
  }

  async function writeFile(dir: FolderDirHandle, name: string, blob: Bytes | Blob): Promise<FolderFileHandle> {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();                             // FSA createWritable = 写临时文件、close 原子替换
    await w.write(blob instanceof Blob ? blob : new Blob([blob as BlobPart]));
    await w.close();
    return fh;
  }

  // copy-先-验-后-删源（§2 move 退路；方向=先保住字节）。返回目标句柄。
  async function copyVerify(src: FolderFileHandle, targetDir: FolderDirHandle, newName: string): Promise<FolderFileHandle> {
    const bytes = await src.getFile();
    const dst = await writeFile(targetDir, newName, bytes);
    const check = await dst.getFile();                               // close 之后重读（回采纪律同款）
    if (check.size !== bytes.size) throw new Error(`folder-provider: copy verify failed for ${newName} (${check.size}≠${bytes.size})——源未删，字节保住`);
    return dst;
  }

  async function moveFile(ref: string, targetFolderRef: string, newName: string | null, eTag: string | null | undefined, conflictBehavior: "fail" | "replace" | "rename"): Promise<CloudItem> {
    const r = await resolveRef(ref);
    if (!r || r.handle.kind !== "file") throw statusError(404, `folder-provider: item 不在了: ${ref}`);
    const src = r.handle;
    await assertMatch(src, eTag, r.path);
    const targetDir = await resolveDir(targetFolderRef);
    if (!targetDir) throw statusError(404, `folder-provider: 目标文件夹不在了: ${targetFolderRef}`);
    const base = newName ?? src.name;
    const occupied = await childByName(targetDir, base);
    const samePlace = occupied === src;                              // 同目录只改大小写等原位情形
    if (occupied && !samePlace) {
      if (conflictBehavior === "fail") throw statusError(409, `folder-provider: 目标已有同名: ${joinPath(targetFolderRef, base)}`);
      if (occupied.kind !== "file") throw statusError(409, `folder-provider: 目标同名是文件夹: ${base}`);
      // replace：读-比-写已在上面对源做过；对目标的覆盖属 caller 语义（restore/trash 一律走 fail，engine 不发 move-replace）
      throw statusError(409, `folder-provider: move conflictBehavior=replace 未支持（engine 只发 fail）`);
    }
    const newPath = joinPath(targetFolderRef === ROOT_REF ? "" : targetFolderRef, base);
    // native move 优先（平台矩阵真机验）；任何一步不支持/抛 → copy-验-删源退路。
    if (typeof src.move === "function") {
      try {
        const { folder: srcFolder } = splitPath(r.path);
        const tgtFolder = targetFolderRef === ROOT_REF ? "" : targetFolderRef;
        const sameDir = srcFolder.toLowerCase() === tgtFolder.toLowerCase();
        if (sameDir) await src.move(base);
        else await src.move(targetDir as unknown as object, base);
        const moved = await childByName(targetDir, base);
        if (moved && moved.kind === "file") return fileItem(moved, newPath);   // 回采：move 后重读目标（不假设 mtime 保留）
      } catch { /* native 不支持该形态 → 退路 */ }
    }
    const dst = await copyVerify(src, targetDir, base);
    await r.parent.removeEntry(src.name);                            // 验过才删源（字节先保住）
    return fileItem(dst, newPath);
  }

  return {
    async list(folder = ""): Promise<CloudItem[]> {
      const dir = await resolveDir(folder);
      if (!dir) throw statusError(404, `folder-provider: folder 不存在: ${folder}`);
      const out: CloudItem[] = [];
      for await (const h of dir.values()) {
        if (isJunk(h.name)) continue;                                // OS 垃圾滤掉；dot 项照返（上层 isHidden 滤）
        const p = joinPath(folder, h.name);
        out.push(h.kind === "file" ? await fileItem(h, p) : dirItem(h, p));
      }
      return out;
    },
    async getItemByPath(path: string): Promise<CloudItem | null> {
      const r = await resolveRef(path);
      if (!r) return null;
      return r.handle.kind === "file" ? fileItem(r.handle, r.path) : dirItem(r.handle, r.path);
    },
    async getApprootRef(): Promise<string> { return ROOT_REF; },
    async download(ref: string): Promise<Blob> {
      const r = await resolveRef(ref);
      if (!r || r.handle.kind !== "file") throw statusError(404, `folder-provider: item 不在了: ${ref}`);
      return r.handle.getFile();                                     // File 即 Blob
    },
    async downloadRange(ref: string, offset: number, length: number): Promise<Blob> {
      const r = await resolveRef(ref);
      if (!r || r.handle.kind !== "file") throw statusError(404, `folder-provider: item 不在了: ${ref}`);
      const f = await r.handle.getFile();
      const start = Math.max(0, offset);
      return f.slice(start, Math.min(f.size, start + Math.max(0, length)));   // 白送（§3）；越界自动钳
    },
    async upload(path: string, blob: Bytes | Blob, opts: UploadOpts = {}): Promise<CloudItem> {
      const { eTag = null, conflictBehavior = "replace" } = opts;
      // 与 graph.uploadFileToApproot 同款运行时护栏（If-Match 家规 2026-08-25）：blind overwrite forbidden。
      if (conflictBehavior === "replace" && !eTag) throw new Error(`folder-provider: blind overwrite forbidden: conflictBehavior:"replace" requires If-Match eTag (${path})`);
      if (conflictBehavior === "rename") throw new Error("folder-provider: conflictBehavior=rename 未支持（engine 不发）");
      const { folder, base } = splitPath(path);
      const dir = await resolveDir(folder) ?? await (async () => { throw statusError(404, `folder-provider: folder 不存在: ${folder}`); })();
      const existing = await childByName(dir, base);
      if (existing && existing.kind !== "file") throw statusError(409, `folder-provider: ${path} 是文件夹`);
      if (conflictBehavior === "fail") {
        if (existing) throw statusError(409, `folder-provider: 已存在: ${path}`);   // 探测-创建 TOCTOU=已知失败（§3）
        const fh = await writeFile(dir, base, blob);
        return fileItem(fh, joinPath(folder, base));
      }
      // replace + eTag：读-比-写。目标不存在 + 带 eTag = 谱系断裂（云端那份没了）→ 412 族（让上层走冲突/重推路径）。
      if (!existing) throw statusError(412, `folder-provider: eTag 指的那份不在了: ${path}`);
      await assertMatch(existing as FolderFileHandle, eTag, path);
      const written = await writeFile(dir, existing.name, blob);     // 用磁盘真实名（大小写保持）
      return fileItem(written, joinPath(folder, existing.name));     // 回采：close 之后 getFile 重读 mtime（纪律核心）
    },
    async ensureFolder(path: string): Promise<string> {
      if (!path || path === ROOT_REF) return ROOT_REF;
      let dir: FolderDirHandle = root;
      const realSegs: string[] = [];
      for (const seg of path.split("/")) {
        const hit = await childByName(dir, seg);
        if (hit && hit.kind === "directory") { dir = hit; realSegs.push(hit.name); continue; }   // 大小写命中沿用真实名
        if (hit) throw new Error(`folder-provider: ${seg} 已存在但不是文件夹`);
        dir = await dir.getDirectoryHandle(seg, { create: true });
        realSegs.push(dir.name);
      }
      return realSegs.join("/");
    },
    async delete(ref: string, eTag?: string): Promise<void> {
      const r = await resolveRef(ref);
      if (!r) throw statusError(404, `folder-provider: item 不在了: ${ref}`);
      if (r.handle.kind === "file") await assertMatch(r.handle, eTag ?? null, r.path);   // 硬删 If-Match（v435 同纪律）；文件夹 eTag 无语义跳过
      await r.parent.removeEntry(r.handle.name);
    },
    async deleteEmptyFolder(path: string) {
      let dir: FolderDirHandle | null;
      try { dir = await resolveDir(path); } catch { return { status: "list-failed" as const }; }
      if (!dir || dir === root) return dir ? { status: "non-empty" as const } : { status: "already-gone" as const };   // 根不许删
      const junk: string[] = [];
      try {
        for await (const h of dir.values()) {
          if (h.kind === "file" && isJunk(h.name)) { junk.push(h.name); continue; }   // OS 垃圾不算内容（Windows 自发产生，算=永远删不掉夹）
          return { status: "non-empty" as const };
        }
      } catch { return { status: "list-failed" as const }; }         // 确认不了空 → 拒删（绝不当空放行）
      const { folder, base } = splitPath(path);
      const parent = await resolveDir(folder);
      if (!parent) return { status: "already-gone" as const };
      for (const j of junk) await dir.removeEntry(j);
      const realName = (await childByName(parent, base))?.name ?? base;
      await parent.removeEntry(realName);
      return { status: "deleted" as const };
    },
    move(ref: string, targetFolderRef: string, opts: MoveOpts = {}): Promise<CloudItem> {
      return moveFile(ref, targetFolderRef, opts.newName ?? null, opts.eTag, opts.conflictBehavior ?? "fail");
    },
    async copy(ref: string, targetFolderRef: string, newName: string): Promise<CloudItem> {
      const r = await resolveRef(ref);
      if (!r || r.handle.kind !== "file") throw statusError(404, `folder-provider: item 不在了: ${ref}`);
      const targetDir = await resolveDir(targetFolderRef);
      if (!targetDir) throw statusError(404, `folder-provider: 目标文件夹不在了: ${targetFolderRef}`);
      if (await childByName(targetDir, newName)) throw statusError(409, `folder-provider: 目标已有同名: ${newName}`);   // Graph copy 同名 409 对齐
      const dst = await copyVerify(r.handle, targetDir, newName);    // 源原位不动（O3 语义）
      return fileItem(dst, joinPath(targetFolderRef === ROOT_REF ? "" : targetFolderRef, newName));
    },
    async rename(ref: string, newName: string, eTag?: string | null): Promise<CloudItem> {
      const { folder } = splitPath(ref);
      return moveFile(ref, folder || ROOT_REF, newName, eTag, "fail");
    },
  };
}
