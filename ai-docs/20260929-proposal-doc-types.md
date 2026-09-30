# 提案：文档种类表——把「只有一种扩展名」这个假设连根拔掉
> created 20260929 · by Claude Fable 5.1 · as-of store 0.15.2 / gallery 0.5.0
> 状态：**只是提案，没有动任何代码，等 user 定方向。** 它取代同日的 `docExts` 提案（那份在分支 `wip/0.16-doc-exts` 上）。
> 范围跨两个库（store + gallery）和四个宿主；文档放在 store 仓是因为身份归 store 管。
> **用词被 user 打回过一次**（2026-09-29「type? extension? name是个坏名字」）：§5 到 §8 已换成候选新词，**词还没定**，见 §5.0。文件名等词定了再改。edited by Claude Fable 5.1 2026-09-29

## 0. 一句话

全家的名字模型是跟着 WeebPaint 出生的：一个 app、一种文档、一个扩展名。在这个前提下，「这个文件是哪一种」是个常数，所以它从来没有成为一个概念。
WXHW 2.0 同时有 txt 稿和书，这个前提不成立了。之后每坏一处就在那一处加一个回调，**每个回调都在用不同的话问宿主同一个问题**。
提案：宿主把自己有哪几种文档、各自怎么拼**当数据报一次**，其余全部由库推导。

## 1. 起因

user 2026-09-29：「那么顺便解决一个屎山问题吧，也是wxhw发现的，就是之前假设只有一种扩展名。结果就一直在monkey patch，你跳出来高屋建瓴地思考一下」

直接导火索是同日的 `docExts`：备份箱里的书取回来名字被切坏。写那份提案时我把它当成一个孤立的小洞，其实它是同一族的第 13 个补丁。

## 2. 病根：三样东西被烧进了代码

| 烧进去的东西 | WeebPaint 时代为什么成立 | WXHW 怎么打破的 |
|---|---|---|
| 类型是常数（`crypt.ext: "ora"`、`isZipDoc: () => true`） | 只有 `.ora` | 两种：`.txt` 是裸字节，`.webxiaoheiwu.zip` 是 zip 容器 |
| 裸名和全名一一对应（`猫` 对 `猫.ora`） | 扩展名唯一，加减一下就行 | `稿` 可能是 `稿.txt` 也可能是 `稿.webxiaoheiwu.zip`，裸名有歧义 |
| 靠字符串猜（「最后一个点」「去掉结尾的 `.zip`」） | `.ora` 只有一段，也不以 `.zip` 结尾 | 书的扩展名有两段，而且以 `.zip` 结尾，正好撞上库给加密容器加的后缀 |

## 3. 账：同一个问题被问了多少遍

下面每一行都是「这个名字是哪一种文档、扩展名从哪开始」的一个变体。

| # | 在哪 | 补丁 | 它其实在问什么 | 现状 |
|---|---|---|---|---|
| 1 | store 0.13.0 | `toName` 回调 | 这个云端名是不是我某种文档的加密容器 | WXHW 手写正则，把扩展名清单又抄了一遍 |
| 2 | store 2026-09-09 | `cryptExtFor` 按最后一个点推导，`crypt.ext` 降级成回退值 | 这份文档的扩展名是什么 | 书推导出来是 `zip`，不是 `webxiaoheiwu.zip` |
| 3 | store 恢复撞名 | 本机腿按最后一个点、云端腿接在末尾 | 扩展名从哪开始 | **坏的**：书取回来名字认不出 |
| 4 | store（提案未发） | `docExts` | 同上 | 第 13 个补丁，本提案取代它 |
| 5 | store | 每次调用传 `isZip` | 这份文档是不是 zip 容器 | WXHW 4 处调用点各答一遍，gallery 里还有一处 |
| 6 | store trash-merge | 时间戳后面的 `(\.zip)?` | 这是不是加密容器 | 能用，靠戳当分隔符 |
| 7 | gallery | `policy.isDoc` | 这个名字是不是我的文档 | 每个宿主各写一个 |
| 8 | gallery | `isZipDoc` | 同 5 | 每个宿主各写一个 |
| 9 | gallery 0.2.1 | `hasThumb` / `thumbs.has` | 这一种文档有没有缩略图 | 每个宿主各写一个 |
| 10 | gallery | `naming.display` | 去掉扩展名的主干是什么 | 每个宿主各写一个 |
| 11 | gallery 0.4.1 | 改名时拿 `name.slice(display.length)` 反推扩展名再补回去 | 扩展名是什么 | 能用，是从显示名倒推出来的 |
| 12 | gallery `copyTargetName` | 没打补丁 | 扩展名从哪开始 | **坏的**，见下 |
| 13 | gallery `uniqueBareName` | 没打补丁 | 同上 | 对名字带扩展名的宿主同样会接错位置，WXHW 目前没走到 |
| 14 | CatsUp 宿主 | `hasThumb: n => isDoc(n) \|\| isDoc(full(n))`，注释「两边都认」 | 传进来的到底是裸名还是全名 | 症状，见 §4 |
| 15 | WXHW `doc-model.ts` | `EXT_RE` / `PROJECT_EXT_RE` / `ANY_EXT_RE` / `docKind` | 全部 | 宿主自己的第三份清单 |

