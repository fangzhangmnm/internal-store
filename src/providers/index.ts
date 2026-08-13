// OneDriveProvider —— **浏览器专属**（MSAL/Graph/document）：方法调用时才碰浏览器；顶层 import 在 node 安全。
// auth 流程（登录/token）只能真机验。

import * as graph from "./graph.ts";
import {
  configureOneDriveAuth,
  isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn,
  getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState,
} from "./auth.ts";
import { graphToCloudProvider } from "../onedrive-provider.ts";

/** createOneDriveProvider 的配置（clientId 必传；msalUrl = vendored MSAL 脚本路径；scopes/authority 有家族默认）。 */
interface OneDriveConfig {
  clientId?: string;
  authority?: string;
  scopes?: string[];
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
export function createOneDriveProvider(config: OneDriveConfig = {}) {
  configureOneDriveAuth(config);                  // { clientId, scopes?, authority?, msalUrl? }
  return {
    provider: graphToCloudProvider(graph),        // CloudProvider（喂 createCloudSync）
    auth: { isAuthConfigured, initAuth, signIn, signOut, getToken, isSignedIn, getActiveAccount, retrySilentSignIn, onAuthChanged, getAuthState },
  };
}

/** OneDrive auth 配置注入（app 调一次）。 */
export { configureOneDriveAuth };
