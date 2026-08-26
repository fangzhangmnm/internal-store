// idb-tx-commit-check —— 红线回归：**IDB 写入必须等事务 commit 才算成功**。
// created 2026-08-26 by Claude Fable 5 (claude-fable-5)——从 tag `opus-round-20260821-before-rollback`
//   的同名夹具参考重造（那版 2026-08-21 当晚经变异测试判定诚实；随 opus 轮整批回滚陪葬，
//   0.3.6 按 user 2026-08-25 拍板复活，见 ai-docs/20260825-localfile-knight-store-round.md §1.1）。
//
// 守的 bug（2026-08-21 实锤，详 WeebPaint ai-docs/20260821-storage-eviction-investigation.md §B.2）：
//   配额撞墙时 IDB 的真实事件顺序是 `req.success → tx.abort(QuotaExceededError)`。
//   若在 req.onsuccess 就 resolve（v0.3.0 及之前就是），一次**根本没落盘**的写会被报成成功，
//   一路向上让 app 清掉 dirty、停掉重试 —— 静默丢用户编辑，且零 unhandled rejection。
//
// 这个夹具跑的是**真实构建产物** dist/idb-store.js（不是逐字复刻，也不是源码）——
//   家规「人类审 exports = 真实 dist，不是提案文字」的同一条纪律。
//   0.3.6 起同时验证：QuotaExceededError 必 funnel 进 reportStoreError（同一 dist 模块实例挂探针）。
//
// 为什么不在 `npm test` 里：node 测不到 IndexedDB，要真浏览器 + CDP 才能压出配额墙。
//   发版 ritual 手动跑一次即可（改了 idb-store.ts 必跑）。语法面由 test/idb-tx-guard.test.ts 常驻把守。
//   **不 vendor fake-indexeddb**（拍板 2026-08-25：quota abort 模拟不可信，假绿危险）。
//
// 跑法：
//   bash scripts/build.sh                      # 必须先构建，夹具加载的是 dist/
//   node tools/idb-tx-commit-check.mjs
//   # 本仓不装 playwright，夹具会自动去兄弟仓 (../20260524 WeebPaint/node_modules) 找；
//   # 装在别处就显式指：PLAYWRIGHT_DIR=<某仓>/node_modules node tools/idb-tx-commit-check.mjs
//
// 期望：两组全过。实验组若打印「put() 竟然 resolve 了」= 红线破了，别发版。

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
const PORT = 8941;

if (!fs.existsSync(path.join(DIST, "idb-store.js"))) {
  console.error("[check] 找不到 dist/idb-store.js —— 先跑 `bash scripts/build.sh`。");
  process.exit(1);
}

// 本仓不装 playwright（不想让库的 install 拖一个浏览器下来）→ 先试自己的，再借兄弟仓的。
//   NODE_PATH 对 ESM 不生效，所以这里按绝对路径显式解析。要指定别处用 PLAYWRIGHT_DIR=/path/to/node_modules。
async function loadChromium() {
  const dirs = [];
  if (process.env.PLAYWRIGHT_DIR) dirs.push(process.env.PLAYWRIGHT_DIR);
  for (const sib of ["20260524 WeebPaint"]) dirs.push(path.join(ROOT, "..", sib, "node_modules"));
  const tries = ["playwright"];
  for (const d of dirs) for (const entry of ["index.mjs", "index.js"]) {
    const f = path.join(d, "playwright", entry);
    if (fs.existsSync(f)) tries.push(pathToFileURL(f).href);
  }
  for (const spec of tries) {
    try {
      const m = await import(spec);
      const c = m.chromium ?? m.default?.chromium;
      if (c) return c;
    } catch { /* 下一个 */ }
  }
  return null;
}
const chromium = await loadChromium();
if (!chromium) {
  console.error("[check] 找不到 playwright。装一个，或 PLAYWRIGHT_DIR=<某仓>/node_modules node tools/idb-tx-commit-check.mjs");
  process.exit(1);
}

const PAGE = `<!doctype html><meta charset="utf-8"><title>idb-tx-commit-check</title>`;

const srv = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/" || url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
    return;
  }
  const f = path.join(DIST, path.normalize(url).replace(/^(\.\.[/\\])+/, ""));
  if (!f.startsWith(DIST) || !fs.existsSync(f)) { res.writeHead(404); res.end("nope"); return; }
  res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
  res.end(fs.readFileSync(f));
});
await new Promise((r) => srv.listen(PORT, r));

const ORIGIN = `http://localhost:${PORT}`;

