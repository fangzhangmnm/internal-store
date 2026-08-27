# 无地骑士 store 轮——拍板记录 + folder provider 契约草案

> created 20260825 · as-of v0.3.5 / 2026-08-25 · by Claude Fable 5
> 上游：WeebPaint `ai-docs/20260825-localfile-knight-grill-verdicts.md`（§5 agenda）。
> 本文 §1-2 = user 已拍板；§3 = 契约草案 v1（**id 选型待 §4 审计回填后定稿，user 过目后才动码**）。
> 持久化结构变更纪律：每项动手前逐个上报 user（家规）。

## 1. 拍板记录（user 2026-08-25）

1. **A2/A3 事务收敛**：`idb-store.ts` 三种事务形状 → 一个 helper：readwrite resolve 只认 `t.oncomplete`，reject 接 `t.onerror` + `t.onabort`（QuotaExceededError 走 reportStoreError）；readonly 同 helper。防回归：① 语法扫描测试（`db.transaction` 只许在 helper 内，抄 ifmatch-guard 手法）；② 真浏览器夹具从 tag `opus-round-20260821-before-rollback` 取 `tools/idb-tx-commit-check.mjs` 当参考重造（当晚变异测试判定诚实）；**不 vendor fake-indexeddb**（quota abort 模拟不可信，假绿危险）。GUIDELINE 重写正确版并记冤史。→ patch **0.3.6**（无 exports 变化）。**已落地 v0.3.6（2026-08-26，Claude Fable 5）**：tx() 唯一入口 + `test/idb-tx-guard.test.ts` + `tools/idb-tx-commit-check.mjs`（真浏览器两组全过；变异自检——dist 改回谎报形状夹具变红——通过）；api/ 零 diff。
2. **`dispose({ drain: true })`**：停 watcher、drain in-flight push、断 IDB 连接、拒后续调用。exports 门牌变更。
3. **dirty facet（聚合，别散一地）**：`files.dirty` 一个门面：`count(): Promise<number>`（只返标量，与 usage 红线同口径，bool=count>0 白送）+ `pushAll(): Promise<{ pushed: number; failed: string[] }>`（绿灯门「先推完」按钮的执行体；failed 返名字是**错误报告**不是列举面，量级=失败数）。⚠ pushAll 的底层「不开文档推 dirty 项」路径现状是否存在**未核**——实现前查明，缺则此门面即其新家。
4. **多账号防御三件套（宣发前铺路，不做 UI）**：① provider 构造显式携带 homeAccountId，store 内部永不问「现在谁登录着」；② registry 的 onedrive 行存账号 id；③ MSAL 取 token 一律带 account 参数。邻域约束不动：personal-account-only、翻 audience 必须连 authority 一起改。
5. **议题 3 结案：零 store 改动**——collections 是实例成员，多实例（`${appId}.${databaseId}` 现成）天然给出每图库一套设置/笔刷；Editor Only 的全局设置归 app 侧去容器重构。
6. exports 变更（dispose + dirty facet + provider 多账号形状）打包一次过目 → **0.4.0** 审版门（版本纪律：人类过目真实 exports 后才花掉版本号）。

## 2. 已拍的 provider 契约纪律

- **eTag = `${mtime}-${size}`**；懒仲裁 hash 只在可疑差异时算（mtime 变 size 同/粗粒度平台），**永不升格为身份**。
- **eTag 回采**：每个 mutation 返回新 item——mtime 必须在 `writable.close()` **之后**重读（mtime 在 close 时刻才定；提前读=回采到旧值=谱系中毒假冲突，2026-06 改名 bug 同族）。
- **If-Match 等价物 = 读-比-写**，TOCTOU 毫秒窗进已知失败清单（唯一并发写手=云盘桌面客户端）；语法护栏同 ifmatch-guard：裸写路径=测试红。
- **权限中途过期**（NotAllowedError）：入队 + surfaced，只在用户手势 re-request，后台绝不弹授权。
- **move 平台矩阵真机验**（`FileSystemFileHandle.move()` 跨目录支持）；缺 move 的平台退路 = **copy-先-验-后-删源**（方向永远是先保住字节）。真机项尽量合批、只验平台行为。
- **大小写护栏**：Windows/OneDrive 不敏感、Linux 敏感——nameOccupied/路径比较按不敏感口径统一（与 appfolder 大小写案对齐）。
- **列举**：目录迭代 + per-file `getFile()` 取 mtime/size。成本校准：本地 getFile 微秒级，画库量级（数百）总耗时优于一次网络往返——真正的纪律是**只在 focus/打开时轮询**（与云 provider 平价，无推送），不热轮询。过滤自家 `.trash`/`.backup` 子目录与 desktop.ini/.DS_Store 类垃圾。

