// ./testing 门牌：测试替身子入口（消费方 app 测试用，不进主入口）。
/** 内存模拟 OneDrive-ish 云盘的 CloudProvider 测试替身（不碰网络/MSAL）。 */
export { createMockProvider, type MockProvider } from "./mock-provider.ts";
/** 内存模拟本地持久层（IDB）的 LocalCache 测试替身。 */
export { createMockLocal, type MockLocal } from "./mock-local.ts";
/** EncryptionPort 契约形状替身（fake 容器非真加密；真加密测试住 @internal/encryption 仓）。 */
export { createMockEncryption } from "./mock-encryption.ts";
/** mock 工厂配置 + mock 内省 trash 条目形状。 */
export type { MockProviderOpts } from "./mock-provider.ts";
export type { TrashItem } from "./mock-local.ts";
/** 供类型化测试直接取用的核心契约（与主门牌同源）。 */
export type { CloudProvider, CloudItem, LocalCache } from "../types.ts";
export type { Bytes } from "../substrate.ts";
/** 故障注入配置（mock provider 的对抗测试面）+ 回收站契约条目 + 传输选项。 */
export type { Fault } from "./mock-provider.ts";
export type { TrashEntry, UploadOpts, MoveOpts, FolderDeleteResult } from "../types.ts";
