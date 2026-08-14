# @internal/store 出生记录 — 从 WebPaint src/store 立户

> as-of 2026-08-13 · 本仓首篇 ai-doc。背景 = v0.9 地基纪元「分仓」第一刀
> （WebPaint `ai-docs/20260810-v08-stabilize-v09-foundation-handoff.md` §4.2/§4.3）。

## 种子与机械改动

- 种子：WebPaint main `01ad1157fe2a0c87656262c476d4e263003ac5e5` 的 `src/store/`（工作区干净时拷贝），逐字节。
- 机械改动（零逻辑改动）：
  1. `mock-provider.ts` / `mock-local.ts` → `src/testing/`（相对 import `./`→`../`），新增 `src/testing/index.ts` 门牌。
  2. `src/FORK-BASE.md` 重写为本仓溯源（WebPaint 端旧 stamp 是 2026-06-19 给 JRP 的脏拷贝，勿信）。
  3. 测试 28 件迁入 `test/`，import `../src/store/X.ts` → `../src/X.ts`（mock → `../src/testing/`）。
  4. 加密契约测试的宿主件收进仓：`test/fixtures/zip.ts`（原 `src/backend/zip.ts`，零 import）、
     `test/fixtures/sevenzip.ts`（原 `src/sevenzip.ts`，仅 vendor 类型 import 改深一级）、
     `vendor/zip-js` + `vendor/7z-wasm`（测试夹具，不进 tgz）、`test/zip-node.mjs` 路径同步。
- 留在 WebPaint 的测试（app 味）：`app-state` / `brush-rack-reactive` / `store-absent` / `boot-restore` / `editor-session` / `name-normalization`。

## 已知 app 残留（过目关卡逐条拍板，出生版未动）

1. `src/providers/auth.ts:76` — 硬编码 `window.dispatchEvent(new Event("wp:auth-changed"))`（WebPaint 命名空间）。修法候选：事件名进 `configureOneDriveAuth` 配置 / 换回调。**接口改动，human 拍板。**
2. `src/crypto-container.ts:77` — `CONTAINER_PEEK_ENTRIES` 硬编码 `"thumb"`（WebPaint v233/234 老容器兼容名）。
3. `src/providers/graph.ts:2` — 注释误写 `Apps/AtlasMaker/`（代码本身 generic，走 approot）。
4. 文档清洗项（不影响运行）：`src/README.md` 等约 9 处「笔架」字样、~30 处 WebPaint/.ora/JRP 字样。

## 未决 / 待办

- [ ] ★ 过目关卡：真实 `dist/index.d.ts` + `pnpm pack --dry-run` 清单 + resolve 冒烟 → user 拍板残留与 exports → 才写 0.1.0 + tag + 建 gh public 仓。
- [ ] license 字段现为 UNLICENSED——public 仓要不要挂正式 license，user 拍板。
- [x] WebPaint cutover：**完成（WebPaint v0.9.1，2026-08-14 已推 dev）**——src/store/ 删除、file:vendor-pkgs tgz、lint 改 bare-specifier、28 件重复测试随库走（961+297=1258 对账绿）；wp:auth-changed 由接缝 app-store.ts 派发。
- [ ] JRP 副本收敛（分叉 32 文件 + JRP 独有 `settings.ts`，另案）。
- [x] pull-package 脚本：**已立（2026-08-14）**——`scripts/pull-package.sh`（消费方仓根运行；只认已 tag 版本，gh release 正货优先；WebPaint 实测幂等 + 拒收未发版/拒在库仓跑）。Changesets 暂不引（单人单库，release.sh 够用）。

## 拍板落地记录（2026-08-13 过目第一轮后）

user 十条拍板，全部已落地（除建仓）：
1. **仓位修正**：挪到 PWAProjects 根 `20260813 internal-store/`（原误放 MyPWAPatterns 内）。CLAUDE.md 相对路径已同步。
2. **MIT license** 已落（LICENSE + package.json）。
3. **`wp:auth-changed` window 广播已删**（auth.ts `_emitAuth`）——订阅走本就暴露的 `createOneDriveProvider().auth.onAuthChanged` 回调，零新接口、零 browser 事件机制。消费方 cutover 时如仍要 window 事件，自己在回调里派发。
4. **`"thumb"` peek 兼容名已拔**（greenfield）：`CONTAINER_PEEK_ENTRIES=["peek"]`。前身 v233/234 老容器 peek 不再被认（正文仍可解）；兄弟项目 import 时自适应。
5. **AtlasMaker 注释已修**（graph.ts → `Apps/<应用注册名>/`）。
6. **中性化洗稿完成**（~110 处）：纪律=例子中性化（preset-rack/builtin-presets.json/X.dat/app-a·app-b/裸名宿主·全名宿主·加密宿主）、**出处保真名**（WebPaint ai-docs/11、事故记录、DATA SAFETY 引用不动）；对照表在 src/FORK-BASE.md。OLD-ENGINE.md（纯前身史料）删除。
7. 297 测试全绿（thumb 拔除后回归通过——老容器兼容测试用的本就是 "peek" entry）。

未决：user 看完 dist/index.d.ts → 写 0.1.0 → `gh repo create internal-store --public` + tag（等 user 发话）。