/** quotaMiB=0 → 不压配额（对照组）。返回页面里跑出来的结构化结果。 */
async function run(quotaMiB, fillBlocks) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  await page.goto(ORIGIN + "/");
  if (quotaMiB) {
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: ORIGIN, quotaSize: quotaMiB * 1024 * 1024 });
    await page.reload();
  }
  const out = await page.evaluate(async ({ blocks }) => {
    // ★ 加载**真实构建产物**；error-handling.js 与 idb-store.js 内部 import 的是同一模块实例 → 探针有效
    const { createIdbCache } = await import("/idb-store.js");
    const { setStoreErrorReporter } = await import("/error-handling.js");
    const funneled = [];                                   // reportStoreError 探针（0.3.6：Quota 必 funnel）
    setStoreErrorReporter((err, level) => funneled.push(`${(err && err.name) || String(err)}:${level}`));
    const idb = createIdbCache("idb-tx-commit-check");
    const blob = (mb) => new Blob([new Uint8Array(mb * 1024 * 1024)]);
    let unhandled = 0;
    addEventListener("unhandledrejection", () => unhandled++);

    let filled = 0, fillRejectedAs = null;
    for (let i = 0; i < blocks; i++) {
      try { await idb.put("f" + i, { blob: blob(8), updatedAt: Date.now() }); filled++; }
      catch (e) { fillRejectedAs = e && e.name || String(e); break; }
    }
    const KEY = "the-artwork.ora";
    let putResolved = false, putRejectedAs = null;
    try { await idb.put(KEY, { blob: blob(8), updatedAt: Date.now() }); putResolved = true; }
    catch (e) { putRejectedAs = (e && e.name) || String(e); }

    await new Promise((r) => setTimeout(r, 300));
    let readBack = null, readErr = null;
    try { const r = await idb.get(KEY); readBack = r ? r.blob.size : null; }
    catch (e) { readErr = (e && e.name) || String(e); }

    // 收敛后 rename/usage 走同一 tx() helper——对照组顺带验它们在真浏览器里活着
    let renamedOk = null, usageCount = null;
    if (putResolved) {
      try {
        await idb.rename(KEY, "renamed/" + KEY);
        const u = await idb.usage("renamed/");
        renamedOk = (await idb.get(KEY)) === undefined && (await idb.get("renamed/" + KEY)) !== undefined;
        usageCount = u.count;
      } catch (e) { renamedOk = (e && e.name) || String(e); }
    }

    await new Promise((r) => { const q = indexedDB.deleteDatabase("idb-tx-commit-check"); q.onsuccess = q.onerror = q.onblocked = () => r(); });
    return { filled, fillRejectedAs, putResolved, putRejectedAs, readBack, readErr, renamedOk, usageCount, funneled, unhandled };
  }, { blocks: fillBlocks });
  await browser.close();
  return { ...out, pageErrors: errs };
}

let failures = 0;
const check = (ok, label, detail) => {
  console.log(`  ${ok ? "✓" : "✗"} ${label}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

console.log("\n=== 对照组：不压配额（写得进去就该 resolve，且读得回）===");
{
  const r = await run(0, 2);
  console.log("  " + JSON.stringify(r));
  check(r.putResolved, "put() resolve", "正常写入必须成功");
  check(r.readBack === 8 * 1024 * 1024, "读回字节完整", `readBack=${r.readBack}`);
  check(r.renamedOk === true && r.usageCount === 1, "rename/usage 走收敛 helper 仍活着", `renamedOk=${r.renamedOk} usageCount=${r.usageCount}`);
  check(r.funneled.length === 0, "对照组无 funnel 噪音", JSON.stringify(r.funneled));
  check(r.pageErrors.length === 0, "无页面异常");
}

console.log("\n=== 实验组：配额压到 48 MiB（撞墙必须 reject，绝不谎报成功）===");
{
  const r = await run(48, 40);
  console.log("  " + JSON.stringify(r));
  check(!r.putResolved, "put() **没有** resolve", r.putResolved ? "红线破了：没落盘却报成功" : `reject as ${r.putRejectedAs}`);
  check(r.putRejectedAs === "QuotaExceededError", "reject 的是 QuotaExceededError", `实际 ${r.putRejectedAs}`);
  check(r.readBack === null, "字节确实没落盘", `readBack=${r.readBack}`);
  check(r.funneled.some((f) => f.startsWith("QuotaExceededError:")), "QuotaExceededError funnel 进了 reportStoreError", JSON.stringify(r.funneled));
  check(r.pageErrors.length === 0, "无页面异常");
}

srv.close();
console.log(failures ? `\n✗ ${failures} 项不合格 —— 红线破了，别发版。\n` : "\n✓ 全过：写入 resolve ⇒ 真的落盘了。\n");
process.exit(failures ? 1 : 0);
