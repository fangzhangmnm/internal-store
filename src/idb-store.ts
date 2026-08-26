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

import { reportStoreError } from "./error-handling.ts";   // QuotaExceededError 必 funnel（拍板 §1.1）

// 记录 = 不透明字节 + 写入时刻。**刻意没有缩略图/预览字段**：曾有个 .peek（零 reader），
// 对加密件把明文缩略图落进了 IDB —— 明文派生物永不落持久层，别再加回来。
export interface CacheRecord { blob: Blob; updatedAt: number; }

const STORE = "blobs";

// ⚠ IDB 库名**必须 per-app 命名空间**（createStore 传 appId 派生 dbName）。IndexedDB 按 origin 隔离、
//   不按 path → 同 origin 的兄弟 PWA（如 GitHub Pages 的 /app-a/ 与 /app-b/）若共用一个写死的库名，
//   会读写同一个库：别人的文件漏进来、schema 戳互踩、缓存互毁。所以库名不再是模块常量，由 app 命名空间决定。
export type IdbCache = ReturnType<typeof createIdbCache>;

/** 建一个绑定到具体 IDB 库名的字节缓存(store 内部)。dbName 必须已带 app 命名空间(见上)。 */
export function createIdbCache(dbName: string) {
  function openDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(dbName, 1);
      r.onupgradeneeded = (): void => { r.result.createObjectStore(STORE); };
      r.onsuccess = (): void => resolve(r.result);
      r.onerror = (): void => reject(r.error);
    });
  }

  // ★ 全库唯一事务入口（形状纪律见文件头）。
  //   run 在事务里排请求，返回一个 finalizer；finalizer 在 `t.oncomplete`（落盘确认）时才被取值。
  //   —— 于是「resolve 了就是真的」不分读写都成立（readonly 也等 commit：oncomplete 紧随最后一个
  //   request，代价可忽略，换掉一整种分叉形状）。
  //   request 级失败不单独接：错误冒泡到 t.onerror、事务随之 abort，统一走 fail()。
  function tx<T>(mode: IDBTransactionMode, run: (s: IDBObjectStore) => () => T): Promise<T> {
    return openDb().then((db) => new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      let failed = false;                                  // onerror 后必再来 onabort：只报一次
      const fail = (): void => {
        if (failed) return;
        failed = true;
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
      catch (e) { failed = true; reject(e); t.abort(); return; }   // 同步 throw（DataError 等）→ 整笔弃，不许部分提交
      t.oncomplete = (): void => resolve(finish());
    }));
  }

  return {
    get(name: string): Promise<CacheRecord | undefined> {
      return tx("readonly", (s) => { const r = s.get(name); return () => r.result as CacheRecord | undefined; });
    },
    put(name: string, rec: CacheRecord): Promise<void> {
      return tx("readwrite", (s) => { s.put(rec, name); return () => undefined; });
    },
    del(name: string): Promise<void> {
      return tx("readwrite", (s) => { s.delete(name); return () => undefined; });
    },
    keys(): Promise<string[]> {
      return tx("readonly", (s) => { const r = s.getAllKeys(); return () => r.result.filter((k): k is string => typeof k === "string"); });
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
      });
    },
    /** 原子改名(同一事务 get→put 新→del 旧):trash/restore/backup 用。源不存在则 noop。 */
    rename(from: string, to: string): Promise<void> {
      return tx("readwrite", (s) => {
        const g = s.get(from);
        g.onsuccess = (): void => { const v = g.result as CacheRecord | undefined; if (v !== undefined) { s.put(v, to); s.delete(from); } };
        return () => undefined;
      });
    },
  };
}
