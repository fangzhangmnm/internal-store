// @local/sync-store —— 唯一公开入口（封口）。
//
// ⚠ 接库只准从这里拿 createStore + 一个 provider。**绝不 deep import 内部文件**
//   （cloud-sync / local-head / push / seal / safe-resolve / folder-* / store.ts …）——
//   那些是红线 guts，绕过 = 绕过红线（见 README.md 铁律）。
//   ✅ scripts/build.sh 有真的 deep-import lint 挡着（v415 补——在那之前这句是**谎注释**，只有约定没有守卫）。
//   要用的东西这里没导出 → 说明公开面缺了，补这里的 export（并想清楚该不该暴露），别绕过封口。
/** 创建 store 的唯一入口（薄组合根：provider → 装配深模块 → 暴露 file / collection / files 面）。 */
export { createStore, ReadOnlyFilesError, StoreDisposedError } from "./create-store.ts";
export { CloudNetworkError } from "./errors.ts";   // 网络层失败的类型化封装（app 按 name 换 i18n 人话文案；2026-08-25）
export { CloudStaleRefError } from "./errors.ts";   // 「已被别处动过」错误族（ref 失效 404 收敛；app 提示刷新列表。2026-08-26）
/** 主门牌类型：配置（StoreConfig）、UI bundle（StoreUI）、文件对象（RawFile/ZipFile）、store 本体（Store）、at-rest 密文（EncryptedBlob）。 */
export type { StoreConfig, StoreUI, RawFile, ZipFile, Store, EncryptedBlob, FileStream } from "./create-store.ts";
/** 统一列举面（README §2）的类型：列举项（Item）、8-badge 同步状态（SyncState）、列举上下文（ListContext）。 */
export type { Item, SyncState, ListContext } from "./listing.ts";
/** syncState 便利判定：isCached（有本地副本）/ isDirty（有未推本地编辑）。 */
export { isCached, isDirty } from "./listing.ts";
/** 字节别名（host adapter 的类型用；不暴露内部文件路径）。 */
export type { Bytes } from "./types.ts";

export type { StoreTextKey, StoreTextFn, StoreTextParams } from "./ui-text.ts";   // busy 文案接缝（宿主写 StoreUI.text 需要可命名）
// 加密：**裸字节**级的面走 store.encryption（有 name 的场景走 file.*）；EncryptedBlob 是 at-rest 密文的 branded 类型。
/** collection 面的类型：Collection 接口、对外 entry（CollectionEntry）、reconcile 终态（ReconcileResult）。 */
export type { Collection, CollectionEntry, ReconcileResult } from "./collection.ts";
/** 本地缓存 adapter 工厂（host 装配 createStore 时注入 local 用；prod=idb）。 */
export { createLocalCache } from "./local-cache.ts";

// provider（云端低层 adapter）：OneDrive（浏览器）/ graph 适配器（可 mock 验）。
/** config 驱动的完整 OneDrive CloudProvider 工厂（MSAL + Graph + 适配器）。 */
export { createOneDriveProvider } from "./providers/index.ts";
/** OneDrive auth 状态（initAuth / getAuthState 返回的形状）。 */
export type { AuthState } from "./providers/auth.ts";   // .h 生成需要可命名（TS4023）；公开面缺了就补这里
/** 把 Graph transport 翻成库的 CloudProvider 的适配器。 */
export { graphToCloudProvider } from "./onedrive-provider.ts";
//   注：迁移（migration）不暴露——createStore 内部自跑（数据搬迁是同步细节，app 不该看见）。
//   预设架走 store.collection、gallery 缩略图/文件夹走 file.getPeek / store.list——不再 deep import
//   cloud-sync/folder-store/graph（接口尽可能瘦，见 ADR：迁移的意义=发现最少接口）。
/** 云端传输契约与条目形状 + 本地缓存契约与 trash 条目（类型化装配/自写 provider·adapter 用）。 */
export type { CloudProvider, CloudItem, LocalCache, TrashEntry } from "./types.ts";
/** MSAL account 句柄（未类型化透传）。 */
export type { Account } from "./providers/auth.ts";
/** collection 批量变更回调签名（onChange 全量档）。 */
export type { ChangeCb } from "./collection.ts";
/** 文件/回收站/删除/刷新各面的收发形状（Result/Opts 类型群）。 */
export type { TryMoveResult, SaveResult } from "./create-store.ts";
export type { TrashResult, RestoreOpts, PurgeOpts, EmptyTrashOpts } from "./trash.ts";
export type { RefreshOpts, FreshResult } from "./freshness.ts";
export type { DelResult } from "./delete.ts";
export type { FolderSnapshot } from "./listing.ts";
export type { FolderDeleteResult, UploadOpts, MoveOpts, Kv } from "./types.ts";
export type { UploadReplayPolicy } from "./upload-queue.ts";
/** staging 覆盖快照（file.stagingCoverage 返回；A5 透明面——徽章三态/离线起播护栏/离线接曲决策）。 */
export type { StagingCoverage } from "./download-session.ts";
/** staging 分区注入契约（StoreConfig.staging；prod 默认 blob-partition 的 staging 分区，测试注内存替身）。 */
export type { StagingStore } from "./download-session.ts";
export type { ResolveChoice } from "./safe-resolve.ts";
export type { StoreErrorLevel } from "./error-handling.ts";
/** 加密 codec 注入契约 + collection 配置 + 回收站聚合条目。 */
export type { CryptoCodec } from "./crypto-container.ts";
export type { CollectionConfig } from "./collection.ts";
export type { TrashItem } from "./trash-merge.ts";
/** OneDrive provider 面：工厂配置 + auth 契约 + Graph transport 形状。 */
export type { OneDriveAuth, OneDriveConfig } from "./providers/index.ts";
export type { GraphTransport, RawGraphItem } from "./onedrive-provider.ts";
/** 深模块透传形状：busy 包装、采纳验真回调、collection seed 条目。 */
export type { Busy, CloudSync, FetchMetaResult, PullResult, PushResult, WeakOverrideResult } from "./types.ts";
export type { AdoptFn } from "./types.ts";
export type { CollectionInitItem } from "./collection.ts";
