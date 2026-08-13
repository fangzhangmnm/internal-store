# FORK-BASE — 本仓 = 引擎户口本体（SSoT）

- fork_base_repo: `20260524 WebPaint`
- fork_base_path: `src/store/`
- fork_base_commit: `01ad1157fe2a0c87656262c476d4e263003ac5e5`
- copied_on: `2026-08-13`
- 拷贝方式：逐字节；唯二机械改动 = ① `mock-provider.ts`/`mock-local.ts` 挪进 `src/testing/`（相对 import 同步改，另新增 `src/testing/index.ts` 门牌）② 本文件重写。
- ⚠️ WebPaint 端 `src/store/FORK-BASE.md` 是 2026-06-19「WebPaint→JRP」的旧 stamp 被误拷回去的脏文件，勿当 merge base 依据；自本 commit 起以本文件为准。
- cutover 前过渡态：WebPaint / JRP / Canary 各自的 baked copy 仍在原地运行；本仓发版后消费方逐个切 `file:` tgz。
