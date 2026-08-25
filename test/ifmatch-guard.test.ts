// 全库 If-Match 语法检测护栏（user 2026-08-25 拍板：「全库以后只能用 if match，进语法检测护栏」）。
// created 2026-08-25 by Claude Fable 5 (claude-fable-5)
//
// 规则：源码里任何**调用点字面量** `conflictBehavior: "replace"` 的语句必须同语句携带 eTag（CAS 覆盖）；
//   新建走 `"fail"`（不存在才准建 = CAS 等价物）。函数签名的默认值（`conflictBehavior = "replace"`）不算
//   调用点，由 graph.uploadFileToApproot 的运行时护栏兜底（blind replace 直接 throw）。
//   豁免：确有单独论证的行加 `IF-MATCH-EXEMPT(<理由>)` 注释——当前应为零。
import { test, assert } from "./runner.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (p.endsWith(".ts")) yield p;
  }
}

test("全库无裸 replace：conflictBehavior:\"replace\" 的调用点必须同语句带 eTag（If-Match 家规 2026-08-25）", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));   // 仓路径含空格：URL.pathname 会 %20，必须 fileURLToPath
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes('conflictBehavior: "replace"')) return;   // 调用点字面量（签名默认值是 `=`，不匹配）
      if (line.includes("IF-MATCH-EXEMPT")) return;
      // 同语句找 eTag：本行或紧邻上下一行（多行调用的参数对象）
      const ctx = [lines[i - 1] ?? "", line, lines[i + 1] ?? ""].join("\n");
      if (!/eTag/.test(ctx)) offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert(offenders.length === 0, `裸 replace（无 If-Match）:\n${offenders.join("\n")}`);
});

test("运行时护栏在位：graph.uploadFileToApproot 拒绝 blind replace", () => {
  const graphSrc = readFileSync(fileURLToPath(new URL("../src/providers/graph.ts", import.meta.url)), "utf8");
  assert(graphSrc.includes('blind overwrite forbidden'), "graph.ts 必须保有 replace-无-eTag 的运行时 throw（语法护栏的深模块兜底）");
});
