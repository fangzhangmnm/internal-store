// 结构守卫（2.3.2，家族周账 F-238；设计稿 = 家族根 ai-docs/20261110-design-store-save-gen-fix.md 第四节第 4 条）。created 2026-11-10 by Claude Opus 5.5
//   「宣布这份文件已经和网盘一致」= head.onPushed(…, dirtyAfter=false 的可能) / head.markSynced(…)。宣布之后本机那份就允许被别的设备的新版直接换掉、
//   允许被腾空间清掉——所以每一处都必须说清它对的是哪一份字节（号从哪来，规矩 R1–R3 见 src/works/disk-ledger.ts 头注释）。
//   下面这张表 = 源码里每一个调用点（文件 + 所在函数 + 调了哪个）。源码多了、少了、挪到别的函数里 → 红：以后谁加一处「宣布一致」，先在这张表里写清它的号。
import { test, assert, eq } from "./runner.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));   // 仓路径含空格：必须 fileURLToPath
function* walk(dir: string): Generator<string> {
  for (const n of readdirSync(dir)) { const p = join(dir, n); if (statSync(p).isDirectory()) yield* walk(p); else if (p.endsWith(".ts")) yield p; }
}
/** 所在函数 = 往上数括号，第一个「打开了一层还没关、而且是函数头」的行。字符串和注释先剥掉（模板串里的 ${ 不算括号）。 */
const strip = (l: string) => l.replace(/\/\/.*$/, "").replace(/`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
const HEADS = [/\bfunction\s+([A-Za-z_$][\w$]*)\s*[<(]/, /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]*)?\{/, /^\s*([A-Za-z_$][\w$]*)\s*:\s*(?:async\s*)?\(/, /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\(/];
const NOT_FN = new Set(["if", "for", "while", "switch", "catch", "return"]);
function enclosing(lines: string[], i: number): string {
  let depth = 0;
  for (let j = i - 1; j >= 0; j--) {
    const l = strip(lines[j]!);
    depth += (l.match(/\}/g) ?? []).length - (l.match(/\{/g) ?? []).length;
    if (depth < 0) {                                   // 这一行打开了一层包着调用点的块
      for (const re of HEADS) { const m = l.match(re); if (m && !NOT_FN.has(m[1]!)) return m[1]!; }
      depth = 0;                                       // 不是函数头（if / try / busy(…, async () => {）：接着往外找
    }
  }
  return "(top)";
}
type Site = { file: string; fn: string; call: "onPushed" | "markSynced" | "declare" };
function scan(): Site[] {
  const out: Site[] = [];
  for (const f of walk(SRC)) {
    const lines = readFileSync(f, "utf8").split("\n");
    lines.forEach((l, i) => {
      const code = l.replace(/\/\/.*$/, "");
      for (const call of ["onPushed", "markSynced"] as const) if (code.includes(`head.${call}(`)) out.push({ file: relative(SRC, f).replace(/\\/g, "/"), fn: enclosing(lines, i), call });
      if (/(?<![.\w])declare\(/.test(code) && !/const declare\s*=/.test(code)) out.push({ file: relative(SRC, f).replace(/\\/g, "/"), fn: enclosing(lines, i), call: "declare" });
    });
  }
  return out;
}
// 文件 · 所在函数 · 调了哪个 · 归哪一类 / 号从哪来
const TABLE: Array<Site & { why: string }> = [
  { file: "works/push.ts", fn: "doPush", call: "onPushed", why: "推成了：号 = opts.gen（save 自己的号）或 doPush 开头读的 ledger.disk（调用方在同名串行段里读盘，R2）；dirtyAfter = 宿主游标变了 ∨ !settled" },
  { file: "works/safe-resolve.ts", fn: "declare", call: "onPushed", why: "自愈 / 本地覆盖云端的宣布：调用方给的 settled() 为假 → 基准接上、仍待传" },
  { file: "works/safe-resolve.ts", fn: "declare", call: "markSynced", why: "同上，settled() 为真（或没给 = 2.3.1 行为）" },
  { file: "works/safe-resolve.ts", fn: "tryHeal", call: "declare", why: "推送撞 412 拉回来逐字节一样：settled = 这次推的号（push.ts unchanged）；「处理…」比字节：号 = 在队里和字节一起取的 ledger.disk" },
  { file: "works/safe-resolve.ts", fn: "weakOverride", call: "declare", why: "冲突面选了本地覆盖云端：settled = 这次推的号" },
  { file: "works/safe-resolve.ts", fn: "commit", call: "markSynced", why: "云端覆盖本地 / 干净快进：号 = 覆盖之后 ledger.wrote；备份之后盘上换过（d0）= 途中保存过；!settled = 不提交谱系（③）" },
  { file: "works/identity.ts", fn: "acquire", call: "markSynced", why: "首次取回落本机：号 = ledger.wrote；!settled = 不宣布" },
  { file: "create-store.ts", fn: "adoptLocal", call: "markSynced", why: "下载会话落地：号 = ledger.wrote；!settled = 不宣布" },
  { file: "create-store.ts", fn: "encSwap", call: "onPushed", why: "加密转换：云没回版本号 / 推失败 = dirtyAfter 恒 true（不宣布）；推成了 = 号 ledger.wrote，dirtyAfter = !settled" },
  { file: "create-store.ts", fn: "encSwap", call: "onPushed", why: "（同上，三处）" },
  { file: "create-store.ts", fn: "encSwap", call: "onPushed", why: "（同上，三处）" },
];
const key = (s: Site) => `${s.file} · ${s.fn} · ${s.call}`;

test("[对号守卫] 每一处「宣布和网盘一致」都在表里登记了号从哪来（多了 / 少了 / 挪了都红）", () => {
  const found = scan().map(key).sort(), want = TABLE.map(key).sort();
  const extra = found.filter((k, i, a) => a.slice(0, i + 1).filter((x) => x === k).length > want.filter((x) => x === k).length);
  const missing = want.filter((k, i, a) => a.slice(0, i + 1).filter((x) => x === k).length > found.filter((x) => x === k).length);
  assert(extra.length === 0 && missing.length === 0, `源码和表对不上。\n  源码里有、表里没有：${extra.join(" | ") || "—"}\n  表里有、源码里没有：${missing.join(" | ") || "—"}\n  （新加一处宣布一致：先想清它的号从哪来，写进 test/declare-synced-guard.test.ts 的 TABLE）`);
});

test("[对号守卫] save() 里标脏、取号、进同名串行段三步之间没有 await（发出即占位）", () => {
  const s = readFileSync(join(SRC, "create-store.ts"), "utf8");
  const a = s.indexOf("head.recordEdit(name);                                   // 同步标脏");
  assert(a > 0, "找得到 save() 里的 recordEdit");
  const b = s.indexOf("const g = ledger.issue(name);", a), c = s.indexOf("const landing = sub.serialize(name, async () => {", a);
  assert(b > a && c > b, "顺序：recordEdit → ledger.issue → sub.serialize");
  const between = s.slice(a, c).split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert(!/\bawait\b/.test(between), "三步之间不许有 await");
  const body = s.slice(c, s.indexOf("const { sealed, receipt } = await landing;", c));
  assert(/seal\.sealForWrite\(/.test(body) && /local\.save\(/.test(body) && /ledger\.landed\(name, g\)/.test(body) && /ledger\.failed\(name, g\)/.test(body), "封装和写盘在队里；落了记 landed、抛了记 failed");
});

test("[对号守卫] 封装里不进同名串行段（save 已经站在队里，再进 = 自己锁自己）", () => {
  const s = readFileSync(join(SRC, "works/seal.ts"), "utf8").split("\n").map((l) => l.replace(/\/\/.*$/, "")).join("\n");
  assert(!/serialize2?\(/.test(s), "seal.ts 里没有 serialize(");
});

test("[对号守卫] 读盘上的字节来推的，都在同名串行段里读（R2）", () => {
  const s = readFileSync(join(SRC, "create-store.ts"), "utf8");
  const calls = [...s.matchAll(/pushLocalBytes\(name\)/g)].map((m) => s.slice(Math.max(0, m.index! - 260), m.index! + 20));
  eq(calls.length, 2, "pushLocalBytes 的两个直接调用：dirty.pushAll / reupload");
  for (const c of calls) assert(/sub\.serialize\(name, /.test(c), `调用点在串行段里：…${c.slice(-160)}`);
  assert(/pushLocal: pushLocalBytes/.test(s), "离线补推接的是它");
  const q = readFileSync(join(SRC, "works/upload-queue.ts"), "utf8");
  const iq = q.indexOf("pushLocal(name)");
  assert(iq > 0 && q.lastIndexOf("serialize(name, async", iq) > q.lastIndexOf("}));", iq), "离线补推在同名串行段里调它");
  assert(!/encode: \(\) => atRest/.test(s.slice(s.indexOf("async resolve(") >>> 0)), "「处理…」的本地覆盖云端不再在队外先读好字节");
});
