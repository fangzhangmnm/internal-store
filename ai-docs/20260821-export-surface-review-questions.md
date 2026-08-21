# 0.3.0 发版时 user 记账的「下轮 store 审阅」问题清单

> created 20260821 · as-of 0.3.0 发版当日。背景：0.3.0 的 api diff（StoreUI.text / getPeek.source /
> +3 type exports）user 粗看放行「先版本号跑起来」，完整审阅（TSDoc + 全 api/store.api.md）**刻意拖着**，
> 到时候连本清单一起过。

1. **公开面收缩（user 方向拍板：「public 暴露的越少越好，到时候应该还可以收」）**：
   `CloudProvider` / `createOneDriveProvider` / `graphToCloudProvider` / cloud-sync 一族要不要暴露？
   做法=先盘一轮消费者（WeebPaint / JRP / BR）实际 import 了什么，没人用的收 private。
   有消费者 pin 后收面 = 跨仓契约变更，走 escalate（CLAUDE.md 版本纪律）。
2. **「public 类里放库内 private 接口」**（user 问是否可行）：TS declaration emit 要求公开面引用的
   类型可命名（TS4023），api-extractor 会报 ae-forgotten-export——不能直接藏。可行替代：
   ①方法面隐藏（public 类只暴露方法，参数/返回用已导出的窄类型）；②opaque/branded 类型
   （如 EncryptedBlob 先例）；③`@internal` TSDoc 标记 + api-extractor trimming（dtsRollup 裁掉）。
   审阅轮逐个定。
3. FileStream / `./sw` 面的消费者盘点（BR 流式在用；WeebPaint/JRP 不用——是否该挪出主门牌）。
4. TSDoc 完整度 review（0.1.0 时的「一口气审 788 行户口」流程仍欠账）。
5. cloudless collection 跨 tab 整份盲写互覆（current-file/restore-attempt 双 tab 串扰）——
   2026-08-21 QA 轮查明、细案未拍（candidate：写前 re-read + per-key merge / storage 事件失效）。
