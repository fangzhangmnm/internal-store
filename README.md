# @internal/store — PWA 家族云同步引擎

> as-of 2026-08-13 · version 0.0.0（第一版未发：等人类过目真实 exports）
> 种子 = WebPaint `src/store/` @ `01ad115`（溯源见 `src/FORK-BASE.md`）。
> 引擎文档本体随源走：`src/README.md`（API SSoT）· `src/CONTEXT.md`（术语）· `src/DATA SAFETY GUIDELINE.md`（红线）。

## 定位

家族 sync-store 引擎（OneDrive appfolder / 离线优先 / 处处 If-Match / 删除=.trash / 冲突必 surface / dirty 永不驱逐）的**户口本体**。此前引擎 baked 在 WebPaint 里靠互拷传播（drift=毒）；从本仓起：库仓出版本化 tgz，消费方 pin 版本、显式升级。

## 消费方式（自包含不变量）

1. 本仓发版：`npm run release` → `internal-store-<ver>.tgz`
2. 消费方把 tgz 拷进自家仓（约定 `vendor-pkgs/`）**并 commit**——tgz 物理进消费方仓，克隆任一 app 仓断网能构建，上游删库/删号不影响。
3. 消费方 `package.json`：`"@internal/store": "file:./vendor-pkgs/internal-store-<ver>.tgz"`
4. 升级 = 显式换 tgz + 改依赖串。永不 `workspace:*` 跨仓、永不 git 依赖。

## 门牌（exports）

- `@internal/store` —— 唯一主入口（`createStore` 等；机器权威 = 构建产物 `dist/index.d.ts`，**人读的 API doc = `src/README.md`**，分工见 ADR-0023 条 7）
- `@internal/store/testing` —— mock provider / mock local（消费方 app 测试用）
- 其余一律无门牌，deep import 在 resolver 层拒绝。

## 宿主注入契约（库内零 import 的另一面）

- **MSAL**：宿主 vendored `msal-browser.min.js`，路径经 `configureOneDriveAuth({ msalUrl })` 传入（库内 script 注入）。
- **加密 codec**：`{ zipPack, zipUnpack, pack7z, unpack7z }` 由宿主注入；不注入则加密 dormant。参考实现见 `test/fixtures/`。
- **StoreUI**：`busy` / `resolveConflict` / `reportError` / `offlineEscape` 由宿主实现喂入。
- 浏览器全局：`indexedDB` / `localStorage` / `crypto.subtle` / `fetch`。

## 结构

- `src/` — 引擎本体（36 模块 + providers/ + 随源文档；`src/testing/` = mock 替身，走 `./testing` 门牌）
- `test/` — 契约测试 28 件 + 零依赖 runner（实时耗时 / 10s 超时墙）；`fixtures/` 参考 codec；`vendor/` 测试夹具（zip-js + 7z-wasm，不进 tgz）
- `scripts/` — `build.sh`（tsc → dist：.js + .d.ts）· `release.sh`（version=0.0.0 时拒绝发版）
