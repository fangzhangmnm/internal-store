// MSAL.js 包了一层（模式承自前身家族，几乎 1:1）。
//
// 关键决策：
// - MSAL 整包由宿主 vendor（如 vendor/msal/）。本地路径，无 CDN 依赖。
//   家族早期走过 CDN，后统一 vendor 路线（更稳，version 跟着 commit）。
// - 懒加载：CLIENT_ID 是占位符就不去 load script，纯离线。
// - 同 origin 多 app 会共用 localStorage 里的 account cache。silent probe 是过滤：
//   有 account 不代表本 app 有 token（本 app 可能从没授权过）。
// - signOut() 只清本 app cache（clearCache），不 logoutRedirect 把用户 Outlook 一起踢掉。

// MSAL 全局由运行时 vendored 脚本（window.msal）加载，无 @types → 整体 any 松类型。
// pca = PublicClientApplication 实例；account = AccountInfo。下面统一用 any 兜（见顶部注释）。
type Msal = any;
type Pca = any;
/** MSAL account 句柄（未类型化透传；导出仅为门牌可命名）。 */
export type Account = any;

import { reportStoreError } from "../error-handling.ts";

// window.msal 由 vendored 脚本注入；用 any 桥接（DOM lib 的 Window 不含 msal）。
declare global {
  interface Window {
    msal?: Msal;
  }
}

interface AuthConfig {
  clientId?: string;
  authority?: string;
  scopes?: string[];
  msalUrl?: string | null;
}

// （取代前身宿主的 config.js import，去 app 化。）
let CLIENT_ID = "";
let AUTHORITY = "https://login.microsoftonline.com/common";
let SCOPES = ["Files.ReadWrite.AppFolder", "offline_access"];
let MSAL_URL: string | null = null;
/** OneDrive auth 配置注入。app 调一次（clientId/authority/scopes/msalUrl；msalUrl = vendored MSAL 脚本相对路径）。 */
export function configureOneDriveAuth({ clientId, authority, scopes, msalUrl }: AuthConfig = {}): void {
  if (clientId) CLIENT_ID = clientId;
  if (authority) AUTHORITY = authority;
  if (scopes) SCOPES = scopes;
  if (msalUrl != null) {   // 浏览器相对路径（vendored 脚本）→ 绝对；node 里 = null
    MSAL_URL = (typeof document !== "undefined" && document.baseURI)
      ? new URL(msalUrl, document.baseURI).href : null;
  }
}

export function isAuthConfigured(): boolean {
  return typeof CLIENT_ID === "string" && CLIENT_ID.length > 0 && !CLIENT_ID.startsWith("REPLACE_ME");
}

// MSAL_URL 由 configureOneDriveAuth 设（app 传 vendored 脚本相对路径，document.baseURI 解绝对）。
let msalLoadPromise: Promise<Msal> | null = null;
let pca: Pca = null;