第 12 行是这次盘点时新发现的，2026-09-29 在无头 Chromium 里用 WXHW v2.1.21 证实：

| 操作 | 结果 |
|---|---|
| 书库里对 `测试书.webxiaoheiwu.zip` 点「复制」 | 多出一个 `测试书.webxiaoheiwu.zip 副本`，书库把它当成打不开的杂物文件 |
| 书库里对 `测试稿.txt` 点「复制」 | 书库里没有多出任何文件。原因没查 |

## 4. 第二个结：「名字」有两种说法

store 说全名（身份）。gallery 对宿主说裸名（`GItem.name`），中间靠宿主给的 `NameBoundary { bare, full }` 翻译。
裸名有歧义之后，WXHW 只好让 `bare = full = 恒等`，再加一个 `display` 专门管显示。
于是在 gallery 自己的代码里，`item.name` 对 WeebPaint 是主干，对 WXHW 是带扩展名的全名。第 12、13、14 行都是这个结长出来的。

**裸名当身份本身就是「只有一种扩展名」的产物。** 一般情况下身份只能是全名，主干只是给人看、给人打字的。

## 5. 目标形状

### 5.0 用词（第一版被打回，下面是候选，等 user 定）

user 2026-09-29：「type? extension? name是个坏名字」

第一版用了 `docTypes` / `ext` / `store.names` / `DocName`。三个词各有各的毛病：

| 第一版的词 | 毛病 | 候选 | 候选词的出处 |
|---|---|---|---|
| name | 整座屎山的源头就是这个词。它在不同地方分别指路径、最后一段、去掉扩展名的那截、显示出来的标题。第一版还拿它给新模块起名 | 不再用它指任何精确的东西 | — |
| extension / ext | 这个词自带「最后一个点之后」的意思，代码正是被它骗的。`.webxiaoheiwu.zip` 按这个意思是两个扩展名。加密容器多出来的 `.zip` 也被叫成扩展名 | **suffix 后缀**：只说「以什么结尾」，不数点 | 新词 |
| type | 撞 TypeScript 的 type、`Blob.type`、MIME type。更要紧的是第一版把两样东西混成了一样，见下 | **kind 种类** | 家规「开放集如 kind」；WXHW 已有 `DocKind`，gallery 已有 `AsideKind` |

**第一版混掉的两样东西**：

| | 是什么 | 归谁 | 谁读它 |
|---|---|---|---|
| 后缀 suffix | 这种文档在路径里怎么拼：`.webxiaoheiwu.zip` | 拼写 | store、gallery：在哪切、是不是文档 |
| 种类 kind | 这是什么东西：书、稿 | app 的概念 | 宿主：交给哪个编辑器。库只原样带着，不解释 |

两者不是一回事：一个种类可以有几种拼法（JRB 以后要是也收 `.md`，它和 `.txt` 是同一个种类）。第一版的 `DocType` 只有 `ext` 没有自己的名字，等于说「种类就是扩展名」，所以才会出现 type 和 extension 两个词指同一行的怪事。

### 5.1 一套词（候选）

| 词 | 意思 | 出处 |
|---|---|---|
| path 路径 | 身份。`文件夹/主干后缀`。跨模块传的只有它 | store 的 `Item.path` 本来就这么叫 |
| folder 文件夹 | 路径里最后一个 `/` 之前 | store 的 `watchFolder` |
| stem 主干 | 人看的、人打的那一截 | WXHW `parseDocName().stem`、JRB `stemOf` |
| suffix 后缀 | 文档路径的结尾，含点 | 新词，顶替 extension |
| kind 种类 | app 自己给这种文档起的标签 | 见上 |

加密容器在云端多出来的那个 `.zip` 是 store 内部的事，宿主看不见，不给它起对外的词。

### 5.2 一张表，报一次

```ts
createStore({
  docKinds: [
    { kind: "book",  suffix: ".webxiaoheiwu.zip", container: "zip" },
    { kind: "draft", suffix: ".txt",              container: "raw" },
  ],
})
// WeebPaint：[{ kind: "painting", suffix: ".ora", container: "zip" }]
// CatsUp：  [{ kind: "model",    suffix: ".glb", container: "raw" }]
// JRB：     [{ kind: "book",     suffix: ".txt", container: "raw" }]
```