## 3. 12 方法映射草案 v1

| 方法 | FSA 落法 | 备注/已知失败 |
|---|---|---|
| list(folder) | resolve 目录句柄→迭代 entries→per-file getFile() | §2 列举纪律 |
| getItemByPath | 逐段 getDirectoryHandle→getFileHandle | 不存在=null 非异常 |
| getApprootId | 根目录标记（"/"） | — |
| download(id) | getFile()（File 即 Blob） | — |
| downloadRange | file.slice(offset,len) | 白送 |
| upload(path,blob,opts) | If-Match：先读 mtime 比对→createWritable（原子替换）→close→重读 mtime 回采；无 base（conflictBehavior:fail）：先 getFileHandle 不带 create 探存在→不存在才 create | 探测-创建 TOCTOU 已知失败 |
| ensureFolder | getDirectoryHandle({create:true}) 逐段 | — |
| delete(id,eTag) | mtime 比对→removeEntry | TOCTOU；⚠ store 语义删除=移 .trash，硬删只发生在 purge |
| deleteEmptyFolder | 迭代验空→removeEntry | 非空拒删（现契约） |
| move(id,target) | handle.move()（矩阵待验）；退路 copy-验-删 | .trash/.backup 的执行体 |
| copy | read→write 新句柄→回采 | O3 copy-then-replace 的本地对应 |
| rename | handle.move(newName) 或同上退路 | 回采新 mtime |

**id 选型（悬）**：方案 A = path-as-id（改名即换 id，语义文档化）vs 方案 B = session 句柄表（id=现铸 token→内存 Map 到句柄，跨 session 失效）。§4 审计定破坏面后拍。

## 4. id 消费点审计（2026-08-25 回填，全库逐点核过）

**结论：核心引擎对 id 稳定性的依赖 = 零。** `src/listing.ts:32` 本来就把「身份 = approot 相对路径，itemId/内容哈希均否决」写成红线，全库贯彻：所有 mutation 返回值只取 `.eTag` 从不复用 `.id`；同一性判定一律 `_find`（按 path）+ eTag。离线队列/trash 记录/staging 账本全部只存 name+eTag，**一个 id 都不持久**。

- **唯一持久化 id**：`create-store.ts:428` 把 `id` 写进 dir-index-cache，唯一读者 = SW 流式网关（`sw/gateway.ts:81-86,128`，按名免 Graph 往返拉分片）。
- **id 跨操作关联窗口**最长的两处：回收站 list→用户点击（秒~分钟；当前只处理 412 未处理 404——这在 OneDrive 下同样不安全，属预存小洞）；download-session 会话期钉 item（promote 腿已有按名重验兜底，read/prefetch 腿硬失败）。
- **方案 A（path-as-id）破坏面**：核心引擎 0 处必改；SW 网关补「id 解析失败→丢缓存重解析一次」；404 收敛进「已被别处动过」错误族（顺手把预存小洞一起堵）；provider 契约文档写清 id 语义。
- **方案 B（session 句柄表）破坏面**：SW 跨 JS 上下文拿不到页面的句柄表（整条 SW 链只能退化成按名兜底）；**失败模式更危险**——旧 key 在新 session 可能被复用 → 解析到**别的文件**而不是干净失败；另需句柄表 GC（watchFolder 每刷新全量发 item，表无限涨）。
- 共同隐含契约（folder provider 必须满足）：同 session 无外部改名时同文件 id 恒定（contract test 钉着）；文件夹 id 与文件 id 同命名空间（ensureFolder/getApprootId 返回值要能当 move/copy 的目标参数）。

**选型（user 2026-08-25 拍板）：方案 A，path-as-id**——「改名即换 id」文档化；与 store 宪法（身份=path）同构，B 弃。配套三件：SW 网关失效重解析、404 错误族收敛、契约文档语义节。
**改名（user 同点拍板）：`id` 字段更名为 `ref`**——名字必须说明行李牌性（opaque reference：同 session 无外部改动时有效；**非身份**；改名/移动后可换；身份=path）。CloudItem.ref + provider 全方法参数同改，OneDrive provider 的 ref 恰好稳定=Graph id（那是地板之上的赠品，消费方不得依赖）。随 0.4.0 exports 批次一起过目。本地磁盘改名裂卡=既有 wart E 同族（低概率、分叉自愈），文档化不修。

