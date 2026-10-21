# 2026-10-21 晚·库道（道 1）版本链索引

> created 20261021 by Claude Fable 5.1 · 周账 `weekly/20261021-family-todo.md` §6 道 1 + user 当晚追加（「weebpaint 需要的后台传大文件优先……store 做 gallery 做 encryption 做」）· 全部已 push、gh release 带 tgz；统筹稿 = 家族根 `ai-docs/20261021-lane-merge-phase.md`。下周周账整理时从这页收。

| 包 | 版本 | 内容一句话 | 发版说明 |
|---|---|---|---|
| store | 2.1.3 | 镜像抽样核对并发下几乎不抽 → 节拍在到达那一刻定 | `20261021-2.1.3-mirror-sampling-tick.md` |
| store | 2.1.4 | F-19 加密稿丢回执自愈（推的就是落本机那份密文）+ F-54 上传会话落盘 `uploads.resumable`（默认关） | `20261021-2.1.4-f19-heal-f54-resumable-upload.md` |
| store | 2.1.5 | streaming 模式 staging 按块淘汰 + 钉热集 | `20261021-2.1.5-staging-block-eviction.md` |
| store | **2.2.0**（minor，user「store minor」追认） | staging 分库 `${appId}.${databaseId}.staging` + 第一条真迁移 v001；authority 默认 /consumers、别的拒；`streaming.verifyChunk` 宿主哈希表核对钩子（F-63 / W-44） | `20261021-2.2.0-staging-split-authority-consumers.md` |
| gallery | 0.8.6 | ghost 行「丢弃」→「处理…」；搁置区「清空」钮 | gallery `ai-docs/20261021-0.8.6-ghost-resolve-empty-aside.md` |
| gallery | **0.8.7** | `configureGalleryRegistry({ dbName })` | gallery `ai-docs/20261021-0.8.7-registry-dbname-configurable.md` |
| workbench-elements | **0.1.3** | popup-menu 外点关「子弹层不算外面」 | 该仓 `ai-docs/20261021-0.1.3-nested-popup-not-outside.md` |
| encryption | 0.2.2 不变 | 无头 Chromium 探针 15 条（`npm run probe`）；ADR-0001 第 9 / 10 条定案 | 该仓 `ai-docs/adr/0001` |
| prefetch | 0.1.1 不变 | 审过无缺陷 | `20261021-f61-library-audit.md` |
| reference-window | 0.4.4 不变 | 账本 + lane 7 交接稿；仓归 lane 7 | 该仓 `ai-docs/20261021-ledger.md` / `20261021-handoff-lane7.md` |

审计两篇：`20261021-f61-library-audit.md`（10-17/18 那批）、`20261021-decisions-audit-store-gallery.md`（既有决策全审；§7 五条 user 当晚全答）。

收包：WXHW v2.3.50 已收三包全绿（F-19 在 e2e 跑绿）；WeebPaint / JRB / MoonSinger / KudsRocket 各道收尾时收。KudsRocket 收 2.2.0 要改 SW 网关 dbName 成 `.staging` 库；W-30 建议销账。

user 当晚定的、落在别处的：口令面板改真表单让 Edge 密码管理器记（全家做，统筹派 WeebPaint / WXHW / KudsRocket）；「面外方向动词拿掉的设计不一定好」下周周账讨论；不帮用户生成口令（ADR-0026 骰子作废）。
