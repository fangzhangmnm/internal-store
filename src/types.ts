// store 深模块的共享类型契约（v223 TS 化）。被 Uint8Array/Blob 类型 bug 雷击两次 →
// 把跨文件的形状收到这一个文件，tsc strict 检查（esbuild 只 strip 不查）。
// 设计原则：把「字节边界」写死——谁吃 Bytes、谁吃/出 Blob，一眼可辨、错配即编译错。

import type { Bytes } from "./substrate.ts";
/** 落盘/上传的字节正规形态（= Uint8Array）；toU8 把任意来源收敛到它。 */
export type { Bytes } from "./substrate.ts";

// ---- 注入端口 ----
/** localStorage / IDB / 内存 都能实现的极简 KV（store 不直碰 localStorage，红线 #7）。 */
export interface Kv {
  /** 读键；缺 → null。 */
  get(k: string): string | null;
  /** 写键。 */
  set(k: string, v: string): void;
  /** 删键。 */
  remove(k: string): void;
}

// ---- 云端低层（CloudProvider）：list/get/download/upload/delete/ensureFolder/move/rename ----
/** 一个云端文件/文件夹的元信息（provider 各方法返回的统一形状）。 */
export interface CloudItem {
  /** 云端 item id。 */
  id: string;
  /** 文件名。 */
  name: string;
  /** 云端路径。 */
  path: string;
  /** 字节大小。 */
  size: number;
  /** 版本 etag。 */
  eTag: string;
  /** 最后修改时间。 */
  lastModifiedDateTime: string | number;
  /** 是否文件夹。 */
  isFolder?: boolean;
  /** 内容 MIME 类型。 */
  contentType?: string;
  /** 下载 URL。 */
  downloadUrl?: string;
  /** Graph 直传的下载 URL 字段（peek byte-range 用）。 */
  "@microsoft.graph.downloadUrl"?: string;
}

/** provider.upload 的选项。 */
export interface UploadOpts {
  /** 内容 MIME 类型。 */
  contentType?: string;
  /** If-Match etag。 */
  eTag?: string | null;
  /** 撞名行为。 */
  conflictBehavior?: "fail" | "replace" | "rename";
}
/** provider.move 的选项。 */
export interface MoveOpts {
  /** 移动同时改名。 */
  newName?: string | null;
  /** If-Match etag。 */
  eTag?: string | null;
  /** 撞名行为。 */
  conflictBehavior?: "fail" | "replace" | "rename";
}

// 删空夹的判别式结果。**backend 侧唯一的文件夹删除面**——递归/无条件的 delete(id) 不暴露给上层删文件夹，
//   护栏（只删空夹）由 provider 保证。四态让上层区分：deleted/already-gone=终态成功；non-empty=有内容（drain 取消、
//   online 拒删）；list-failed=列举失败确认不了空（drain 留队 defer、online 拒删）。绝不 throw 非空/列举失败（用 status 表达）。
/** 删空夹的判别式结果（backend 侧唯一的文件夹删除面；绝不 throw 非空/列举失败，用 status 表达）。 */
export interface FolderDeleteResult {
  /** 四态：deleted/already-gone=终态成功；non-empty=有内容；list-failed=列举失败确认不了空。 */
  status: "deleted" | "already-gone" | "non-empty" | "list-failed"
}

/** 低层云端传输契约。生产用 OneDriveProvider（包 Graph），测试用 MockProvider。 */
export interface CloudProvider {
  /** 列举文件夹的子项。 */
  list(folder?: string): Promise<CloudItem[]>;
  /** 按路径取 item；缺 → null。 */
  getItemByPath(path: string): Promise<CloudItem | null>;
  /** 取 approot 文件夹 id。 */
  getApprootId(): Promise<string>;
  /** 下载文件内容。 */
  download(id: string): Promise<Blob>;
  /** byte-range 下载。 */
  downloadRange(id: string, offset: number, length: number): Promise<Uint8Array | ArrayBuffer | Blob>;
  /** 上传文件字节。 */
  upload(path: string, blob: Bytes | Blob, opts?: UploadOpts): Promise<CloudItem>;
  /** 确保文件夹存在。 */
  ensureFolder(path: string): Promise<string>;
  /** 文件硬删（trash purge）。eTag=If-Match（硬删不可逆，必带）。**文件夹删除不走它**——走 deleteEmptyFolder（护栏在 provider）。 */
  delete(id: string, eTag?: string): Promise<void>;
  /** 删**空**文件夹（唯一文件夹删除面）：provider 内部证实空才删（Graph 无 native「删空夹」→ list-then-delete，带 If-Match folder etag best-effort）。 */
  deleteEmptyFolder(path: string): Promise<FolderDeleteResult>;
  /** 移动到目标文件夹。 */
  move(id: string, targetFolderId: string, opts?: MoveOpts): Promise<CloudItem>;
  /** 改名。 */
  rename(id: string, newName: string, eTag?: string | null): Promise<CloudItem>;
}

