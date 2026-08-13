# 0023 — 文档写作规范（project-agnostic，可兄弟互拷）
> created 20260813

Status: accepted（2026-08-13 user 指示立此 ADR；条款零新发明，全部蒸馏自 user 既有拍板，出处见文末）。
Canonical = MyPWAPatterns `docs/adr/0023`；本文件为 internal-store 拷贝（copied 2026-08-13）；兄弟仓可原样拷走，拷贝须注明 canonical 位置与拷贝日期。

## 规范

1. **命根子 = 零背景人类能读懂。** doc 是人类监督 coding agent 的依据；堆细节、堆术语、重心失衡到人读不懂，doc 即废。
2. **反自言自语。** 每句话对没看过上下文的读者成立；用通用说法（「一个绘画 app」）不用项目代号；不写「最重要的一条」「上面讨论的」这类只对当下对话成立的相对措辞——分量靠结构和位置体现。
3. **反膨胀。** 骨架固定（参考形：铁律 → 心智模型 → 入口 → 分模块 API → 机制）；各节篇幅与其分量成比例；改一个 API 只改那个签名块/表格行，不为单个 API 新开解释段；只服务一个细节的散文压成一行注释或收进末尾机制节；动骨架 = 动概念，escalate human。
4. **要有例子。** 接口必附最小可抄用例。
5. **现在时 SSoT。** 只写「现在是什么、怎么用」；改动史归 CHANGELOG/git；功能标「已实现」或「计划中（未实现）」并带日期戳；与代码矛盾时信代码、escalate human。
6. **元数据（家规重申）**：新 doc 文件名 `yyyymmdd-name.md`（入口文件 README/MASTER 与 ADR 例外）；正文带 `> as-of` 戳；ADR 正文第二行 `> created yyyymmdd`；引用「user 说过」必须有真实出处。
7. **机器参考与人类文档分工**：生成物（.d.ts / .h 树）是机器与勘误参考，不承担人类可读性；人读的 API doc 单独写、按本规范写。

## 出处

- 2026-06-26 JRP `STORE.md` §「改这份文档前请读（写给 AI coding agent）」（human-authored commit `cc2b781`；现存最新副本 = internal-store `src/README.md` 末节）：条 1/2/3/5 的祖本。
- user 原话（JRP journals，cached meta feedback）：「文档里面写好行为，以后这个文档当 ssot，写的 human friendly，不要一大堆自言自语。需要有 examples」（条 2/4/5）；「小细节的结果没必要写……免得重心失当」（条 3）。
- user 原话（WebPaint journal ARCHIVE 20260604）：「避免自言自语——用存在于你的 context 中但对没看过上下文的人 confusing……我的目标是一个干净 context 的 agent 看 readme 能看懂」（条 1/2）。
- 家族根 CLAUDE.md §「AI 写的 doc 的信任政策」「doc 文件名带创建日期戳」（条 6）。
- 2026-08-13 user：「.d.ts人类可读性不够好，我们可能还是需要少行少ai废话的documentation，以及project agnostic universal的documentation的写作规范（adr，可兄弟internal互拷）」（本 ADR 的动因 + 条 7）。