// ── 0.11.2 续签诊断（纯记日志，零行为变化；user 2026-08-31「一小时掉线好几个 minor 纪元每次必现」）──
// 现象上「缓存里没有 refresh token」与「refresh token 被拒」都经 iframe 退路抛同一个 InteractionRequiredAuthError，
//   分不开；能分开的两样东西：① MSAL 自己的日志（它会说跳过 RT 还是 RT 请求返回了什么）② 缓存里 RT 条数。
// - MSAL logger 接 Info 级进一个 40 行的环（不进 app 日志——平时太吵），Warning/Error 即时上报（log 级）；
//   静默续签失败时把环整段附在失败报告里 → app 黑匣子一次拿到上下文。
// - countRefreshTokens：只读扫 localStorage 里 MSAL 自己的 RT 键（`<homeAccountId>-<env>-refreshtoken-<clientId>-…`）。
//   这不是 store 的命名空间（namespacedKv choke point 管的是 store 键），是 MSAL 的储物柜，本文件是它唯一的包装层。
const MSAL_TAIL_MAX = 40;
const _msalTail: string[] = [];
function _msalLog(level: number, message: string): void {
  _msalTail.push(`${new Date().toISOString().slice(11, 23)} L${level} ${message}`);
  if (_msalTail.length > MSAL_TAIL_MAX) _msalTail.splice(0, _msalTail.length - MSAL_TAIL_MAX);
  if (level <= 1) reportStoreError(new Error("[msal] " + message), "log");   // 0=Error 1=Warning：即时给 app（log 级，不弹）
}
/** 只读诊断：MSAL 在 localStorage 里为该账号（缺省=任意账号）存了几条 refresh token。存储不可用 → null。 */
export function countRefreshTokens(homeAccountId?: string): number | null {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return null;
    const prefix = homeAccountId ? homeAccountId.toLowerCase() + "-" : "";
    let n = 0;
    for (let i = 0; i < ls.length; i++) {
      const k = ls.key(i);
      if (k && k.includes("-refreshtoken-") && (!prefix || k.toLowerCase().startsWith(prefix))) n++;
    }
    return n;
  } catch { return null; }
}
function _logSilentFailure(where: string, account: Account, e: unknown): void {
  const err = e as { errorCode?: unknown; subError?: unknown; message?: unknown; name?: unknown } | null;
  const hid = typeof account?.homeAccountId === "string" ? account.homeAccountId : "";
  const lines = [
    `[auth] silent token renewal failed (${where}): name=${String(err?.name ?? "?")} code=${String(err?.errorCode ?? "?")} sub=${String(err?.subError ?? "")} msg=${String(err?.message ?? e).slice(0, 200)}`,
    `  account=${hid ? hid.slice(0, 8) + "…" : "(none)"} refreshTokensInCache=${String(countRefreshTokens(hid || undefined))} scopes=${SCOPES.join(" ")}`,
    `  msal-tail(${_msalTail.length}):`,
    ..._msalTail.map((l) => "    " + l),
  ];
  reportStoreError(new Error(lines.join("\n")), "log");
}
let activeAccount: Account = null;
let initPromise: Promise<AuthState> | null = null;

/** initAuth / getAuthState 返回的 auth 状态。 */
export interface AuthState {
  /** 是否已登录（单一源 activeAccount 的派生读）。 */
  signedIn: boolean;
  /** 当前 MSAL account（未登录 = null）。 */
  account: Account;
  /** clientId 未配置（占位符）→ 纯离线，不 load MSAL。 */
  notConfigured?: boolean;
  /** 后台 silent token 探测进行中（探测不阻塞 init）。 */
  probing?: boolean;
  /** 正在探测的缓存 account。 */
  probedAccount?: Account;
}

// ---- auth 状态可观察 seam ----
// 单一源 = activeAccount。**每个**转变（登录回来 / 后台 silent / 登出 / 过期）都 _emitAuth。
// UI 订阅一次（onAuthChanged）→ 永不漂移；isSignedIn() 是派生读。治"按钮不变蓝"+ F2 过期假登录。
type AuthSub = (st: AuthState) => void;
const _authSubs = new Set<AuthSub>();
export function onAuthChanged(cb: AuthSub): () => void { _authSubs.add(cb); return () => _authSubs.delete(cb); }
export function getAuthState(): AuthState { return { signedIn: !!activeAccount, account: activeAccount }; }
function _emitAuth(): void {
  const st = getAuthState();
  for (const cb of _authSubs) { try { cb(st); } catch (_) {} }
}

// ⚠ **必须带超时**（v418）：`onerror` 只在请求明确失败时触发。请求**挂着**（半开连接 / 强制门户）
//   时 onload 和 onerror 都不来，于是这个 promise 永不 settle —— 下面的重试永远不会发生、也永远
//   不会放弃，而动态插入的 script 仍然吊着 window 的 load 事件 → 浏览器标签页一直转圈。
// ⚠ 但这个数只用来兜「永远挂着」，**不是用来判断「慢」的**（v421 修：原来是 8000，太激进）。
//   真机抓包实测 msal-browser.min.js 单次加载花了 **15.4 秒**、最终 200。8 秒会把它判死 →
//   三次重试全部超时 → MSAL 根本载不进来 → **慢网下登录彻底不可用**。这比它要修的 bug 更糟。
const SCRIPT_LOAD_TIMEOUT_MS = 45000;

