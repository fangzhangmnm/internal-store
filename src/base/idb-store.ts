// ⚠ 使用前必读 README.md。这是 store 内部模块,**不要从 app 直接 import**——app 只走 createStore()。
//
// 通用 IndexedDB 字节存(store 自己的本地持久层)。**内容无关**:存任意 binary blob,按 name 键。
// 取代旧 local-adapter 反向依赖的前身宿主 storage.ts/session.ts —— store 不懂内容格式(一律不透明 binary)。
// 浏览器专用(IndexedDB),node 测不到 → 语法护栏 test/idb-tx-guard.test.ts + 真浏览器夹具
// tools/idb-tx-commit-check.mjs（改本文件必跑，见夹具头注释）。
//
// ★ 事务纪律（v0.3.6 收敛，2026-08-26 by Claude Fable 5；user 拍板 2026-08-25，
//   见 ai-docs/20260825-localfile-knight-store-round.md §1.1）：
//   **全库唯一事务入口 = 下面的 tx() helper**，readwrite/readonly 同一形状：
//   resolve 只认 `t.oncomplete`（落盘确认），reject 接 `t.onerror` + `t.onabort`。
//   守的 bug（2026-08-21 实锤，详 WeebPaint ai-docs/20260821-storage-eviction-investigation.md §B.2）：
//   配额撞墙时 IDB 的真实事件顺序是 `req.success → tx.abort(QuotaExceededError)`——
//   若在 req.onsuccess 就 resolve（v0.3.0 及之前），一次**根本没落盘**的写被报成成功，
//   一路向上让 app 清 dirty、停重试 = 静默丢用户编辑，且零 unhandled rejection。
//   冤史：正确修法 2026-08-21 当晚已写出并经变异测试判定诚实，随 opus 轮整批回滚陪葬
//   （回滚是问责事故非技术否决，详 WeebPaint ai-docs/20260821-rollback）；本版按拍板重写复活。
//   防回归：语法扫描测试钉「db.transaction 只许在 tx() 内」；别再新开第二种事务形状。
//
// ★ 挂死自愈（0.11.5，2026-09-06 by Claude Fable 5.1；user 2026-09-06 批「每个 IDB 请求给 deadline 同意 /
//   老连接自己关 试试 / 超时扔连接重开重试一次 同意」）。案发：iPad 过夜 → 图库首帧 99s 不来、files.usage 超时，
//   重启即愈（WeebPaint ai-docs/20260906-gallery-idb-wedge-log-analysis.md）。三件：
//   ① 一次 open / 一笔事务超过 IDB_OP_TIMEOUT_MS → 判连接挂死：abort 本事务、丢连接 memo、抛 IdbTimeoutError；
//   ② 超时后**重开连接重试一次**（把「用户手动重启自愈」交给库）；再超时 → reportStoreError(warning) 上报 + 抛；
//   ③ onversionchange（别的 tab 升库版本 / 删库）→ 老连接自己 close，下一 op 重开；onblocked 记一笔。
//   deadline 只管「等多久」，不改任何写入语义：resolve 仍只认 oncomplete；被 abort 的写 = 没落盘 = 诚实 reject。
//
// ★ 页面离场不持锁（0.11.6，user 2026-09-06 批「老页面在 pagehide 时 abort 在飞事务」）。案发：重连 redirect 两次
//   （pagehide persisted=true = 老页面进 bfcache）后新页面图库首帧 99s 不来，user 切走那一刻帧才到——冻结页面若握着未 commit
//   的事务，同 origin 新页面对同一 object store 的事务排在它后面永远等。pagehide → abort 所有在飞 **readonly** 事务
//   （读被弃 = reject IdbSuspendedError，页面反正要走）；readwrite **不腰斩**（抢救写照跑，「resolve 只认 oncomplete」照旧诚实）；
//   随后若无 readwrite 在飞 → 关连接（冻结页面连连接都不留）。下一 op（bfcache 复活 / 新页面）自动重开。
//
// ★ 0.12.1 改判（user 2026-09-09「IDB都做」#60-B；WeebPaint ai-docs/20260909-bfcache-idb-lock-daily-reauth-analysis.md）：
//   0.11.6 的「readwrite 放行」是个口子——app 在 pagehide 里无条件写 settings，suspend() 见 rw>0 就不关连接，页面带着活跃写事务被冻进
//   bfcache（WebKit IDBDatabase 无 suspend/无 bfcache 阻断，事务原地冻结，锁一直握着），新页面全挂。而冻结页里的写**永远 commit 不了**
//   （冻结前没有事件循环轮次让 success 事件派下来），驱逐时 stop() 一律 abort——放行救不了任何一笔写，只留下锁。所以：
//   pagehide **persisted=true**（要进 bfcache；PageTransitionEvent 标准字段，非某浏览器怪癖）→ abort 全部在飞事务（读写都弃）、关连接、
//   闸门落下：pageshow 之前新事务直接 reject IdbSuspendedError（不开连接、不排队）。persisted=false（页面销毁）→ 什么都不做：
//   在飞写尽量跑完（Chrome 会让它完成；WebKit stop() 自会 abort），页面死了锁自然释放。IdbSuspendedError 在 reportStoreError 漏斗里
//   降为 log 级（页面在离场，不是数据错）。

