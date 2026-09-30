// identifiers：身份的语法。created 2026-09-29 by Claude Fable 5.1
//   §A 名字语料对账：四家宿主今天的配置 + 今天的行为（0.15.2 的 defaultCloudToName、WXHW 手写的 toName 正则）逐条和新推导比，
//   只有提案 §3 标了「坏的」那几处允许不同，而且逐条列出来。
import { test, eq, assert } from "./runner.mjs";
import { createIdentifiers, validateDocKinds, withStemTail, SEAL_SUFFIX, type DocKind } from "../src/identifiers.ts";
const deq = (a: unknown, b: unknown, msg?: string) => eq(JSON.stringify(a), JSON.stringify(b), msg);

const WXHW: DocKind[] = [{ kind: "book", suffix: ".webxiaoheiwu.zip", container: "zip" }, { kind: "draft", suffix: ".txt", container: "raw" }];
const WEEBPAINT: DocKind[] = [{ kind: "painting", suffix: ".ora", container: "zip" }];
const CATSUP: DocKind[] = [{ kind: "model", suffix: ".glb", container: "raw" }];
const JRB: DocKind[] = [{ kind: "book", suffix: ".txt", container: "raw" }];

// 0.15.2 的两种旧行为（原样抄来当对照，不 import——它们就是要被删掉的东西）
const oldDefaultToName = (c: string) => (c.endsWith(".zip") ? c.slice(0, -4) : c);
const oldWxhwToName = (c: string) => (c.endsWith(".zip") && /(\.txt|\.webxiaoheiwu\.zip)$/i.test(c.slice(0, -4))) ? c.slice(0, -4) : c;

test("[identifiers] parse：文件夹 / 主干 / 后缀 / 种类；整串比对不数点；几个都命中取最长；主干不能为空", () => {
  const ids = createIdentifiers(WXHW);
  deq(ids.parse("草稿/樱川.webxiaoheiwu.zip"), { identifier: "草稿/樱川.webxiaoheiwu.zip", folder: "草稿", stem: "樱川", suffix: ".webxiaoheiwu.zip", kind: "book", container: "zip" });
  deq(ids.parse("20260929-5c5c.txt"), { identifier: "20260929-5c5c.txt", folder: "", stem: "20260929-5c5c", suffix: ".txt", kind: "draft", container: "raw" });
  eq(ids.parse("v1.2 草稿.txt")!.stem, "v1.2 草稿", "主干里的点不是分隔");
  eq(ids.parse("笔记.txt.webxiaoheiwu.zip")!.stem, "笔记.txt", "主干以另一个后缀结尾也照样：取最长命中");
  eq(ids.parse("A.WEBXIAOHEIWU.ZIP")!.suffix, ".WEBXIAOHEIWU.ZIP", "大小写不敏感、保留原样");
  eq(ids.parse("a/b/c.txt")!.folder, "a/b", "多层文件夹");
  eq(ids.parse(".txt"), null, "整个就是后缀 = 没有主干");
  eq(ids.parse("夹/.txt"), null);
  eq(ids.parse("pic.png"), null, "不在表里 = 不是文档");
  eq(ids.parse("樱川.webxiaoheiwu"), null);
  eq(ids.parse(""), null);
});

test("[identifiers] join 是 parse 的逆；withStemTail 文档插在后缀前、非文档插在最后一个点前", () => {
  const ids = createIdentifiers(WXHW);
  for (const s of ["草稿/樱川.webxiaoheiwu.zip", "20260929-5c5c.txt", "v1.2 草稿.txt", "a/b/c.txt"]) { const d = ids.parse(s)!; eq(ids.join(d), s, s); }
  eq(ids.join({ folder: "", stem: "x", suffix: ".txt" }), "x.txt");
  eq(withStemTail("草稿/樱川.webxiaoheiwu.zip", " [20260929-143200]", ids), "草稿/樱川 [20260929-143200].webxiaoheiwu.zip");
  eq(withStemTail("稿.txt", " 副本", ids), "稿 副本.txt");
  eq(withStemTail("夹/pic.png", " 副本", ids), "夹/pic 副本.png", "非文档：最后一个点之前");
  eq(withStemTail("README", " 副本", ids), "README 副本", "非文档没有点：接在末尾");
  eq(withStemTail("夹.子/README", " 副本", ids), "夹.子/README 副本", "文件夹名里的点不算");
});

test("[identifiers] 云端名 ↔ 身份：加密容器 = 身份 + .zip；只有文档会被封", () => {
  const ids = createIdentifiers(WXHW);
  eq(ids.sealed("稿.txt"), "稿.txt.zip");
  eq(ids.sealed("书.webxiaoheiwu.zip"), "书.webxiaoheiwu.zip.zip");
  deq(ids.fromCloud("稿.txt.zip"), { identifier: "稿.txt", sealed: true });
  deq(ids.fromCloud("书.webxiaoheiwu.zip.zip"), { identifier: "书.webxiaoheiwu.zip", sealed: true });
  deq(ids.fromCloud("书.webxiaoheiwu.zip"), { identifier: "书.webxiaoheiwu.zip", sealed: false }, "明文的书：去掉 .zip 剩 书.webxiaoheiwu 不是文档 → 不是容器");
  deq(ids.fromCloud("稿.txt"), { identifier: "稿.txt", sealed: false });
  deq(ids.fromCloud("archive.zip"), { identifier: "archive.zip", sealed: false }, "不是文档的 zip 原名对待");
  deq(ids.fromCloud("夹/稿.TXT.zip"), { identifier: "夹/稿.TXT", sealed: true }, "文档后缀不分大小写");
  deq(ids.fromCloud("夹/稿.txt.ZIP"), { identifier: "夹/稿.txt.ZIP", sealed: false }, "加密后缀只认小写：大写 .ZIP 不是库封的");
});

