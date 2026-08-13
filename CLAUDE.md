# 20260813 internal-store — 本库规则（@internal/store）

家族总规则见 `../CLAUDE.md`。这里只写本库特有的。

- **本库 = 家族云同步 store 引擎的户口本体**（2026-08-13 从 WebPaint `src/store/` 立户，种子见 `src/FORK-BASE.md`；此前 MyPWAPatterns `sync-store/` 只是空壳 README）。红线 = MASTER §A（`../20260601 MyPWAPatterns/docs/MASTER.md`，该仓 sunset 后随迁）：无 LWW、处处 If-Match、删除=移到 .trash、冲突必 surface、dirty 永不被驱逐。**改引擎逻辑前 escalate human**（pwa-cloud-store skill）。
- **只出货不送货**（对齐 Colors/SVG Icons 契约）：交付物 = `npm run release` 出的 `.tgz`，不发 npm registry。消费方自己把 tgz 拷进自家 `vendor-pkgs/` 走 `file:` 依赖并 commit（自包含不变量：克隆任一 app 仓断网能构建）。宿主 pull，本库永不 push。
- **版本纪律（2026-08-13 user）**：开发期 version 钉 `0.0.0`，不 tag、不出 tgz；版本号只在人类过目**真实 exports**（dist/index.d.ts 全文 + `pnpm pack --dry-run` 清单）通过后才写、才花掉。有消费者 pin 之后，改名/删导出 = 跨仓契约变更，escalate。
- **exports 门牌**：`.`（主入口）+ `./testing`（mock 替身）两个，其余模块 resolver 层拒绝 deep import。**加门牌 = 接口变更，human 拍板。**
- `vendor/` 是**测试专用夹具**（zip-js + 7z-wasm 喂加密契约测试），不进 tgz；引擎运行时 codec 由宿主注入，库内零内容格式知识。
- 测试 `npm test`（node runner，实时耗时 + 10s 超时墙）；构建 `npm run build`（tsc → dist）。
- `journal/` 人类区，AI 永不写（家规硬规则 #2）。
