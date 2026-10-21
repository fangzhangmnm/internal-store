# 周账 F-61 / F-62 / F-63：库层审计（道 1）——Opus 10-17 深夜到 10-18 凌晨落的库改动与接线

> created 20261021 by Claude Fable 5.1 · as-of store 2.1.3 / gallery 0.8.5 / encryption 0.2.2 / prefetch 0.1.1 / KudsRocket v0.1.70（各仓 main 当时）
> 出处：家族根 `weekly/20261021-family-todo.md` §0-1 / §6 道 1。方法 = 只读源码 + diff + 跑既有测试；每条都写「看了什么、判什么」。没有真机。

## 0. 一句话

八项里**一项要修**（store 镜像抽样在并发下几乎不抽 → **2.1.3 patch**，回归测试钉着），其余没查出缺陷。F-62 判**不分频道**（理由写进加密库 ADR-0001 第 10 条，等 user 点头）。F-63 判**要补**：KRD 正文是 AES-CTR、逐片没有认证，加密盘和明文盘一样只能靠抽样 → KudsRocket W-44「明文分片哈希表进 KRD2 头」值得做，归道 5。

## 1. 逐项

| # | 对象 | 看了什么 | 判 |
|---|---|---|---|
| 1 | encryption 0.2.1 | `idbSecretStore`：`onversionchange` 让出连接、`dbp = null` 下次重开 | 对。关连接时在途事务自然收尾；还原出厂的 `deleteDatabase` 不再被堵。 |
| 2 | encryption 0.2.2 | `exists()`：只读 / 删除前用 `indexedDB.databases()` 问库在不在，枚举不了的平台照旧打开 | 对，方向保守（最多多问一次口令，不会少问）。残余：WebKit 的 `databases()` 若漏报 → `recall()` 当没记 → 多问一次；ADR 第 9 条的 iPad Edge 真机验证还是零，顺便验这条。 |
| 3 | gallery 0.8.4 | 三张模板搬进 `templates.ts`（常量字符串，禁拼接）→ `@vue/compiler-dom` 3.5.35 构建时编成 render；`HELPERS` 全在才用预编译，否则退回运行时编译 + 黑匣子记一笔；守卫测试「生成物和模板源一致」+「没有 new Function / eval / with」 | 对。核过全家 vendored Vue 都是 3.5.35（WeebPaint / WXHW / MoonSinger / JRB / CatsUp），和编译器同版。**小坑（不修，记着）**：预编译只认 helper 不认版本——哪家把 Vue 换成 3.6 而 gallery 没重编，还是会走预编译；Vue 的 render 产物跨版本一般兼容，真出事是整个图库渲染错、很响，不是静默。要防的话下次 patch 加一句 `Vue.version !== COMPILED_WITH_VUE → diagNote`。 |
| 4 | gallery 0.8.5 | `delete()` → `trash()`：`verbs.ts` 两处 + `VerbFile` 接口；grep 全 src 没有漏改的 store `.delete(` | 对。 |
| 5 | prefetch 0.1.0 / 0.1.1 | 全库 957 行读完：`types / prefetch / planner / model`；红线守卫（不联网、不碰存储、不碰 DOM、不开定时器）机械执法 | 对。字节原样透传（`read` 不碰内容，坏不了盘）；学到的东西是四等（丢了重学），`decodeModel` 解不开 / 对不上块大小就从头学，别的设备的坏模型只会被忽略。「往 IDB 写暂存区」那半其实在 store 的流式面（`prefetch` = 低优先拉进 staging），不在本库。**小坑（不修）**：`read()` 里 `pump()` 同步跑在 `source.read` 之后、`await` 之前，宿主的 `budget.network()` 若抛会让这次读失败且 `pending` 悬空——现实里 KudsRocket 的 `networkState()` 不会抛。 |
| 6 | KudsRocket v0.1.59 等级表 | `config.ts DOC_KINDS`：手动格 `-s<n>` 一等、自动格 `-a<n>` / 历史份 `-h<时刻>` 二等（stem `^[0-9a-f]{16}-[ah]\d+$`）、菜谱二等、盘三等、存档罐 / 铁盒一等；`test/doc-kinds.test.ts` 正反两头钉名字（含 `-A1` / `-a1 (2)` / `my-a1` 都算一等）；store 侧 `identifiers.ts` 带 stem 的行先试、都不中落默认行 | 对。最怕的「手动格被当二等静默盖掉」被测试钉死。二等语义（open / save / resolve 三处 `tierOf(name) === "auto-backup"` → keepMine / takeCloud / 不进备份箱）是 2.1.0 自己写的、这次再读一遍无误。 |
| 7 | KudsRocket v0.1.68 快照先落本机 | `slot-writer.ts`（每格一条队、只留最新、落好后 `pushAfterMs` 请续推；后台不请）+ `snapshots.ts save()`（手动盖格先把旧份留内存 + 历史份；拿不到旧份改存新格；自动盖格先 `ensureLineage`，接不上就跳过）+ `main.ts pushDirty` = `store.files.dirty.pushAll()` | 对。`pushAll` 没带 `onConflict`：412 / 撞名 → 留 dirty、报 failed、图库「要你处理」——不弹面也不静默盖。文档里自己写明的唯一风险（排着没落本机时页面被杀 = 这一份没了、上一份还在）属实。 |
| 8 | F-57 重打的发版包 | 四家 `vendor-pkgs/internal-store-2.1.2.tgz` 同一个 sha256（0cbd7cc6…）；按 2.1.2 源码提交（5b940de）`git archive` 重建 `dist/` 逐字节对比 → **一致**；package.json 只差 pnpm pack 的键序 | 对。全家只有 2.1.2 在用（没有 2.0.0 / 2.1.0 / 2.1.1 的包副本），不用再核。store 仓自己工作区里那个未跟踪的 tgz 是 10-18 文案提交后重打的（README / 注释不同），没发出去。 |