import { reportStoreError } from "./error-handling.ts";   // QuotaExceededError 必 funnel（拍板 §1.1）

// 记录 = 不透明字节 + 写入时刻。**刻意没有缩略图/预览字段**：曾有个 .peek（零 reader），
// 对加密件把明文缩略图落进了 IDB —— 明文派生物永不落持久层，别再加回来。
export interface CacheRecord { blob: Blob; updatedAt: number; rev?: number; }   // rev：A4 本地版本戳（files 分区用；老记录缺席=0，零迁移）

const STORE = "blobs";

/** IDB 单次 open / 单笔事务的 deadline（ms）。图库看门狗 8s：3s + 重试一次 = 6s 内库先给出 onError。测试可调。 */
let _idbOpTimeoutMs = 3000;
export function idbOpTimeoutMs(): number { return _idbOpTimeoutMs; }
export function setIdbOpTimeoutForTests(ms: number): void { _idbOpTimeoutMs = ms; }
/** 连接挂死（open 或事务在 deadline 内没响应）。name = "IdbTimeoutError"，app 侧按 name 识别即可。 */
export class IdbTimeoutError extends Error {
  constructor(op: string, ms: number) { super(`idb ${op} did not respond within ${ms}ms (connection wedged?)`); this.name = "IdbTimeoutError"; }
}
/** 页面离场（pagehide persisted=true）时被主动 abort 的事务，或闸门期间（pageshow 前）被拒的新事务。name = "IdbSuspendedError"。不是数据错。 */
export class IdbSuspendedError extends Error {
  constructor(op: string) { super(`idb ${op} aborted on pagehide (page leaving; not an error of the data)`); this.name = "IdbSuspendedError"; }
}

// ⚠ IDB 库名**必须 per-app 命名空间**（createStore 传 appId 派生 dbName）。IndexedDB 按 origin 隔离、
//   不按 path → 同 origin 的兄弟 PWA（如 GitHub Pages 的 /app-a/ 与 /app-b/）若共用一个写死的库名，
//   会读写同一个库：别人的文件漏进来、schema 戳互踩、缓存互毁。所以库名不再是模块常量，由 app 命名空间决定。
export type IdbCache = ReturnType<typeof createIdbCache>;

