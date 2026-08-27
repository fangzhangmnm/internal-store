# 废弃记账：`collection(name, {local:true})`（cloudless 变体）
> created 20260827 · as-of v0.6.0 / 2026-08-27 · by Claude Fable 5

**出处**：WeebPaint P5 escalation（2026-08-27，背景 = WeebPaint `ai-docs/20260827-p5-settings-destore-proposal.md` §9.7）。

## 决定

- **标 deprecated（本日）**：`StoreConfig` 侧 `collection(name, {local:true})` 与 `CollectionConfig.cloudless` 两处 JSDoc 已挂 `@deprecated`。新消费不许再接。
- **为什么**：WeebPaint P5 正把 device 本地字段全部迁出 store（改走 app 侧 localStorage 器官）。落地后 `local:true` **零消费者**；移除它 store 才单一职责（user 原话）。cloudless collection 从来只是「借 store 的壳存本地键值」——不碰云、不走红线机器，本就不该住在同步引擎里。
- **⚠ 顺序红线（本记账的存在理由）**：**物理移除必须等 WeebPaint P5 收货落地之后的版本**。现在删会断 WeebPaint 在跑的 `local-user-preference` / `local-app-state`。移除是 exports 变更（删导出面 + 有消费者 pin = 跨仓契约变更）→ 届时照家规 escalate + 审版门。

## 移除清单（到点照单执行）

1. 前置核实：WeebPaint 已收货 P5 版本且 `grep -rn "local: true" src/`（WeebPaint 仓）对 collection 调用点归零。
2. 删 `CollectionConfig.cloudless` + collection.ts 内 6 处 `cloudless` 分支（27:注释 / 80 / 149 / 236-237 / 247 / 263 / 294 / 305 附近）。
3. 删 create-store.ts `collection()` 的 `opts.local` 位 + `if (!opts.local) registerScaffold` 收敛为无条件。
4. 测试清理：collection.test.mjs 的 local-only 变体用例删除或改语义。
5. exports diff 过目 → 花版本号（预计 minor）。

## 备注

- P5 对 store 的其余需求 = **零**：gallery 层设置用现有 per-实例 collections（`${appId}.${databaseId}` 多实例，2026-08-25 拍板 §1.5 议题 3 结案同构）；账号层方案已撤回作废。
