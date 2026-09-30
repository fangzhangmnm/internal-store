// 身份（identifier）的语法。created 2026-09-29 by Claude Fable 5.1（提案 ai-docs/20260929-proposal-doc-types.md，user 2026-09-29 批）
//
// 这是库里**唯一**允许切身份、拼身份的地方。宿主在 createStore 时把自己有哪几种文档、各自以什么结尾报一次（docKinds 表），
// 之后「这个身份是不是文档、主干在哪、后缀从哪开始、云端那个名字是不是加密容器」全部从这张表推导。
// 2026-09-29 之前这些问题散在七八个回调里各答各的（toName / crypt.ext / isZip / docExts / gallery 的 naming、isDoc、isZipDoc…），
// 根子是家族出生时假设「一个 app 一种文档一个扩展名」；WXHW 同时有 .txt 稿和 .webxiaoheiwu.zip 书之后全坏了。
//
// 用词（user 逐词定的，别改）：
//   identifier 身份 = 库对外说的「这是哪一份文档」，形如 `文件夹/主干后缀`。改名、挪文件夹就是换身份（transponder 号可以重设）。
//   folder     = 身份里最后一个 `/` 之前；"" = 最外层。
//   stem       = 主干，人看的、人打的那一截。
//   suffix     = 身份的结尾，含点，可以多段（".webxiaoheiwu.zip"）。**整串比对，不数点**：和 Python 字符串的 endswith / removesuffix
//                一个意思，和 pathlib 那个只取最后一个点的 `.suffix` 不是一回事。
//   kind       = app 给这种文档起的标签，库原样带着，不解释。
// 底下那一层（云盘和本地文件夹里真实的文件）仍然用 path / name / 扩展名 这些词，那里就是文件系统的意思；身份这一层不借用它们。
//
// 纯函数、零 IO。库内 cloud-sync / trash-merge / local-cache / move-aside / seal 都从这里取答案；gallery 和宿主也直接用 store.identifiers。

export interface DocKind {
  /** app 自己的标签（开放集，如 "book" / "draft" / "painting"）。几行可以是同一个 kind（同一种文档几种拼法）。 */
  kind: string;
  /** 身份以什么结尾，含点，可以多段：".txt" / ".webxiaoheiwu.zip"。整串比对，不数点；大小写不敏感。 */
  suffix: string;
  /** 明文字节是什么容器。"zip" = 能按条目名取一小段（封面 peek，`store.zip()`）；"raw" = 不能。库仍然不看内容。 */
  container: "raw" | "zip";
}

/** 一条文档身份切开之后。 */
export interface DocIdentifier {
  /** 身份本身，原样。 */
  identifier: string;
  /** 最后一个 `/` 之前；"" = 最外层。 */
  folder: string;
  /** 主干。 */
  stem: string;
  /** 命中的后缀，保留身份里原有的大小写。 */
  suffix: string;
  kind: string;
  container: "raw" | "zip";
}

export interface Identifiers {
  /** 报进来的表（已冻结）。 */
  readonly kinds: readonly DocKind[];
  /** 切开。不是本 app 的文档 → null。几个后缀都命中取最长的；主干不能为空（身份整个就是后缀不算文档）。 */
  parse(identifier: string): DocIdentifier | null;
  /** 拼回去：`folder/stem + suffix`（folder 为空就没有斜杠）。不检查 suffix 在不在表里——拼非文档的名字也允许。 */
  join(parts: { folder: string; stem: string; suffix: string }): string;
}

/** 加密容器在云端多出来的那一截（ADR-0012：外壳是明文 STORE zip）。底下那一层的事，宿主看不见。 */
export const SEAL_SUFFIX = ".zip";

/** 库内用的超集（不出门牌）：身份 ↔ 云端真实文件名。 */
export interface IdentifierCodec extends Identifiers {
  /** 这份文档的加密容器在云端叫什么 = 身份 + ".zip"。 */
  sealed(identifier: string): string;
  /** 云端真实文件名 → 身份。
   *  先去掉结尾的一个小写 ".zip"：剩下的认得是文档 → 那是它的加密容器（sealed）；否则整个名字就是身份、不是容器。
   *  不认得的文件（图片、杂物）永远按明文原名对待——只有文档会被封。 */
  fromCloud(cloudName: string): { identifier: string; sealed: boolean };
}

