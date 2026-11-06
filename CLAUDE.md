# 20260813 internal-store — 本库规则（@internal/store）

家族总规则见 `../CLAUDE.md`。这里只写本库特有的。

- **本库 = 家族云同步 store 引擎的户口本体**（2026-08-13 从 WebPaint `src/store/` 立户，种子见 `src/FORK-BASE.md`；此前 MyPWAPatterns `sync-store/` 只是空壳 README）。红线 = MASTER §A（`../20260601 MyPWAPatterns/docs/MASTER.md`，该仓 sunset 后随迁）：无 LWW、处处 If-Match、删除=移到 .trash、冲突必 surface、dirty 永不被驱逐。**改引擎逻辑前 escalate human**（pwa-cloud-store skill）。
- **只出货不送货**（对齐 Colors/SVG Icons 契约）：交付物 = `npm run release` 出的 `.tgz`，不发 npm registry。消费方自己收货：在消费方仓根跑 `scripts/pull-package.sh`（只认已 tag 版本；tgz 落 vendor-pkgs/ 走 `file:` 依赖 + npm install，测试/commit 归宿主）（自包含不变量：克隆任一 app 仓断网能构建）。宿主 pull，本库永不 push。
- **版本纪律（2026-08-13 user）**：开发期 version 钉 `0.0.0`，不 tag、不出 tgz；版本号只在人类过目**真实 exports**（dist/index.d.ts 全文 + `pnpm pack --dry-run` 清单）通过后才写、才花掉。有消费者 pin 之后，改名/删导出 = 跨仓契约变更，escalate。**bump minor 之前必须 user 批准**（2026-09-19 user「所有的内部库想要bump minor之前都找我批准」，全部 `@internal/*` 适用）。edited by Claude Fable 5.1 2026-09-19
- **exports 门牌**：`.`（主入口）+ `./testing`（mock 替身）两个，其余模块 resolver 层拒绝 deep import。**加门牌 = 接口变更，human 拍板。**
- `vendor/` 是**测试专用夹具**（zip-js + 7z-wasm 喂加密契约测试），不进 tgz；引擎运行时 codec 由宿主注入，库内零内容格式知识。
- 测试 `npm test`（node runner，实时耗时 + 10s 超时墙）；构建 `npm run build`（tsc → dist）。
- `journal/` 人类区，AI 永不写（家规硬规则 #2）。
- **行为变更默认关、消费方显式开（2026-10-15 user「123同意」，起因 = KudsRocket 的体量 / 频率和画画完全不同，user「非常怕家族文件的那些app开始丢画」）**：
  ① 传输层 / 重试这类**行为**变更一律做成 `createOneDriveProvider({ transport })` / `createStore({ pushRetry })` 这样的显式开关，默认 = 变更前的行为；
  ② KudsRocket 这种大文件高频消费方专属的东西（流式上传、暂存区、将来的 delta 列举 / 索引文件）做独立模块或独立包，艺术类 app 永不 import；
  ③ 每个版本的发版说明（ai-docs/<日期>-<版本>-*.md）单列「行为差异」，艺术类 app 升级时逐条过、不默认接受。钉版本是现有的隔离墙（WeebPaint 钉 0.13.0）。edited by Claude Fable 5.1 2026-10-15
  ②′（2026-10-17 深夜，user「艺术类 app 不传 streaming 也许需要视频参考呢」；edited by Claude Fable 5.1）：② 说的是**作品那台引擎不为大文件消费方改行为**，不是艺术类 app 不许用流式面——流式面是三等资源的通用面（电台的音乐、参考窗的视频、KudsRocket 的大文件），任何 app 都可以开 `createStore({ streaming })`。
  ④ **真要默认开一条行为变更，发版说明里先写「为什么这条不走默认关」**（2026-10-21 user 追认 0.18.0「干净副本接谱系」默认开时：「默认开，下次遇到同样的问题还是需要想清楚」——那条当时没写理由、事后被审计问出来）。写不出理由就默认关。edited by Claude Opus 5.5 2026-10-21
  ⑤ **脏副本谱系丢了（刷新 + 登录前恢复）不许盲推**（2.2.1，2026-10-26 user「修，默认开」）：推之前先问云端，云端还是这份字节同步到的那一版才重捕谱系、带 If-Match 推；真动过直接走冲突面；面上的 cloudState 必须是问出来的，不许写死。起因 = CatsUp 正常编辑天天弹假的「云端有新版本」（家族根 ai-docs/20261026-cloud-conflict-ux-postmortem.md）。added by Claude Fable 5.1 2026-10-26
  ⑥ **open 也做回执丢失自愈、改名撞上谱系不明先问人**（2.2.2，2026-10-26 user「批，库出 2.2.2」「同意，反正不删就行了」）：脏 ∧ 云端版本号不同 → 大小一样才拉来逐字节比，一样就认领不弹面，拉的过程可被「跳过到离线」打断（慢网不许卡死人 = 创世承诺，安全模型 A19）；改名 / 移动在动字节前问 `ui.resolveRenameOld`「搬走旧的（进回收站）/ 留着旧的 / 取消」，宿主没接 = 默认留着 + oldKept。added by Claude Fable 5.1 2026-10-26
  ⑦ **「处理…」弹面之前也做回执丢失自愈**（2.2.3，2026-11-03 user「1 可以」；家族周账 F-142）：`file.resolve()` 算出云端版本号变了、本机还脏 → 先拉云端逐字节比，一样就认领不弹面（和 push 路 412 / open 路 2.2.2 同一条规则）；不一样才弹。默认开的理由在发版说明 `ai-docs/20261103-2.2.3-resolve-heals-before-sheet.md` §3。added by Claude Fable 5.1 2026-11-03
  ⑧ **`file.save` 也守 isOnline + 列表条目带 `cloudSealed`**（2.2.6，2026-11-04 user「列表带加密可以」「库自己守同意」）：宿主说离线时 save 不再发那个注定失败的 fetchMeta / upload（结果和推了没成一样：留 dirty、补推队列照入、reason "offline"）；列举时云端名经 toName 变了名 = 加密容器 → `Item.cloudSealed: true`（零多余请求，不碰 badge），给 gallery 当「加密态」第三路。默认开的理由在 `ai-docs/20261104-2.2.6-save-offline-and-item-cloud-sealed.md` §3½。added by Claude Fable 5.1 2026-11-04
  ⑨ **`dispose` 收掉 collection 的定时器并落盘、在飞的目录帧自退**（2.2.7，2026-11-05 user「1 修」；家族周账 F-199）：drain = 排着的本地写先落盘再关，快速拆除 = 只取消、一步不等、只进黑匣子；排着的云推取消，下次开库补推；释放后迟到的帧不投、不写缓存、不叫 `onError`、只进 `log`。释放前的失败照常响亮。默认开的理由在 `ai-docs/20261105-2.2.7-dispose-closes-collections-and-inflight-frames.md` §3½。added by Claude Opus 5.5 2026-11-05
  两台引擎（作品：cloud-sync / push / local-head / safe-resolve…；资源：download-session / chunk-scheduler / mirror / sw）**互不 import、只共用底座**，`test/engine-boundary-guard.test.mjs` 机械执法；是否物理拆成 cloud / store / stream 三包（= 3.0.0）未定，见 `ai-docs/20261017-2.0.0-streaming-lanes-stall-mirrors.md`「为什么是 major」。
  **源码三个夹 = 底座 + 两台引擎（2.1.1，2026-10-17 深夜 user「做」）**：`src/base/`（底座：provider / graph / auth / IDB / 身份语法 / 错误 / 类型）、`src/works/`（作品引擎）、`src/stream/`（资源引擎，含 `sw/`）；顶层只有组合根 `create-store.ts` / `index.ts` 和 `testing/` 替身。**新文件先想清进哪个夹**——不进夹、或跨夹 import，守卫直接红。真拆包那天三个夹就是三个包。
