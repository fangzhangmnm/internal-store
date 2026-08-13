# OneDrive scope 永久钉死 AppFolder —— 全盘读永不
> created 20260810

**Status:** accepted (2026-08-10, user 拍板) — 把 `20260602-cloud-ux-lessons.md` 里「scope 最小化」两行 lessons 提升为 ADR 级红线

## Context

Background Radio 的胖 OST「拷一遍进 appfolder 不优雅、卡门」倒逼重新审视 2026-05 的 AppFolder 隔离决定（user：当年是「刚开始接触coding agent，出于对不可控不了解事物的安全考虑」的「保守懒政」）。2026-08-10 全面论证（本日 user session）后的事实基础：

- 消费者版 OneDrive **不存在文件夹级 scope**：`Files.Read.Selected` / `Files.ReadWrite.Selected` 仅对 work/school 账号有效（MS permissions reference；个人版文件夹级授权正是社区向微软要而未得的缺口）。token 级硬墙只有三档：**AppFolder-RW / 全盘只读 `Files.Read` / 全盘读写 `Files.ReadWrite`**。
- 因此「限定文件夹」**没有硬墙可用**——库内虚拟根只能拦走 store 的马虎 agent，拦不住 token 本身这个能力（漂移/恶意代码可从同 origin 的 MSAL cache 掏 token 裸 fetch）。
- **同 origin 放大**：兄弟 app 部署在同一 origin（github.io project pages）时 localStorage 共享，给任何一个 app 开胖 scope ≈ 给全家开（user：「开一个等于全开这个确实风险非常大」）。
- **两轴分离**（本 ADR 的核心认识）：**写纪律轴**（丢数据）可随 agent 时代放松——If-Match 机器 + 守卫测试 + 只读 ctor 变体这些软墙够用；**读隐私轴**不随 agent 变强而放松——它是 token 能力问题，不是纪律问题。

## Decision

1. **scope 永久钉死 `Files.ReadWrite.AppFolder`（+ `offline_access`）**。user 2026-08-10：「现在定死appfolder了，只是rw可以放开罢了」。隐私墙外包给微软的 scope enforcement（user 原话「onedrive盘太敏感，值得报微软的红队大腿轮子」，读作：抱微软红队的大腿、用他们的轮子当墙）。
2. **永不申请 OneDrive 全盘读**——`Files.Read` 与 `Files.ReadWrite` 一并永久否决，**无豁免条款**。user：「永不onedrive全量读」；「隐私是真问题。考虑到onedrive盘用法的本质，可能确实是非常红的东西」。
3. **appfolder 内部的写纪律可以放松/分级**（本 ADR 唯一开的口子）：例如 BR 接 store 时 ctor 写死 files 只读（collections 可写）、全量守卫测试断言无裸 Graph 调用、无 delete 调用。这是 store 层软墙——防马虎不防恶意，在钉死 AppFolder 的前提下够用。

## 胖文件的正解（不是放开 scope）

**搬家，不是拷贝**：appfolder 就是盘里的普通可见文件夹（`Apps/<AppName>/`），把胖内容（OST / glb）的 canonical 位置直接安在里面，用户从资源管理器维护，app 零代码。注意两点：

- 「撤销授权会自动删 appfolder」——**已实测证伪（2026-08-10）**：真 app（Background Radio gh-pages 线上版）在 account.live.com/consent/Manage 撤销授权后，`Apps/Background Radio/` 及全部内容原地不动。传闻本就查无出处（疑与 iCloud 行为记混）。「开发者删除 app 注册」变体**待测**——实验被 MSA 当日风控打断：同账号同日两次新注册 + 连环 consent + 一次撤销后，该账号暂时无法落任何**新** consent（token 端点不透明 `server_error`，换手机热点无效），**存量授权不受影响**（WebPaint 静默续 token + Graph 全程正常）。协议与复盘见家族根目录 `20260810 Canary Test/`。
- appfolder **没有只读档**（不存在 `Files.Read.AppFolder`），token 永远 RW——canonical 库住进沙箱意味着该 app 的马虎 agent 理论上可删库。兜底 = 数据分级（OST/glb 属可重取，非 precious 画作）+ store 只读 ctor + 守卫测试。

## Rejected（防 re-litigate）

- **`Files.Read` 全盘只读**：丢数据轴零风险（token 物理写不了），但隐私轴一票否决（2026-05 BR doc「`Files.Read` 全盘只读不可接受」+ 2026-08-10 知情重申）。
- **`Files.ReadWrite` 全盘 + 库内虚拟根复刻 appfolder 体验**：软墙无宿主可挂——模拟的根挡不住 token 能力，且同 origin 放大到全家族。
- **File Picker v8 scoped-token**（BR doc 2026-05 记录的「最高价值未实施项」）：个人账号无文件夹级 scope，picker 只帮选文件、token 仍是三档之一，「token 焊死在单一文件夹」的愿望在消费者账号上落空——**该条目由本 ADR supersede**。
- **匿名分享链接 provider**（`/shares/{u!…}` 免 token 只读）：文件夹级 + 只读双硬墙，但链接 = bearer capability，泄漏即该文件夹对全网公开——私有内容不适用（user：「各种私有曲子不适合公开分享」）。仅对真公开内容有意义（user 认可 provider 品种本身有意义），按需再长，不在本 ADR 排期，且个人版免认证兑换 + CORS 尚未 spike 验证。
- **媒体专用小号（账号隔离）**：可行备胎（用账号边界造出微软不给的文件夹墙），但免费档 5GB 配额装不下胖 OST，未采用。

## Consequences

- 家族 CLAUDE.md 硬规则新增对应条目（scope 钉死 + 全盘读永不）。
- 任何 session 再提「直读用户 OneDrive 文件夹 / 加全盘 scope」→ 指到本 ADR，不 re-litigate。
- BR 接 store 重构时的配套（另行排期，非本 ADR 承诺）：create-store 现把 files 与 collections 接同一 provider 实例，「files 只读 + collections 可写」需拆 per-instance provider 接缝；backlog G2 `readOnlyMirror` dirty 误判一并清；守卫测试沿用家族静态断言 pattern。
- RealHome 的胖 glb 同解：搬家进它自己的 appfolder；其写需求留在 appfolder 内，不构成全盘 RW 的理由。

> as-of 2026-08-10。出处 = 本日 user session 原话（引号内均为原文），Graph scope 事实 = MS Learn permissions reference（Files.Read.Selected 仅 work/school）+ appfolder 概念页。