## 5. 缓存姿态（user 2026-08-25 拍板）

**「folder 就是另一朵云」**：folder provider 走与云完全同一台机器（IDB 本地腿照常），引擎零特判；安全性与云图库平价不降。依据：会咬人的 divergence 只有 dirty-vs-源，与云模式同一套红线管辖；clean 缓存陈旧被打开时 freshness 检查（永不跳过红线）杀掉。「clean 字节不值得缓存」= post-v1 优化旋钮（provider 标记重取微秒级）；无缓存全案 park，不在红线区做定制手术。folder 模式 dirty 不需活过 session（无离线 + 图库退出自动 ctrl+s）——此事实是旋钮的将来依据，不是 v1 特判的理由。

## 6. MASTER / share-file-model 宪法修订案（草案，⚠ 逐条待 user 过目后才动家族 doc）

1. **IDB 里永远不放任何东西的正本**（§A 新一行）。它只干三件事：图库的本地缓存（丢了从源重拿）、崩溃备份（尽力而为）、这台设备自己的记事本（链接过哪些图库、句柄）。「dirty 永不被驱逐」这条红线管的是**我们自己的代码**——绝不主动清没推完的画；但**浏览器**有权存储紧张时把整个库端掉，这拦不住（A1/A6）。真正的保命三件套：让「没推上去」的时间越短越好（退出自动推）、挂上图库就向浏览器申请「别清我」（persist()）、写代码永远假设 IDB 明天就没了。
2. **share-file-model Home 表修订**：「accountless 文件家住 IDB、never evict」一行 superseded——accountless 的家 = 用户文件系统（文件 / folder gallery）；ScratchPad 孤儿 workbench 行保留（其角色即 crash-shadow）。
3. **folder provider 红线映射**（§A 新节）：etag→(mtime,size)+懒仲裁 hash（hash 永不升格身份）；If-Match→读-比-写（TOCTOU 毫秒窗文档化，唯一并发写手=云盘客户端）；删除=.trash→源内子文件夹（资源管理器可见）；**synced-folder 跨机仲裁委托云盘客户端（冲突副本档位，低于 Graph If-Match）——档位差异必须文档化**。
4. **一源一历史 + 拷贝即分叉**（文件级与 gallery 级统一）：禁止任何源内身份标记（0607 判决延伸到 gallery 尺度）；registry（per-gallery、device-local、永不同步）≠ 0607 否决的 registry（per-file、跨设备同步）——ADR 记区分。
5. **provider 的 `ref` 就是张行李牌**（原 `id` 字段更名）：拿到后这一趟能用（下载/删除/移动都凭它），但它**不代表这个文件是谁**——文件是谁永远看路径。文件被改名/移动后旧牌可能作废，作废就按路径重查一张。OneDrive 的牌恰好很耐用（改名不作废），那是白送的，代码不许依赖。副作用照旧：在外面改文件名，图库里裂成「旧卡消失+新卡出现」——path 身份一直有的已知小疣（wart E），数据不丢，接受不修。
6. **多实例**：`${appId}.${databaseId}` 每源一实例一库；锁/键一律带源命名空间。
7. 指针行：无地环境轴、一画一家、两模式详 WeebPaint `ai-docs/20260825-localfile-knight-grill-verdicts.md`（app 级宪法，家族 doc 只挂指针不复制）。

## 7. 实现顺序

0.3.6（A2/A3 收敛）→ 0.4.0（dispose + dirty facet + `id`→`ref` + provider 多账号形状；exports 打包一次过目）→ folder provider → MASTER 修订落地（§6 获批后）。

### 0.4.0 批实现记录（2026-08-26，Claude Fable 5；**已实现待审版**——版本号未花，等 user 过目 api/ diff）

