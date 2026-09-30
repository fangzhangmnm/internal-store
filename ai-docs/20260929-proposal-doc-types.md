# 提案：文档种类表——把「只有一种扩展名」这个假设连根拔掉
> created 20260929 · by Claude Fable 5.1 · as-of store 0.15.2 / gallery 0.5.0
> 状态：**已批准，开工**（user 2026-09-29「好，你和另外一个agent协调好了就可以开始做了 identifier, folder, suffix先这样吧」）。它取代同日的 `docExts` 提案（那个分支作废）。
> 范围跨两个库（store + gallery）和四个宿主；文档放在 store 仓是因为身份归 store 管。
> 用词经三轮定稿（user 2026-09-29「type? extension? name是个坏名字」→ 逐词批复 → 「identifier, folder, suffix先这样吧」）：**identifier / folder / stem / suffix / kind**，见 §5.1 末尾的定稿表。§7 的 .h 已按定稿改。edited by Claude Fable 5.1 2026-09-29

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

### 5.1 一套词（第二轮，user 逐词批过，还剩三个词没定）

user 2026-09-29 对第一轮候选逐词的回复：

| 第一轮候选 | user 的回复 |
|---|---|
| path | 「不同意，和文件系统的语义混淆」 |
| folder | 「不同意，和文件系统的语义混淆」 |
| stem | 「随便」 |
| suffix | 「多点的情况怎么办」 |
| kind | 「同意」 |

**path 和 folder 为什么确实不能用。** store 里其实有两层，第一轮没分清：

| 层 | 说的是什么 | 例 |
|---|---|---|
| 底下那一层 | 云盘和本地文件夹里真实的文件、真实的路径 | 加密的稿在云端叫 `稿.txt.zip`；回收站里的叫 `.trash/稿.txt [戳-guid]` |
| 身份这一层 | 库对外说的「这是哪一份文档」 | 同一份稿永远是 `稿.txt` |

path、folder、文件名、扩展名这些词属于底下那一层，那里它们就是文件系统的意思。现状是同一个词两层都在用：
`Item.path` 是身份；`CloudItem.path` 是云端真实路径；云端列举出来的 `CloudItem.name` 却又是身份（经 `toName` 翻译过）。
`toName` 这个补丁本身就是两层之间的翻译，只是从来没有人把「两层」说出来。**身份这一层要有自己的词。**

候选（词由 user 定）：

| 概念 | 候选 | 说明 |
|---|---|---|
| 身份那一整串 | **id** | 就是中文里一直说的「身份」。改名 = 换 id，这和家族现有说法「改身份」一致。云盘给的那个不透明编号在接口里叫 `ref`，不会撞 |
| | key | store 注释里叫过它「唯一跨后端 key」。缺点是和密码、kv 的 key、`trashKey` 撞 |
| 身份里「放在哪」的那一截 | **shelf** | 架子。没有任何技术上的旧含义 |
| | binder | 夹子，最贴近中文的「夹」 |
| | place | 最朴素，「放在哪」 |
| 人看的、人打的那一截 | stem | user「随便」，沿用 |
| 文档身份的结尾 | **suffix（已定）** | user 第三轮：「suffix应该没问题吧…ending是坏名字」。ending 作废。第四轮我建议过 docSuffix，user 定「suffix先这样吧」 |
| app 给这种文档起的标签 | kind | user「同意」 |

界面上给用户看的字仍然是「文件夹」，因为对用户来说它在 OneDrive 里确实就是个文件夹；这里定的只是代码和文档里身份这一层的词。

**定稿（2026-09-29 第四轮）**：

