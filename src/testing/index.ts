// ./testing 门牌：测试替身子入口（消费方 app 测试用，不进主入口）。
/** 内存模拟 OneDrive-ish 云盘的 CloudProvider 测试替身（不碰网络/MSAL）。 */
export { createMockProvider, type MockProvider } from "./mock-provider.ts";
/** 内存模拟本地持久层（IDB）的 LocalCache 测试替身。 */
export { createMockLocal, type MockLocal } from "./mock-local.ts";
