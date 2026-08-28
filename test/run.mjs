// @internal/store 测试入口 —— 引擎契约测试 28 件（2026-08-13 自 WebPaint test/ 迁入；
// app 味的 app-state / brush-rack-reactive / store-absent 等留在 WebPaint）。
// runner = 零依赖家规版：实时耗时 + 每测 10s 超时墙（长跑纪律 2026-08-10）。
import { run } from "./runner.mjs";

// 契约/低层
import "./onedrive-provider.contract.test.mjs";
import "./enc-at-rest.test.mjs";
import "./substrate.test.mjs";
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./collection.test.mjs";
import "./maintenance.test.mjs";
import "./store-folder-listing.test.mjs";
import "./dir-index-cache.test.mjs";
import "./download-session.test.mjs";
import "./read-only-files.test.mjs";
import "./sw-gateway.test.mjs";
import "./store-cloud-naming.test.ts";
import "./zip-peek.test.mjs";
// 红线对抗 battery（If-Match/parentBase/conflict→backup/move-aside/…）
import "./push.test.ts";
import "./safe-resolve.test.ts";
import "./graph-network-error.test.ts";   // 2026-08-25 网络层翻译（CloudNetworkError）
import "./ifmatch-guard.test.ts";   // 2026-08-25 全库 If-Match 语法护栏
import "./idb-tx-guard.test.ts";   // 2026-08-26 IDB 事务形状语法护栏（0.3.6 收敛；行为面=tools/idb-tx-commit-check.mjs）
import "./store-dispose-dirty.test.ts";   // 2026-08-26 0.4.0 批：dispose + dirty facet + CloudStaleRefError
import "./folder-provider.contract.test.ts";   // 2026-08-26 folder provider（「folder 就是另一朵云」；fake FSA=Linux 口径+无 native move）
import "./persistence.test.ts";   // 2026-08-27 persist 三件套（必填表态+纯查询感知+手势执行体；库永不自动调 persist()）
import "./delete.test.ts";
import "./trash.test.ts";
import "./trash-merge.test.ts";
import "./upload-queue.test.ts";
import "./seal.test.ts";
import "./freshness.test.ts";
import "./store-open-conflict.test.ts";
import "./local-head.test.ts";
import "./offload.test.ts";
import "./identity.test.ts";
import "./cloud-write-ifmatch.test.ts";
import "./reconcile.test.ts";
import "./pending-gone.test.ts";
import "./cloud-sync.test.ts";
import "./folder-delete.test.ts";
import "./store-lost-response-claim.test.mjs";
import "./migration.test.mjs";
import "./store-narrow-waist.test.ts";

console.log("\n  @internal/store —— 云同步引擎契约测试\n");
await run();
