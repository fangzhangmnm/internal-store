// @local/sync-store —— 唯一公开入口（封口）。
//
// ⚠ 接库只准从这里拿 createStore + 一个 provider。**绝不 deep import 内部文件**
//   （cloud-sync / local-head / push / seal / safe-resolve / folder-* / store.ts …）——
//   那些是红线 guts，绕过 = 绕过红线（见 README.md 铁律）。
//   ✅ scripts/build.sh 有真的 deep-import lint 挡着（v415 补——在那之前这句是**谎注释**，只有约定没有守卫）。
//   要用的东西这里没导出 → 说明公开面缺了，补这里的 export（并想清楚该不该暴露），别绕过封口。
/** 创建 store 的唯一入口（薄组合根：provider → 装配深模块 → 暴露 file / collection / files 面）。 */
export { createStore, ReadOnlyFilesError, StoreDisposedError } from "./create-store.ts";
// persist 三件套（user 2026-08-27 拍板，全案 = persistence.ts 头注释）：执行体只准在用户手势时刻调；
//   感知面走 store.files.persistence()；StoreConfig.persistence 必填表态。库永不自动调 persist()。
export { requestStoragePersistence, queryStoragePersistence } from "./base/persistence.ts";
export { wipeAppNamespace, scanAppNamespace, WipeConsentError } from "./works/maintenance.ts";
export type { WipeReport, NamespaceScanReport } from "./works/maintenance.ts";
export type { PersistenceState, StorageManagerLike } from "./base/persistence.ts";
export { CloudNetworkError } from "./base/errors.ts";   // 网络层失败的类型化封装（app 按 name 换 i18n 人话文案；2026-08-25）
export { CloudStaleRefError } from "./base/errors.ts";   // 「已被别处动过」错误族（ref 失效 404 收敛；app 提示刷新列表。2026-08-26）
/** 主门牌类型：配置（StoreConfig）、UI bundle（StoreUI）、文件对象（RawFile/ZipFile）、store 本体（Store）、at-rest 密文（EncryptedBlob）。 */
export type { StoreConfig, StoreUI, RawFile, ZipFile, Store, EncryptedBlob, FileStream } from "./create-store.ts";
/** 统一列举面（README §2）的类型：列举项（Item）、8-badge 同步状态（SyncState）、列举上下文（ListContext）。 */
export type { Item, SyncState, ListContext } from "./works/listing.ts";
export type { LocalSaveReceipt } from "./base/types.ts";   // A4 守护写回执（guard="user-save" 撞版 surface）
/** syncState 便利判定：isCached（有本地副本）/ isDirty（有未推本地编辑）。 */
export { isCached, isDirty } from "./works/listing.ts";
/** 字节别名（host adapter 的类型用；不暴露内部文件路径）。 */
export type { Bytes } from "./base/types.ts";
export type { ByteSource } from "./base/types.ts";   // 0.17.0 files.uploadStream 的字节来源（宿主实现）

export type { AuthChangeReason, ProviderAuthEvent } from "./base/types.ts";   // 0.12.0 户口收口：0.11.6 漏出的 forgotten-export
export type { StoreTextKey, StoreTextFn, StoreTextParams } from "./base/ui-text.ts";   // busy 文案接缝（宿主写 StoreUI.text 需要可命名）
// 加密：**裸字节**级的面走 store.encryption（有 name 的场景走 file.*）；EncryptedBlob 是 at-rest 密文的 branded 类型。
/** collection 面的类型：Collection 接口、对外 entry（CollectionEntry）、reconcile 终态（ReconcileResult）。 */
export type { Collection, CollectionEntry, ReconcileResult } from "./works/collection.ts";
/** 本地缓存 adapter 工厂（host 装配 createStore 时注入 local 用；prod=idb）。 */
export { createLocalCache } from "./base/local-cache.ts";

