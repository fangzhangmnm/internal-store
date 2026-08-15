// @internal/store 测试入口 —— 引擎契约测试 28 件（2026-08-13 自 WebPaint test/ 迁入；
// app 味的 app-state / brush-rack-reactive / store-absent 等留在 WebPaint）。
// runner = 零依赖家规版：实时耗时 + 每测 10s 超时墙（长跑纪律 2026-08-10）。
import { run } from "./runner.mjs";

// 契约/低层
import "./onedrive-provider.contract.test.mjs";
import "./crypto-container.test.mjs";
import "./substrate.test.mjs";
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./collection.test.mjs";
import "./store-folder-listing.test.mjs";
import "./folder-snapshots.test.mjs";
import "./download-session.test.mjs";
import "./store-cloud-naming.test.ts";
import "./zip-peek.test.mjs";
// 红线对抗 battery（If-Match/parentBase/conflict→backup/move-aside/…）
import "./push.test.ts";
import "./safe-resolve.test.ts";
import "./delete.test.ts";
import "./trash.test.ts";
import "./trash-merge.test.ts";
import "./upload-queue.test.ts";
import "./seal.test.ts";
import "./freshness.test.ts";
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
