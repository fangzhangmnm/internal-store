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