/** 建一个绑定到具体 IDB 库名的字节缓存(store 内部)。dbName 必须已带 app 命名空间(见上)。 */
export function createIdbCache(dbName: string) {
  // 连接 memo（0.4.0，dispose 需要可关的连接；顺带省掉每 op 一次 open 的往返）。
  //   浏览器强关（onclose：用户清站点数据/存储压力）→ 清 memo，下一 op 自动重开。
  //   close() 后拒后续（dispose 契约「断 IDB 连接、拒后续调用」的本层执行体）。
  let _db: Promise<IDBDatabase> | null = null;
  let _closed = false;
  let _opens = 0;   // 诊断/测试：open 次数（重开可观测）
  interface ActiveTx { t: IDBTransaction; mode: IDBTransactionMode; suspended: boolean }
  const _active = new Set<ActiveTx>();   // 在飞事务（pagehide 时处置）
  let _suspended = false;                // pagehide(persisted) 之后、pageshow 之前：本页在/正进 bfcache，不许再碰 IDB
  /** 页面离场处置（0.12.1）。persisted=true：abort 全部在飞事务（读写都弃 → IdbSuspendedError）、关连接、闸门落下；
   *  persisted=false：什么都不做（页面在销毁，在飞写尽量跑完，锁随页面死）。幂等。 */
  function suspend(persisted = true): void {
    if (!persisted) return;
    _suspended = true;
    let n = 0;
    for (const a of _active) { a.suspended = true; n++; try { a.t.abort(); } catch { /* 已结束 */ } }
    dropConnection(null);
    if (_opens > 0) reportStoreError(new Error(`[idb] pagehide persisted=true → aborted ${n} in-flight tx, connection closed, gated until pageshow (${dbName})`), "log");
  }
  /** bfcache 复活（pageshow）：抬闸，下一 op 自动重开连接。 */
  function resume(): void {
    if (!_suspended) return;
    _suspended = false;
    reportStoreError(new Error(`[idb] pageshow → gate lifted, next op reopens (${dbName})`), "log");
  }
  const _onPageHide = (e: Event): void => suspend((e as { persisted?: unknown }).persisted === true);
  const _onPageShow = (): void => resume();
  const _win = typeof window !== "undefined" && typeof window.addEventListener === "function" ? window : null;
  _win?.addEventListener("pagehide", _onPageHide);
  _win?.addEventListener("pageshow", _onPageShow);
  /** 丢连接 memo（挂死 / 版本变更 / 强关）：下一 op 自动重开。只在 memo 还是当前这条时才清，迟到的老回调别误伤新连接。 */
  function dropConnection(which: Promise<IDBDatabase> | null): void {
    if (which !== null && _db !== which) return;
    const p = _db; _db = null;
    void p?.then((db) => { try { db.close(); } catch { /* 已关 */ } }).catch(() => { /* 打开本就失败 → 无可关 */ });
  }
  function openDb(): Promise<IDBDatabase> {
    if (_closed) return Promise.reject(new Error(`idb cache closed (disposed): ${dbName}`));
    if (_db) return _db;
    _opens++;
    const ms = _idbOpTimeoutMs;
    const p: Promise<IDBDatabase> = new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      // ① open 也有 deadline：被别的连接 blocked / 后端挂死 → 不许无限等
      const timer = setTimeout(() => { dropConnection(p); reject(new IdbTimeoutError("open", ms)); }, ms);
      r.onupgradeneeded = (): void => { r.result.createObjectStore(STORE); };
      r.onblocked = (): void => { reportStoreError(new Error(`[idb] open blocked by another connection (versionchange pending): ${dbName}`), "log"); };
      r.onsuccess = (): void => {
        clearTimeout(timer);
        const db = r.result;
        db.onclose = (): void => { dropConnection(p); };                     // 浏览器强关 → 下一 op 重开
        db.onversionchange = (): void => { db.close(); dropConnection(p); }; // ③ 别的 tab 升版本/删库 → 老连接自己关，别当僵尸 block 对方
        if (_db !== p) { db.close(); return; }                                // 超时后迟到的 open：memo 已换/已丢 → 关掉别泄漏
        resolve(db);
      };
      r.onerror = (): void => { clearTimeout(timer); dropConnection(p); reject(r.error); };
    });
    _db = p;
    return p;
  }
  /** 关连接 + 拒后续调用（store.dispose 用）。幂等。 */
  function close(): void {
    _closed = true;
    _win?.removeEventListener("pagehide", _onPageHide);
    _win?.removeEventListener("pageshow", _onPageShow);
    dropConnection(null);
  }

  // ★ 全库唯一事务入口（形状纪律见文件头）。
  //   run 在事务里排请求，返回一个 finalizer；finalizer 在 `t.oncomplete`（落盘确认）时才被取值。
  //   —— 于是「resolve 了就是真的」不分读写都成立（readonly 也等 commit：oncomplete 紧随最后一个
  //   request，代价可忽略，换掉一整种分叉形状）。
  //   request 级失败不单独接：错误冒泡到 t.onerror、事务随之 abort，统一走 fail()。
  // ② 超时 → 重开连接重试一次（run 会被再调一次：它只往 store 排请求，可重入）；再超时 → warning 上报 + 抛。
  function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => () => T, op = "tx"): Promise<T> {
    if (_suspended) return Promise.reject(new IdbSuspendedError(`${mode} ${op}`));   // 闸门（0.12.1）：冻结/将冻结的页面不碰 IDB
    return txOnce(mode, run, op).catch((e: unknown) => {
      if (!(e instanceof IdbTimeoutError) || _closed) throw e;
      reportStoreError(new Error(`[idb] ${e.message} → reopening connection, retrying once`), "log");
      return txOnce(mode, run, op).catch((e2: unknown) => {
        if (e2 instanceof IdbTimeoutError) reportStoreError(e2, "warning");
        throw e2;
      });
    });
  }

  //   deadline（0.11.5）：事务在 IDB_OP_TIMEOUT_MS 内没 complete/error/abort → 判挂死：abort 它、丢连接、抛 IdbTimeoutError。
  function txOnce<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => () => T, op: string): Promise<T> {
    const conn = openDb();
    return conn.then((db) => new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const ms = _idbOpTimeoutMs;
      const rec: ActiveTx = { t, mode, suspended: false };
      _active.add(rec);
      let failed = false;                                  // onerror 后必再来 onabort：只报一次
      const timer = setTimeout(() => {
        if (failed) return;
        failed = true;
        _active.delete(rec);
        dropConnection(conn);                              // 连接判挂死：丢 memo，下一 op（含下面的重试）重开
        try { t.abort(); } catch { /* 已结束 */ }
        reject(new IdbTimeoutError(`${mode} ${op}`, ms));
      }, ms);
      const fail = (): void => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        _active.delete(rec);
        if (rec.suspended) { reject(new IdbSuspendedError(`${mode} ${op}`)); return; }   // pagehide 主动弃读：不是数据错，不走 Quota/上报
        const err = t.error ?? new DOMException(`idb ${mode} transaction aborted`, "AbortError");
        // 配额撞墙 = 「写没落盘」的头号来源，必须 funnel 给 app（拍板 2026-08-25 §1.1）；
        // reject 照旧向上抛——上层清 dirty/停重试的决定只准建立在 resolve 之上。
        if ((err as Partial<DOMException>).name === "QuotaExceededError") reportStoreError(err, "error");
        reject(err);
      };
      t.onerror = fail;
      t.onabort = fail;
      let finish: () => T;
      try { finish = run(t.objectStore(STORE)); }
      catch (e) { failed = true; clearTimeout(timer); _active.delete(rec); reject(e); t.abort(); return; }   // 同步 throw（DataError 等）→ 整笔弃，不许部分提交
      t.oncomplete = (): void => { clearTimeout(timer); _active.delete(rec); if (failed) return; resolve(finish()); };
    }));
  }
  return {
    close,
    get(name: string): Promise<CacheRecord | undefined> {
      return tx("readonly", (s) => { const r = s.get(name); return () => r.result as CacheRecord | undefined; }, "get");
    },
    put(name: string, rec: CacheRecord): Promise<void> {
      return tx("readwrite", (s) => { s.put(rec, name); return () => undefined; }, "put");
    },
    del(name: string): Promise<void> {
      return tx("readwrite", (s) => { s.delete(name); return () => undefined; }, "del");
    },
    keys(): Promise<string[]> {
      return tx("readonly", (s) => { const r = s.getAllKeys(); return () => r.result.filter((k): k is string => typeof k === "string"); }, "keys");
    },
    /** 按 key 前缀汇总占用（单事务 cursor 走一遍；`Blob.size` 是引用属性，**不把字节读进内存**）。
     *  只返两个标量，不返任何名字 —— 拿不到清单，故**不能**当全库列举用（那是被否决的退化设计）。 */
    usage(prefix: string): Promise<{ bytes: number; count: number }> {
      return tx("readonly", (s) => {
        let bytes = 0, count = 0;
        const c = s.openCursor();
        c.onsuccess = (): void => {
          const cur = c.result;
          if (!cur) return;                                // 走完 → 等 oncomplete
          if (typeof cur.key === "string" && cur.key.startsWith(prefix)) {
            const rec = cur.value as CacheRecord | undefined;
            if (rec && rec.blob) { bytes += rec.blob.size || 0; count++; }
          }
          cur.continue();
        };
        return () => ({ bytes, count });
      }, "usage");
    },
    /** 原子改名(同一事务 get→put 新→del 旧):trash/restore/backup 用。源不存在则 noop。 */
    rename(from: string, to: string): Promise<void> {
      return tx("readwrite", (s) => {
        const g = s.get(from);
        g.onsuccess = (): void => { const v = g.result as CacheRecord | undefined; if (v !== undefined) { s.put(v, to); s.delete(from); } };
        return () => undefined;
      }, "rename");
    },
    /** 诊断/测试：连接被 open 过几次（重开可观测）。 */
    _opens(): number { return _opens; },
    /** 页面离场处置（pagehide 自动调；测试可直调）。 */
    suspend,
    /** bfcache 复活处置（pageshow 自动调；测试可直调）。 */
    resume,
  };
}
