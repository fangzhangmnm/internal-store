# store + gallery 既有决策审计（user 2026-10-21「store 和 gallery 所有之前拍的都好好审计一下」）

> created 20261021 by Claude Fable 5.1 · as-of store 2.2.0 / gallery 0.8.7 · 方法：每条决策 → 代码在哪守 → 测试在哪钉 → 状态。只读源码 + 全套测试（store 516 / gallery 177 全绿）。没有真机。
> 姐妹篇：`20261021-f61-library-audit.md`（10-17/18 那批改动的审计）。

## 0. 结论一页

- **守住的**：MASTER §A 十行 + §A 修订五条；store ADR 0004 / 0007 / 0009 / 0012 / 0014 / 0015 / 0016 / 0017 / 0018 / 0020 / 0021 / 0022 / 0024；0.17.2–2.1.5 发版说明里的行为；gallery 0.5.0–0.8.5 的每条 CLAUDE.md 决策。
- **查出来、今天修掉的**（五条）：① MSAL authority 库默认值是 `/common`（家规 #7 禁；八个 app 都显式传 `/consumers` 所以没炸）→ **2.2.0** 默认 `/consumers`、别的直接拒；② 镜像抽样并发漏抽 → **2.1.3**；③ 加密稿双重封包、丢回执自愈比不出（A3）→ **2.1.4**；④ gallery ghost 行还留着面外方向动词「丢弃」→ **0.8.6**；⑤ store README「清空备份箱暂无 gallery UI」过时 → 改。
- **已过时 / 待销账**（§6）：ADR-0002、0025 已标 superseded 且代码无残留；ADR-0012「口令只在内存」10-17 已注吃书；ADR-0019 的 v001 webpaint-anchor 2026-07-13 随「无用户无后向兼容」清掉、今天第一条真迁移另起 v001-20261021（staging 分库）；KudsRocket W-30「只丢掉这台的改动」被 0.18 的 `resolve()` 三选一顶掉，建议道 5 销账；ADR-0026 不过时（§6）。
- **要 user 定的**（§7）：0.18.1 `openLineageFromDurable` 默认开 vs 库政策「行为变更默认关」；gallery 文案里剩下的方向动词（「拉取到本地」「卸载本地」「留一份离线」「送到回收站」）是不是都算「面外」。

## 1. MASTER §A 十行 → 库里谁在守

| §A 行 | 守在哪 | 测试 | 状态 |
|---|---|---|---|
| 两设备离线各改 → LWW 静默吃掉一边 | 内容无 LWW：`push.ts` 每推 If-Match；412 → `safe-resolve` 面三选一，输家进 `.backup` | `push.test.ts` / `safe-resolve.test.ts` / `cloud-write-ifmatch`（7）/ `ifmatch-guard`（4，全库 If-Match 语法护栏） | 守住 |
| 同机多 tab 旧 tab Ctrl+S 盖新 tab | per-name serialize + If-Match；A4 本地互覆护栏（rev 对表、对方字节先备份） | `local-conflict-guard`（6）/ `edit-race` | 守住 |
| 时钟偏差让 LWW 判错 | 没有 LWW；分叉由 eTag 判 | 同上 | 守住 |
| 未推的本地改动被缓存驱逐 | `offload.ts`：只驱逐 clean ∧ re-fetchable；dirty 永不驱逐；2.1.5 按块淘汰只动 staging（三等） | `offload`（9）/ `staging-block-eviction` | 守住 |
| 上传中断 → 云端半成品 → 下次 pull 盖掉好的本地 | Graph 上传会话最后一块落地才成文件；提交前核 eTag（续上的会话一律核）；F0「落地未确认不算成功」 | `graph-upload-resilience` / `graph-upload-session-resume` / `push.test`（deferred） | 守住 |
| delete-vs-edit 合并丢东西 | edit-wins；删除 = move-aside 进 `.trash`，冲突必 surface | `delete.test` / `trash.test` / `trash-merge` / `pending-gone` | 守住 |
| 云端 dedup / 改名 / 扫描搬了文件 | 身份 = 路径；无内容哈希身份（ADR-0025 弃案，源码 grep `lazyHash / contentHash / baseHash` 零） | `identifiers` / `restore-naming` / `identity` | 守住 |
| 「同步成功」其实写错账号 / 文件夹 | 库没有 `currentPath` 这种幻影状态；破坏性操作按句柄实际身份走；账号钉 `homeAccountId`（OneDriveConfig） | `identity` / `store-cloud-naming` | 守住（phantom-path 那半是 app 层宪法） |
| 冲突化解静默丢一边 | 永不硬覆盖；keepMine 输家进 `.backup`（二等自动备份除外 = user 拍的等级表） | `safe-resolve` / `doc-tiers` | 守住 |
| 冷启动读到半写文件 | app 层（ADR-0008 / 0010 的 ready-gate / crash-shadow）；库只保证 IDB 写 oncomplete 才算成功 | `idb-tx-guard`（9） | 不在库（app 守） |