function loadScript(url: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement("script");
    let done = false;
    const settle = (fn: () => void) => { if (done) return; done = true; clearTimeout(timer); fn(); };
    const timer = setTimeout(() => settle(() => {
      s.remove();   // 摘掉挂死的 script，别继续吊着 load 事件
      reject(new Error(`timeout loading ${url}`));
    }), SCRIPT_LOAD_TIMEOUT_MS);
    s.src = url;
    s.async = true;
    s.onload = () => settle(resolve);
    s.onerror = () => settle(() => reject(new Error(`failed to load ${url}`)));
    document.head.appendChild(s);
  });
}

async function loadScriptWithRetry(url: string, attempts = 3): Promise<void> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try { await loadScript(url); return; }
    catch (e) {
      lastErr = e;
      console.warn(`MSAL load attempt ${i + 1}/${attempts} failed`);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 300 * (i + 1)));
    }
  }
  throw new Error(`MSAL load failed ${url}: ${(lastErr as Error | undefined)?.message}`);
}

function loadMsal(): Promise<Msal> {
  if (window.msal) return Promise.resolve(window.msal);
  if (msalLoadPromise) return msalLoadPromise;
  msalLoadPromise = (async () => {
    await loadScriptWithRetry(MSAL_URL as string);
    if (window.msal) return window.msal;
    msalLoadPromise = null;
    throw new Error("MSAL loaded but window.msal didn't appear");
  })().catch((e) => { msalLoadPromise = null; throw e; });
  return msalLoadPromise;
}

export async function initAuth(): Promise<AuthState> {
  if (!isAuthConfigured()) {
    return { signedIn: false, account: null, notConfigured: true };
  }
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const msal = await loadMsal();
    pca = new msal.PublicClientApplication({
      system: {
        loggerOptions: {
          logLevel: msal.LogLevel?.Info ?? 2,   // 0 Error / 1 Warning / 2 Info / 3 Verbose / 4 Trace
          piiLoggingEnabled: false,
          loggerCallback: (level: number, message: string, containsPii: boolean) => { if (!containsPii) _msalLog(level, message); },
        },
      },
      auth: {
        clientId: CLIENT_ID,
        authority: AUTHORITY,
        redirectUri: location.origin + location.pathname,
        postLogoutRedirectUri: location.origin + location.pathname,
      },
      cache: {
        cacheLocation: "localStorage",
        storeAuthStateInCookie: false,
        // 0.11.1（user 2026-08-31 批准 S3）：redirect 往返的临时缓存（request state / PKCE verifier / interaction 状态）
        //   MSAL 缺省放 sessionStorage——iOS 主屏 PWA 跳去微软页期间进程被杀（长画后内存紧张）→ sessionStorage 没了
        //   → 回程 handleRedirectPromise 对不上 state → 登录静默失败（案发 2026-08-31「点登录 OneDrive 挂不上」）。
        //   放 localStorage 即活过进程重启（MSAL 官方对 iOS PWA 的建议）。代价已核：① 弃置的 redirect（用户在微软页
        //   关掉）留下的 interaction_in_progress 由下次 boot 的 handleRedirectPromise 无 hash 分支 cleanRequestByInteractionType
        //   自清（vendored 3.27.0 已实证该分支）；② 两 tab 同时 redirect 登录会互撞 interaction_in_progress——单用户 app 可接受；
        //   ③ 暴露面无新类：access/refresh token 本就在 localStorage（cacheLocation）。
        temporaryCacheLocation: "localStorage",
      },
    });
    await pca.initialize();

    let response = null;
    try { response = await pca.handleRedirectPromise(); }
    catch (e) {
      // 0.11.1（user 2026-08-31 批准 S2）：以前只 console.warn——iPad 上 redirect 登录回程失败（state 对不上 / 微软页
      //   返回 error）用户零感知，表现为「点登录没反应、挂不上」。走统一上报 → app 横幅。store 侧不 console（家规）。
      reportStoreError(new Error("[auth] sign-in redirect return failed (handleRedirectPromise): " + String((e as { message?: unknown })?.message ?? e)), "error");
    }

    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      _emitAuth();                                  // 登录 redirect 回来 → 通知 UI（按钮变蓝）
      return { signedIn: true, account: activeAccount };
    }

    const cached = pca.getAllAccounts();
    reportStoreError(new Error(`[auth] init: redirectResponse=no cachedAccounts=${cached.length} refreshTokensInCache=${String(countRefreshTokens())}`), "log");
    if (cached.length === 0) return { signedIn: false, account: null };

    // silent token 探测**移出阻塞 init** → 后台跑（F4）。iOS 上 acquireTokenSilent 的 iframe 会卡住；
    // 若在此 await，MSAL interaction 状态被一直占着 → 用户点登录的 loginRedirect 撞 interaction_in_progress。
    _probeSilent(cached[0]);
    return { signedIn: false, account: null, probing: true, probedAccount: cached[0] };
  })().catch((e) => { initPromise = null; throw e; });
  return initPromise;
}

