// OneDriveProvider —— **浏览器专属**（MSAL/Graph/document）：方法调用时才碰浏览器；顶层 import 在 node 安全。
// auth 流程（登录/token）只能真机验。

import { createGraph } from "./graph.ts";
import {
  configureOneDriveAuth,
  isAuthConfigured, initAuth, signIn, signOut, getToken, getTokenFor, isSignedIn,
  getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState,
} from "./auth.ts";
import { graphToCloudProvider } from "../onedrive-provider.ts";
import type { CloudProvider } from "../types.ts";
import type { AuthState, Account } from "./auth.ts";

/** createOneDriveProvider 返回的 auth 面（契约显式化；订阅走 onAuthChanged 回调，无 window 事件）。 */
export interface OneDriveAuth {
  /** 是否已注入真实 clientId（占位符 = 未配置，纯离线不 load MSAL）。 */
  isAuthConfigured(): boolean;
  /** 初始化 auth（silent probe：有 account 不代表本 app 有 token）。 */
  initAuth(): Promise<AuthState>;
  /** 交互式登录（用户手势里调）。 */
  signIn(): Promise<unknown>;
  /** 登出：只清本 app cache（clearCache），不 logoutRedirect 踢掉用户整个微软会话。 */
  signOut(): Promise<void>;
  /** 拿 access token（silent）。 */
  getToken(): Promise<string>;
  /** 是否已登录。 */
  isSignedIn(): boolean;
  /** 当前活跃 account（MSAL 句柄）。 */
  getActiveAccount(): Account;
  /** 静默重试登录。 */
  retrySilentSignIn(): Promise<boolean>;
  /** auth 状态订阅（每个转变都回调）；返回退订函数。 */
  onAuthChanged(cb: (st: AuthState) => void): () => void;
  /** 当前 auth 状态快照。 */
  getAuthState(): AuthState;
}

/** createOneDriveProvider 的配置（clientId 必传；msalUrl = vendored MSAL 脚本路径；scopes/authority 有家族默认）。 */
export interface OneDriveConfig {
  /** app 注册的 clientId（必传）。 */
  clientId?: string;
  /** MSAL authority（有家族默认）。 */
  authority?: string;
  /** OAuth scopes（有家族默认）。 */
  scopes?: string[];
  /** vendored MSAL 脚本路径。 */
  msalUrl?: string | null;
  /** 多账号防御（2026-08-25 拍板 §1.4 铺路）：给定 = 本 provider **钉死**这个账号取 token
   *  （MSAL homeAccountId，登录后从 `auth.getActiveAccount().homeAccountId` 拿、由 app 存进自己的
   *  gallery registry），store 内部永不问「现在谁登录着」；缺省 = 沿用全局 activeAccount（现状单账号）。
   *  邻域约束不动：personal-account-only；翻 authority audience 必须连 authority 一起改（2026-08-23 拍板）。 */
  homeAccountId?: string;
}
/** config 驱动的完整 OneDrive CloudProvider（MSAL + Graph + 适配器）。**浏览器专属**；auth 流程只能真机验。
 *
 * 用法（app 传的就这些：clientId + 浏览器相关 msalUrl）：
 * ```ts
 *  const { provider, auth } = createOneDriveProvider({
 *    clientId: "....",                                  // 必传
 *    msalUrl: "./vendor/msal/msal-browser.min.js",      // vendored 脚本
 *    scopes?, authority?,                               // 有家族默认
 *  });
 *  await auth.initAuth(); if (auth.isSignedIn()) { ...store 用 provider... }
 * ```
 */
export function createOneDriveProvider(config: OneDriveConfig = {}): { provider: CloudProvider; auth: OneDriveAuth } {
  configureOneDriveAuth(config);                  // { clientId, scopes?, authority?, msalUrl? }
  // token-source 接缝：页面上下文 = MSAL（SW 上下文自建 createGraph(凭据桥)）。
  //   homeAccountId 给定 → 钉死该账号（getTokenFor）；缺省 → 全局 activeAccount（getToken）。
  //   2026-08-28 实例化：graph 的 token 源与 approot/subfolder/downloadUrl 缓存全部 per-provider——
  //   同页多 provider（多账号库并联）互不覆盖、互不投毒（旧模块级单例的已知局限就此清除）。
  const hid = config.homeAccountId;
  const g = createGraph(hid ? () => getTokenFor(hid) : getToken);
  return {
    provider: graphToCloudProvider(g),        // CloudProvider（喂 createCloudSync）
    auth: { isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState },
  };
}

/** OneDrive auth 配置注入（app 调一次）。 */
export { configureOneDriveAuth };
