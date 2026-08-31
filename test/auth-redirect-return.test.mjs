// initAuth 的 redirect 回程失败上报 + MSAL 临时缓存位置（0.11.1，user 2026-08-31 批准 S2/S3）。
// created 2026-08-31 by Claude Fable 5.
// 契约锁死：① handleRedirectPromise 抛错 → reportStoreError("error")（以前 console.warn 静默）且 initAuth 仍 resolve 为未登录；
//   ② PublicClientApplication 配置 cache.temporaryCacheLocation === "localStorage"（iOS PWA redirect 往返活过进程重启）；
//   ③ cacheLocation 仍 localStorage、storeAuthStateInCookie 仍 false（零回归）。
// 模块级 initPromise 只跑一次 → 用 query-string 拿一份**独立**模块实例（不与 auth-signin.test 共享 pca）。
import { describe, it, assert, eq } from "./runner.mjs";
import { setStoreErrorReporter } from "../src/error-handling.ts";

let cfgSeen = null;
class ThrowingPca {
  constructor(cfg) { cfgSeen = cfg; }
  async initialize() {}
  async handleRedirectPromise() { throw new Error("state_not_found: Request state not found in cache (sessionStorage lost)"); }
  getAllAccounts() { return []; }
  setActiveAccount() {}
}
globalThis.window = globalThis.window || globalThis;
globalThis.location ??= { origin: "https://weebpaint.test", pathname: "/dev/" };   // node 无 location；initAuth 拼 redirectUri 要用（2026-08-31 补：auth 测试自 0.10.0 起因此从未在套件里跑起来）

describe("auth initAuth · redirect 回程失败上报 + 临时缓存落 localStorage（0.11.1）", () => {
  it("handleRedirectPromise 抛错 → reportStoreError(error)，initAuth 仍 resolve 未登录", async () => {
    const prevMsal = globalThis.window.msal;
    globalThis.window.msal = { PublicClientApplication: ThrowingPca };
    const reported = [];
    setStoreErrorReporter((e, lvl) => reported.push([String(e), lvl]));
    try {
      const auth = await import("../src/providers/auth.ts?fresh=redirect-return");
      auth.configureOneDriveAuth({ clientId: "test-client-id" });
      const st = await auth.initAuth();
      eq(st.signedIn, false, "回程失败 = 未登录（不假登录）");
      assert(reported.some(([m, l]) => l === "error" && m.includes("handleRedirectPromise") && m.includes("state_not_found")), "失败经统一上报、带原因: " + JSON.stringify(reported));
    } finally {
      setStoreErrorReporter(() => {});
      globalThis.window.msal = prevMsal;
    }
  });

  it("MSAL cache 配置：temporaryCacheLocation=localStorage；cacheLocation/storeAuthStateInCookie 零回归", () => {
    assert(cfgSeen, "上一测已建 pca");
    eq(cfgSeen.cache.temporaryCacheLocation, "localStorage");
    eq(cfgSeen.cache.cacheLocation, "localStorage");
    eq(cfgSeen.cache.storeAuthStateInCookie, false);
  });
});