## 2. F-62：记住口令的钥匙 prod 和 `/dev/` 共用 → **不分**

判定与理由写进 `20260828 internal-encryption/ai-docs/adr/0001-device-remembers-password.md` 落地清单第 10 条（同日提交）。一句话：同源已经共用 store 本机库和 MSAL 令牌，dev 的 XSS 拿得到的远不止这把钥匙；分开 = 两条记录同一个口令，看起来安全而已；真正挡 XSS 的那层 CSP 10-17 三家都上了。**等 user 点头**（行为不改，所以只是点头，不是开工）。

## 3. F-63：盘镜像只抽样核对 → **要补（归 KudsRocket W-44）**

- 核了 `20261014 KudsRocket/src/disc/crypt.ts`：KRD1 / KRD2 **正文 = AES-256-CTR**，只有头部元数据走 AES-GCM。正文逐片**没有认证**：镜像给错一片，解出来是乱码，核照读不报错。所以「加密盘自带校验、抽样够用」**不成立**，加密盘和明文盘一样靠抽样。
- 抽样本身在 2.0.0–2.1.2 **几乎没发生**（节拍在 `await` 后看计数，三路并发系统性跳过）→ 本次 **store 2.1.3** 修（`ai-docs/20261021-2.1.3-mirror-sampling-tick.md`）。修完也只是每 16 片真抽 1 片。
- 正解不在库：W-44「明文分片哈希表进 KRD2 头、只当校验不当身份」——盘是三等、只读，哈希表进头部不改身份；镜像来的每片按表核（本机算哈希、零网络），云端来的也顺便核。user 10-17 已经答「可以」，剩的问题是「玩家 rom 改名之后到底会发生什么」（身份归路径，哈希只校验，改名 = 新身份、表照用）。**归道 5**（KudsRocket 仓）。

## 4. 这次没做、要人定的

- F-62 点头（见 §2）。
- 库 minor：没有需要 minor 的项（2.1.3 是 patch）。
- F-19（加密稿页面死掉后重推比不出同一篇）：等 user 立项，没动。
- 两个「小坑」（gallery Vue 版本不核、prefetch `pump()` 不包 try）记在 §1，不值得单独发版，下次各自 patch 时顺手。
