// 取 token 单飞 + 需交互闩（0.12.1；#60-D，user 2026-09-09「IDB都做」）。created 2026-09-09 by Claude Fable 5.1
// 案发 2026-09-08 黑匣子：RT 过期后同一毫秒 6 个 getTokenFor 并发 → 6 个隐藏 iframe 往返 + 6 组日志 + 多条 E 级横幅。
// 用 query-string 拿独立模块实例（模块级 pca/initPromise 只跑一次）。
import { describe, it, assert, eq } from "./runner.mjs";
import { setStoreErrorReporter } from "../src/error-handling.ts";

class Pca {
  constructor(cfg) { this.cfg = cfg; this.active = null; this.silentCalls = 0; this.mode = "ok"; this.accounts = [{ homeAccountId: "h1", username: "u@example.com" }]; }
  async initialize() {}
  async handleRedirectPromise() { return null; }
  getAllAccounts() { return []; }
  setActiveAccount(a) { this.active = a; }
  getAccountByHomeId(h) { return this.accounts.find((a) => a.homeAccountId === h) ?? null; }
  async loginPopup() { return { account: this.accounts[0] }; }
  async clearCache() {}
  async acquireTokenSilent() {
    this.silentCalls++;
    await new Promise((r) => setTimeout(r, 5));
    if (this.mode === "ok") return { accessToken: "tok" + this.silentCalls };
    if (this.mode === "interaction") { const e = new Error("login_required: Silent authentication was denied."); e.name = "InteractionRequiredAuthError"; e.errorCode = "login_required"; throw e; }
    const e = new Error("network down"); e.name = "ClientAuthError"; e.errorCode = "network_error"; throw e;
  }
}
globalThis.window = globalThis.window || globalThis;
globalThis.location ??= { origin: "https://weebpaint.test", pathname: "/dev/" };
async function fresh(tag) {
  const prev = globalThis.window.msal; let pca = null;
  globalThis.window.msal = { PublicClientApplication: class extends Pca { constructor(c) { super(c); pca = this; } }, LogLevel: { Error: 0, Warning: 1, Info: 2, Verbose: 3, Trace: 4 } };
  const auth = await import(`../src/providers/auth.ts?fresh=single-flight-${tag}`);
  auth.configureOneDriveAuth({ clientId: "test-client-id" });
  await auth.initAuth();
  globalThis.window.msal = prev;
  return { auth, pca };
}

describe("auth · 取 token 单飞 + 需交互闩（0.12.1 #60-D）", () => {
  it("6 个并发 getTokenFor → acquireTokenSilent 只跑 1 次，全员同一个 token；飞完再来 → 再跑（单飞不是缓存）", async () => {
    const { auth, pca } = await fresh("a");
    const toks = await Promise.all(Array.from({ length: 6 }, () => auth.getTokenFor("h1")));
    eq(pca.silentCalls, 1, "★并发合并成一次 MSAL 调用");
    assert(toks.every((t) => t === toks[0]), "同一个 token");
    await auth.getTokenFor("h1");
    eq(pca.silentCalls, 2, "飞完了再来一次 → 再跑一次");
  });
  it("InteractionRequired → 闩：后续调用不进 MSAL、抛同一个错、不刷日志；popup 登录成功解闩", async () => {
    const { auth, pca } = await fresh("b");
    const logs = []; setStoreErrorReporter((e, l) => logs.push([String((e && e.message) || e), l]));
    pca.mode = "interaction";
    const errs = await Promise.all(Array.from({ length: 4 }, () => auth.getTokenFor("h1").catch((e) => e)));
    eq(pca.silentCalls, 1, "并发 4 → 1 次 MSAL");
    assert(errs.every((e) => e && e.name === "InteractionRequiredAuthError"), "全员拿到 InteractionRequired");
    eq(logs.filter(([m]) => m.includes("silent token renewal failed")).length, 1, "★一次失败一条日志（不是 4 条）");
    const e2 = await auth.getTokenFor("h1").catch((e) => e);
    eq(pca.silentCalls, 1, "★闩住：不再进 MSAL（不开 iframe）");
    assert(e2 === errs[0], "抛的是同一个错对象");
    eq(logs.filter(([m]) => m.includes("silent token renewal failed")).length, 1, "闩住期间不刷日志");
    pca.mode = "ok";
    await auth.signIn({ mode: "popup" });   // 显式登录成功 → 解闩
    eq(await auth.getTokenFor("h1"), "tok2", "解闩后照常取到新 token");
    eq(pca.silentCalls, 2);
    setStoreErrorReporter(() => {});
  });
  it("网络类错误不上闩：下一次调用照进 MSAL", async () => {
    const { auth, pca } = await fresh("c"); setStoreErrorReporter(() => {});
    pca.mode = "net";
    await auth.getTokenFor("h1").catch(() => {});
    await auth.getTokenFor("h1").catch(() => {});
    eq(pca.silentCalls, 2, "网络错不闩");
  });
  it("getToken 并发失败：activeAccount 只清一次、expired 只广播一次（行为不变：仍清、仍 rethrow）", async () => {
    const { auth, pca } = await fresh("d"); setStoreErrorReporter(() => {});
    await auth.signIn({ mode: "popup" }); assert(auth.isSignedIn(), "popup 登录后已签到");
    let expired = 0; const off = auth.onAuthChanged((st) => { if (st.reason === "expired") expired++; });
    pca.mode = "interaction";
    const errs = await Promise.all(Array.from({ length: 3 }, () => auth.getToken().catch((e) => e)));
    off();
    assert(errs.every((e) => e && e.name === "InteractionRequiredAuthError"), "全员原样 rethrow");
    eq(pca.silentCalls, 1, "并发 3 → 1 次 MSAL");
    eq(expired, 1, "★expired 只广播一次");
    assert(!auth.isSignedIn(), "activeAccount 已清");
  });
});