// ---- 本地持久层（LocalCache）：store.local 契约（**内容无关**，存任意 binary blob）----
// **字节边界关键点**（0B bug 雷区）：save 可收 Bytes 或 Blob（store 流经 toU8 给的是 Bytes），
//   但内部必须落 Blob（size/上传/读取都按 Blob 算）；get 出 Blob。类型在此写死，错配即编译错。
/** 本地 trash/backup 列举的一项（trashKey + 原名）。 */
export interface TrashEntry {
  /** 本地回收站键（restore/purgeTrash 用）。 */
  trashKey: string;
  /** 原名。 */
  name: string;
}
/** 本地持久层（store.local 契约）：**内容无关**，存任意 binary blob。 */
export interface LocalCache {
  /** hint：save 透传的 app 旁路（store 不解释、不看内容；app 可经 hint.peek 供不透明 sidecar 字节）。 */
  save(name: string, bytes: Bytes | Blob, hint?: unknown): Promise<unknown>;
  /** 读缓存 blob；缺 → null。 */
  get(name: string): Promise<Blob | null>;
  /** 是否已缓存。 */
  exists(name: string): Promise<boolean>;
  /** 已缓存的**应用文件名**集合（排除 trash/backup/collection 内部命名空间）——gallery 批量判 cached 用。 */
  appKeys(): Promise<string[]>;
  /** 轻量元信息（size + updatedAt），不取 blob 内容。listing 给本地项填尺寸/时间（离线/云端帧到达前也不显 0B/1970）。缺 → null。 */
  stat(name: string): Promise<{ size: number; updatedAt: number } | null>;
  /** 本地已缓存文件的总占用（字节 + 件数）。单事务 cursor，不载字节内容。
   *  ⚠ **只返标量，永不返名字** —— 这是刻意的：全库列举是被否决的退化设计（列举只走 per-folder watchFolder）。 */
  usage(): Promise<{ bytes: number; count: number }>;
  /** 复制一份备份（原件留着；pull 前的安全网），返备份名。 */
  backup(name: string): Promise<string>;
  /** 移进本地 .trash。deleteEventId 由 delete.ts 生成、与云端腿**共用**（trash-merge 据此精确配对）。返 trashKey。 */
  trash(name: string, deleteEventId: string): Promise<string>;
  /** 真删（仅用于「云端已进 trash、不留双份」的本地侧）。 */
  hardDelete(name: string): Promise<void>;
  /** 从本地 trash 恢复。 */
  restore(trashKey: string): Promise<string>;
  /** 彻底删一条本地 trash。 */
  purgeTrash?(trashKey: string): Promise<void>;
  /** 本地 trash 列举。 */
  listTrash?(): Promise<TrashEntry[]>;
  /** 备份分区列举（weakOverride/keepMine loser 的本地 stash）——回收站/备份视图两端聚合用。restore/purgeTrash 已认 `backup/` 前缀 key。 */
  listBackup?(): Promise<TrashEntry[]>;
}