| 概念 | 定为 | user 原话 |
|---|---|---|
| 身份那一整串 | `identifier` | 「我就是想找一个和id不一样的词，我以为id是identity, 那么有什么是改名会变的?但是语义就是identifier啊，比如你同一家飞机transponder总是会设不同的数字」——id 会被读成 identity（永远不变）；identifier 是分配给它的号，可以重设，改名就是重设 |
| 最后一个 `/` 前面那一截 | `folder` | 「放在哪 那不就是folder吗，为什么你会纠结」 |
| 人看的、人打的那一截 | `stem` | 「随便」 |
| 文档身份的结尾 | `suffix` | 「identifier, folder, suffix先这样吧」。接口注释必写「整串比对，不数点」 |
| app 给这种文档起的标签 | `kind` | 「同意」 |

模块叫 `store.identifiers`，只有 `parse` 和 `join`。store 现有接口里指身份的 `Item.path`、`file(name)`、`nameOccupied`、`activeFileName`、`hiddenName` 一并改成 identifier 的说法。

**「多点的情况怎么办」**，分五种：

| 情况 | 怎么办 |
|---|---|
| 后缀自己有好几个点，`.webxiaoheiwu.zip` | 整串比对结尾，从来不数点 |
| 主干里有点，`v1.2 草稿.txt` | 主干是 `v1.2 草稿`。同样因为不数点 |
| 几个后缀都命中 | 取最长的 |
| 云端加密容器多出来的 `.zip`，`稿.txt.zip`、`书.webxiaoheiwu.zip.zip` | 先去掉一个 `.zip`，剩下的认得就是那份文档的加密容器；否则整串认得就是明文文档 |
| 表本身有歧义：某个后缀去掉结尾的 `.zip` 之后，剩下的又以表里另一个后缀结尾（例：同时报 `.a` 和 `.a.zip`，云端的 `X.a.zip` 两种读法都成立）；或者直接报了一个光秃秃的 `.zip` | `createStore` 当场抛错，不让这样的表进来。WXHW 的表（`.txt` 和 `.webxiaoheiwu.zip`）没有歧义 |

关于 suffix 这个词和 Python 对不对得上（user 问的，2026-09-29 实测）：

| Python 里的用法 | 对 `草稿/书.webxiaoheiwu.zip` 的结果 | 和我们的意思 |
|---|---|---|
| 字符串 `s.endswith(".webxiaoheiwu.zip")` | True | 一致：suffix 就是任意一段结尾，几个点都行 |
| 字符串 `s.removesuffix(".webxiaoheiwu.zip")` | `草稿/书` | 一致 |
| pathlib 的 `.suffix` | `.zip` | **不一致**：那里是「最后一个点之后」 |
| pathlib 的 `.suffixes` | `[".webxiaoheiwu", ".zip"]` | 不一致：按点拆开 |
| pathlib 的 `.stem` | `书.webxiaoheiwu` | 不一致：我们的主干是 `书` |

结论：和字符串函数对得上，和 pathlib 的属性对不上。接口注释里要写一句「整串比对，不数点」。

加密容器在云端多出来的那个 `.zip` 是底下那一层的事，宿主看不见，不给它起对外的词。

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
  /** 身份以什么结尾，含点，可以多段：".txt" / ".webxiaoheiwu.zip"。**整串比对，不数点**；大小写不敏感。 */
  suffix: string;
  /** 明文字节是什么容器。"zip" = 能按条目名取一小段（封面）；"raw" = 不能。库仍然不看内容。 */
  container: "raw" | "zip";
}
/** 一条文档身份切开之后。 */
export interface DocIdentifier {
  identifier: string;   // 身份本身
  folder: string;       // 最后一个 / 之前；"" = 最外层
  stem: string;         // 主干
  suffix: string;       // 命中的后缀，保留身份里原有的大小写
  kind: string;
  container: "raw" | "zip";
}
export interface Identifiers {
  /** 切开。不是本 app 的文档 → null。几个后缀都命中取最长的。 */
  parse(identifier: string): DocIdentifier | null;
  /** 拼回去。 */
  join(parts: { folder: string; stem: string; suffix: string }): string;
}
export interface StoreConfig {
  /** 必填表态（和 persistence / reconcilePolicy 同一类）。空数组 = 明确声明本 app 没有文档种类。 */
  docKinds: readonly DocKind[];
  /** 列举时藏起来的非文档噪音（原 hiddenName）。 */
  hidden?: (identifier: string) => boolean;
  /** 当前打开的文档（原 activeFileName）。 */
  activeIdentifier?: () => string | null;
  // 删除：fileName / encFileName / toName / crypt.ext / hiddenName / activeFileName
}
export interface Item { identifier: string; syncState; size?; lastModified? }   // 原 path
export interface Store {
  identifiers: Identifiers;
  /** 任何文件（文档、图片、杂物）。 */
  file(identifier: string, opts: { mode: "new" | "existing" }): RawFile;
  /** 只准用于 container 是 "zip" 的文档，否则抛。多出 getPeek / decryptPeek。 */
  zip(identifier: string, opts: { mode: "new" | "existing" }): ZipFile;
  files: { occupied(identifier: string): Promise<boolean>; /* 原 nameOccupied */ … };
}