/** 检查表：格式、重复、和加密后缀的歧义。有问题 → 抛（createStore 当场失败，绝不带着一张会认错文件的表跑起来）。 */
export function validateDocKinds(docKinds: readonly DocKind[]): void {
  if (!Array.isArray(docKinds)) throw new Error("docKinds must be an array (pass [] to declare that this app has no document kinds)");
  const seen = new Set<string>();
  for (const k of docKinds) {
    if (!k || typeof k.kind !== "string" || !k.kind) throw new Error(`docKinds: every row needs a non-empty kind (got ${JSON.stringify(k)})`);
    if (typeof k.suffix !== "string" || k.suffix.length < 2 || !k.suffix.startsWith(".")) throw new Error(`docKinds[${k.kind}]: suffix must start with "." and have at least one character after it (got ${JSON.stringify(k.suffix)})`);
    if (k.suffix.includes("/") || /\s$/.test(k.suffix)) throw new Error(`docKinds[${k.kind}]: suffix must not contain "/" or end with whitespace (got ${JSON.stringify(k.suffix)})`);
    if (k.container !== "raw" && k.container !== "zip") throw new Error(`docKinds[${k.kind}]: container must be "raw" or "zip" (got ${JSON.stringify(k.container)})`);
    const low = k.suffix.toLowerCase();
    if (seen.has(low)) throw new Error(`docKinds: suffix ${JSON.stringify(k.suffix)} declared twice`);
    seen.add(low);
  }
  // 和加密后缀的歧义：某个后缀 S 以 ".zip" 结尾，去掉 ".zip" 剩 T；若表里有 S1 使得 T 与 S1 互为结尾（含 T 为空），
  //   那么云端的 `X + S` 既可以读成「明文的 S 文档」也可以读成「S1 文档 X+T 的加密容器」→ 拒绝。
  const lows = [...seen];
  for (const s of lows) {
    if (!s.endsWith(SEAL_SUFFIX)) continue;
    const t = s.slice(0, -SEAL_SUFFIX.length);
    for (const s1 of lows) {
      if (t.endsWith(s1) || s1.endsWith(t)) {
        throw new Error(`docKinds: suffix ${JSON.stringify(s)} is ambiguous with the encryption container suffix "${SEAL_SUFFIX}"` +
          (t ? ` because ${JSON.stringify(t)} and ${JSON.stringify(s1)} overlap` : ` (a bare ".zip" document suffix can never be told apart from a container)`) +
          `: a cloud file named "X${s}" could be either a plaintext "${s}" document or the encrypted container of "X${t}"`);
      }
    }
  }
}

export function createIdentifiers(docKinds: readonly DocKind[]): IdentifierCodec {
  validateDocKinds(docKinds);
  const kinds: readonly DocKind[] = Object.freeze(docKinds.map((k) => Object.freeze({ kind: k.kind, suffix: k.suffix, container: k.container })));
  // 长的先试：几个后缀都命中取最长的（".webxiaoheiwu.zip" 优先于 ".zip"）
  const bySuffixLength = [...kinds].sort((a, b) => b.suffix.length - a.suffix.length);

  function parse(identifier: string): DocIdentifier | null {
    if (typeof identifier !== "string" || !identifier) return null;
    const slash = identifier.lastIndexOf("/");
    const folder = slash < 0 ? "" : identifier.slice(0, slash);
    const base = slash < 0 ? identifier : identifier.slice(slash + 1);
    const low = base.toLowerCase();
    for (const k of bySuffixLength) {
      const s = k.suffix.toLowerCase();
      if (low.length > s.length && low.endsWith(s)) {
        return { identifier, folder, stem: base.slice(0, base.length - s.length), suffix: base.slice(base.length - s.length), kind: k.kind, container: k.container };
      }
    }
    return null;
  }
  function join(parts: { folder: string; stem: string; suffix: string }): string {
    const folder = parts.folder ?? "";
    return `${folder ? `${folder}/` : ""}${parts.stem}${parts.suffix}`;
  }
  function sealed(identifier: string): string { return `${identifier}${SEAL_SUFFIX}`; }
  function fromCloud(cloudName: string): { identifier: string; sealed: boolean } {
    // 加密后缀**区分大小写**：容器是库自己封的、永远小写 ".zip"；大写 ".ZIP" 不是库写的，按明文原名对待（0.15.2 同此口径）。
    //   文档后缀则不分大小写（parse 里）。
    if (cloudName.endsWith(SEAL_SUFFIX)) {
      const inner = cloudName.slice(0, -SEAL_SUFFIX.length);
      if (parse(inner)) return { identifier: inner, sealed: true };
    }
    return { identifier: cloudName, sealed: false };
  }
  return { kinds, parse, join, sealed, fromCloud };
}

/** 身份里插一段（副本 / 撞名时间戳 / 序号）：文档 → 主干后面、后缀前面；不是文档 → 最后一个点之前（没有点就接在末尾）。
 *  两条腿（本地 / 云端）恢复撞名、gallery 复制都走这一个函数，别再各写各的。 */
export function withStemTail(identifier: string, tail: string, ids: Identifiers): string {
  const d = ids.parse(identifier);
  if (d) return ids.join({ folder: d.folder, stem: `${d.stem}${tail}`, suffix: d.suffix });
  const slash = identifier.lastIndexOf("/");
  const base = slash < 0 ? identifier : identifier.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base, rest = dot > 0 ? base.slice(dot) : "";
  return `${slash < 0 ? "" : identifier.slice(0, slash + 1)}${stem}${tail}${rest}`;
}
