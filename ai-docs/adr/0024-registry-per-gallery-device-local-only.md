# registry 只准 per-gallery、device-local、永不同步 —— 与 0607 否决的 per-file registry 划清界线
> created 20260827

**Status:** accepted (2026-08-25 无地骑士轮 user 拍板「一源一历史 + 拷贝即分叉」；2026-08-27 user 批准成 ADR — Claude Fable 5)

## Context

无地骑士轮引入 folder gallery（本地文件夹当一朵云，MASTER §A 修订 2026-08-25），app 需要记住「这台设备链接过哪些图库」（folder 的 FSA 句柄、OneDrive 图库的账号 id 等）——一个 **registry**。而「registry」这个词在本家族有前科：2026-06-07 身份回滚案（`WebPaint/ai-docs/20260607-sync-identity-decision.md`，ADR-0011 superseded）否决过一种 registry。**两者名字相同、安全性质相反**，不写清区分，将来必被 re-litigate 或误用。

0607 否决的是什么：**per-file、跨设备同步**的 id↔path 映射（配合文件内 GUID 身份标记）。真机验尸结论：它是第二真相源——registry 与文件系统现状漂移时（云端 provider 挪动/恢复/别设备改名），漂移本身就是数据丢失路径；且源内身份标记（GUID-in-thumb）把 store 变成格式感知、把「拷贝文件」变成身份污染（两份同 GUID 互相打架）。判决落地为家族宪法：**身份 = path/name，源内不铸任何 id**。

2026-08-25 拍板把这条判决延伸到 gallery 尺度：**一源一历史 + 拷贝即分叉**——把一个文件夹整个拷走，得到的是一个新图库（新历史），不是「同一图库的另一个副本」；因此**源内（文件夹内）也禁止任何 gallery 级身份标记**（比如往文件夹里写 `.gallery-id` 文件）。

## Decision

1. **合法形态（唯一）**：registry = **per-gallery、device-local、永不同步**的链接登记。
   - 记的内容：这台设备链接过哪些图库（folder 的 FSA 句柄、onedrive 行的 `homeAccountId`、显示名、上次打开时间之类的设备便利）。
   - 性质：它是**这台设备自己的记事本**（§A 修订第 1 条「IDB 只干三件事」中的第三件）——**不铸身份、不进源、不跨设备**。丢了无损：用户重新 pick 文件夹/重新登录即重链，字节与历史全在源里。
   - 键：`${appId}.${databaseId}` 命名空间内，与 store 多实例纪律（每源一实例一库）对齐。
2. **否决形态（0607 判决，维持）**：per-file 的 id↔path 映射、任何跨设备同步的 registry、任何**写进源内**的身份标记（文件级 GUID 或 gallery 级 marker 文件）——一律禁止。**registry 绝不成为第二真相源**：任何「registry 说有、源里没有」的分歧，真相永远是源。
3. **判别口径**（将来新需求过这三问，全「是」才合法）：① 丢了它数据无损、重链即愈？② 它只描述**本设备↔源**的关系、不描述文件是谁？③ 它永不离开本设备？

## Consequences

- folder gallery / 多图库 UI 的持久层设计有了明确的形状边界；「要不要把图库列表同步到云端」这类提案直接撞本 ADR 第 2 条（想要跨设备一致的图库清单 = 把源列表放进某个源，语义先天矛盾）。
- 拷贝文件夹 = 分叉出新图库（no shared history）是**特性不是缺陷**——与文件级「拷贝即分叉」（wart E 谱系）同构，文档化不修。
- 交叉引用：MASTER §A 修订（2026-08-25）第 3 条挂本 ADR；`ai-docs/20260825-localfile-knight-store-round.md` §6.4 是拍板出处。
