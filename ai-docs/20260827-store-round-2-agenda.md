# store 轮二 agenda（交下一个 store agent）

> created 20260827 · by Claude Fable 5（WeebPaint P3/P6 收官 session 产出）
> as-of @internal/store v0.6.0 / 2026-08-27。读者 = 新开的 store 仓 agent。

## 起手必读（顺序）

1. 家族 CLAUDE.md 云同步节 + `20260601 MyPWAPatterns/docs/MASTER.md` §A 红线 + **pwa-cloud-store skill**（改库前置纪律：escalate human）。
2. 上轮案卷 `ai-docs/20260825-localfile-knight-store-round.md`（§7 已完结）+ ADR-0024（registry 划界）+ ADR-0025（懒 hash park）。
3. 消费方现状：WeebPaint 已收货 **0.6.0** 并全量接线——`persistence:"app-managed"` 表态 + `requestStoragePersistence` 手势体、**多实例 databaseId 已在产线跑**（P3：每 gallery 一实例 `weebpaint.gallery-<id>`，legacy=defaultStore）、`dispose({drain})` 与 `files.dirty.count()` 是 detach 绿灯门的承重面、folder provider 已接 FSA 真句柄。WeebPaint 侧台账 = 该仓 `ai-docs/20260827-p3-gallery-multiinstance-grill-verdicts.md` + `20260827-p6-single-html-landing.md`。0.4–0.6 收货转达就此闭环。

## 议题（逐条 escalate human，不许自行拍板）

### 1. OneDrive provider per-account pin（P3 余账）

现状：auth 面已有 `getTokenFor(homeAccountId)`（0.4.0 口子），但 **provider 绑 MSAL active account**——WeebPaint 切到非 active 账号的库时只能先交互登录切 active（P3 Q8 拍板「结构支持、UX 不打磨」下可接受）。
需求方向（escalate 设计再动）：provider 级账号 pin（`createOneDriveProvider({ homeAccountId })` 或 per-store 注入），让 attach 非 active 账号库能 silent token。不急——真多账号顺滑才需要。

### 2. 深清 / 无痕扫口子（WeebPaint P7 还原出厂的前置，0825 案卷 §2.10）

app 侧 P7 流程 = 清 registry + 全缓存库 + localStorage + crash/revert ring → **无痕扫**（枚举自家前缀验证归零）→ 打字 consent。store 侧缺两个口子（**先 escalate 口径设计**）：
- **wipe**：删除本 appId 全部命名空间（所有 `${appId}.*` 的 IDB 库 + localStorage 键；含全部 databaseId 实例）。注意与活实例的关系（先 dispose 全部再 wipe？多 tab 并发？）。
- **无痕扫**：残留枚举验证归零。⚠ 与「usage/dirty 永不返名字」红线的关系要 human 裁：枚举**库名/键名**（命名空间层）≠ 枚举**文件名**（内容层）——建议口径=只返命名空间级残留计数/库名，绝不透出文件名，但这是 escalation 题不是你我拍的。
- app 自己的库（crash / gallery-registry / thumbs / device-kv，GUID 前缀 `weebpaint-bd6cece69075d759.*`）由 app 侧自扫，不进 store 口子。

### 3. cloudless collection（{local:true}）物理移除——**协同工单，别抢跑**

清单已在 `ai-docs/20260827-deprecation-cloudless-collection.md`（删 `cloudless` 六分支 + `opts.local` 位 + 测试；exports 变更预计 minor，届时 escalate + 审版门）。
⚠ **前置 = WeebPaint 先清零消费**：现值还有两处（`src/app-store.ts:121-122`）——
- `local-user-preference`：只剩 P5 播种源（`seedDevicePrefsFromLegacy` 的 `_LEGACY_HOME` 读腿）；
- `local-app-state`：`appState.currentFile / restoreAttempt` legacy 读腿（写面已由 resume-slate 接管，读腿是回执条播种源）。
清零 = WeebPaint 侧工单（评估播种期是否可关：存量设备都升过 0.11.10+ 后 legacy 播种可退役）。**等 WeebPaint 清零信号再删**，顺序红线见 deprecation doc。

### 4. 真机矩阵（folder provider）

native move / mtime 语义 / 权限过期表现——已并入 WeebPaint `ai-docs/20260827-device-test-batch.md` 场景 C，user 跑完结果回流本仓记录；假冲突观察 = ADR-0025 懒 hash 的启动条件。

## 纪律提醒（上轮血泪，防退化）

- 红线区改动前 escalate；MASTER §A（无 LWW、处处 If-Match、删除=.trash、冲突必 surface、dirty 永不驱逐）。
- 版本号测试期钉 0.0.0，落地点才花；exports 审**真实 dist + pack 清单**不是提案文字；发版 = user 过目批准。
- eTag 不透明红线：拆解/组件化比较永久禁止（ADR-0025 附案）。
- personal-account-only；翻 audience 必须连 authority 一起改（2026-08-23 坑）。
- 署名制：新文件/commit 署模型名+日期；只签自己。
