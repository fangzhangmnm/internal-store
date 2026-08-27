# 懒仲裁 hash：park 到真机观察到假冲突为止；eTag 拆解捷径永久禁止
> created 20260827

**Status:** accepted (2026-08-27 user 定案「记录不做的决策」— Claude Fable 5)

## Context

folder provider 的 eTag = `${mtime}-${size}`（拍板 2026-08-25，`ai-docs/20260825-localfile-knight-store-round.md` §2）。同拍板给了一个旋钮：「懒仲裁 hash 只在可疑差异时算（mtime 变 size 同），永不升格为身份」——用来消「桌面云盘客户端 touch 了 mtime 但内容没变 → 假冲突」。2026-08-27 讨论「要不要防御性顺手做掉」，推演结论：**它不是 provider 里几行代码**。

- 仲裁需要比对**当前源内容 vs base 时刻内容**，而引擎刻意不留 base 字节（无 git tree 已拍板；本地缓存躺的是 dirty 编辑字节不是 pristine base）。真正能工作的唯一落点 = **markSynced/onPushed 时把 base 内容 hash 持久化进谱系轨**——动 local-head/cloud-sync 双轨 etag 机器（红线最核心区，2026-06 改名 etag 中毒同族）+ 持久化结构变更（家规逐项上报）+ markSynced 多读全文件（不再「懒」）。
- 便宜捷径 =「hash 塞进 eTag 串、引擎比较时拆开看」——**破坏 eTag 在全引擎的 opacity**（Graph eTag 是不透明串，全库比较=整串相等），provider 私有语义漏进引擎比较逻辑，跨 provider 分叉的起点。
- 收益档位：只消「假冲突面多弹一次」（annoyance 层；clean 路径=folder 下微秒级重读，dirty 路径=冲突面弹出但 never-lose 兜底，**零数据丢失**）。丢数据方向它帮不上：粗粒度 mtime 漏检是「eTag 相同」，按定义不可疑，懒 hash 永不触发。
- 触发场景（云盘客户端 touch mtime 不改内容）的存在与频率**未被真机观察过**——folder gallery 真机矩阵尚未跑。

## Decision

1. **现在不做**（park）。风险收益倒挂：拿谱系机器（真丢数据的地方）的改动风险，去修一扇纱窗级的 annoyance。
2. **重启条件**：folder gallery 真机 dogfood **实际观察到**假冲突（现象：没人动过的文件弹冲突面）。届时按观察到的实际形态设计，红线区走 escalate 正门。
3. **实现约束（预钉，防捷径）**：将来若做，落点 = markSynced 时持久化 base 内容 hash（谱系轨新字段，走持久化结构上报）；**永久禁止** eTag 字符串拆解/组件化比较——eTag 对引擎必须保持不透明整串。hash 永不升格为身份（原拍板不变）。
4. 给没观测过的问题预铺机器 = 「math/手感类禁猜测式调试」同族错误——本 ADR 即先例记录。

## Consequences

- folder provider v1 的已知小疣：桌面云盘客户端若真会 touch mtime，用户会偶见一次多余冲突面（选一下即过，两边留底）——接受，观察，不预修。
- 任何「给 eTag 加结构」的提案直接撞本 ADR 第 3 条。
