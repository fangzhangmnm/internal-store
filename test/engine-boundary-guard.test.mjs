// 两台引擎一个包（2.0.0，2026-10-17 Claude Fable 5.1；user「要不要包里面重构分两个单一职责的库，还是现在其实已经架构反应这个了」）。
// 结构守卫（grep import，不跑代码）：
//   · 作品引擎（save / push / 冲突 / 回收站 / 列举 / collections）和资源引擎（openStream / staging / 调度 / 镜像 / SW 网关）**互不 import**；
//   · 两台都只准 import 底座（provider / graph / IDB / 身份语法 / 错误汇报 / 类型）；
//   · 底座不准 import 任何一台引擎（反向箭头 = 边界漏了）。
//   · 只有组合根（create-store.ts / index.ts）看得见两台。
// 这就是「物理拆包」要保证的东西，先在包里机械守住；真拆（= 3.0.0）时三个夹就是三个包。src/testing/ 是 mock 替身，不在图里。
import { describe, it, assert } from "./runner.mjs";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";

const SRC = resolve("src");
// 归类 = 文件夹（2026-10-17 深夜 user「做」：物理挪进三个夹）。src/ 顶层只许组合根两个文件；新文件不进夹 → 红。
const COMPOSITION = new Set(["create-store.ts", "index.ts"]);
const groupOf = (f) => f.startsWith("base/") ? "substrate" : f.startsWith("works/") ? "works" : f.startsWith("stream/") ? "stream" : COMPOSITION.has(f) ? "composition" : null;

function* walk(d) { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) { if (f !== "testing") yield* walk(p); } else if (f.endsWith(".ts")) yield p; } }
const edges = [];   // [from, to]（相对 src 的路径）
const unknown = [];
for (const abs of walk(SRC)) {
  const from = relative(SRC, abs).replace(/\\/g, "/");
  if (!groupOf(from)) { unknown.push(from); continue; }
  const text = readFileSync(abs, "utf8");
  for (const m of text.matchAll(/import\s+(?:type\s+)?[^;]*?from\s+"(\.[^"]+)"/g)) {
    const to = relative(SRC, resolve(dirname(abs), m[1])).replace(/\\/g, "/");
    edges.push([from, to]);
  }
}

describe("engine-boundary-guard · 两台引擎互不 import、只共用底座", () => {
  it("src 里每个文件都在 base/ works/ stream/ 之一（顶层只有组合根两个文件）", () => {
    assert(unknown.length === 0, `没归类的文件：${unknown.join(", ")}（放进 src/base、src/works 或 src/stream；顶层只许 create-store.ts / index.ts）`);
  });
  it("作品引擎 ↔ 资源引擎 零 import", () => {
    const bad = edges.filter(([a, b]) => (groupOf(a) === "works" && groupOf(b) === "stream") || (groupOf(a) === "stream" && groupOf(b) === "works"));
    assert(bad.length === 0, `越界：${bad.map(([a, b]) => `${a} → ${b}`).join("; ")}`);
  });
  it("两台引擎只 import 底座（和自己那台）", () => {
    const bad = edges.filter(([a, b]) => ["works", "stream"].includes(groupOf(a)) && !["substrate", groupOf(a)].includes(groupOf(b)));
    assert(bad.length === 0, `引擎 import 了不该 import 的：${bad.map(([a, b]) => `${a} → ${b}`).join("; ")}`);
  });
  it("底座不 import 任何引擎、不 import 组合根", () => {
    const bad = edges.filter(([a, b]) => groupOf(a) === "substrate" && groupOf(b) !== "substrate");
    assert(bad.length === 0, `底座反向依赖：${bad.map(([a, b]) => `${a} → ${b}`).join("; ")}`);
  });
});
