# 改库记录：0.14.0 三件——`files.onRenamed` / 云腿在线 = `isOnline ∧ signedIn` / `config.hiddenName`

> created 20260919 · by Claude Fable 5.1 · as-of 0.14.0 · 起因 = JRB 第三消费者切分审计（`../../20260523 JustReadBooks/ai-docs/20260919-modernization-plan.md` §11）。
> user 2026-09-19 原话：「onRenamed(from, to) 这个不应该是 gallery 的，而是应该是 store 的！gallery 是前端，是前端，是前端，查一下还有什么切分错误的」「计划把改名事件源迁到 store（files.onRenamed），并把"在线"判定改为 isOnline∧signedIn（或排除 auth 类错误可重试）同意」。

## 1. `files.onRenamed(cb): () => void`

- 语义：任何入口的 `file.tryMove` **成功后**同步回调 `(from, to)`（库身份 = 全名；含离线 move 分支；撞名 `ok:false` 不发；监听器抛错 → `ui.reportError(warning)`，不污染改名结果）。dispose 清空。
- 为什么在 store：改名是**身份变更**（MASTER §A「身份 = path/name」），伴生数据（JRB 的阅读位置 / 切章规则、WeebPaint 的缩略图缓存）按路径键，必须跟着身份走；发起改名的可能是图库、编辑器、任何 app 代码——事件源只能在身份的唯一入口。gallery 0.3.1 曾把它做成 `GalleryScreenDeps.onRenamed`，0.3.2 撤。
- 没做：`restoreTrash` 恢复到别名（撞名自动 (2)）也是身份变更，**目前不发**——边缘，等有消费者要。

## 2. 云腿「在线」= `rawOnline() ∧ signedIn()`

- 症状（JRB 冒烟抓到）：未登录、`navigator.onLine=true` 时改一本本地件的名要 1.2s——`nameOccupied` 查云（fetchMeta 抛「Not signed in」）→ `identity.rename` 的 `probeOld` 再抛 → `doPush` 推字节，`push.retriable()` 把「无 HTTP status 的错」一律当可重试：4 次、退避 200+400+600ms → `cloudDeferred`。功能正确，纯白等。
- 修：`create-store.ts` 内 `isOnline = () => rawOnline() && signedIn()`（所有云腿门：nameOccupied / identity / del / offload / reconcile / freshness / keepOffline / encrypt·decrypt·rekey / upload-queue / ensureFolder）。未登录 = 云不可达 → 走各处**已 vetted 的离线分支**（离线 move = 本地 float + 补推入队 + 离线删队列；`pullIfClean` 早退 offline；offload 非法），回线登录后 `drainOfflineQueue` 收敛。列举 ctx 仍分开报 `{signedIn, online: rawOnline}`（登出视角 / 掺快照 判定要区分）。
- 兜底：`push.retriable` 排除 `message === "Not signed in"`（auth 缺席重试也不会好）。
- 红线自查（DATA SAFETY §A）：不动 If-Match、不动 move-aside、不动 dirty 驱逐；只是把「不可能成功的云腿」提前判成离线。407 测绿，无既有测试改期望。

## 3. `config.hiddenName?: (path) => boolean`

- 语义：宿主额外隐藏名，叠在 `is-hidden.ts` 的 dot 规则之上；命中的路径**不进 watchFolder 帧、不进 cloud-gone 收敛**（隐藏项云端本就不列，绝不据此误判 gone）；`nameOccupied` / `open` / `save` 照常看见（一个 `.part` 名仍算占用）。穿到 listing / reconcile / cloud-sync 三处（各自 `isHiddenAny = isHidden ∨ cfg.hidden`）。
- 为什么在 store：「夹里有什么」是列举面的事；写入方半成品 `*.part` / `~*` / `.tmp` 与 v1 遗留 `session.json` 是文件系统噪音不是文档，图库过滤（gallery 0.3.0 `policy.hide`）= 前端替数据层做决定，且每个消费者要再过滤一遍。0.3.2 撤。

## 4. 版本

0.14.0（minor：两个新面 + 一处语义收紧）。user 2026-09-19 拍板 ①②；③ 同一原则顺带，本文即告知。
