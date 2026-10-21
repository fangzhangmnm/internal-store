// @internal/store 测试入口 —— 引擎契约测试 28 件（2026-08-13 自 WebPaint test/ 迁入；
// app 味的 app-state / brush-rack-reactive / store-absent 等留在 WebPaint）。
// runner = 零依赖家规版：实时耗时 + 每测 10s 超时墙（长跑纪律 2026-08-10）。
import { run } from "./runner.mjs";

// 契约/低层
import "./onedrive-provider.contract.test.mjs";
import "./enc-at-rest.test.mjs";
import "./enc-rekey.test.mjs";        // 0.12.0 换密码不经明文（rekey）
import "./enc-lost-response-heal.test.mjs";   // 2026-10-21 F-19：加密稿丢回执 → 本机密文重推自愈（save 推的 = 落本机那份）
import "./substrate.test.mjs";
import "./folder-merge.test.mjs";
import "./folder-flow.test.mjs";
import "./collection.test.mjs";
import "./maintenance.test.mjs";
import "./store-folder-listing.test.mjs";
import "./busy-key.test.mjs";
import "./dir-index-cache.test.mjs";
import "./download-session.test.mjs";
import "./staging-block-eviction.test.mjs";   // 2026-10-21 2.1.5：streaming 模式 staging 按块淘汰 + 钉热集
import "./chunk-scheduler.test.mjs";   // 2026-10-17 2.0.0：分片调度（互等修了 / 车道 / 卡住对冲 / 让道 / 来源回落）
import "./mirror.test.mjs";            // 2026-10-17 2.0.0：替代来源（本机文件 / HTTP 镜像）
import "./store-upload-session.test.mjs";   // 2026-10-21 F-54：createStore uploads.resumable → 记忆面（sha256 token）递给 provider
import "./graph-upload-session-resume.test.ts";   // 2026-10-21 F-54：上传会话落盘（记忆面 → 续传 / 重开 / 412 清）
import "./graph-range-progress.test.ts";   // 2026-10-17 2.0.0：range 按流报进度 + 中止不重试
import "./engine-boundary-guard.test.mjs";   // 2026-10-17 2.0.0：两台引擎互不 import、只共用底座（结构守卫）
import "./doc-tiers.test.ts";   // 2026-10-17 2.1.0：docKinds[].tier（一等作品 / 二等自动备份 / 三等资源在 API 层表达；stem 形分行；每种自己的 validate）
import "./read-only-files.test.mjs";
import "./sw-gateway.test.mjs";
import "./store-cloud-naming.test.ts";
import "./zip-peek.test.mjs";
import "./get-head.test.ts";   // 2026-09-20 0.15.0：RawFile.getHead 头片 peek（CatsUp .glb 封面）
import "./upload-stream.test.ts";   // 2026-10-14 0.17.0：files.uploadStream 流式新建 + save onProgress（KudsRocket）
// 红线对抗 battery（If-Match/parentBase/conflict→backup/move-aside/…）
import "./push.test.ts";
import "./safe-resolve.test.ts";
import "./graph-network-error.test.ts";   // 2026-08-25 网络层翻译（CloudNetworkError）
import "./graph-upload-resilience.test.ts";   // 2026-10-15 0.17.1：分块上传接着传 / 提交前核 eTag / 请求超时（KudsRocket iOS 锁屏挂死）
import "./ifmatch-guard.test.ts";   // 2026-08-25 全库 If-Match 语法护栏
import "./idb-tx-guard.test.ts";   // 2026-08-26 IDB 事务形状语法护栏（0.3.6 收敛；行为面=tools/idb-tx-commit-check.mjs）
import "./idb-deadline.test.mjs";   // 2026-09-06 0.11.5 挂死自愈：deadline / 重开重试 / onversionchange（假 IDB）
import "./store-dispose-dirty.test.ts";   // 2026-08-26 0.4.0 批：dispose + dirty facet + CloudStaleRefError
import "./collection-peek.test.mjs";   // 2026-08-30 0.11.0：collectionPeek 三态探针（纯读零记账）
import "./auth-signin.test.mjs";              // 0.10.0 signIn popup/redirect 分流（⚠ 2026-08-31 发现自 0.10.0 起从未注册进套件，今补）
import "./auth-redirect-return.test.mjs";     // 0.11.1：redirect 回程失败上报 + 临时缓存落 localStorage
import "./auth-silent-failure-log.test.mjs";  // 0.11.2：续签失败日志（失败码 + RT 盘点 + msal tail）
import "./auth-single-flight.test.mjs";      // 0.12.1：取 token 单飞 + 需交互闩（#60-D）
import "./folder-provider.contract.test.ts";   // 2026-08-26 folder provider（「folder 就是另一朵云」；fake FSA=Linux 口径+无 native move）
import "./persistence.test.ts";   // 2026-08-27 persist 三件套（必填表态+纯查询感知+手势执行体；库永不自动调 persist()）
import "./delete.test.ts";
import "./trash.test.ts";
import "./trash-merge.test.ts";
import "./upload-queue.test.ts";
import "./seal.test.ts";
import "./freshness.test.ts";
import "./store-open-conflict.test.ts";
import "./open-lineage.test.ts";   // 0.18.0：open 核对没跑成时干净副本接血统
import "./resolve.test.ts";        // 0.18.0：file.resolve() 主动叫面
import "./local-head.test.ts";
import "./local-conflict-guard.test.ts";
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
import "./rename-event-hidden-signedin.test.mjs";   // 0.14.0：onRenamed / isOnline∧signedIn / hiddenName
import "./edit-race.test.ts";
import "./identifiers.test.ts";   // 0.16.0：身份的语法（docKinds 表）
import "./restore-naming.test.ts";   // 0.16.0：取回撞名两条腿走表；zip()/encrypt 守卫

console.log("\n  @internal/store —— 云同步引擎契约测试\n");
await run();