test("[identifiers] 语料对账 · WeebPaint / CatsUp / JRB（单后缀、身份带后缀）：新推导 = 0.15.2 默认 toName，除了「不是文档却以 .zip 结尾」这一种", () => {
  for (const [table, docs] of [[WEEBPAINT, ["猫.ora", "插画/猫娘/001.ora", "v1.2 猫.ora"]], [CATSUP, ["cat.glb", "夹/cat.glb"]], [JRB, ["书.txt", "夹/书.txt"]]] as [DocKind[], string[]][]) {
    const ids = createIdentifiers(table);
    const corpus: string[] = [];
    for (const d of docs) corpus.push(d, `${d}.zip`, d.toUpperCase(), `${d.toUpperCase()}.ZIP`);
    corpus.push("pic.png", "夹/pic.png", "notes.md", "README", ".trash", "x.ora.zip.zip");
    for (const c of corpus) {
      const mine = ids.fromCloud(c).identifier, old = oldDefaultToName(c);
      const nonDocZip = c.toLowerCase().endsWith(".zip") && !ids.parse(c.slice(0, -4));
      if (nonDocZip) { eq(mine, c, `${c}：不是文档的 .zip 以后按原名对待（旧行为把它当 ${old} 的加密容器）`); continue; }
      eq(mine, old, c);
    }
  }
});

test("[identifiers] 语料对账 · WXHW（两种后缀、其一以 .zip 结尾）：新推导 = 宿主手写的 toName 正则，逐条相同", () => {
  const ids = createIdentifiers(WXHW);
  const corpus = ["稿.txt", "稿.txt.zip", "书.webxiaoheiwu.zip", "书.webxiaoheiwu.zip.zip", "夹/稿.txt.zip", "夹/书.webxiaoheiwu.zip", "20260929-5c5c.txt", "20260929-5c5c.txt.zip",
    "稿 [20260929-143200].txt", "书 [20260929-143200].webxiaoheiwu.zip", "笔记.txt.webxiaoheiwu.zip", "笔记.txt.webxiaoheiwu.zip.zip", "a.webxiaoheiwu.zip.txt", "a.webxiaoheiwu.zip.txt.zip",
    "pic.png", "archive.zip", "x.webxiaoheiwu", "x.webxiaoheiwu.zip.zip.zip", "稿.TXT.ZIP", "书.WEBXIAOHEIWU.ZIP"];
  for (const c of corpus) eq(ids.fromCloud(c).identifier, oldWxhwToName(c), c);
  // 而且 sealed 标志 = 「名字经 toName 变了」，和 0.13.0 起的判定口径一致
  for (const c of corpus) eq(ids.fromCloud(c).sealed, oldWxhwToName(c) !== c, `sealed: ${c}`);
});

test("[identifiers] 表校验：格式、重复、和加密后缀的歧义都当场拒绝；空表合法", () => {
  const bad = (rows: unknown, re: RegExp) => { let msg = ""; try { validateDocKinds(rows as DocKind[]); } catch (e) { msg = String((e as Error).message); } assert(re.test(msg), `expected ${re} got: ${msg}`); };
  validateDocKinds([]);
  validateDocKinds(WXHW); validateDocKinds(WEEBPAINT);
  bad([{ kind: "", suffix: ".txt", container: "raw" }], /non-empty kind/);
  bad([{ kind: "a", suffix: "txt", container: "raw" }], /must start with "\."/);
  bad([{ kind: "a", suffix: ".", container: "raw" }], /at least one character/);
  bad([{ kind: "a", suffix: ".a/b", container: "raw" }], /must not contain/);
  bad([{ kind: "a", suffix: ".txt", container: "tar" }], /container must be/);
  bad([{ kind: "a", suffix: ".txt", container: "raw" }, { kind: "b", suffix: ".TXT", container: "raw" }], /declared twice/);
  bad([{ kind: "a", suffix: ".zip", container: "zip" }], /bare "\.zip"/);
  bad([{ kind: "a", suffix: ".a", container: "raw" }, { kind: "b", suffix: ".a.zip", container: "zip" }], /ambiguous/);
  bad([{ kind: "a", suffix: ".a", container: "raw" }, { kind: "b", suffix: ".x.a.zip", container: "zip" }], /ambiguous/);
  bad([{ kind: "a", suffix: ".b.a", container: "raw" }, { kind: "b", suffix: ".a.zip", container: "zip" }], /ambiguous/);
  bad([{ kind: "a", suffix: ".zip.zip", container: "zip" }], /ambiguous/);
  validateDocKinds([{ kind: "a", suffix: ".a", container: "raw" }, { kind: "b", suffix: ".b.zip", container: "zip" }]);   // .b 和 .a 不互为结尾 → 合法
  assert(typeof SEAL_SUFFIX === "string");
});

test("[identifiers] 表是冻结的；kinds 原样带出", () => {
  const ids = createIdentifiers(WXHW);
  eq(ids.kinds.length, 2); eq(ids.kinds[0]!.kind, "book");
  let threw = false; try { (ids.kinds as DocKind[]).push({ kind: "x", suffix: ".x", container: "raw" }); } catch { threw = true; }
  assert(threw);
});
