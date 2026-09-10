# 2026-09-09 改库申请：加密名判定收成一个 seam；`crypt.ext` 按文件推导
> 作者：Claude Fable 5.1（claude-fable-5-1）· created 20260909 · 申请人 = WXHW 2.0（家族根 `ai-docs/20260909-wxhw-2.0-long-haul-plan.md`）· user 2026-09-09「库点头」（改前 escalate 已完成，本文是记录）

## 问题
1. **明文 `.zip` 文档被当加密容器**。ADR-0012 把加密件外扩展名统一追加 `.zip`；`cloud-sync.ts` 默认 `toName` 去掉一个尾部 `.zip` 还原身份，`trash-merge.ts` 的 `parseCloudTrashName` 也按 `.zip` 尾推断加密。WXHW 2.0 的工程是明文 zip `X.webxiaoheiwu.zip`：列举把它还原成 `X.webxiaoheiwu`，打开时按加密名 `X.webxiaoheiwu.zip` 命中 → 当加密容器去解 → 打不开；回收站恢复也会送去 encFileName 路径。提示后缀救不了，尾巴还是 `.zip`。
2. **`crypt.ext` 是 store 级单值**（WXHW 填 `"txt"`），写进容器 `meta.bin` 供 7-Zip 手工恢复还原真名。同一 store 里同时有 `.txt` 稿和 `.webxiaoheiwu.zip` 工程，这个值对其中一种是错的。

## 申请
- **一个 seam**：`isEncryptedCloudName(cloudName) → boolean`（名字暂定），listing 的 `toName`、resolve 的 enc 分支、trash-merge 的解析三处全吃它，不再各自 `endsWith(".zip")`。默认规则保持现状（去尾 `.zip` 即加密），**app 可配**。WXHW 的规则：去掉 `.zip` 后剩下的名字以 `.txt` 或 `.webxiaoheiwu.zip` 结尾才算加密件，否则它本身就是明文工程。既有 config 钩子 `fileName / encFileName / toName / match` 保留，新 seam 与之互逆。
- **`crypt.ext` 改为从逻辑名推导**（最后一个点之后），旧的单值字段留作回退。
- **不动 ADR-0012 的外扩展名**（会动全家族已有加密件）。后果：加密工程 at-rest = `X.webxiaoheiwu.zip.zip`，名字为真（zip 套 zip）。

## 验收（先落测试）
- 明文 `a.webxiaoheiwu.zip` 列举身份 = 原名、打开走明文路径、删除 → 回收站 → 恢复回明文路径。
- 加密 `b.txt` at-rest `b.txt.zip`、加密 `c.webxiaoheiwu.zip` at-rest `c.webxiaoheiwu.zip.zip`：列举还原、打开走加密路径、回收站往返不串。
- 不配规则的 app（WeebPaint）行为字节不变。
- `meta.bin` 里的真名扩展名 = 逻辑名的扩展名。

## 状态
- 2026-09-09：已批。同日落地 **0.13.0**（`config.toName` 单 seam 穿到 cloud-sync 与 mergeTrash 兜底；`cryptExtFor` 按逻辑名推 ext；403 测绿，含 WXHW 规则的端到端 watchFolder 用例）。tgz 待 user 过目 `api/store.d.ts` diff 后 `release.sh` 打包。