`kind` 的取值是各家自己的事，上面几个只是举例。

### 5.3 一个窄模块 `store.paths`

所有「切路径、拼路径」只准在这里发生。库内和 gallery 都用它，宿主也可以用。只有两个函数：切开，拼回去。改名、复制、挪文件夹、撞名加时间戳都是「切开，换一格，拼回去」。

## 6. 现状 .h（节选，全文 `api/store.d.ts`、gallery `api/gallery.d.ts`）

```ts
// store 0.15.2
interface StoreConfig {
  crypt?: { ext?: string; … };
  fileName?: (name: string) => string;        // 全家没有人传
  encFileName?: (name: string) => string;     // 全家没有人传
  toName?: (cloudName: string) => string;     // 只有 WXHW 传
}
function file(name, opts: { isZip: true;  mode }): ZipFile;
function file(name, opts: { isZip: false; mode }): RawFile;

// gallery 0.5.0
interface NameBoundary { bare(s): string; full(bare): string; display?(bare): string }
interface GItem { name: string /* 裸名 */; syncState; size?; lastModified? }
interface DataFacePolicy { isDoc?(path): boolean; isImage?(path): boolean; naming?: NameBoundary }
interface GalleryScreenDeps { naming?: NameBoundary; isZipDoc?(fullName): boolean; hasThumb?(fullName): boolean; … }
```

## 7. 提案 .h

```ts
// ── store ──
/** 本 app 的一种文档怎么拼、是什么容器。 */
export interface DocKind {
  /** app 自己的标签（开放集）。库原样带着，不解释。几行可以是同一个 kind。 */
  kind: string;
  /** 路径以什么结尾，含点，可以多段：".txt" / ".webxiaoheiwu.zip"。大小写不敏感。 */
  suffix: string;
  /** 明文字节是什么容器。"zip" = 能按条目名取一小段（封面）；"raw" = 不能。库仍然不看内容。 */
  container: "raw" | "zip";
}
/** 一条文档路径切开之后。 */
export interface DocPath {
  path: string;      // 身份
  folder: string;    // "" = 根
  stem: string;      // 主干
  suffix: string;    // 命中的后缀，保留路径里原有的大小写
  kind: string;
  container: "raw" | "zip";
}
export interface Paths {
  /** 切开。不是本 app 的文档 → null。几个后缀都命中取最长的。 */
  parse(path: string): DocPath | null;
  /** 拼回去。 */
  join(parts: { folder: string; stem: string; suffix: string }): string;
}
export interface StoreConfig {
  /** 必填表态（和 persistence / reconcilePolicy 同一类）。 */
  docKinds: readonly DocKind[];
  // 删除：fileName / encFileName / toName / crypt.ext
}
export interface Store {
  paths: Paths;
  /** 任何文件（文档、图片、杂物）。 */
  file(path: string, opts: { mode: "new" | "existing" }): RawFile;
  /** 只准用于 container 是 "zip" 的文档，否则抛。多出 getPeek / decryptPeek。 */
  zip(path: string, opts: { mode: "new" | "existing" }): ZipFile;
}

// ── gallery ──
export interface GItem { path: string; stem: string; kind: string; syncState; size?; lastModified? }
export interface GalleryPolicy {
  /** 不是文档的文件里哪些算图片（WeebPaint 的云盘图片）。 */
  isImage?(path: string): boolean;
  /** 哪几个种类有缩略图。不给 = 都没有。 */
  thumbs?: { kinds: readonly string[]; dbName: string; fetch(path, source): Promise<Blob | null> };
}
// 删除：NameBoundary、naming、policy.naming、policy.isDoc、isZipDoc、hasThumb、thumbs.has、uniqueBareName 的 naming 参数
```

## 8. 每个旧接缝的去向

| 今天 | 以后 |
|---|---|
| `toName` | 删。云端名去掉结尾 `.zip` 后能被 `parse` 认出 → 是那份文档的加密容器；云端名自己能被认出 → 是明文文档 |
| `crypt.ext` + `cryptExtFor` | 删。用这条路径命中的后缀（见 §10 第 2 条） |
| `docExts`、恢复撞名 | 切开，主干后面接 ` [戳]`，拼回去。两条腿同一个函数 |
| 每次调用的 `isZip` | 删。`file()` / `zip()`，表说了算 |
| `fileName` / `encFileName` | 删。身份就是云端文件名；加密后缀恒为 `.zip` |
| gallery `isDoc` | `paths.parse(path) != null` |
| gallery `isZipDoc` | 切开之后的 `container` |
| gallery `naming.display`、改名反推后缀 | 切开之后的 `stem`；改名 = 换主干拼回去 |
| gallery `copyTargetName`、`uniqueBareName` | 主干后面接「副本」或序号，拼回去 |
| gallery `hasThumb` | 策略里按种类列 |
| WXHW `doc-model.ts` 的三个正则和 `docKind()` | 删，改读 `store.paths`，种类直接从切开的结果里拿 |

