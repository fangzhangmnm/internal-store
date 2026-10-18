// ⚠ 使用前必读 README.md。app 经 createStore 拿感知面（files.persistence），执行体经顶层 export。
// created 2026-08-27 by Claude Fable 5 (claude-fable-5)
//
// persist() 三件套（user 2026-08-27 拍板；出处 = 本日 store session「三件套同意」）：
//   ① 感知强制（库内，零 consent）：boot 后自动 `navigator.storage.persisted()` 纯查询——任何平台
//     不弹任何东西——结果暴露 `files.persistence()` + 未持久时 funnel 一次（"log" 级）。
//   ② 接线强制（编译期）：StoreConfig.persistence **必填**（"app-managed" | "none"），逼装配者表态，
//     「忘了这回事」从可能变成不可能（validateAdopt/appId 必填同手法）。
//   ③ 执行体（库出车，app 踩油门）：requestStoragePersistence()——app 在**自己的手势时刻**调
//     （挂图库/首存/安装后；宪法「挂上图库就 persist()」的落点）。
//
// 为什么**不**由库自动调 persist()（拍板定性，别翻案）：
//   · Firefox 是真弹窗——库在 boot/非手势时刻自动调 = 无上下文炸脸，违反家族「后台绝不弹授权、
//     权限只在用户手势」纪律（provider NotAllowedError 处置、store 不劫持导航，同族）。
//   · Chromium 从不弹窗，按 site engagement 启发式静默批/拒——boot 时调多半静默拒（空枪）。
//   · Safari 的 7 天 ITP **不理它**（家族已按最坏假设设计）；用户手动清站点数据任何平台照清。
//   → persist 是 §A 修订保命三件套里**最弱的一件**（真承重 = dirty 窗口短 + 正本不在 IDB）。
//     库能保证的只有「必表态、必感知」，保证不了「必成功」——装作能保证反而是谎报承重（瑞士奶酪反面）。
//   · persist 是 **origin 级**不是库级：同 origin 兄弟（github.io project pages）共享此状态，
//     调用时机天然归宿主/产品层。
//   ⚠ 结果**绝不改变 store 行为**：granted 与否，所有红线（dirty 不驱逐、正本不进 IDB、退出自动推）原样。

/** 持久化状态（纯查询快照）。supported=false 含「环境无 StorageManager」（node/旧浏览器/测试）。 */
export interface PersistenceState {
  /** 环境支持 navigator.storage.persisted 查询。 */
  supported: boolean;
  /** 本 origin 已获持久化（Chromium：storage pressure 下不清 persistent bucket；其余平台语义见头注释）。 */
  persisted: boolean;
}

/** StorageManager 最小面（参数注入 = 测试 seam；prod 缺省走 globalThis.navigator.storage）。 */
export type StorageManagerLike = { persist?: () => Promise<boolean>; persisted?: () => Promise<boolean> };
const globalStorage = (): StorageManagerLike | null =>
  (globalThis as { navigator?: { storage?: StorageManagerLike } }).navigator?.storage ?? null;

/** 纯查询（零 consent、零弹窗、任何时刻可调）。异常/缺环境 → supported:false（诚实降级，不谎报已持久）。 */
export async function queryStoragePersistence(sm: StorageManagerLike | null = globalStorage()): Promise<PersistenceState> {
  if (typeof sm?.persisted !== "function") return { supported: false, persisted: false };
  try { return { supported: true, persisted: await sm.persisted() }; }
  catch { return { supported: false, persisted: false }; }
}

/** 执行体：**只准在用户手势时刻调**（挂图库/首存/安装后——Firefox 会真弹窗，别在 boot/后台调）。
 *  已持久 → 直接 granted（不重复打扰）；denied 可下次手势再试（Chromium 启发式会随 engagement 变）。
 *  ⚠ 无论结果如何都**不得**据此改变数据安全行为（persist 是降概率，不是保证——头注释档位定性）。 */
export async function requestStoragePersistence(sm: StorageManagerLike | null = globalStorage()): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof sm?.persist !== "function") return "unsupported";
  try {
    if (sm.persisted && await sm.persisted()) return "granted";
    return (await sm.persist()) ? "granted" : "denied";
  } catch { return "unsupported"; }
}
