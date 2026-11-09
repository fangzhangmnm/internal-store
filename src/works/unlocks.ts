// ⚠ 使用前必读 README.md + DATA SAFETY GUIDELINE.md。store 内部深模块——app 经 createStore 的 store.files.unlock / lock / unlockOf / watchUnlocks。
//
// unlocks（深模块，2.3.0）—— 「这台设备此刻让不让改这份作品」的账。created 2026-11-08 by Claude Fable 5.1
//   家规「源文件原则上只读：手动解锁才能改」（家族 CLAUDE.md，user 2026-11-08）：
//     「默认的文件你根本不能编辑，一编辑就报错，一保存就报错…得手动的解锁才行。然后这个解锁的状态反而是一个 transient 的状态，
//      就是可能过段时间或者换个设备它就没了，你得重新解。」「解锁肯定是每个作品单独解锁，过期的话，我觉得就用一天吧」
//     「不管是解锁还是从最后画，就是只要你再画，这个时间就会无限往后拖」
//   所以一枚解锁 = 逐件、跟设备（只记本机 kv，**永不进任何同步面**）、放凉 ttl 过期（滑动：每次成功的 save 往后推）。
//   正开着的那份（activeIdentifier）过期不打断：它不再是活动文档的那一刻才落锁（盖住「开着没存、放了一天回来接着画」——不然那一笔存不下来）。
//
// ⚠ 和「no-timestamps」红线的关系（MASTER §A：内容的新旧从不看时间戳）：这里的时间**只决定这台设备此刻让不让改**，
//   不参与谁覆盖谁、不参与任何同步 / 合并 / 新鲜度判断。它是防误触的保险（枪的保险），不是安全边界，更不是同步决策的先例。
//   时钟只用本机的；本机时钟被往回拨过（记下的时刻在「现在」之后）→ 一看到就把那条改记成现在，过期最多再等一个 ttl。
//
// 持久：kv 相对键 `internal.unlocks`（namespacedKv 补 `${appId}.${databaseId}.` 前缀；和 pending_gone / pending_deletions 同族，不新增 IDB 表）。
//   值 = { [identifier]: { at, saved? } }。每次读都从 kv 现读：别的标签页解的锁这一页下一次问就看得见（「跟设备走」）。
import { reportStoreError } from "../base/error-handling.ts";
import type { Kv } from "../base/types.ts";

const KEY = "internal.unlocks";

/** 一枚活着的解锁。expiresAt = max(解锁那刻, 最近一次成功 save) + ttl；正开着的那份过了这个时刻仍然活着（见头注释）。 */
export interface Unlock {
  /** 哪一份。 */
  identifier: string;
  /** 解锁那一刻（epoch ms，本机时钟）。 */
  unlockedAt: number;
  /** 放凉到这一刻过期（epoch ms，本机时钟）。只给界面显示用，别拿它做任何内容决策。 */
  expiresAt: number;
}

export interface Unlocks {
  /** 解锁这一份（已经解着的 = 重新计时）。 */
  unlock(identifier: string): Unlock;
  /** 提前收回（车钥匙那一下）。本来就锁着 = 什么都不做。 */
  lock(identifier: string): void;
  /** 现在活着的那一枚；锁着 → null。 */
  get(identifier: string): Unlock | null;
  /** 这一份刚成功存了一次：有活着的解锁就把过期往后推；没有就什么都不做（存不等于解锁）。 */
  noteSaved(identifier: string): void;
  /** 改名 / 移动成功：解锁跟着新身份走。 */
  rename(from: string, to: string): void;
  /** 现在活着的全部。 */
  live(): Unlock[];
  /** 订阅活着的解锁：订阅当场给一次现在的全表，之后有变化（解 / 锁 / 过期 / 改名）再给。返退订。 */
  watch(cb: (live: Unlock[]) => void): () => void;
  /** 收掉定时器（store.dispose）。之后不再回调。 */
  close(): void;
}

interface Rec { at: number; saved?: number }

