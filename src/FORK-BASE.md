# FORK-BASE — 本仓 = 引擎户口本体（SSoT）

- fork_base_repo: `20260524 WebPaint`
- fork_base_path: `src/store/`
- fork_base_commit: `01ad1157fe2a0c87656262c476d4e263003ac5e5`
- copied_on: `2026-08-13`
- 拷贝方式：逐字节；唯二机械改动 = ① `mock-provider.ts`/`mock-local.ts` 挪进 `src/testing/`（相对 import 同步改，另新增 `src/testing/index.ts` 门牌）② 本文件重写。
- ⚠️ WebPaint 端 `src/store/FORK-BASE.md` 是 2026-06-19「WebPaint→JRP」的旧 stamp 被误拷回去的脏文件，勿当 merge base 依据；自本 commit 起以本文件为准。
- cutover 前过渡态：WebPaint / JRP / Canary 各自的 baked copy 仍在原地运行；本仓发版后消费方逐个切 `file:` tgz。
- 洗稿约定（2026-08-13 中性化，user 拍板「洗成中性词但要中性例子」）：注释/文档里「**前身引擎**」= WebPaint `src/store/`（种子 commit 如上）、「**前身宿主**」= WebPaint/JRP 等 baked 消费者；`preset-rack` / `builtin-presets.json` / `X.dat` / `app-a·app-b` 均为中性示例词，非真实兄弟项目名。真实**出处引用**（如 `WebPaint ai-docs/11`）保留真名——引用是溯源，不是残留。
- 同日拔除（user 拍板 greenfield）：`wp:auth-changed` window 广播（订阅走 `auth.onAuthChanged` 回调，门牌本就暴露）；crypto-container `"thumb"` 老 peek 兼容名（前身 v233/234 老容器 peek 不再被认，正文仍可解）。OLD-ENGINE.md（纯前身历史文档）删除，WebPaint git 史里永存。
