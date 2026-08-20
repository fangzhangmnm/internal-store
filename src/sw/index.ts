// `./sw` 门牌（2026-08-20 收敛开牌；tag 前随 exports 一起过人类审）。
// 两个消费面：**SW 上下文**用网关（createSwStreamGateway，token 自动走凭据桥），
// **页面上下文**启动凭据桥写端（startSwAuthBridge）。SW 归 app（家族一贯）——store 只给薄件，零媒体概念。
/** SW 流式网关（把 /stream/<name> 的 Range 请求答成 206；本地副本→staging→云端三级字节源）。 */
export { createSwStreamGateway, parseRange } from "./gateway.ts";
export type { SwGatewayCfg, SwGatewayCloud } from "./gateway.ts";
/** 凭据桥：页面写端（定期把 MSAL token 落 IDB 给 SW）+ SW 读端（token-source）。 */
export { startSwAuthBridge, createBridgeTokenSource } from "./bridge.ts";
export type { SwAuthBridgeCfg } from "./bridge.ts";