// 后台 silent token 探测：成功 → 设 activeAccount + 广播。绝不阻塞 init / sign-in（iOS iframe 卡不要紧）。
// ⚠ 推迟到 window `load` 之后（v417）：acquireTokenSilent 内部开一个隐藏 iframe，而**同文档 iframe 在
//   load 事件之前创建会一直吊着 load 事件**。上一行注释已经写明这个 iframe 在 iOS 上会卡住——卡住的
//   iframe + 未触发的 load = 浏览器标签页永远转圈，即使 app 本身已经完全可用（这正是区分本症状的判据：
//   转圈但能操作 = 这里；整页空白 = SW/head 脚本那条）。探测本就是纯后台的锦上添花，晚几百毫秒无损。
function _afterWindowLoad(fn: () => void): void {
  const w = globalThis as { document?: { readyState?: string }; addEventListener?: typeof addEventListener };
  if (!w.addEventListener || w.document?.readyState === "complete") { fn(); return; }
  w.addEventListener("load", () => fn(), { once: true });
}

async function _probeSilent(account: Account): Promise<void> {
  await new Promise<void>((r) => _afterWindowLoad(r));
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account });
    pca.setActiveAccount(account);
    activeAccount = account;
    _emitAuth();                                    // 后台 silent 成功 → 通知 UI
  } catch (e) { _logSilentFailure("boot-probe", account, e); /* 拿不到 token = 未真登录；UI 保持未登录，用户可显式登录 */ }
}

export async function signIn(opts?: { prompt?: "select_account"; mode?: "popup" | "redirect" }): Promise<unknown> {
  // **iOS 关键**：loginRedirect 必须在同步 user-gesture（点击）里调，**前面不能有 await**，
  // 否则 iOS Safari 把它当非手势导航静默拦截（→ 不弹登录框）。
  // interaction 状态由 boot initAuth 的 handleRedirectPromise 清（silent 探测已移后台不占 interaction），
  // 所以点击时 pca 通常已就绪，直接同步 loginRedirect。
  // opts.prompt="select_account"（0.9.0，user 2026-08-28「加口子」）：强制微软账号选择页——多账号
  //   「换一个账号连接图库」入口用（P3 §1.10 铸第二账号）；缺省不传 = SSO 快路（单账号零打扰不变）。
  // opts.mode="popup"（0.10.0，user 2026-08-25 拍板「桌面主场 MSAL popup、iOS redirect」、0830 确认直做）：
  //   loginPopup 全程不离页——resolve 时账号已就位（activeAccount 已设、已广播），调用方可直接续办，
  //   不再需要 redirect 的「待续标记 + 回程续办」舞步。桌面/移动的判断归 app（库零产品知识），缺省仍 redirect。
  //   popup 同样要同步 user-gesture 起跳（弹窗拦截），前面不能有 await（pca 就绪时下面直达）。
  //   取消（user_cancelled）/被拦（popup_window_error）= reject 原样抛给调用方——绝不吞、绝不自动降级
  //   redirect（降级导航已不在用户手势里，会被 iOS/弹窗拦截判黑，且「点登录却整页跳走」正是 popup 要治的病）。
  if (!pca) await initAuth();                  // 仅 boot 还没建 pca 的极少数情况才等（会丢 gesture，但罕见）
  const request = { scopes: SCOPES, ...(opts?.prompt ? { prompt: opts.prompt } : {}) };
  if (opts?.mode === "popup") {
    const response = await pca.loginPopup(request);
    if (response?.account) {
      pca.setActiveAccount(response.account);
      activeAccount = response.account;
      _emitAuth();                             // popup 弹回 → 通知 UI（与 redirect 回程 initAuth 同一广播面）
    }
    return response;
  }
  return pca.loginRedirect(request); // 同步调用，保住 iOS user-gesture
}

