// 静默续签失败诊断（0.11.2，纯记日志；user 2026-08-31「一小时掉线好几个 minor 纪元每次必现」）。
// created 2026-08-31 by Claude Fable 5.
// 契约锁死：① getToken 的 acquireTokenSilent 失败 → reportStoreError("log") 一条，含 code/sub/msg + 该账号 RT 条数 + msal tail；
//   行为零变（仍清 activeAccount、仍原样 rethrow）；② pca 配了 system.loggerOptions（Info、pii 关），Warning/Error 即时 log 级上报、
//   Info 只进 tail；③ countRefreshTokens 只读扫 MSAL 键，按 homeAccountId 前缀过滤；localStorage 缺 → null。
// 用 query-string 拿独立模块实例（模块级 pca/initPromise 只跑一次）。
import { describe, it, assert, eq } from "./runner.mjs";
import { setStoreErrorReporter } from "../src/error-handling.ts";

let cfgSeen = null;
class SilentFailPca {
  constructor(cfg) { cfgSeen = cfg; this.active = null; }
  async initialize() {}
  async handleRedirectPromise() { return null; }
  getAllAccounts() { return []; }
  setActiveAccount(a) { this.active = a; }
  getAccountByHomeId() { return null; }
  async loginPopup() { return { account: { homeAccountId: "UID.9188040d-6c67-4c5b-b112-36a304b66dad", username: "u@example.com" } }; }
  async acquireTokenSilent() {
    const e = new Error("AADSTS50058: A silent sign-in request was sent but no user is signed in.");
    e.name = "InteractionRequiredAuthError"; e.errorCode = "login_required"; e.subError = "";
    throw e;
  }
}
// 假 localStorage：两条本账号 RT + 一条别账号 RT + 一条无关键
function fakeLS(map) {
  const m = new Map(Object.entries(map));
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), clear: () => m.clear() };
}
globalThis.window = globalThis.window || globalThis;
globalThis.location ??= { origin: "https://weebpaint.test", pathname: "/dev/" };   // node 无 location；initAuth 拼 redirectUri 要用（2026-08-31 补：auth 测试自 0.10.0 起因此从未在套件里跑起来）

describe("auth · 静默续签失败诊断日志（0.11.2）", () => {
  it("getToken 失败 → log 级一条：code/sub/msg + refreshTokensInCache + msal tail；行为零变", async () => {
    const prevMsal = globalThis.window.msal, prevLS = globalThis.localStorage;
    globalThis.window.msal = { PublicClientApplication: SilentFailPca, LogLevel: { Error: 0, Warning: 1, Info: 2, Verbose: 3, Trace: 4 } };
    globalThis.localStorage = fakeLS({
      "uid.9188040d-6c67-4c5b-b112-36a304b66dad-login.windows.net-refreshtoken-test-client-id----": "{}",
      "uid.9188040d-6c67-4c5b-b112-36a304b66dad-login.microsoftonline.com-refreshtoken-test-client-id----": "{}",
      "other.tenant-login.windows.net-refreshtoken-test-client-id----": "{}",
      "msal.token.keys.test-client-id": "{}",
    });
    const reported = [];
    setStoreErrorReporter((e, lvl) => reported.push([String(e && e.message || e), lvl]));
    try {
      const auth = await import("../src/providers/auth.ts?fresh=silent-failure-log");
      auth.configureOneDriveAuth({ clientId: "test-client-id" });
      await auth.signIn({ mode: "popup" });
      assert(auth.isSignedIn(), "popup 登录后已登录");
      // ② logger 配置 + 分流
      assert(cfgSeen?.system?.loggerOptions?.loggerCallback, "配了 loggerOptions");
      eq(cfgSeen.system.loggerOptions.logLevel, 2, "Info 级");
      eq(cfgSeen.system.loggerOptions.piiLoggingEnabled, false);
      const before = reported.length;
      cfgSeen.system.loggerOptions.loggerCallback(2, "Info: cache miss", false);
      eq(reported.length, before, "Info 只进 tail，不上报");
      cfgSeen.system.loggerOptions.loggerCallback(1, "Warning: refresh token expired", false);
      assert(reported.some(([m, l]) => l === "log" && m.includes("[msal] Warning: refresh token expired")), "Warning 即时 log 级上报");
      cfgSeen.system.loggerOptions.loggerCallback(1, "pii stuff", true);
      assert(!reported.some(([m]) => m.includes("pii stuff")), "containsPii 一律丢");
      // ③ RT 盘点
      eq(auth.countRefreshTokens("UID.9188040d-6c67-4c5b-b112-36a304b66dad"), 2, "按账号前缀（大小写不敏感）数 RT");
      eq(auth.countRefreshTokens(), 3, "不限账号 = 全部 RT 键");
      // ① 失败报告
      let threw = null;
      try { await auth.getToken(); } catch (e) { threw = e; }
      assert(threw && threw.errorCode === "login_required", "原样 rethrow");
      assert(!auth.isSignedIn(), "行为零变：仍清 activeAccount");
      const rep = reported.find(([m, l]) => l === "log" && m.includes("silent token renewal failed (getToken)"));
      assert(rep, "有失败报告: " + JSON.stringify(reported.map((r) => r[0].slice(0, 60))));
      assert(rep[0].includes("code=login_required"), "带 errorCode");
      assert(rep[0].includes("name=InteractionRequiredAuthError"), "带 name");
      assert(rep[0].includes("refreshTokensInCache=2"), "带本账号 RT 条数: " + rep[0]);
      assert(rep[0].includes("Info: cache miss"), "附 msal tail");
      assert(rep[0].includes("scopes=Files.ReadWrite.AppFolder"), "带 scopes");
    } finally {
      setStoreErrorReporter(() => {});
      globalThis.window.msal = prevMsal;
      if (prevLS === undefined) delete globalThis.localStorage; else globalThis.localStorage = prevLS;
    }
  });

  it("localStorage 不可用 → countRefreshTokens 返 null（诊断本身不抛）", async () => {
    const prevLS = globalThis.localStorage;
    delete globalThis.localStorage;
    try {
      const auth = await import("../src/providers/auth.ts?fresh=silent-failure-log");
      eq(auth.countRefreshTokens(), null);
    } finally { if (prevLS !== undefined) globalThis.localStorage = prevLS; }
  });
});
