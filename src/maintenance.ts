// maintenance —— 深清（还原出厂）两口子：wipe（删本 appId 全部命名空间）+ 无痕扫（残留验证）。
// created 2026-08-28 by Claude Fable 5. 出处 = WeebPaint P7 还原出厂（0825 案卷 §2.10）+ store 轮二议题 2，
//   user 拍板：type-consent 比对**必须在库内做**（"typing check 需要库来做"，2026-08-25/0828 两次确认）。
//
// 契约（实例无关的模块级口子，不挂 Store 实例）：
//   - 作用域 = `${appId}.` 前缀的 IndexedDB 库（`${appId}.${databaseId}` 全部实例）+ 同前缀 localStorage 键。
//     app 自己的库（如 GUID 前缀 `weebpaint-bd6cece69075d759.*`——注意 "-" ≠ "."，天然不在本前缀内）
//     由 app 自扫自删，不进本口子（议题 2 拍板）。
//   - 调用方契约：wipe 前先 dispose 全部活 store 实例（deleteDatabase 会被开着的连接堵住）。
//     多 tab 并发：别的 tab 攥着连接 → 该库进 blocked 报告（**不傻等**，BLOCKED_TIMEOUT 后放弃），
//     UI 提示「关掉其他标签页重试」。绝不静默吞。
//   - 无痕扫红线口径（议题 2 拍板）：只返**命名空间级库名 + localStorage 键计数**——
//     localStorage 键名可能内嵌文件名（files.etag:<name> 等），**永不返键名/文件名**
//     （与 usage/dirty「永不返名字」红线同源）。归零验证要的是计数，不是名单。
//   - typed consent（库内比对）：wipe 必须携带 { expected, typed }——expected = app 展示给用户的
//     确认词（i18n 归 app），typed = 用户逐字敲进来的。不等 / 空 / 过短 → throw WipeConsentError，
//     库拒绝执行。API 形状使「跳过 consent」在 app 代码里成为显式的谎（grep 可查），同 storeUI 强制注入逻辑。

export class WipeConsentError extends Error {
  code = "WIPE_CONSENT";
  constructor(msg: string) { super(msg); this.name = "WipeConsentError"; }
}

export interface WipeReport {
  deletedDatabases: string[];      // 命名空间级库名（`${appId}.${databaseId}`），无内容信息
  blockedDatabases: string[];      // 被活连接堵住未删成的库（关别的 tab / dispose 后重试）
  localStorageKeysRemoved: number; // 只报计数（键名可能嵌文件名，红线不返）
}

export interface NamespaceScanReport {
  databasesSupported: boolean;     // indexedDB.databases() 平台可用性（Firefox<126 等 → false = 库面扫不了）
  databases: string[];             // 残留库名（命名空间级）；databasesSupported=false 时恒 []
  localStorageKeys: number;        // 残留键计数（不返键名）
}

const BLOCKED_TIMEOUT_MS = 2000;   // deleteDatabase 被堵的放弃线：报 blocked 而不是吊死深清流程

type IdbLike = { databases?: () => Promise<{ name?: string }[]>; deleteDatabase: (name: string) => IDBOpenDBRequest };
type LsLike = { length: number; key(i: number): string | null; removeItem(k: string): void };

const _idb = (): IdbLike | null => (globalThis as { indexedDB?: IdbLike }).indexedDB ?? null;
const _ls = (): LsLike | null => { try { return (globalThis as { localStorage?: LsLike }).localStorage ?? null; } catch { return null; } };

async function listNamespaceDbs(appId: string, idb: IdbLike): Promise<{ supported: boolean; names: string[] }> {
  if (typeof idb.databases !== "function") return { supported: false, names: [] };
  try {
    const all = await idb.databases();
    return { supported: true, names: all.map((d) => d.name ?? "").filter((n) => n.startsWith(`${appId}.`)) };
  } catch { return { supported: false, names: [] }; }
}

function listNamespaceLsKeys(appId: string, ls: LsLike): string[] {
  const prefix = `${appId}.`;
  const keys: string[] = [];
  for (let i = 0; i < ls.length; i++) { const k = ls.key(i); if (k && k.startsWith(prefix)) keys.push(k); }
  return keys;   // 内部用；对外永远只报 length
}

function deleteDbOrBlocked(idb: IdbLike, name: string): Promise<"deleted" | "blocked"> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r: "deleted" | "blocked") => { if (!settled) { settled = true; resolve(r); } };
    const timer = setTimeout(() => done("blocked"), BLOCKED_TIMEOUT_MS);
    const req = idb.deleteDatabase(name);
    req.onsuccess = () => { clearTimeout(timer); done("deleted"); };
    // deleteDatabase 语义：error 极罕见（安全模式等）——按 blocked 报（诚实：没删掉），不吞不谎报成功
    req.onerror = () => { clearTimeout(timer); done("blocked"); };
    req.onblocked = () => { /* 连接未释放：等到 timer 放弃线，期间若对方关闭仍可能转 onsuccess */ };
  });
}

/** 无痕扫：枚举本 appId 命名空间残留（还原出厂后验证归零用）。只读，零副作用。 */
export async function scanAppNamespace(appId: string): Promise<NamespaceScanReport> {
  if (!appId) throw new Error("scanAppNamespace: appId required");
  const idb = _idb(); const ls = _ls();
  const dbs = idb ? await listNamespaceDbs(appId, idb) : { supported: false, names: [] };
  return {
    databasesSupported: dbs.supported,
    databases: dbs.names,
    localStorageKeys: ls ? listNamespaceLsKeys(appId, ls).length : 0,
  };
}

/** 深清：删除本 appId 全部命名空间（所有 databaseId 实例的 IDB 库 + localStorage 键）。
 *  前置：全部活 store 实例已 dispose（否则对应库进 blocked 报告）。consent 库内比对，不过不执行。 */
export async function wipeAppNamespace(opts: { appId: string; consent: { expected: string; typed: string } }): Promise<WipeReport> {
  const { appId, consent } = opts;
  if (!appId) throw new Error("wipeAppNamespace: appId required");
  const expected = consent?.expected?.trim() ?? "";
  if (expected.length < 4) throw new WipeConsentError("wipe refused: consent.expected missing or too short (app must show the user a real confirmation phrase)");
  if (consent.typed !== consent.expected) throw new WipeConsentError("wipe refused: typed consent does not match the expected phrase");

  const report: WipeReport = { deletedDatabases: [], blockedDatabases: [], localStorageKeysRemoved: 0 };
  const idb = _idb();
  if (idb) {
    const dbs = await listNamespaceDbs(appId, idb);
    // databases() 不可用的平台（老 Firefox）：枚举不了就删不全——诚实缺口，由 scan 的 databasesSupported=false
    //   告知 app（UI 层自己决定提示）。绝不假装删干净。
    for (const name of dbs.names) {
      const r = await deleteDbOrBlocked(idb, name);
      (r === "deleted" ? report.deletedDatabases : report.blockedDatabases).push(name);
    }
  }
  const ls = _ls();
  if (ls) {
    const keys = listNamespaceLsKeys(appId, ls);
    for (const k of keys) ls.removeItem(k);
    report.localStorageKeysRemoved = keys.length;
  }
  return report;
}