export async function signOut(): Promise<void> {
  if (!pca || !activeAccount) return;
  const account = activeAccount;
  activeAccount = null;
  _emitAuth();                                      // 登出 → 立即通知 UI（按钮变灰）
  try { await pca.clearCache({ account }); }
  catch (e) { console.warn("clearCache failed:", e); }
  try { pca.setActiveAccount(null); } catch (_) {}
}

export async function getToken(): Promise<string> {
  if (!pca || !activeAccount) throw new Error("Not signed in");
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account: activeAccount });
    return result.accessToken;
  } catch (e) {
    _logSilentFailure("getToken", activeAccount, e);
    // silent 失败 = token 过期/失效 → 清 activeAccount + 通知 UI（按钮变灰，回到"未登录"）。
    // **绝不在此 acquireTokenRedirect**：getToken 只在后台 graph 请求里被调；后台数据同步
    //   触发交互式跳转 = boot 重定向循环（silent 失败→跳转→重载→再 silent 失败…一直转）/
    //   阅读中被劫持导航。交互式重新登录只走显式 signIn()（user-gesture loginRedirect），
    //   后台同步在此降级为离线（调用方 try/catch 收成 offline，本地仍可读、脏不丢）。
    activeAccount = null;
    _emitAuth();
    throw e;
  }
}

export function getActiveAccount(): Account { return activeAccount; }
export function isSignedIn(): boolean { return !!activeAccount; }

// 多账号防御（2026-08-25 user 拍板 §1.4，宣发前铺路）：provider 构造显式携带 homeAccountId 时，
//   token 一律按**那个账号**取——store 内部永不问「现在谁登录着」。与 getToken 的差别：
//   ① account 按 homeAccountId 显式解析（pca.getAccountByHomeId），不是全局 activeAccount；
//   ② silent 失败**不动**全局 activeAccount（那是「当前登录 UI」的状态，钉死账号的失败不该把别的账号登出）。
//   acquireTokenSilent 依旧显式带 account 参数（拍板 §1.4 ③——本文件所有取 token 处皆然，勿删）。
export async function getTokenFor(homeAccountId: string): Promise<string> {
  if (!pca) await initAuth();
  if (!pca) throw new Error("Auth not initialized");
  const account = pca.getAccountByHomeId(homeAccountId);
  if (!account) throw new Error(`Account not signed in on this device: ${homeAccountId}`);
  try {
    const result = await pca.acquireTokenSilent({ scopes: SCOPES, account });
    return result.accessToken;
  } catch (e) { _logSilentFailure("getTokenFor", account, e); throw e; }
}

// 当从离线变成在线时调一次。boot 时 acquireTokenSilent 因网络抛错 → activeAccount
// 留空 → 后面有网了 isSignedIn 也还是 false。这个函数显式 retry 一次 silent，
// 成功就把 activeAccount 设上，UI 该刷新 / cloud list 该重拉的就跟着走。
export async function retrySilentSignIn(): Promise<boolean> {
  if (activeAccount) return true;                    // 已签到
  if (!isAuthConfigured()) return false;
  if (!pca) {
    try { await initAuth(); } catch (_) { return false; }
  }
  if (!pca) return false;
  const cached = pca.getAllAccounts();
  if (cached.length === 0) return false;
  try {
    await pca.acquireTokenSilent({ scopes: SCOPES, account: cached[0] });
    pca.setActiveAccount(cached[0]);
    activeAccount = cached[0];
    _emitAuth();                                    // online 后 silent 补登 → 通知 UI
    return true;
  } catch (e) {
    _logSilentFailure("retry-silent", cached[0], e);
    return false;
  }
}
