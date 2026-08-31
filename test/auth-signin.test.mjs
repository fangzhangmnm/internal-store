// signIn popup/redirect 分流（0.10.0；user 2026-08-25 拍板「桌面 popup、iOS redirect」、0830 确认直做）。
// created 2026-08-30 by Claude Fable 5.
// 契约锁死：① 缺省 = loginRedirect（0.9.x 行为零变）；② mode:"popup" = loginPopup，resolve 时
//   activeAccount 已设 + onAuthChanged 已广播（调用方可直接续办）；③ prompt 透传两条路；
//   ④ popup 取消/被拦 = 原样 reject，不吞、不动登录态、不广播。
import { describe, it, assert, eq } from "./runner.mjs";

// ---- fake window.msal（auth.ts 只认 window.msal 全局；MSAL_URL 不配 → 不走 loadScript/document）----
let fake = null;
class FakePca {
  constructor(cfg) { this.cfg = cfg; this.active = null; this.calls = []; this.nextPopup = null; fake = this; }
  async initialize() {}
  async handleRedirectPromise() { return null; }
  getAllAccounts() { return []; }
  setActiveAccount(a) { this.active = a; }
  getAccountByHomeId() { return null; }
  async loginPopup(req) {
    this.calls.push(["popup", req]);
    if (this.nextPopup) { const fn = this.nextPopup; this.nextPopup = null; return fn(); }
    return { account: { homeAccountId: "h1", username: "u@example.com" } };
  }
  async loginRedirect(req) { this.calls.push(["redirect", req]); }
}
globalThis.window = globalThis.window || globalThis;
globalThis.location ??= { origin: "https://weebpaint.test", pathname: "/dev/" };   // node 无 location；initAuth 拼 redirectUri 要用（2026-08-31 补：auth 测试自 0.10.0 起因此从未在套件里跑起来）
globalThis.window.msal = { PublicClientApplication: FakePca };

const auth = await import("../src/providers/auth.ts");
auth.configureOneDriveAuth({ clientId: "test-client-id" });

describe("auth signIn popup/redirect 分流", () => {
  it("缺省 = loginRedirect（0.9.x 行为零变），prompt 透传", async () => {
    await auth.signIn();
    await auth.signIn({ prompt: "select_account" });
    eq(fake.calls.length, 2);
    eq(fake.calls[0][0], "redirect");
    eq(fake.calls[0][1].prompt, undefined, "缺省不带 prompt（SSO 快路）");
    eq(fake.calls[1][0], "redirect");
    eq(fake.calls[1][1].prompt, "select_account");
    assert(!auth.isSignedIn(), "redirect 不在本页落账号");
  });

  it("popup 取消/被拦 = 原样 reject，不动登录态、不广播", async () => {
    let events = 0;
    const off = auth.onAuthChanged(() => events++);
    fake.nextPopup = () => { throw new Error("user_cancelled: User cancelled the flow."); };
    let threw = null;
    try { await auth.signIn({ mode: "popup" }); } catch (e) { threw = e; }
    off();
    assert(threw && String(threw).includes("user_cancelled"), "取消要原样抛出");
    assert(!auth.isSignedIn(), "取消不得设 activeAccount");
    eq(events, 0, "取消不得广播 auth-changed");
  });

  it("popup 成功：loginPopup + 账号就位 + 广播（调用方可直接续办）", async () => {
    let seen = null;
    const off = auth.onAuthChanged((st) => { seen = st; });
    await auth.signIn({ mode: "popup", prompt: "select_account" });
    off();
    const last = fake.calls[fake.calls.length - 1];
    eq(last[0], "popup");
    eq(last[1].prompt, "select_account", "prompt 在 popup 路也透传");
    assert(Array.isArray(last[1].scopes) && last[1].scopes.length > 0, "scopes 必带");
    assert(auth.isSignedIn(), "resolve 时已登录");
    eq(auth.getActiveAccount().homeAccountId, "h1");
    eq(fake.active?.homeAccountId, "h1", "pca.setActiveAccount 已同步");
    assert(seen && seen.signedIn === true, "onAuthChanged 已广播 signedIn");
  });
});
