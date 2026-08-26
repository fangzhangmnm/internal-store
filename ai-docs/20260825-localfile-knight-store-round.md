# 无地骑士 store 轮——拍板记录 + folder provider 契约草案

> created 20260825 · as-of v0.3.5 / 2026-08-25 · by Claude Fable 5
> 上游：WeebPaint `ai-docs/20260825-localfile-knight-grill-verdicts.md`（§5 agenda）。
> 本文 §1-2 = user 已拍板；§3 = 契约草案 v1（**id 选型待 §4 审计回填后定稿，user 过目后才动码**）。
> 持久化结构变更纪律：每项动手前逐个上报 user（家规）。

## 1. 拍板记录（user 2026-08-25）

1. **A2/A3 事务收敛**：`idb-store.ts` 三种事务形状 → 一个 helper：readwrite resolve 只认 `t.oncomplete`，reject 接 `t.onerror` + `t.onabort`（QuotaExceededError 走 reportStoreError）；readonly 同 helper。防回归：① 语法扫描测试（`db.transaction` 只许在 helper 内，抄 ifmatch-guard 手法）；② 真浏览器夹具从 tag `opus-round-20260821-before-rollback` 取 `tools/idb-tx-commit-check.mjs` 当参考重造（当晚变异测试判定诚实）；**不 vendor fake-indexeddb**（quota abort 模拟不可信，假绿危险）。GUIDELINE 重写正确版并记冤史。→ patch **0.3.6**（无 exports 变化）。
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

**选型建议（AI 推荐，⚠ 待 user 拍板）：方案 A，path-as-id**——「改名即换 id」文档化；与 store 宪法（身份=path）同构，B 全弃。配套三件：SW 网关失效重解析、404 错误族收敛、契约文档 id 语义节。

## 5. 后续

宪法修订案（MASTER §A：IDB 降级、无地环境轴、folder backend 红线映射、拷贝即分叉）待本文定稿后起草，user 逐行过目。实现顺序：0.3.6（A2/A3）→ 0.4.0（dispose+dirty+多账号形状）→ folder provider。