§A 修订（2026-08-25）：① IDB 永不放正本 → 本机缓存 re-fetchable + dirty 受护（同上）；② folder provider etag = (mtime,size)、hash 永不升格为身份 → `folder-provider.contract`；③ 一源一历史、registry per-gallery device-local → gallery `gallery-registry`（0.8.7 库名归宿主、仍 device-local 不同步）；④ `ref` 是行李牌不是身份 → `CloudItem.ref` 只用于这一趟；⑤ 多实例一源一库 → `storeNamespace`（2.2.0 加 `.staging` 撞库守卫）。

## 2. store ADR 逐条

| ADR | 决策一句话 | 现状 |
|---|---|---|
| 0002 content model | superseded by 0007 | 已标 ✓ |
| 0004 session reconcile | 不阻塞启动、时间戳只做 advisory | `reconcile.test` ✓ |
| 0007 Home axis + consent-on-commit | 推 = 用户动作（save / consent），库不自动推作品 | `save` 有 `tryPush:false`、`uploadReplay` 策略 ctor 必填 ✓ |
| 0008 workbench = RAM 影子 | app 层 | 不在库 |
| 0009 conflict model：两条 check 向量、override 旋钮、`.backup` | push 412 + open 时云端更新 → 面；weak-override 进 backup | `safe-resolve` / `store-open-conflict` ✓ |
| 0011 四形状 → 两形状、rack 是文件夹 | collection + file 两面 | `collection.test` ✓ |
| 0012 三层加密容器 + 密文 peek | `seal.ts` + encryption 端口；**「口令只在内存」那行 10-17 吃书**（记住口令住 encryption 库 ADR-0001） | `seal.test` / `enc-at-rest` / `enc-rekey` / `enc-lost-response-heal`（新）✓ |
| 0014 有状态权威、pin = 不驱逐、ghost | dirty → 本地权威；clean → 云端静默快进；ghost 行走面（gallery 0.8.6） | `freshness` / `open-lineage` / `resolve` ✓ |
| 0015 trash / backup 两套同层、不跨网搬 | `trash.ts` + `trash-merge` + `aside`（gallery 搁置区抽象） | `trash` / `trash-merge` ✓ |
| 0016 clean 静默快进、dirty 才面 | `freshness.ts` | `freshness` ✓ |
| 0017 前台新鲜度 + 陈旧锁 + 手动刷新 | `freshness.ts` + `fresh-hints`（0.17.0 watchFolder 帧当证据） | `freshness` ✓ |
| 0018 离线上传回线补推 | `upload-queue.ts` + ctor 策略 auto / ask / manual | `upload-queue` ✓ |
| 0019 名字锚 JRP + 显式版本迁移 | 体系在（`migration.ts`）；v001 webpaint-anchor 07-13 清掉；**今天第一条真迁移 v001-20261021** | `migration` / `staging-split` ✓ |
| 0020 dirty 默认 clean、两条轨 | `local-head`（files）/ `cloud-sync`（collections） | `local-head` / `cloud-sync` ✓ |
| 0021 app 四面、永不碰 kv | 库面只有 file / collection / localSettings / syncedSettings；app 侧结构守卫在各仓 | `store-narrow-waist`（16）✓ |
| 0022 scope AppFolder 永久 | `auth.ts` SCOPES 常量；**authority 默认值今天才改成 /consumers（2.2.0）** | `staging-split`（authority 三条）✓ |
| 0024 registry per-gallery device-local | gallery `gallery-registry.ts`（IDB、不同步） | gallery `gallery-registry.test` ✓ |
| 0025 懒 hash 弃案、eTag 拆解永禁 | 源码无 hash 身份；eTag 只整串比 | grep 零 ✓ |
| 0026 口令来源 | 方向定了、app 层未做（§6） | 不在库 |