// ── gallery ──
export interface GItem { identifier: string; stem: string; kind: string; syncState; size?; lastModified? }
export interface GalleryPolicy {
  /** 不是文档的文件里哪些算图片（WeebPaint 的云盘图片）。 */
  isImage?(identifier: string): boolean;
  /** 哪几个种类有缩略图。不给 = 都没有。 */
  thumbs?: { kinds: readonly string[]; dbName: string; fetch(identifier, source): Promise<Blob | null> };
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
2. **加密容器里记的扩展名：查清了，决定一个字节都不改。**（2026-09-29 查）`meta.bin` 是 `{v, name, ext}`，用途是人拿 7-Zip 手工恢复时把 `data.bin` 改回真名；全家没有任何程序读它（`unpackContainer` 把它带出来，store 和四个宿主都没人用）。其中 `name` 记的已经是完整的身份（含后缀），`ext` 是多余的一份、按最后一个点取（书是 `zip`）。改成按后缀取对程序没有任何影响，但它是落在用户文件里的字节，没有理由去动。所以 `cryptExtFor` 按最后一个点取的逻辑原样保留，只删掉没人用的回退配置 `crypt.ext`（四个宿主交给 store 的身份都带后缀，回退永远走不到）。
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

## 12. 要 user 定的（2026-09-29 第三轮收敛后只剩三个）

user 2026-09-29：「还有几个问题要问我？」

| # | 问题 | 我的建议 |
|---|---|---|
| 1 | 身份那一整串在代码里叫什么 | 定 `identifier`（第四轮） |
| 2 | 身份里最后一个 `/` 前面那一截叫什么 | 定 `folder`（第四轮） |
| 3 | 批不批 store 0.16.0 和 gallery 0.6.0 两个 minor 按本提案做 | **已批**（「好，你和另外一个agent协调好了就可以开始做了」）；和参考窗库会话已打过招呼 |

已经定了、不用再问的：

| 项 | 结论 | 谁定的 |
|---|---|---|
| kind | 用 | user「同意」 |
| stem | 用 | user「随便」 |
| suffix | 用；ending 作废 | user「suffix应该没问题吧…ending是坏名字」 |
| path、folder 不用于身份这一层 | 不用 | user「不同意，和文件系统的语义混淆」 |
| name 不再指任何精确的东西 | 是 | user「name是个坏名字」 |
| 种类表必填 | 是。可选就得在库里留着「猜」的那条路 | AI |
| 这一轮做到哪 | store 和 gallery 两刀加 WXHW；WeebPaint、CatsUp、JRB 不动 | AI，随第 3 问一起批 |
| `nameOccupied`、`activeFileName`、`hiddenName` | 跟着身份的词一起改名 | AI，随第 3 问一起批 |
| 模块名 | 不叫 `paths`（path 已被否），跟着身份的词走 | AI |
| gallery 的条目改成带身份、主干、种类 | 是，第 2 刀的一部分 | AI，随第 3 问一起批 |
| 加密容器里记的内容 | 一个字节都不改，见 §10 第 2 条 | AI |
