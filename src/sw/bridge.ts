// ⚠ 实验期模块（A2b spike）——**跑在页面上下文**，SW 凭据桥的写端。
//
// SW 跑不了 MSAL（iframe/redirect 都是页面的事）→ 页面定期把 access token 写进 IDB `sw-bridge/` 分区，
//   SW 网关按需读（gateway.ts getToken）。这是「后台连播三层堵洞」的第①层：**音频在响=页面活着**，
//   活着的页面每 ~35 分钟静默续一次凭据，边界时刻 SW 手里的 token 大概率新鲜。
// 密级说明（2026-08-15 user 拍板实验）：access token 本就躺在 MSAL 的 localStorage 里，IDB 多一份密级相当；
//   token 短效（~1h），signOut 时调 stop({wipe:true}) 抹掉。
import { createPartitionedBlobStore } from "../blob-partition.ts";

export interface SwAuthBridgeCfg {
  /** 与 SW 网关同一个 IDB 库名。 */
  dbName: string;
  /** 取 access token（provider.auth.getToken；内部 acquireTokenSilent，绝不 redirect）。 */
  getToken: () => Promise<string>;
  /** 刷新周期（默认 35 分钟——access token ~1h，留余量；后台播放中 timer 被节流但会跑）。 */
  refreshEveryMs?: number;
}

/** 启动凭据桥：立即写一次 + 定期刷 + focus/online 时补刷。
 *  返回 { ready, stop }：ready = 首次 token 已落 IDB（caller await 它再开播，防「SW 拿不到凭据」竞态）；
 *  stop(opts.wipe) 停桥并可抹掉 token 记录（signOut 时用）。 */
export function startSwAuthBridge(cfg: SwAuthBridgeCfg): { ready: Promise<void>; stop: (opts?: { wipe?: boolean }) => void } {
  const bridge = createPartitionedBlobStore(cfg.dbName).partition("sw-bridge");
  let stopped = false;
  async function refresh(): Promise<void> {
    if (stopped) return;
    try {
      const token = await cfg.getToken();
      await bridge.put("token", { blob: new Blob([JSON.stringify({ v: 1, token, savedAt: Date.now() })]), updatedAt: Date.now() });
    } catch { /* 静默失败（离线/未登录）：SW 用旧 token，过期由网关 401 路径兜 */ }
  }
  const ready = refresh();
  const timer = setInterval(() => { void refresh(); }, cfg.refreshEveryMs ?? 35 * 60_000);
  const onWake = (): void => { void refresh(); };
  addEventListener("focus", onWake);
  addEventListener("online", onWake);
  const stop = (opts?: { wipe?: boolean }): void => {
    stopped = true;
    clearInterval(timer);
    removeEventListener("focus", onWake);
    removeEventListener("online", onWake);
    if (opts?.wipe) void bridge.del("token").catch(() => {});
  };
  return { ready, stop };
}