## 3. 发版说明里的行为（0.17.2 → 2.2.0）

0.17.2 传输层开关默认关 ✓（`GraphTransportOptions` 不传 = 0.17.0）；0.18.x `resolve()` / pendingGone / cloud-reappeared ✓（`resolve` / `pending-gone`）；2.0.0 流式开关、车道、卡住对冲、镜像第一片核对 ✓（`chunk-scheduler` / `mirror` / `download-session`）；2.1.0 等级表三处判定 ✓（`doc-tiers`，姐妹篇 §1-6）；2.1.1 三夹结构守卫 ✓；2.1.2 `trash()` 无别名 ✓；2.1.3–2.2.0 今天的（各自发版说明）。

## 4. gallery CLAUDE.md 决策逐条

| 决策 | 现状 |
|---|---|
| 0.5.0 回收站 / 备份箱 = 同一抽象「搁置区」，别处不许写 `kind === "backup"` 分支 | grep 源码：`aside.ts` 之外零处 ✓ |
| 0.6.2 弹层归深模块（卡片 ⋯ 菜单 Teleport 进 band） | 模板里全是 `<Teleport :to="menuMount">` ✓ |
| 0.7.0 `tile.aspect` 是一个数 | ✓ |
| 0.7.1 冲突面主按钮「云端覆盖本地」、云端在前 | 文案 + 0.8.1 走 store 面 ✓ |
| 0.8.0 tileAction / facts | ✓ |
| 0.8.1 删「推送到云端」「重新上传」方向动词 → 只剩「处理…」 | grep 源码：`reupload` / 推送到云端只剩注释 ✓ |
| 0.8.3 pendingGone 行只剩「处理…」；ghost 行**没动** | **0.8.6 补上**：ghost 行 = 「处理…」+「重命名留存」 ✓ |
| 0.8.4 模板构建时编好 + 守卫 | ✓（姐妹篇记的小坑：只认 helper 不认 Vue 版本，全家都是 3.5.35） |
| 0.8.5 `trash()` | ✓ |
| 版本纪律：minor 要 user 批 | 今天两版都是 patch ✓ |

剩下的文案里还有四个带方向的动词：「拉取到本地」`gal.pullLocal`、「卸载本地」`gal.unloadLocal`、「留一份离线」`gal.keepOffline`、「送到回收站」`gal.toTrash`。它们不是冲突化解（拉 = 取副本不改谱系；卸载 = offload 只对 clean；留离线 = keepOffline；送回收站 = 正常删除），我判不属于 10-16「面外方向动词」那一类——**但要 user 一句话定**（§7）。

## 5. 「彻底删除 = 点了之后变成新的」（user 10-21）

库侧已经有 `wipeAppNamespace({ appId, consent })`（`maintenance.ts`，2026-08-28 user 拍板打字确认在库内比对）：删 **`${appId}.` 前缀下一切**——IDB 库（files / trash / backup / collections / staging / sw-bridge；2.2.0 分出去的 `.staging` 库也在前缀内，测试已钉）+ 同前缀全部 localStorage 键（dirty / etag / upload-session / settings / database-version）。**不看 dirty**（变成新的就是变成新的），枚举不了库的平台如实报 `databasesSupported:false`，被别的标签页堵住报 `blockedDatabases`。user 以前说的「清空缓存」被 app 侧接成了「只放掉可重取副本」（KudsRocket `clearLocalCopies`）——那是 app 层接错，不是库缺。