// ---- cloud-sync（session 级同步 over CloudProvider）：Store 消费的「cloud 后端」 ----
/** pull 的结果：拉到的字节 + 权威 item（H7：分片末响应无 item 时拉权威 etag）+ 建议落地名（撞名 caller 用）。 */
export interface PullResult {
  /** 拉到的字节。 */
  blob: Blob;
  /** 权威 item。 */
  item: CloudItem | null;
  /** 建议落地名（撞名时 caller 用）。 */
  suggestedName: string;
}
/** push 的结果。 */
export interface PushResult {
  /** 上传后的云端 item。 */
  item: CloudItem | null;
}
/** fetchMeta 的结果：只轻量元信息（store open/refresh 比对 etag 用），不下载内容。 */
export interface FetchMetaResult {
  /** 云端当前 etag。 */
  etag: string;
  /** 最后修改时间。 */
  lastModified: string | number;
  /** 字节大小。 */
  size: number;
  /** 完整云端 item。 */
  item: CloudItem;
}
/** 弱覆盖（冲突解决 weak-override 分支）的结果：覆盖云端 + 留底。 */
export interface WeakOverrideResult {
  /** 覆盖后的新云端 item。 */
  item: CloudItem | null;
  /** 留底的备份名。 */
  backedUp: string | null;
}
// push 收 Bytes|Blob（store 传 toU8 后的 Bytes，folder-flow 传 encode 出的 Blob；内部交 provider.upload）。
/** cloud-sync 暴露给 store/app 的面（dirty/etag 状态 + push/pull/list/trash 等）。 */
export interface CloudSync {
  /** 推字节上云。opts.encrypted：字节是加密容器（ADR-0012）→ 落 encFileName（.zip）路径；未配 encFileName 时忽略。 */
  push(name: string, bytes: Bytes | Blob, opts?: { baseEtag?: string | null; encrypted?: boolean }): Promise<PushResult>;
  /** 拉整份内容（字节 + 权威 item + 建议落地名）；无此件 → null。 */
  pull(name: string): Promise<PullResult | null>;
  /** 只取轻量元信息（比对 etag 用），不下载内容。 */
  fetchMeta(name: string): Promise<FetchMetaResult | null>;
  /** 尾部 byte-range 纯读（peek 预览纯云端文件用；store.getTailBytes 的云端腿）。 */
  pullTail(name: string, n: number): Promise<{ bytes: Bytes; item: CloudItem } | null>;
  /** 任意绝对偏移 byte-range 纯读（getPeek 的「CD / entry 溢出尾片时二次拉」用）。越界自动钳。 */
  pullRange(name: string, offset: number, length: number): Promise<{ bytes: Bytes; item: CloudItem } | null>;
  /** 弱覆盖：覆盖云端 + 留底。 */
  weakOverride(name: string, bytes: Bytes, opts?: { encrypted?: boolean }): Promise<WeakOverrideResult>;
  /** 移进云端 .trash。deleteEventId 同上——两条腿必须是同一个，否则回收站里一次删除会裂成两行/误配。 */
  trash(name: string, deleteEventId: string, opts?: { baseEtag?: string | null }): Promise<unknown>;
  /** enc.encrypted：trash 里的字节是加密容器（.zip 尾）→ 恢复必须落 encFileName（否则加密件被恢复到明文路径 = 打不开）。 */
  restore(cloudItemId: string, name: string, opts?: { encrypted?: boolean; eTag?: string | null }): Promise<unknown>;
  /** 彻底删一条云端 trash。 */
  purge(cloudItemId: string, eTag?: string | null): Promise<unknown>;
  /** 列举云端文件。 */
  list(): Promise<CloudItem[]>;
  /** 全树列举；complete=false → 列表不完整、不权威（partial 守卫：绝不据此判 cloud-gone）。 */
  listAll(): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }>;
  /** 单夹列举（非递归，一次 provider.list 往返）——watchFolder / per-folder reconcile 用。
   *  files/folders = 该夹**直属**子项（folders=immediate 子夹全路径）。complete=false → 这一夹 list() 抛错
   *  （离线/未登录/子树失败）→ 调用方当「该夹不权威」处理，**绝不据此判 cloud-gone**（与 listAll 的 partial 守卫同纪律）。 */
  listFolder(path: string): Promise<{ files: CloudItem[]; folders: string[]; complete: boolean }>;
  /** 列举全部云端文件夹路径。 */
  listFolders(): Promise<string[]>;
  /** 列举云端 .trash。 */
  listTrash(): Promise<CloudItem[]>;
  /** 列举云端备份分区。 */
  listBackup(): Promise<CloudItem[]>;
  /** 云端改名。 */
  rename(oldName: string, newName: string, opts?: { baseEtag?: string | null }): Promise<unknown>;
  /** 确保云端文件夹存在。 */
  ensureFolder(path: string): Promise<void>;
  /** 薄委托 provider.deleteEmptyFolder（护栏在 backend）。 */
  deleteEmptyFolder(path: string): Promise<FolderDeleteResult>;
  /** 该名的 dirty 标志。 */
  isDirty(name: string): boolean;
  /** 置/清该名的 dirty 标志。 */
  setDirty(name: string, dirty: boolean): void;
  /** 读记录的 etag；无 → null。 */
  getETag(name: string): string | null;
  /** 写记录的 etag。 */
  setETag(name: string, etag: string | null): void;
  /** 清该名的同步状态（dirty/etag）。 */
  clearState(name: string): void;
}

// ---- busy 注入（UI 锁；契约详见 store.ts createStore JSDoc）----
export type BusyFn = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

/** busy 遮罩包装的函数形状（= StoreUI.busy；深模块 opts 里透传用）。 */
export type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

/** 采纳验真回调（云字节覆盖本地前验明文；= StoreConfig.validateAdopt 的函数形状）。 */
export type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;
