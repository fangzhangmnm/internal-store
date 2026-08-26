// IDB 事务形状语法护栏（user 2026-08-25 拍板，ai-docs/20260825-localfile-knight-store-round.md §1.1）。
// created 2026-08-26 by Claude Fable 5 (claude-fable-5)
//
// 守的红线：**IDB 写入必须等事务 commit 才算成功**。配额撞墙时真实事件顺序是
//   `req.success → tx.abort(QuotaExceededError)` —— 在 req.onsuccess 就 resolve 的形状会把
//   没落盘的写报成成功（上层清 dirty、停重试 = 静默丢编辑）。2026-08-21 实锤，
//   详 WeebPaint ai-docs/20260821-storage-eviction-investigation.md §B.2。
// 语法规则（行为面由真浏览器夹具 tools/idb-tx-commit-check.mjs 压测，node 测不到 IDB）：
//   ① `db.transaction` 全 src 只许出现在 idb-store.ts 的 tx() helper 内，恰一次——不许再分叉第二种事务形状；
//   ② helper 形状：resolve 只挂 `t.oncomplete`；`t.onerror` + `t.onabort` 都接 reject；
//      QuotaExceededError 走 reportStoreError funnel；
//   ③ 事务内不许出现「onsuccess 里 resolve」（openDb 的 indexedDB.open 回调是唯一豁免——那不是事务）。
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

const srcDir = fileURLToPath(new URL("../src", import.meta.url));   // 仓路径含空格：必须 fileURLToPath
const idbPath = join(srcDir, "idb-store.ts");
const idbSrc = readFileSync(idbPath, "utf8");
const idbLines = idbSrc.split("\n");

test("全库唯一事务入口：`.transaction(` 只在 idb-store.ts 且恰一次（tx() helper 内）", () => {
  const offenders: string[] = [];
  for (const file of walk(srcDir)) {
    const lines = readFileSync(file, "utf8").split("\n");
    lines.forEach((line, i) => {
      if (!line.includes(".transaction(")) return;
      if (file === idbPath) return;                       // 本尊单独数（下面）
      offenders.push(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
  assert(offenders.length === 0, `idb-store.ts 之外开了 IDB 事务（形状纪律要求全走 tx() helper）:\n${offenders.join("\n")}`);
  const inIdb = idbLines.filter((l) => l.includes(".transaction(")).length;
  assert(inIdb === 1, `idb-store.ts 里 .transaction( 应恰 1 处（tx() helper），实际 ${inIdb} —— 别分叉第二种事务形状`);
});

test("tx() helper 形状：resolve 只认 oncomplete；onerror+onabort 都 reject；Quota 走 reportStoreError", () => {
  // 数**赋值形态**（`t.oncomplete =`），注释里提及不算——护栏管代码形状不管文案
  const completes = idbLines.filter((l) => l.includes("t.oncomplete ="));
  assert(completes.length === 1, `\`t.oncomplete =\` 应恰 1 处（helper 内），实际 ${completes.length}`);
  assert(/resolve\(/.test(completes[0]), `resolve 必须发生在 t.oncomplete（落盘确认）: ${completes[0].trim()}`);
  assert(idbLines.filter((l) => l.includes("t.onabort =")).length === 1, "`t.onabort =` 应恰 1 处（helper 内接 reject）");
  assert(/t\.onerror = fail/.test(idbSrc) && /t\.onabort = fail/.test(idbSrc), "t.onerror 与 t.onabort 必须都接统一 fail()（reject 双通道）");
  assert(/QuotaExceededError/.test(idbSrc) && /reportStoreError\(/.test(idbSrc), "QuotaExceededError 必须 funnel 进 reportStoreError（拍板 2026-08-25 §1.1）");
});

test("事务内禁「onsuccess 里 resolve」（唯一豁免 = openDb 的 indexedDB.open 回调）", () => {
  const openDbStart = idbLines.findIndex((l) => l.includes("function openDb"));
  const txStart = idbLines.findIndex((l) => l.includes("function tx<"));
  assert(openDbStart >= 0 && txStart > openDbStart, "结构变了（openDb/tx 找不到或顺序变了）——护栏需要人重新核对");
  const offenders: string[] = [];
  idbLines.forEach((line, i) => {
    if (!(/onsuccess/.test(line) && /resolve\(/.test(line))) return;
    if (i > openDbStart && i < txStart) return;           // openDb 区间：indexedDB.open 的 onsuccess，非事务
    offenders.push(`${i + 1}: ${line.trim()}`);
  });
  assert(offenders.length === 0, `事务 request 的 onsuccess 里直接 resolve = 配额撞墙谎报成功的回归:\n${offenders.join("\n")}`);
});