app 侧接法（给各道）：`files.dirty.count()` 先拿个数给人看 → `store.dispose()` → `wipeAppNamespace` → app 自己命名空间（`<app>-<guid>.*`：记住口令 / 盘名缓存 / device-kv / gallery-registry）自扫自删（清单 = 道 6 的 IDB 盘点）→ 只注销自己的 SW、只删自己前缀的 Cache → reload。

## 6. ADR-0026「口令来源」是什么、还要不要；别的 obsolete

**是什么**：2026-09-09 的方向——用户的口令从哪来。不是人脑、不是纸，而是 ① 密码框旁一个骰子按钮生成 6 词短语（提供不强制），② 短语本身就是 7-Zip 字面密码（anti-abandonware 不破），③ 默认托管给浏览器 / 平台的凭据管理器（Safari / Edge / iCloud 钥匙串 / Google 密码管理器——把钥匙交给已经看得见明文的一方不新增信任；密文在微软、钥匙在苹果 / 谷歌 = provider split），④ 纸 opt-in。落地清单全在 app 层：口令面板改成真 `<form>` + `<input type="password" autocomplete>`（浏览器才会弹「要保存密码吗」）、不禁粘贴、骰子、显示 / 复制。你当时说「今天不用急着做」。

**记住口令之后还要不要**：两件事解决的不是同一个问题。「记住」（ADR-0001）= **这台设备**不用重输，30 天作废，**不帮你找回口令**；0026 解决的是 **A11「忘了口令 = 加密稿永远打不开」**（安全模型里唯一标「设计如此」的硬损失）——口令住在跨设备同步的凭据管理器里（你 iPad / PC 都用 Edge，它的密码管理器是同步的），换设备、30 天过期、设备丢了都还能找回。所以：**不过时，但可以瘦**——凭据管理器那半（真 `<form>` + autocomplete）值得做，骰子生成短语是锦上添花、随意；纸那条 opt-in 本来就不强制。要不要排、排给谁，你定。

**别的已被后来拍板顶掉的**：
- ADR-0002（content model）→ 0007 顶掉，已标。
- ADR-0025（懒 hash）→ 08-28 弃案，已标，代码零残留。
- ADR-0012「口令只在内存、永不持久化」那一行 → 10-15 / 10-17 吃书（ADR-0001 记住口令），10-17 已加修订注。
- ADR-0019 的 v001「webpaint-anchor」搬迁 → 07-13「无用户无后向兼容」清掉，没做过也不用做；今天 v001-20261021 另起。
- KudsRocket wishlist **W-30**「只丢掉这台的改动」（10-14）→ 被 0.18 `file.resolve()` 三选一（10-16 你「我要的就是本地覆盖云端和云端覆盖本地二选一」）顶掉；建议道 5 销账。
- KudsRocket 10-16 提过的 `file.takeCloud()` → 你当场否决，库里没有。
- 周账 F-19 里写的两条「根治」（推路径记明文哈希 / 自愈时比解开后的明文）→ 2.1.4 用更简单的修法（推本机那份密文）顶掉，不用再提。

## 7. 要 user 定的

1. 0.18.1 `openLineageFromDurable` **默认开**（`create-store.ts:733` `?? true`）——库政策是「行为变更默认关、消费方显式开」（10-15）；这条是 10-16 发的，默认开有没有你的话我今天没去语料核。要么核出出处记上，要么改成默认关让 WXHW / KudsRocket 显式开。
2. gallery 四个带方向的动词（§4 末）算不算「面外」。
3. ADR-0026 瘦身后要不要排（§6）。