净变化：store 配置少 4 个字段多 1 个，调用点少一个布尔；gallery 少 1 个接口和 6 个宿主钩子。

## 9. 不变的东西

| 项 | 为什么不变 |
|---|---|
| 已存的数据 | 四个宿主在 store 里的身份本来就都是全名（WeebPaint / CatsUp / JRB 是在 gallery 边界上加的扩展名）。IDB、云端文件名、缩略图缓存的 key、阅读位置的 key 都不用动 |
| 库不懂内容 | 表说的是路径怎么拼，不是内容。`container` 顶替的是今天已经在问的 `isZip`；`kind` 库只带着不解释 |
| 不是文档的文件 | 图片、杂物照旧存在，`parse` 返回 null，gallery 按 `isImage` 分流 |
| 留底的命名 | `<原名> [<戳>-<guid>]` 不变，旧的回收站和备份箱条目照常列得出 |
| 同步逻辑 | If-Match、冲突、留底、dirty 一行不碰。动的只有「名字怎么读」 |

## 10. 风险和怎么验

1. **云端列举认错加密件是最重的一条。** `toName` 是全库判定「这是不是加密容器」的唯一接缝，推导写错会把明文当密文或反过来。验法：先把四个宿主今天的配置和今天的行为录成一份名字语料（带文件夹、主干里有点、扩展名大写、以 `.zip` 结尾但不是文档、带戳的回收站名、加密容器名），新推导逐条和旧行为对账。只有 §3 里标了「坏的」那几条允许不同，而且要逐条列出来。
2. **加密容器里记的扩展名会变。** 今天书的 `meta.bin` 里记的是 `zip`，改成按类型之后新封的容器会记 `webxiaoheiwu.zip`。这个字段解密时有没有人读、旧容器读不读得出，**我还没查**，动手前必须先查清。这属于持久化字段的语义变化，单独要 user 点头。
3. **宿主一次改很多调用点。** `isZip` 的替换是机械的，编译错误就是清单。
4. 真机没有任何一项测过，这份提案本身也只是纸面。

## 11. 分几刀

库是按版本钉在每个宿主里的，库改了之后别的宿主不升级就不受影响，升级那一刻编译错误就是迁移清单。所以不需要六个仓库同一天动。

| 刀 | 内容 | 版本 | 做完之后 |
|---|---|---|---|
| 1 | store：种类表、`store.paths`、库内全部推导、删四个旧字段和 `isZip` | store 0.16.0 | WXHW 收货，备份箱入口上线 |
| 2 | gallery：改吃 `store.paths`，`GItem` 改成路径、主干、种类，删 `NameBoundary` 和六个钩子 | gallery 0.6.0 | WXHW 收货，复制修好，`doc-model.ts` 的三个正则删掉 |
| 3 | WeebPaint / CatsUp / JRB 各自升级 | 各家自己的 session | 每家的 gallery 宿主少一段翻译代码 |

每一刀自己是完整的，不留「新旧都认」的过渡层。第 1 刀和第 2 刀之间 WXHW 会短暂处于 store 已经是新模型、gallery 还在用 `naming` 的状态。那段时间 gallery 0.5.0 看名字只经宿主给的钩子，这一半没问题；但它调 `file()` 时还会多传一个 `isZip`，新 store 得容忍这个多余的字段（忽略它），这一点要在第 1 刀里写成测试。如果两刀连着做、WXHW 一次收两个库，这个中间状态就不存在。

## 12. 要 user 定的

1. 方向做不做。做的话 `docExts` 那份提案作废。
2. 这一轮做到哪一刀。我建议第 1 刀和第 2 刀都做，第 3 刀留给各家。
3. 种类表必填还是可选。我建议必填：可选就意味着库里还得留着「猜」的那条路。
4. `GItem.name` 从裸名改成路径是对四个宿主的破坏性改动，要不要。
5. §10 第 2 条查清之后的结论，到时候单独问。
6. **用词**（§5.0、§5.1）。另有一个连带问题：store 现有的对外接口里还有三处带 Name 的名字，指的其实都是路径——`files.nameOccupied`、`activeFileName`、`hiddenName`。要不要趁第 1 刀一起改掉（对宿主是破坏性的，但是机械替换）。函数签名里叫 `name` 的形参改成 `path` 不影响任何调用方，这个我会直接做。
