/** MSAL account 句柄（未类型化透传；导出仅为门牌可命名）。 */
export declare type Account = any;

/** 采纳验真回调（云字节覆盖本地前验明文；= StoreConfig.validateAdopt 的函数形状）。 */
export declare type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;

/** initAuth / getAuthState 返回的 auth 状态。 */
export declare interface AuthState {
    /** 是否已登录（单一源 activeAccount 的派生读）。 */
    signedIn: boolean;
    /** 当前 MSAL account（未登录 = null）。 */
    account: Account;
    /** clientId 未配置（占位符）→ 纯离线，不 load MSAL。 */
    notConfigured?: boolean;
    /** 后台 silent token 探测进行中（探测不阻塞 init）。 */
    probing?: boolean;
    /** 正在探测的缓存 account。 */
    probedAccount?: Account;
}

/** busy 遮罩包装的函数形状（= StoreUI.busy；深模块 opts 里透传用）。 */
export declare type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;

/** 落盘/上传的字节正规形态。toU8 把任意来源收敛到它。 */
export declare type Bytes = Uint8Array;

/** 整库 onChange 回调（收本批变更的 id 列表）。 */
export declare type ChangeCb = (changedIds: string[]) => void;

/** 一个云端文件/文件夹的元信息（provider 各方法返回的统一形状）。 */
export declare interface CloudItem {
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

/** 低层云端传输契约。生产用 OneDriveProvider（包 Graph），测试用 MockProvider。 */
export declare interface CloudProvider {
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

/** cloud-sync 暴露给 store/app 的面（dirty/etag 状态 + push/pull/list/trash 等）。 */
export declare interface CloudSync {
    /** 推字节上云。opts.encrypted：字节是加密容器（ADR-0012）→ 落 encFileName（.zip）路径；未配 encFileName 时忽略。 */
    push(name: string, bytes: Bytes | Blob, opts?: {
        baseEtag?: string | null;
        encrypted?: boolean;
    }): Promise<PushResult>;
    /** 拉整份内容（字节 + 权威 item + 建议落地名）；无此件 → null。 */
    pull(name: string): Promise<PullResult | null>;
    /** 只取轻量元信息（比对 etag 用），不下载内容。 */
    fetchMeta(name: string): Promise<FetchMetaResult | null>;
    /** 尾部 byte-range 纯读（peek 预览纯云端文件用；store.getTailBytes 的云端腿）。 */
    pullTail(name: string, n: number): Promise<{
        bytes: Bytes;
        item: CloudItem;
    } | null>;
    /** 任意绝对偏移 byte-range 纯读（getPeek 的「CD / entry 溢出尾片时二次拉」用）。越界自动钳。 */
    pullRange(name: string, offset: number, length: number): Promise<{
        bytes: Bytes;
        item: CloudItem;
    } | null>;
    /** 弱覆盖：覆盖云端 + 留底。 */
    weakOverride(name: string, bytes: Bytes, opts?: {
        encrypted?: boolean;
    }): Promise<WeakOverrideResult>;
    /** 移进云端 .trash。deleteEventId 同上——两条腿必须是同一个，否则回收站里一次删除会裂成两行/误配。 */
    trash(name: string, deleteEventId: string, opts?: {
        baseEtag?: string | null;
    }): Promise<unknown>;
    /** enc.encrypted：trash 里的字节是加密容器（.zip 尾）→ 恢复必须落 encFileName（否则加密件被恢复到明文路径 = 打不开）。 */
    restore(cloudItemId: string, name: string, opts?: {
        encrypted?: boolean;
        eTag?: string | null;
    }): Promise<unknown>;
    /** 彻底删一条云端 trash。 */
    purge(cloudItemId: string, eTag?: string | null): Promise<unknown>;
    /** 列举云端文件。 */
    list(): Promise<CloudItem[]>;
    /** 全树列举；complete=false → 列表不完整、不权威（partial 守卫：绝不据此判 cloud-gone）。 */
    listAll(): Promise<{
        files: CloudItem[];
        folders: string[];
        complete: boolean;
    }>;
    /** 单夹列举（非递归，一次 provider.list 往返）——watchFolder / per-folder reconcile 用。
     *  files/folders = 该夹**直属**子项（folders=immediate 子夹全路径）。complete=false → 这一夹 list() 抛错
     *  （离线/未登录/子树失败）→ 调用方当「该夹不权威」处理，**绝不据此判 cloud-gone**（与 listAll 的 partial 守卫同纪律）。 */
    listFolder(path: string): Promise<{
        files: CloudItem[];
        folders: string[];
        complete: boolean;
    }>;
    /** 列举全部云端文件夹路径。 */
    listFolders(): Promise<string[]>;
    /** 列举云端 .trash。 */
    listTrash(): Promise<CloudItem[]>;
    /** 列举云端备份分区。 */
    listBackup(): Promise<CloudItem[]>;
    /** 云端改名。 */
    rename(oldName: string, newName: string, opts?: {
        baseEtag?: string | null;
    }): Promise<unknown>;
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

/** Collection —— 一份同步 JSON 装多个**原子** item 的 KV 面（信封 id + uat + value，per-item uat-LWW；
 *  删除 = null 墓碑）。读写 = 同步内存；经 store.collection(name) 拿。 */
export declare interface Collection {
    /** 先 hydrate 本地（快）→ 后台 reconcile 云端（不 await）+ 新库 seed。 */
    init(): Promise<void>;
    /** 事件驱动重拉 + resolve。**读 status**：unchanged/synced/offline/invalid/dirty/error（别只 await 就报成功）。 */
    reconcileWithRemote(): Promise<ReconcileResult>;
    /** 同步写内存 + 防抖持久化（init 前抛错；value===undefined 报错）。 */
    setItem(id: string, value: unknown): void;
    /** ≡ setItem(id, null)：null 墓碑，LWW。 */
    deleteItem(id: string): void;
    /** 同步读 value（无值 / 墓碑 → default）。 */
    getItem<V = unknown>(id: string, def?: V | (() => V)): V | undefined;
    /** 带 uat 的完整 entry（墓碑 → undefined）。 */
    getEntry(id: string): CollectionEntry | undefined;
    /** 全部 entry（过滤墓碑）。 */
    entries(): CollectionEntry[];
    /** 全部 id（过滤墓碑）。 */
    keys(): string[];
    /** 整库：**任何**值变（本地 setItem 同步 fire / 云端 reconcile）→ 通知 changedIds（返退订）。 */
    onChange(cb: ChangeCb): () => void;
    /** 单 key：绑某个 key，其值变→通知（返退订）。 */
    onChange(id: string, cb: () => void): () => void;
    /** 立即写本地缓存（卸载兜底）。**ok=false 表示本地都没写进去**（配额/IDB 拒绝）——别忽略。 */
    flushLocal(): Promise<{
        ok: boolean;
        error?: unknown;
    }>;
    /** 云推脏标。 */
    isDirty(): boolean;
}

/** Collection 的配置（cloud + name 必传）。 */
export declare interface CollectionConfig {
    /** 云同步面。 */
    cloud: CloudSync;
    /** 同步键 = 云端文件名（如 "synced-user-preference.json"）。 */
    name: string;
    /** 在线判定注入。 */
    isOnline?: () => boolean;
    /** 编辑后防抖自动同步（collection 无冲突、union 安全，频繁推也行）。 */
    syncDelayMs?: number;
    /** uat 盖戳（默认 Date.now；测试可注入确定时钟）。 */
    now?: () => number;
    /** true=setItem/delete 只标脏不自动调度云推，由 reconcileWithRemote 驱动 commit。 */
    manual?: boolean;
    /** 本地缓存（IDB）：透明缓存内存 env → 离线可读 + 强杀存活 + 旧设备旧缓存靠 uat-LWW 不盖新。不传 = 纯内存+云。 */
    local?: Pick<LocalCache, "save" | "get" | "exists">;
    /** 本地写防抖（coalesce 高频 setItem，避免每帧写 IDB）。默认 400。 */
    localWriteDelayMs?: number;
    /** local-only 变体：永不碰云（init 只 hydrate、setItem 只写本地、reconcileWithRemote no-op）。 */
    cloudless?: boolean;
    /** 仅当这份 collection 的 json **不存在**时调（填初始值，uat=1）。store 内容无关：app 域构造 id+value 数组。 */
    getInitData?: () => CollectionInitItem[] | Promise<CollectionInitItem[]>;
}

/** 对外 entry：id + uat（只读盖戳）+ value（任意 JSON）。 */
export declare interface CollectionEntry {
    /** item id。 */
    id: string;
    /** 更新时间戳（内部盖戳，只读）。 */
    uat: number;
    /** 任意 JSON 值。 */
    value: unknown;
}

/** getInitData 的初始项：id + value（value 不可为 undefined）。 */
export declare interface CollectionInitItem {
    /** item id。 */
    id: string;
    /** 初始值（不可为 undefined）。 */
    value: unknown;
}

/** LocalCache 工厂（prod=IDB）：files/trash/backup 三分区的本地持久层，内容无关、只存不透明 blob。
 *  dbName 必须已带命名空间（createStore 传 `${appId}.${databaseId}`）——同 origin 兄弟 PWA /
 *  多 store 实例隔离，见 idb-store.ts 头注释。 */
export declare function createLocalCache(dbName: string): LocalCache;

/** config 驱动的完整 OneDrive CloudProvider（MSAL + Graph + 适配器）。**浏览器专属**；auth 流程只能真机验。
 *
 * 用法（app 传的就这些：clientId + 浏览器相关 msalUrl）：
 * ```ts
 *  const { provider, auth } = createOneDriveProvider({
 *    clientId: "....",                                  // 必传
 *    msalUrl: "./vendor/msal/msal-browser.min.js",      // vendored 脚本
 *    scopes?, authority?,                               // 有家族默认
 *  });
 *  await auth.initAuth(); if (auth.isSignedIn()) { ...store 用 provider... }
 * ```
 */
export declare function createOneDriveProvider(config?: OneDriveConfig): {
    provider: CloudProvider;
    auth: OneDriveAuth;
};

/** 库的唯一入口 —— 薄组合根：provider → 库内造 cloud/local/kv/脊椎 → 装配深模块 →
 *  暴露 README.md 的面（file / collection / files / encryption）。设置/状态**全走 collection**。
 *  红线全在各深模块内 enforce；这里只接线 + 把 ui bundle 映射到各 flow 的回调。 */
export declare function createStore(config: StoreConfig): {
    /** 文件对象工厂（含 tryMove/pullIfClean/save/open/delete/reupload…）。 */
    file: {
        (name: string, opts: {
            isZip: true;
            mode: "new" | "existing";
        }): ZipFile;
        (name: string, opts: {
            isZip: false;
            mode: "new" | "existing";
        }): RawFile;
        (name: string, opts: {
            isZip: boolean;
            mode: "new" | "existing";
        }): RawFile | ZipFile;
    };
    /** collection 工厂（app schema 全局单例；设置/状态全走它）。 */
    collection: (name: string, opts?: {
        manual?: boolean;
        local?: boolean;
        getInitData?: CollectionConfig["getInitData"];
    }) => Collection;
    /** 所有「不挂在单个 file 上」的文件域操作（列举订阅 / 文件夹增删 / 离线队列 / 回收站备份箱 / 名字占用 / 全库收敛）。
     *  **唯一列举面 = files.watchFolder（订阅当前夹）**：立即本地帧、云端到了同一 cb 再闪。 */
    files: {
        /** 名字占用（**boolean**）：在线云端+本地都看，离线只看本地（靠 push conflictBehavior:fail 兜底）。app 新建/另存/改名前预检。 */
        nameOccupied: (name: string) => Promise<boolean>;
        /** 订阅**一个**文件夹（网盘模型）：立即本地帧 + 云端帧同一 cb 再闪；之后本夹任何本地写即时重推本地帧。返回退订。 */
        watchFolder: (folder: string, cb: (s: FolderSnapshot) => void) => () => void;
        /** 本地已缓存文件的总占用（字节 + 件数），给 app 显示「本地存了多少」。**口径**：只量本库 files 分区，
         *  **不含** trash/backup/collections 分区、app 自己别的 IDB 库、纯云端未缓存的作品。
         *  ⚠ **只返两个标量、永不返名字** —— 它不是、也不能变成全库列举（列举唯一面 = watchFolder）。 */
        usage: () => Promise<{
            bytes: number;
            count: number;
        }>;
        /** 确保文件夹存在。**离线也能建**（本地登记 + 回线 drainOfflineQueue 补建）。 */
        ensureFolder: (path: string) => Promise<void>;
        /** 新建空文件夹（gallery folder-tree；离线也能建，回线补建）。 */
        newFolder: (path: string) => Promise<void>;
        /** 删除**空**文件夹——「必须证实为空」库内强制（两端判空；非空/无法确认 → 抛错拒删）。 */
        deleteFolder: (path: string) => Promise<void>;
        /** 离线队列统一重放（app 在 focus/visibility/online/boot 调）：新文件夹补建 → 新上传补推 → 删文件 → 删文件夹（按序）。 */
        drainOfflineQueue: () => Promise<void>;
        /** 回收站列表：**本地↔云两端聚合**（mergeTrash）。只返元数据（trashKey/cloudItemId/原名/加密标志/conflictLive），绝不带 blob。 */
        listTrash: () => Promise<TrashItem[]>;
        /** 备份箱列表（同 listTrash 的两端聚合；备份箱是冲突 loser 留底，无 conflictLive 语义）。 */
        listBackup: () => Promise<TrashItem[]>;
        /** 从回收站/备份箱恢复一项。 */
        restoreTrash: (opts?: RestoreOpts | undefined) => Promise<TrashResult>;
        /** 彻底删除回收站/备份箱一项。 */
        purgeTrash: (opts?: PurgeOpts | undefined) => Promise<TrashResult>;
        /** 清空回收站。 */
        emptyTrash: (opts?: EmptyTrashOpts | undefined) => Promise<TrashResult>;
        /** 清空备份箱。 */
        emptyBackup: (opts?: EmptyTrashOpts | undefined) => Promise<TrashResult>;
        /** **全库** cloud-gone 收敛（去抖后 send trash）。**仅用户显式指令**（隐藏的「校验完整性」入口），
         *  绝不自动/轮询——全树 listAll 是重活。 */
        reconcileAll: (opts?: {
            activeFileName?: string;
        }) => Promise<{
            demoted: string[];
        }>;
    };
    /** **裸字节**级的加密面（文件还没进 store、无 name 可查时用）。有 name 的场景一律走 file.*
     *  （isEncrypted / encrypt / decrypt / verifyPassword / getPeek / decryptPeek / getEncryptedBlob）——
     *  那些能用便宜的 peek 路径，别走这里。 */
    encryption: {
        /** 是不是加密容器。**只嗅魔数/尾窗**，不派生密钥、不解密（便宜，可用于分流）。 */
        isEncryptedBlob: (blob: Blob | Uint8Array) => Promise<boolean>;
        /** 验密码 + 解出明文，**合一**。null = 错密码（或不是容器）。
         *
         *  为什么合一（这就是「不做重复的计算」）：旧面把它拆成 verifyContainer(验) + unsealWith(解)，
         *  而两者内部都是完整的 unpackContainer —— 导入一个加密文件要把整幅作品**解密两遍**
         *  （密码试错时更多）。7z-wasm 全量解一幅画不是小钱。合一后一次尝试 = 一次解密，
         *  且成功那次的明文直接给调用方复用。
         *  明文只在返回的 Blob 里（内存），库不缓存、不落盘。 */
        tryDecryptEncryptedBlob: (blob: Blob, pw: string) => Promise<Blob | null>;
        /** 这块 blob 是不是**密文 peek**（getPeek 对加密件返回的那种）。纯类型判定，零计算。
         *  取代把 ENC_PEEK_MIME 这个魔法常量导出给 app —— app 要问的是语义，不是常量值。 */
        isEncryptedPeekBlob: (blob: Blob | null | undefined) => boolean;
    };
};

/** 宿主注入的 zip/7z codec（createStore config 注入；不提供 = 加密不可用）。 */
export declare interface CryptoCodec {
    /** 打包明文 zip（外层容器）。 */
    zipPack(entries: {
        path: string;
        data: Uint8Array | string;
    }[]): Promise<Blob>;
    /** 解开明文 zip（path 到字节的记录）。 */
    zipUnpack(blob: Blob): Promise<Record<string, Uint8Array>>;
    /** 打包加密 .7z（AES-256 + 强 KDF + 加密头）。 */
    pack7z(entries: {
        path: string;
        data: Uint8Array | string;
    }[], password: string): Promise<Uint8Array>;
    /** 解开加密 .7z（也认老 WinZip-AES zip）。 */
    unpack7z(bytes: Uint8Array, password: string): Promise<Record<string, Uint8Array>>;
}

/** 删除操作的终态。 */
export declare interface DelResult {
    /** 终态串。 */
    status: string;
    /** 位置串。 */
    where?: string;
    /** 移入 trash 的结果（不透明）。 */
    trashed?: unknown;
    /** 本地 trashKey。 */
    trashKey?: string | null;
    /** 删除时的 base etag。 */
    baseEtag?: string | null;
    /** 云删已进离线队列。 */
    queuedCloudDelete?: boolean;
    /** 原因串。 */
    reason?: string;
    /** drain 重放的条数。 */
    drained?: number;
    /** 留队 defer 的条数。 */
    deferred?: number;
}

/** emptyTrash（批量彻底删）的选项。 */
export declare interface EmptyTrashOpts {
    /** 在线判定注入。 */
    isOnline?: () => boolean;
    /** busy 遮罩注入。 */
    busy?: Busy;
    /** 并发数。 */
    concurrency?: number;
    /** 清哪一端。 */
    scope?: "local" | "cloud" | "both";
}

/** 加密容器的 at-rest 字节（branded）。唯一发牌方 = ZipFile.getEncryptedBlob()。
 *  只收密文的下游（导出 / 拷贝 / checkpoint）用它当形参类型 → 传明文 Blob 编译不过。 */
export declare type EncryptedBlob = Blob & {
    readonly __encryptedAtRest: unique symbol;
};

/** fetchMeta 的结果：只轻量元信息（store open/refresh 比对 etag 用），不下载内容。 */
export declare interface FetchMetaResult {
    /** 云端当前 etag。 */
    etag: string;
    /** 最后修改时间。 */
    lastModified: string | number;
    /** 字节大小。 */
    size: number;
    /** 完整云端 item。 */
    item: CloudItem;
}

/** 流式读取会话句柄（file.openStream 返回；A2）。字节 = at-rest 原样（内容盲）。 */
export declare interface FileStream {
    /** 总字节数。 */
    totalSize: number;
    /** 读一段（播放优先级；staging/本地命中则不打网络）。越界自动钳。 */
    read(offset: number, length: number): Promise<Uint8Array>;
    /** 低优先预拉一段进 staging（下一曲头部预拉等）。本地面 no-op。 */
    prefetch(offset: number, length: number): Promise<void>;
    /** 升格正式本地副本（= keepOffline：只补缺口 + 进度）。本地面 no-op。升格后请重开 openStream。 */
    keep(opts?: {
        onProgress?: (doneBytes: number, totalBytes: number) => void;
    }): Promise<void>;
    /** 关会话（staging 分片留着，受全局 cap 兜底——先播后 pin 不重下）。 */
    close(): void;
}

/** 删空夹的判别式结果（backend 侧唯一的文件夹删除面；绝不 throw 非空/列举失败，用 status 表达）。 */
export declare interface FolderDeleteResult {
    /** 四态：deleted/already-gone=终态成功；non-empty=有内容；list-failed=列举失败确认不了空。 */
    status: "deleted" | "already-gone" | "non-empty" | "list-failed";
}

/** 单夹 snapshot（watchFolder 每次回调的形状）——**只这一夹的直属子项**（非递归）。 */
export declare interface FolderSnapshot {
    /** 本夹路径（订阅方 sanity-check 用：emit 错乱把别夹推来时可断言丢弃）。 */
    path: string;
    /** 直属文件项。 */
    items: Item[];
    /** immediate 子夹全路径。 */
    folders: string[];
    /** false → 该夹列举失败、不权威。 */
    complete: boolean;
    /** true → 本帧掺了 dir-index-cache 的「上次云端所见」（A3 冷首帧）：cloud-only 项可能已过时，
     *  等云端帧纠偏。stale 帧恒 complete:false（不权威，别据此做任何删/收敛判断）。 */
    stale?: true;
}

/** open / refresh 的终态。 */
export declare interface FreshResult {
    /** 内容来源串。 */
    source?: string;
    /** 终态串。 */
    status?: string;
    /** 原因串。 */
    reason?: string;
    /** 覆盖前留底的备份名。 */
    backupName?: string;
    /** 原始异常。 */
    error?: unknown;
}

/** 把 Graph transport（graph.ts）翻成库的 CloudProvider（原始 Graph item → CloudItem）。
 *  纯：graph **必传**（测试传 graphFromProvider(MockCloudProvider)，与 graphToCloudProvider 复合 ≈ 恒等）。 */
export declare function graphToCloudProvider(graph: GraphTransport): CloudProvider;

/** OneDrive Graph transport 契约（graphToCloudProvider 消费的最小面）。
 *  providers/index 传真 graph.ts 模块、测试传 graphFromProvider(Mock)——结构满足即可（自定义 transport 同理）。 */
export declare interface GraphTransport {
    /** 列举子夹的直属子项（原始 Graph item）。 */
    listChildren(subfolder?: string): Promise<RawGraphItem[]>;
    /** 按路径取 item；缺 → null。 */
    getItemByPath(path: string): Promise<RawGraphItem | null>;
    /** 下载文件内容。 */
    downloadItemBlob(itemId: string): Promise<Blob>;
    /** byte-range 下载；offset=null 取末尾 length 字节。 */
    downloadItemRange(itemId: string, offset: number | null, length: number): Promise<ArrayBuffer>;
    /** 上传到 approot 相对路径。 */
    uploadFileToApproot(path: string, blob: Blob, contentType?: string, opts?: {
        conflictBehavior?: "replace" | "fail" | "rename";
        eTag?: string | null;
    }): Promise<RawGraphItem | null>;
    /** 硬删 item。 */
    deleteItem(itemId: string, eTag?: string | null): Promise<void>;
    /** 移动到目标文件夹。 */
    moveItemToFolder(itemId: string, targetFolderId: string, opts?: {
        eTag?: string | null;
        newName?: string | null;
        conflictBehavior?: "replace" | "fail" | "rename";
    }): Promise<RawGraphItem>;
    /** 改名。 */
    renameItem(itemId: string, newName: string, eTag?: string | null): Promise<RawGraphItem>;
    /** 取 approot 文件夹 id。 */
    getApprootId(): Promise<string>;
    /** 确保子夹存在，返其 id。 */
    ensureSubfolder(name: string): Promise<string>;
}

/** 有本地副本 → 离线可读。 */
export declare function isCached(s: SyncState): boolean;

/** 有未推本地编辑 → 永不被驱逐。 */
export declare function isDirty(s: SyncState): boolean;

/** 统一列举的一项（local ∪ cloud 归并后）。 */
export declare interface Item {
    /** 身份 = approot 相对路径。格式无关 + provider 无关（唯一跨后端 key；itemId/内容哈希均否决）。 */
    path: string;
    /** 按 ListContext 解析好的 badge —— Item 上就这一个状态字段（防下游 AI 重推导越狱）。 */
    syncState: SyncState;
    /** 字节大小（云端 authoritative，否则本地缓存记录）。 */
    size?: number;
    /** sort-by-date 用（epoch ms）。 */
    lastModified?: number;
}

/** localStorage / IDB / 内存 都能实现的极简 KV（store 不直碰 localStorage，红线 #7）。 */
export declare interface Kv {
    /** 读键；缺 → null。 */
    get(k: string): string | null;
    /** 写键。 */
    set(k: string, v: string): void;
    /** 删键。 */
    remove(k: string): void;
}

/** 列举上下文：syncState 的可解析度由它决定（用户拍板：store 吃 ctx、返解析好的 badge）。 */
export declare interface ListContext {
    /** 登录与否。 */
    signedIn: boolean;
    /** 在线与否。 */
    online: boolean;
}

/** 本地持久层（store.local 契约）：**内容无关**，存任意 binary blob。 */
export declare interface LocalCache {
    /** hint：save 透传的 app 旁路（store 不解释、不看内容；app 可经 hint.peek 供不透明 sidecar 字节）。 */
    save(name: string, bytes: Bytes | Blob, hint?: unknown): Promise<unknown>;
    /** 读缓存 blob；缺 → null。 */
    get(name: string): Promise<Blob | null>;
    /** 是否已缓存。 */
    exists(name: string): Promise<boolean>;
    /** 已缓存的**应用文件名**集合（排除 trash/backup/collection 内部命名空间）——gallery 批量判 cached 用。 */
    appKeys(): Promise<string[]>;
    /** 轻量元信息（size + updatedAt），不取 blob 内容。listing 给本地项填尺寸/时间（离线/云端帧到达前也不显 0B/1970）。缺 → null。 */
    stat(name: string): Promise<{
        size: number;
        updatedAt: number;
    } | null>;
    /** 本地已缓存文件的总占用（字节 + 件数）。单事务 cursor，不载字节内容。
     *  ⚠ **只返标量，永不返名字** —— 这是刻意的：全库列举是被否决的退化设计（列举只走 per-folder watchFolder）。 */
    usage(): Promise<{
        bytes: number;
        count: number;
    }>;
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
    /** 读某夹目录索引缓存 JSON 串；缺/未实现 → null。 */
    getDirIndexCache?(folder: string): Promise<string | null>;
    /** 写某夹目录索引缓存 JSON 串（覆盖写）。 */
    putDirIndexCache?(folder: string, json: string): Promise<void>;
}

/** provider.move 的选项。 */
export declare interface MoveOpts {
    /** 移动同时改名。 */
    newName?: string | null;
    /** If-Match etag。 */
    eTag?: string | null;
    /** 撞名行为。 */
    conflictBehavior?: "fail" | "replace" | "rename";
}

/** createOneDriveProvider 返回的 auth 面（契约显式化；订阅走 onAuthChanged 回调，无 window 事件）。 */
export declare interface OneDriveAuth {
    /** 是否已注入真实 clientId（占位符 = 未配置，纯离线不 load MSAL）。 */
    isAuthConfigured(): boolean;
    /** 初始化 auth（silent probe：有 account 不代表本 app 有 token）。 */
    initAuth(): Promise<AuthState>;
    /** 交互式登录（用户手势里调）。 */
    signIn(): Promise<unknown>;
    /** 登出：只清本 app cache（clearCache），不 logoutRedirect 踢掉用户整个微软会话。 */
    signOut(): Promise<void>;
    /** 拿 access token（silent）。 */
    getToken(): Promise<string>;
    /** 是否已登录。 */
    isSignedIn(): boolean;
    /** 当前活跃 account（MSAL 句柄）。 */
    getActiveAccount(): Account;
    /** 静默重试登录。 */
    retrySilentSignIn(): Promise<boolean>;
    /** auth 状态订阅（每个转变都回调）；返回退订函数。 */
    onAuthChanged(cb: (st: AuthState) => void): () => void;
    /** 当前 auth 状态快照。 */
    getAuthState(): AuthState;
}

/** createOneDriveProvider 的配置（clientId 必传；msalUrl = vendored MSAL 脚本路径；scopes/authority 有家族默认）。 */
export declare interface OneDriveConfig {
    /** app 注册的 clientId（必传）。 */
    clientId?: string;
    /** MSAL authority（有家族默认）。 */
    authority?: string;
    /** OAuth scopes（有家族默认）。 */
    scopes?: string[];
    /** vendored MSAL 脚本路径。 */
    msalUrl?: string | null;
}

/** pull 的结果：拉到的字节 + 权威 item（H7：分片末响应无 item 时拉权威 etag）+ 建议落地名（撞名 caller 用）。 */
export declare interface PullResult {
    /** 拉到的字节。 */
    blob: Blob;
    /** 权威 item。 */
    item: CloudItem | null;
    /** 建议落地名（撞名时 caller 用）。 */
    suggestedName: string;
}

/** purge（永久删，不可恢复）的选项。 */
export declare interface PurgeOpts {
    /** 本地 trashKey（本地腿）。 */
    trashKey?: string | null;
    /** 云端 trash item id（云端腿）。 */
    cloudItemId?: string | null;
    /** danger confirm 回调。 */
    confirm?: (ctx: {
        title: string;
        body: string;
        danger?: boolean;
    }) => boolean | Promise<boolean>;
    /** busy 遮罩注入。 */
    busy?: Busy;
}

/** push 的结果。 */
export declare interface PushResult {
    /** 上传后的云端 item。 */
    item: CloudItem | null;
}

/** 文件对象（非 zip）。isZip 在编译期分出两种：RawFile 无 getPeek/setPeek。 */
export declare interface RawFile {
    /** 本地落盘 + best-effort 推云（默认 tryPush:true）；tryPush:false = 只落本地不推
     *  （autosave/频繁保存；opaque Work 的 push 必须 consent-gated，ADR-0016/0018）。
     *  tryPush 是 **best-effort**：离线/冲突/失败 → 文件留 dirty、下次补推。hint 透传缩略图（store content-blind）。
     *  **别忽略 pushed**：pushed:false 不是错误，是**事实**（离线/冲突/用户 cancel），调用方据此保住 push-pending。 */
    save(bytes: Bytes | Blob, opts?: {
        tryPush?: boolean;
        hint?: unknown;
    }): Promise<SaveResult>;
    /** 打开读取，返回**明文** Blob（加密透明解壳）；拿不到（本地无且云端不可达）→ null。 */
    open(): Promise<Blob | null>;
    /** 事件驱动「干净快进」：本地 clean ∧ 云端有更新 → 拉新版覆盖本地缓存；本地 dirty → no-op
     *  （绝不在事件里弹 sheet，后续 push 的 412 会 surface 真分叉）。app 在 focus/visibility/online 调。 */
    pullIfClean(opts?: RefreshOpts): Promise<FreshResult>;
    /** 改身份/移动的**唯一入口**（含 nameOccupied 占用检查，结果式不抛；ok:false→UI surface where）。无独立 rename。 */
    tryMove(to: string): Promise<TryMoveResult>;
    /** 返 DelResult：**别只 await 就报「已删除」**（v436）。status 至少三种不是成功：
     *  cancelled（用户在脏文件警告里选了取消）· noop（本地云端都没有）
     *  · queuedCloudDelete:false（离线且谱系不明 → 本地 move-aside 了，但云端那份还在）。 */
    delete(): Promise<DelResult>;
    /** 重新上传（candidate-gone 的「保留重传」动作）：本地 clean 字节推云到空 path。撞名(乌龙云端已有)→抛
     *  CloudNameCollisionError（app surface conflict）；成功→采纳新 etag 变 synced + 清 candidate。 */
    reupload(): Promise<{
        status: string;
    }>;
    /** 本地有副本？（= 已留作离线）。 */
    isKeptOffline(): Promise<boolean>;
    /** 留一份离线副本（未缓存则分片会话下载：**复用 staging 已流分片只补缺口**——先播后 pin 不重下；
     *  onProgress 报字节进度）。注：open 已含下载子过程，故名 keepOffline 非 download。 */
    keepOffline(opts?: {
        onProgress?: (doneBytes: number, totalBytes: number) => void;
    }): Promise<void>;
    /** 流式读取会话（A2，大媒体按需取片）：本地有副本 → 本地切片喂；无 → 云端分片会话（tee 入 staging）。
     *  **at-rest 字节面**（加密件给的是密文容器字节——流式消费请只用于明文文件；加密件走 open()）。
     *  两端都拿不到 → null。keep() 升格正式本地副本后，请**重开** openStream（新 handle 走本地面）。
     *  不限音频：RealHome「世界预热」（glb 预载不退场等加载）同一面——prefetch/keep 预热 + stagingCoverage 报进度。 */
    openStream(): Promise<FileStream | null>;
    /** staging 覆盖快照（A5 透明面）：**只读、零网络、离线可用**；无残片 → null。与本地正式副本无关
     *  （那查 isKeptOffline）。徽章三态：isKeptOffline→已钉；complete→已缓存（离线可完整播）；
     *  有值不完整→部分缓存（**离线不该起播**——防头部先响、播到洞卡死）；null→无。 */
    stagingCoverage(): Promise<StagingCoverage | null>;
    /** 合法(clean∧在线∧曾synced∧云端有完整)→hardDelete；非法(唯一副本/不可重取)→抛 OffloadIllegalError（banner）。 */
    offload(): Promise<void>;
    /** 本地字节是否加密容器。 */
    isEncrypted(): Promise<boolean>;
    /** 明文→密文（先本地后云 If-Match；离线 defer；错密码前置出局）。 */
    encrypt(opts?: {
        isOnline?: () => boolean;
    }): Promise<{
        status: string;
    }>;
    /** 密文→明文（同 encrypt 红线）。 */
    decrypt(opts?: {
        isOnline?: () => boolean;
    }): Promise<{
        status: string;
    }>;
    /** app 解锁循环（busy 外）便宜验：解 peek，不碰 7z。 */
    verifyPassword(pw: string): Promise<boolean>;
}

/** graph item 的原始形状（含 file/folder facet、path、downloadUrl 注解；transport 契约的条目面）。
 *  比 graph.ts 内部形状放宽（测试 mock 带 path）。 */
export declare interface RawGraphItem {
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

/** files 面只读镜像（readOnlyFiles:true）下调用写路径 → 抛此错（app surface；这不是失败，是契约）。 */
export declare class ReadOnlyFilesError extends Error {
    constructor(op: string);
}

/** reconcileWithRemote 的终态。status 来自 folder-flow.sync（synced/offline/invalid/dirty），
 *  外加 unchanged（云端 etag 没变，压根没拉）和 error（意外抛）。 */
export declare interface ReconcileResult {
    /** 终态串（synced/offline/invalid/dirty/unchanged/error）。 */
    status: string;
    /** 是否一并推了本地更新。 */
    pushed?: boolean;
    /** error 态的原始异常。 */
    error?: unknown;
}

/** refresh（事件驱动的纯干净快进）的选项。 */
export declare interface RefreshOpts {
    /** 在线判定注入。 */
    isOnline?: () => boolean;
    /** 采纳验真回调。 */
    adopt?: AdoptFn;
    /** 本地 dirty 判定注入。 */
    localDirty?: () => boolean;
    /** N10：真要拉内容（动过+clean）才触发，app 给非阻塞 status。 */
    onReplaceStart?: () => void;
    /** busy 遮罩注入。 */
    busy?: Busy;
}

/** 冲突派发的选择串（keepMine / takeCloud / cancel）。 */
export declare type ResolveChoice = "keepMine" | "takeCloud" | "cancel";

/** restore（从回收站恢复）的选项。 */
export declare interface RestoreOpts {
    /** 走云端腿恢复。 */
    fromCloud?: boolean;
    /** 云端 trash item id（云端腿）。 */
    cloudItemId?: string | null;
    /** 恢复的目标名。 */
    targetName?: string;
    /** 本地 trashKey（本地腿）。 */
    trashKey?: string | null;
    /** trash 里的字节是加密容器 → 恢复落 encFileName。 */
    encrypted?: boolean;
    /** busy 遮罩注入。 */
    busy?: Busy;
}

/** save 的结果：本地一定落了（没落会抛），云端**不一定**上去了。pushed:true = 云端已确认落地（拿到新 etag）；
 *  pushed:false = 只落了本地，reason：not-attempted(tryPush:false) / offline-or-error / deferred(落地未确认)
 *  / unresolved|cancelled(冲突面用户没解决) —— 文件仍 dirty，等下次推。 */
export declare type SaveResult = {
    pushed: boolean;
    reason?: string;
};

/** staging 覆盖快照（A5 透明面，2026-08-18 user 批「关键是透明清晰」）——只读 staging 账本，
 *  **零网络、离线可用**。app 拿它画徽章三态（已钉走 isKeptOffline / 完整缓存 / 部分缓存）+ 离线起播
 *  护栏（complete 才起播——防「头部在缓存先响了、播到洞静默卡死」）+ 离线边界接曲决策（headBytes）。
 *  注意：反映的是账上那一版（eTag 在案），不上网验云端当下版。 */
export declare interface StagingCoverage {
    totalBytes: number;
    /** 已持有字节（按分片账算，不打网络）。 */
    bytes: number;
    /** 从文件头起**连续**已持有的字节数（「头部备好没」）。 */
    headBytes: number;
    /** 全部分片在账 = 离线可完整播。 */
    complete: boolean;
    eTag: string;
}

/** staging 分区的注入端口（prod = blob-partition 的 "staging" 分区；测试 = 内存 map）。 */
declare interface StagingStore {
    get(key: string): Promise<Blob | null>;
    put(key: string, blob: Blob): Promise<void>;
    del(key: string): Promise<void>;
    keys(): Promise<string[]>;
}

/** store 本体类型（createStore 的返回面：file / collection / files / encryption）。 */
export declare type Store = ReturnType<typeof createStore>;

/** createStore 的配置。 */
export declare interface StoreConfig {
    /** 云端低层 adapter（CloudProvider；如 createOneDriveProvider().provider）。 */
    provider: CloudProvider;
    /** ui bundle（StoreUI）：store 在决策点回调进来。 */
    ui: StoreUI;
    /** ⚠ **必填**：app 在本 origin 内的唯一命名空间（如 "app-a" / "app-b"）。与 databaseId 一起构成命名空间根
     *  `${appId}.${databaseId}`：IndexedDB 库名 + 全部 localStorage 键前缀都据它隔离（namespacedKv 统一加）。
     *  **同 origin 的兄弟 PWA 必须用不同 appId**。 */
    appId: string;
    /** 同一 app 内的 store 实例标识（默认 "defaultStore"）。想开**多个互不打架的 store**（不同数据集）
     *  → 传不同 databaseId：各自独立 IDB 库 `${appId}.${databaseId}` + 独立 localStorage 前缀。 */
    databaseId?: string;
    /** app 注入的 zip/7z 加密 codec（参考实现见本仓 test/fixtures/）；不注入 → 加密 dormant。 */
    crypto?: CryptoCodec;
    /** 加密相关的 app 域注入（不加密的 app 不传）。 */
    crypt?: {
        /** 真扩展名 → meta.bin（"ora"/"txt"…），还原真名。 */
        ext?: string;
        /** 明文→不透明 peek 字节（app 域；store 不看内容）。 */
        makePeek?: (plain: Blob) => Promise<Uint8Array | null>;
        /** 同步、非交互、只读内存（唯一密码源）；app 持密码 + 解锁循环在 busy 外。 */
        getPassword?: (name: string) => string | null;
    };
    /** ⚠ 未采用：README §5 的库统一密钥/salt 超集本版不实现（见 ai-docs/11，加密走 crypt.getPassword）。 */
    encryptionSaltFileName?: string;
    /** 内部/测试 seam：KV 注入（prod 默认 localStorage）。 */
    kv?: Kv;
    /** 内部/测试 seam：本地缓存注入（prod 默认 idb，createLocalCache）。 */
    local?: LocalCache;
    /** 内部/测试 seam：staging 暂存区注入（prod 默认 idb 的 `staging/` 分区）。 */
    staging?: StagingStore;
    /** 分片下载会话的分片大小（默认 2MiB；= pin 给播放让路的粒度）。 */
    stagingChunkBytes?: number;
    /** staging 暂存区全局字节上限（默认 256MiB；超限 FIFO 清最旧整组——scratch 兜底，非缓存治理）。 */
    stagingCapBytes?: number;
    /** 旧顶层密码源（向后兼容；优先用 crypt.getPassword）。 */
    getPassword?: (name: string) => string | null;
    /** 采纳云端字节前的有效性闸（N2：clean 快进/pull 覆盖本地前调）——**所有 consumer 必传，禁 placeholder/noop**。
     *  store 格式盲、自己验不了内容 → 逻辑 app 给（验是不是真文档字节）。
     *  **库对加密透明**：验的是**解密后的明文**，不是密文容器。 */
    validateAdopt: (plain: Blob) => boolean | Promise<boolean>;
    /** store name → 云端文件名（如把 name 追加 ".dat"）。**不给 = 恒等**（名字本身含扩展名的 app）。 */
    fileName?: (name: string) => string;
    /** 加密容器的云端文件名（如把 name 追加 ".zip"；ADR-0012）。 */
    encFileName?: (name: string) => string;
    /** offload 离线守卫（默认 navigator.onLine）。 */
    isOnline?: () => boolean;
    /** **连接态由 store 自持**（网盘模型：app 不再每次列举传 ctx）。ctor 注入一次；不给 → 恒 true
     *  （退回 provider 失败即降级）。watchFolder / 云列举据此决定「云轴可不可解析」。 */
    signedIn?: () => boolean;
    /** 消费模式：true=开即自动留本地（读者/编辑器）；false=过路/流式（开整份拉云不落本地；range 按需取片是 ⚠TODO 优化）。 */
    autoCacheOpenedFile?: boolean;
    /** ADR-0018：离线「新上传」回线补推策略 auto|ask|manual（默认 manual）。 */
    offlineUploadReplay?: UploadReplayPolicy;
    /** 测试/无 localStorage 环境跳过迁移（prod 不传）。 */
    skipMigration?: boolean;
    /** 云端防抖窗口覆盖（测试注入小值；prod 缺省 ~24h）。 */
    cloudGoneGraceMs?: number;
    /** 当前打开的 doc（全名身份）：cloud-gone 去抖 trash 绝不碰它（连 watchFolder 自动 reconcileFolder 也跳过）。 */
    activeFileName?: () => string | null;
    /** A4（ADR-0022 预排的 readOnlyMirror，2026-08-15 落地）：**files 面只读镜像**。BR 类消费者——内容由用户经
     *  OneDrive 客户端投放进 appfolder，app 永不写。true → 一切 files 写路径（save/tryMove/delete/reupload/
     *  encrypt/decrypt、建删夹、回收站恢复/清空）抛 ReadOnlyFilesError；**collections 不受影响**（阅读位置等照写）。
     *  只读消费面照常：open/openStream/keepOffline/offload/pullIfClean/watchFolder/reconcileAll。 */
    readOnlyFiles?: boolean;
}

/** 错误上报分级：error=非预期失败；warning=可疑但非致命；info=值得让用户知道的瞬态；log=良性 offline/fallback。 */
export declare type StoreErrorLevel = "error" | "warning" | "info" | "log";

/** ui bundle：store 在决策点回调进来 + await。**全部必填，禁 placeholder/noop**
 *  （offlineEscape 例外：缺它优雅退回 isOnline 守卫，非隐藏失败）。 */
export declare interface StoreUI {
    /** busy UI 锁：包住一段用户态异步操作（label 供显示）。 */
    busy: <T>(label: string, fn: () => Promise<T>) => Promise<T>;
    /** 冲突必 surface：consumer 必须给真 sheet，绝不静默 cancel。 */
    resolveConflict: (ctx: {
        name: string;
        local: Blob | null;
        cloud: Blob | null;
    }) => Promise<ResolveChoice>;
    /** 错误必 surface：绝不吞 console。level 缺省 "error"（见 error-handling.ts 分级）。 */
    reportError: (err: unknown, level?: StoreErrorLevel) => void;
    /** 可选：云端检查（freshness gate）的「跳过到离线」逃生闸（无硬超时，用户即超时）。
     *  store 在 open 的 freshness 检查前调，拿 probe 与 fetchMeta race；用户点「跳过到离线」→ probe resolve → 读本地。
     *  不实现 → 无逃生闸（退回纯 isOnline 守卫 + 裸 await）。settle() 在检查结束后清理 skip UI。 */
    offlineEscape?: () => {
        probe: Promise<unknown>;
        settle: () => void;
    };
    /** 补推进度/冲突 surface（非 busy，走状态行/toast）。 */
    onReplayStatus?: (evt: {
        phase: "start" | "pushed" | "collision" | "done";
        name?: string;
        done: number;
        total: number;
    }) => void;
    /** 'ask' 模式：回线/成功连接问一次「N 篇离线上传现在同步到云端？」。 */
    confirmReplay?: (count: number) => Promise<boolean>;
}

/** syncState = residency(住哪) ⟂ sync-status(clean/dirty/conflict/gone) 两轴的 derived 投影（8-badge）。 */
export declare type SyncState = "cloud-only" | "synced" | "unpushed" | "newer-on-cloud" | "conflict" | "ghost" | "pendingGone" | "float" | "local-only";

/** 本地 trash/backup 列举的一项（trashKey + 原名）。 */
export declare interface TrashEntry {
    /** 本地回收站键（restore/purgeTrash 用）。 */
    trashKey: string;
    /** 原名。 */
    name: string;
}

/** 回收站/备份箱聚合视图的一行（本地↔云两端按原名归并）。 */
export declare interface TrashItem {
    /** 展示/恢复原名（local 行 = 全路径身份；cloud-only 行 = basename，folder context 在云端 trash 已丢）。 */
    name: string;
    /** yyyymmddhhmmss（展示/排序；解析不出 → null）。 */
    ts: string | null;
    /** 痕迹所在端。 */
    side: "local" | "cloud" | "both";
    /** 云端字节是加密容器（从 stamped `.zip` 尾推断）→ restore 落 encFileName。 */
    encrypted: boolean;
    /** local 行原名仍活在权威云端列表（离线删被 edit-wins 撤销）→ 两存，别丢。 */
    conflictLive: boolean;
    /** 本地 trashKey（本地腿 restore/purge）。 */
    localKey: string | null;
    /** 云端 item id（云端腿 restore/purge）。 */
    cloudItemId: string | null;
}

/** restore / purge / emptyTrash 的终态。 */
export declare interface TrashResult {
    /** 终态串。 */
    status: string;
    /** 涉及的文件名。 */
    name?: string | null;
    /** 本地腿标志。 */
    local?: boolean;
    /** 云端腿标志。 */
    cloud?: boolean;
    /** 彻底删的条数。 */
    purged?: number;
    /** 失败汇总（逐项独立 try、不静默）。 */
    failed?: unknown[];
}

/** tryMove 结果式返回（不抛，UI 渲染 where 标签）。ok:true 时**仍可能有话要说**（别只看 ok 就报「已重命名（含云端）」）：
 *  oldKept=谱系不明降级 save-as、云端旧名原地留着；oldUnknown=云端旧名状态取不到（「取不到」≠「没有」）；
 *  oldCloudOrphan=旧名进 .trash 失败成云端孤儿；cloudDeferred=云端推失败、新名只在本地待推。 */
export declare type TryMoveResult = {
    ok: true;
    where?: string;
    oldName?: string;
    oldKept?: boolean;
    oldUnknown?: boolean;
    oldCloudOrphan?: boolean;
    cloudDeferred?: boolean;
} | {
    ok: false;
    reason: "name-collision";
    where: "local" | "cloud";
};

/** provider.upload 的选项。 */
export declare interface UploadOpts {
    /** 内容 MIME 类型。 */
    contentType?: string;
    /** If-Match etag。 */
    eTag?: string | null;
    /** 撞名行为。 */
    conflictBehavior?: "fail" | "replace" | "rename";
}

/** per-app 补推策略：auto=静默补推；ask=每次 reconnect/成功连接问一次整批；manual=不做（等显式再存）。 */
export declare type UploadReplayPolicy = "auto" | "ask" | "manual";

/** 弱覆盖（冲突解决 weak-override 分支）的结果：覆盖云端 + 留底。 */
export declare interface WeakOverrideResult {
    /** 覆盖后的新云端 item。 */
    item: CloudItem | null;
    /** 留底的备份名。 */
    backedUp: string | null;
}

/** zip 容器文件对象：RawFile + 按 entry 名取字节的 peek 面（zip 解析在库内部，app 不碰 zip 布局）。 */
export declare interface ZipFile extends RawFile {
    /** 从 zip 容器里**按文件名**抓 zipEntry 的字节。**明文** zip → entry 原始字节 Blob(**无 type**，格式盲，app 自解释)；
     *  **加密**容器 → **密文** peek Blob(type=ENC_PEEK_MIME，未解密，解密走 decryptPeek)；找不到/不可达→null。
     *  ⚠库不认内容格式——就是「按名取到的 entry 字节」；app 通常拿去当缩略图（内容知识全在 app）。 */
    getPeek(opts: {
        bytesLength: number;
        zipEntry: string;
    }): Promise<Blob | null>;
    /** 把 getPeek 返回的密文 peek blob 非交互解密成明文（内存密码；锁定/错密码→null）。已是明文(非 ENC_PEEK_MIME)→原样返。 */
    decryptPeek(encPeek: Blob): Promise<Blob | null>;
    /** 本地 at-rest 字节**原样**（内容盲，不解壳）——仅当这份是加密容器时给，否则 null。
     *
     *  为什么需要：`open()` 是**透明解壳**的（拿到的是明文），所以「原样搬密文」的场景——
     *  导出加密作品、拷贝加密作品、给加密作品存 checkpoint——以前根本没有接口，
     *  只能退化成「解密再存/再导出」，那就是明文落盘/明文外流（红线）。
     *
     *  返回 EncryptedBlob（branded）：下游只收密文的 sink 用这个类型签名，
     *  传普通 Blob 直接编译错 —— 把「别把明文当密文传」从人的自觉变成编译期约束。
     *  ⚠ 诚实的边界：TS 证明不了「这坨字节运行时真是密文」；brand 挡的是编码错误，
     *    运行时真相由本方法保证（它是唯一发牌方，非加密件一律返 null）。 */
    getEncryptedBlob(): Promise<EncryptedBlob | null>;
}

export { }