- **dispose(opts?: {drain?: boolean})**（§1.2）：先拒新调用（`StoreDisposedError`，含 dispose 前已握着的 file/collection 句柄——检查在调用时刻）→ 停 watcher → drain（默认 true，substrate.drain 等全部 serialize 链尾；`{drain:false}`=快拆，in-flight 因连接关闭响亮失败）→ 关 IDB（idb-store 连接 memo 化 + close()，LocalCache 契约加可选 `close?()`）。幂等。
- **dirty facet**（§1.3）：`files.dirty.count()`（标量，与 usage 红线同口径）+ `pushAll()`→`{pushed, failed: string[]}`。**§1.3 未核项已核明：底层「不开文档推 dirty 项」路径此前不存在**（uploadReplay 只管 never-synced float）→ 门面即其新家，建在 pushLocalBytes（vetted push；F0 deferred 不算成功，冲突不级联弹面、名字进 failed）。枚举腿 = durable dirty 轨（`files.dirty:` kv 扫描）。
- **id→ref**（§4 拍板 + 配套三件）：CloudItem.ref（行李牌 JSDoc 语义节）+ provider 全方法参数 + `getApprootId`→`getApprootRef` + CloudSync/TrashItem/RestoreOpts/PurgeOpts 的 `cloudItemId`→`cloudRef`。**dir-index-cache 持久 JSON 键名保持 `id` 不动**（schema v1 零变更，非持久化结构变更）；SW 网关配套「失效重解析」（range 404 → 丢缓存跳过 dir-index 走 Graph 按名重查一次）；404 收敛 = `CloudStaleRefError`（「已被别处动过」族，restore/purge 落地，预存小洞一起堵）。GraphTransport/RawGraphItem 保留 Graph 域 `id` 命名（wire 形状；OneDrive ref=Graph id 是赠品的文档化边界）。
- **多账号形状**（§1.4 ①③库侧）：`OneDriveConfig.homeAccountId?` → token source 钉死该账号（auth.getTokenFor：`pca.getAccountByHomeId` + silent 带 account；失败不动全局 activeAccount）；已知局限 = graph token-source 模块级（同页第二 provider 覆盖前者，现状单 provider/页，真多账号并联归将来批次）。② registry 存账号 id = app 侧（WeebPaint），本批不动。
- 测试：+5（drain/dispose 拒后续/dirty count/pushAll 成败/CloudStaleRefError），364 全绿；真浏览器夹具（连接 memo 后）复跑全过。api/ diff + pack 清单 = 审版材料。
- **→ v0.4.0 已发（2026-08-26 user 过目批准；tag + gh release）。**

### folder provider 实现记录（2026-08-26，Claude Fable 5；**已实现待审版**——新 exports 未花版本号）

- `src/providers/folder.ts`：`createFolderProvider(root) → CloudProvider`，§2 契约逐条落地——eTag=`${mtime}-${size}`；
  回采 mtime 在 `writable.close()` **之后**重读；If-Match=读-比-写（412），blind replace 运行时护栏与 graph 同款；
  ref=path（方案 A，move/rename 后换牌）；大小写解析统一不敏感口径（命中沿用磁盘真实大小写，**逐段**采真名）；
  move：native `handle.move()` 优先、缺则 copy-先-验-后-删源（字节数核对过才删源）；错误形状 `.status` 404/409/412
  与 Graph 对齐 → cloud-sync/push 零改动直接工作（§5「另一朵云」引擎零特判，集成冒烟已证）。
- 句柄类型 = 结构化最小面（`FolderDirHandle`/`FolderFileHandle`/`FolderFile`）：浏览器 FSA 句柄天然满足，
  node fake 可注入（TS dom lib 对 FSA 异步迭代器覆盖不全是次因）。
- **列举过滤的落点偏离 §2 草案一处（有意）**：OS 垃圾（desktop.ini/.DS_Store/Thumbs.db/~$*）本层滤 + 判空时视作可清
  （否则 Windows 自发 desktop.ini 让夹永远删不掉）；`.trash`/`.backup` 等 dot 项本层**照返**——上层 isHidden
  （listing.ts）是既有唯一滤点，本层再滤会挡住 listTrash 列 `.trash` 内部。
- 测试 +8（`test/folder-provider.contract.test.ts`）：fake FSA 刻意 Linux 大小写敏感 + 无 native move，逼出不敏感层与
  copy-验-删源；含 cloud-sync 骑 folder provider 的集成冒烟（push/If-Match/trash 腿）。372 全绿。
- **真机矩阵待验**（§2 拍板项，node 测不到）：native `move()` 支持面（同夹改名/跨夹）、move 后 mtime 保留行为、
  权限中途过期（NotAllowedError）路径。合批到下次真机 session。
- 悬而未做（非本批）：懒仲裁 hash（post-v1 旋钮）；app 层句柄持久化/权限 re-request 手势；WeebPaint 接线归无地 P 系。
- exports 增量（待过目 → 0.5.0 审版门）：`createFolderProvider` + `FolderDirHandle`/`FolderFileHandle`/`FolderFile` 四条，别无变化。