// provider（云端低层 adapter）：OneDrive（浏览器）/ graph 适配器（可 mock 验）。
/** config 驱动的完整 OneDrive CloudProvider 工厂（MSAL + Graph + 适配器）。 */
export { createOneDriveProvider } from "./base/providers/index.ts";
export { DEFAULT_GRAPH_TIMEOUTS, type GraphTimeouts, type GraphTransportOptions } from "./base/providers/graph.ts";   // 0.17.2：传输层行为开关（默认关）
// folder provider（2026-08-25 拍板「folder 就是另一朵云」；2026-08-26 落地）：本地文件夹句柄 → CloudProvider，
//   引擎零特判。句柄类型 = 结构化最小面（浏览器 FileSystemDirectoryHandle 天然满足；见 providers/folder.ts 头注释）。
export { createFolderProvider } from "./base/providers/folder.ts";
export type { FolderDirHandle, FolderFileHandle, FolderFile } from "./base/providers/folder.ts";
/** OneDrive auth 状态（initAuth / getAuthState 返回的形状）。 */
export type { AuthState } from "./base/providers/auth.ts";   // .h 生成需要可命名（TS4023）；公开面缺了就补这里
/** 把 Graph transport 翻成库的 CloudProvider 的适配器。 */
export { graphToCloudProvider } from "./base/onedrive-provider.ts";
//   注：迁移（migration）不暴露——createStore 内部自跑（数据搬迁是同步细节，app 不该看见）。
//   预设架走 store.collection、gallery 缩略图/文件夹走 file.getPeek / store.list——不再 deep import
//   cloud-sync/folder-store/graph（接口尽可能瘦，见 ADR：迁移的意义=发现最少接口）。
/** 云端传输契约与条目形状 + 本地缓存契约与 trash 条目（类型化装配/自写 provider·adapter 用）。 */
export type { CloudProvider, CloudItem, LocalCache, TrashEntry } from "./base/types.ts";
/** MSAL account 句柄（未类型化透传）。 */
export type { Account } from "./base/providers/auth.ts";
/** collection 批量变更回调签名（onChange 全量档）。 */
export type { ChangeCb } from "./works/collection.ts";
/** 文件/回收站/删除/刷新各面的收发形状（Result/Opts 类型群）。 */
export type { TryMoveResult, SaveResult, ResolveOutcome, CloudState } from "./create-store.ts";
export type { TrashResult, RestoreOpts, PurgeOpts, EmptyTrashOpts } from "./works/trash.ts";
export type { RefreshOpts, FreshResult } from "./works/freshness.ts";
export type { TrashOutcome } from "./works/delete.ts";
export type { FolderSnapshot, WatchFolderErrorPhase } from "./works/listing.ts";   // 0.11.1：watchFolder opts.onError 的 phase
export type { FolderDeleteResult, UploadOpts, MoveOpts, Kv } from "./base/types.ts";
export type { UploadReplayPolicy } from "./works/upload-queue.ts";
/** staging 覆盖快照（file.stagingCoverage 返回；A5 透明面——徽章三态/离线起播护栏/离线接曲决策）。 */
export type { StagingCoverage } from "./stream/download-session.ts";
/** staging 分区注入契约（StoreConfig.staging；prod 默认 blob-partition 的 staging 分区，测试注内存替身）。 */
export type { StagingStore } from "./stream/download-session.ts";
// 2.0.0 流式面开关（createStore({ streaming })，默认关 = 0.18）：车道 / 卡住判定 / 镜像；FileStream.status() 的形状；镜像契约。
export type { StreamingOptions, StreamStatus, SchedulerStatus, MirrorSource, MirrorHandle, MirrorState, RangeOpts } from "./stream/download-session.ts";
export { StreamStallError } from "./stream/download-session.ts";   // 投机的一片卡住又没别的来源 → prefetch 以它 reject（预取方按 name 辨认）
/** 镜像（替代来源）两个现成实现：这台设备上的文件（File API）/ 任何支持 Range 的 HTTP 主机（局域网 / Tailscale）。身份仍归云端 item，字节抽样和云端比。 */
export { createFileMirror, createHttpMirror, type HttpMirrorOptions } from "./stream/mirror.ts";
export type { ResolveChoice } from "./works/safe-resolve.ts";
export type { StoreErrorLevel } from "./base/error-handling.ts";
/** 加密 codec 注入契约 + collection 配置 + 回收站聚合条目。 */
export type { EncryptionPort } from "./create-store.ts";   // 加密端口（@internal/encryption 实例喂进 config.encryption）
export type { CollectionConfig } from "./works/collection.ts";
export type { TrashItem } from "./works/trash-merge.ts";
export type { DocKind, DocIdentifier, DocTier, Identifiers } from "./base/identifiers.ts";   // 0.16.0：身份的语法（docKinds 表）；2.1.0 DocTier 公民等级
export { createIdentifiers, withStemTail, validateDocKinds } from "./base/identifiers.ts";   // 0.16.1：createIdentifiers 也出门牌——宿主的纯代码 / gallery 的测试可以不经 store 实例用同一套切名逻辑
/** OneDrive provider 面：工厂配置 + auth 契约 + Graph transport 形状。 */
export type { OneDriveAuth, OneDriveConfig } from "./base/providers/index.ts";
export type { GraphTransport, RawGraphItem } from "./base/onedrive-provider.ts";
/** 深模块透传形状：busy 包装、采纳验真回调、collection seed 条目。 */
export type { Busy, CloudSync, FetchMetaResult, PullResult, PushResult, WeakOverrideResult } from "./base/types.ts";
export type { AdoptFn } from "./base/types.ts";
export type { CollectionInitItem } from "./works/collection.ts";