export function createUnlocks(cfg: {
  kv: Kv;
  ttlMs: number;
  now?: () => number;
  /** 当前打开的文档（身份）：它的解锁过期不打断。 */
  activeIdentifier?: () => string | null;
  /** 定时器 seam（测试注入；默认 setTimeout / clearTimeout）。 */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
}): Unlocks {
  const { kv, ttlMs } = cfg;
  const now = cfg.now ?? (() => Date.now());
  const setTimer = cfg.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = cfg.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  const watchers = new Set<(live: Unlock[]) => void>();
  let timer: unknown = null, closed = false, lastSig = "";
  /** 正开着的那份过了期还活着的时候，多久回来看一眼它是不是不再开着了（只为了通知界面；问 get() 的那一刻总是现算的）。 */
  const ACTIVE_RECHECK_MS = 60_000;

  function read(): Record<string, Rec> {
    try {
      const raw = kv.get(KEY);
      const m = raw ? JSON.parse(raw) : {};
      return m && typeof m === "object" && !Array.isArray(m) ? m as Record<string, Rec> : {};
    } catch (e) { reportStoreError(e, "log"); return {}; }   // 读不出来 = 当作没有解锁（往锁着的方向坏）
  }
  function write(m: Record<string, Rec>): void {
    if (Object.keys(m).length) kv.set(KEY, JSON.stringify(m)); else kv.remove(KEY);
  }
  const baseOf = (r: Rec): number => Math.max(r.at, r.saved ?? 0);
  const toUnlock = (identifier: string, r: Rec): Unlock => ({ identifier, unlockedAt: r.at, expiresAt: baseOf(r) + ttlMs });

  /** 过一遍账：时钟回拨的改记成现在、过期又不是正开着的删掉。返回还活着的。只在确实改了的时候写 kv。 */
  function sweep(): Record<string, Rec> {
    const m = read(), t = now(), active = cfg.activeIdentifier?.() ?? null;
    let changed = false;
    for (const id of Object.keys(m)) {
      const r = m[id]!;
      if (typeof r?.at !== "number") { delete m[id]; changed = true; continue; }   // 形状不认 → 当没有
      if (baseOf(r) > t) { m[id] = { at: t }; changed = true; continue; }           // 时钟被往回拨过：改记成现在（最多再等一个 ttl）
      if (t >= baseOf(r) + ttlMs && id !== active) { delete m[id]; changed = true; }
    }
    if (changed) { try { write(m); } catch (e) { reportStoreError(e, "log"); } }
    return m;
  }
  const liveOf = (m: Record<string, Rec>): Unlock[] => Object.keys(m).sort().map((id) => toUnlock(id, m[id]!));

  /** 账可能变了：重排定时器；有人在听且全表真的变了就通知。 */
  function settle(m: Record<string, Rec>): void {
    if (closed) return;
    if (timer != null) { clearTimer(timer); timer = null; }
    if (!watchers.size) return;
    const live = liveOf(m);
    const sig = JSON.stringify(live);
    if (sig !== lastSig) { lastSig = sig; for (const cb of [...watchers]) { try { cb(live); } catch (e) { reportStoreError(e, "warning"); } } }
    if (!live.length) return;
    const t = now();
    // 下一次该回来看的时刻：最早的那个过期点；已经过期（= 正开着的那份）的，隔一会儿回来看它是不是放下了。
    const due = Math.min(...live.map((u) => (u.expiresAt > t ? u.expiresAt - t + 1 : ACTIVE_RECHECK_MS)));
    timer = setTimer(() => { timer = null; settle(sweep()); }, Math.max(1, due));
  }

  return {
    unlock(identifier) {
      const m = sweep();
      const r: Rec = { at: now() };
      m[identifier] = r;
      write(m);                      // 写不进去（配额）→ 抛给调用方：没记上就不能说解了锁
      settle(m);
      return toUnlock(identifier, r);
    },
    lock(identifier) {
      const m = sweep();
      if (m[identifier] == null) { settle(m); return; }
      delete m[identifier];
      write(m);
      settle(m);
    },
    get(identifier) {
      const m = sweep();
      const r = m[identifier];
      settle(m);
      return r ? toUnlock(identifier, r) : null;
    },
    noteSaved(identifier) {
      const m = sweep();
      const r = m[identifier];
      if (!r) return;
      r.saved = now();
      try { write(m); } catch (e) { reportStoreError(e, "log"); }   // 往后推没记上：字节已经落盘了，不为这个让保存失败；过期只会更早，方向是锁
      settle(m);
    },
    rename(from, to) {
      const m = sweep();
      const r = m[from];
      if (!r) return;
      delete m[from]; m[to] = r;
      try { write(m); } catch (e) { reportStoreError(e, "log"); }
      settle(m);
    },
    live() { const m = sweep(); settle(m); return liveOf(m); },
    watch(cb) {
      const m = sweep(), live = liveOf(m);
      settle(m);                             // 先让已经在听的人对上现值（没变就不叫）
      watchers.add(cb);
      lastSig = JSON.stringify(live);
      try { cb(live); } catch (e) { reportStoreError(e, "warning"); }   // 新来的：当场给一次现值
      settle(m);                             // 排定时器（现在有人听了）
      return () => { watchers.delete(cb); if (!watchers.size && timer != null) { clearTimer(timer); timer = null; } };
    },
    close() { closed = true; watchers.clear(); if (timer != null) { clearTimer(timer); timer = null; } },
  };
}
