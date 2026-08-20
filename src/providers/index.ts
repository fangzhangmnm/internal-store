// OneDriveProvider —— **浏览器专属**（MSAL/Graph/document）：方法调用时才碰浏览器；顶层 import 在 node 安全。
// auth 流程（登录/token）只能真机验。

import * as graph from "./graph.ts";
import {
  configureOneDriveAuth,
  isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn,
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
  graph.configureGraphTokenSource(getToken);      // token-source 接缝：页面上下文 = MSAL（SW 上下文注入凭据桥读端）
  return {
    provider: graphToCloudProvider(graph),        // CloudProvider（喂 createCloudSync）
    auth: { isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState },
  };
}

/** OneDrive auth 配置注入（app 调一次）。 */
export { configureOneDriveAuth };
