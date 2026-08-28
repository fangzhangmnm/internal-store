// MockLocal —— 内存模拟本地持久层（IDB），实现 store.local 契约。
// 真 LocalCache（包 session.js/storage.js）在 C1b 写；现在用它测 Store 的编排。
//
// store.local 契约：
//   save(name, bytes)      → void        覆盖写（一文件一原子写，H1）
//   get(name)             → bytes|null
//   exists(name)          → bool
//   backup(name)          → backupName   复制一份（原件留着；pull 前的安全网）；本地无此项则抛
//   trash(name,eventId)   → trashKey     move-aside 进本地 trash（绝不硬删用户数据）。key 用真格式
//                                       `trash/<deleteEventId>:<name>` → 测试能走 trash-merge 的真解析路径
//   hardDelete(name)      → void         真删（仅用于「云端已进 trash、不留双份」的本地侧）
//   restore(trashKey)     → name|null    从本地 trash 恢复

import type { Bytes } from "../substrate.ts";
import type { LocalCache, TrashEntry } from "../types.ts";
import { restoreTargetName, snapshotStampOf } from "../move-aside.ts";

/** 本地 trash 条目内部形状。 */
export interface TrashItem {
  /** 原名。 */
  name: string;
  /** 字节内容。 */
  bytes: Bytes;
}

async function toU8(x: Bytes | Blob | ArrayBuffer | string | null | undefined): Promise<Bytes> {
  if (x == null) return new Uint8Array(0);
  if (x instanceof Uint8Array) return x;
  if (x instanceof ArrayBuffer) return new Uint8Array(x);
  if (typeof x === "string") return new TextEncoder().encode(x);
  if (typeof x.arrayBuffer === "function") return new Uint8Array(await x.arrayBuffer());
  throw new Error("MockLocal: 无法识别的 bytes 类型");
}

/** MockLocal = LocalCache 契约（类型层验证真 LocalCache 同契约）+ 测试辅助内省字段。 */
export interface MockLocal extends LocalCache {
  /** 内省：name → 字节。 */
  _items: Map<string, Bytes>;
  /** 内省：trashKey → TrashItem（name + bytes）。 */
  _trash: Map<string, TrashItem>;
  /** 内省：folder → 目录索引缓存 JSON 串（dir-index-cache 分区替身）。 */
  _dirIndex: Map<string, string>;
}

/** 共享 backing（A4 双 tab 测试用）：两个 createMockLocal 实例喂同一 backing = 同设备两个 tab 共 IDB。 */
export interface MockLocalBacking {
  items: Map<string, Bytes>;
  trash: Map<string, TrashItem>;
  dirIndex: Map<string, string>;
  revs: Map<string, number>;      // name → 落盘 rev（A4 版本戳；真实现存进 CacheRecord.rev）
  bk: { n: number };
}
export function createMockLocalBacking(): MockLocalBacking {
  return { items: new Map(), trash: new Map(), dirIndex: new Map(), revs: new Map(), bk: { n: 0 } };
}

/** MockLocal 工厂：内存模拟本地持久层（IDB），实现 store.local 契约（测 Store 编排用）。
 *  opts.backing 注入共享底座 = 模拟同设备双 tab（各实例 per-tab seenRev，同 A4 真实现）。 */
export function createMockLocal(opts: { backing?: MockLocalBacking } = {}): MockLocal {
  const backing = opts.backing ?? createMockLocalBacking();
  const items = backing.items;                       // name → Uint8Array
  const trash = backing.trash;                       // trashKey → { name, bytes }
  const dirIndex = backing.dirIndex;                 // folder → 目录索引缓存 JSON 串
  const revs = backing.revs;
  // A4 镜像（契约同 local-cache.ts）：per-tab seen + guard 撞版备份 + 5min 防 spam 冷却。
  const _seenRev = new Map<string, number>();
  const _lastConflictBackupAt = new Map<string, number>();
  const CONFLICT_BACKUP_COOLDOWN_MS = 5 * 60_000;
  // 注：本测试替身内部以 Uint8Array 存取（测试断言 .length / u8txt），而真 LocalCache
  // 契约「内部落 Blob、get 出 Blob」。二者在「字节 vs Blob」上有意背离 —— 测试只关心字节内容。
  // 故 get 运行时回 Bytes，但声明为契约的 Blob（下方 as 处擦除），保持 MockLocal ⊆ LocalCache。
  const adapter: LocalCache = {
    async save(name: string, bytes: Bytes | Blob, _hint?: unknown, guard?: "user-save") {
      const storedRev = revs.get(name) ?? 0;
      let foreignOverwrite: { backedUp: boolean; foreignRev: number } | undefined;
      if (guard === "user-save" && items.has(name) && storedRev !== (_seenRev.get(name) ?? 0)) {
        const nowTs = Date.now();
        let backedUp = false;
        if (nowTs - (_lastConflictBackupAt.get(name) ?? 0) >= CONFLICT_BACKUP_COOLDOWN_MS) {
          items.set(`.backup-local/${++backing.bk.n}:${name}`, items.get(name)!);   // 对方字节留底
          _lastConflictBackupAt.set(name, nowTs);
          backedUp = true;
        }
        foreignOverwrite = { backedUp, foreignRev: storedRev };
      }
      items.set(name, await toU8(bytes));
      const rev = storedRev + 1;
      revs.set(name, rev);
      _seenRev.set(name, rev);
      return foreignOverwrite ? { rev, foreignOverwrite } : { rev };
    },
    async get(name: string): Promise<Blob | null> {
      if (items.has(name)) _seenRev.set(name, revs.get(name) ?? 0);   // A4：读也刷新本 tab seen
      // 测试替身：运行时回 Uint8Array（测试只读字节内容），类型按契约声明 Blob。
      return (items.has(name) ? items.get(name)! : null) as unknown as Blob | null;
    },
    async exists(name: string) { return items.has(name); },
    async stat(name: string) { const b = items.get(name) as { size?: number } | undefined; return b ? { size: b.size ?? 0, updatedAt: 0 } : null; },
    async appKeys() { return [...items.keys()].filter((k) => !k.startsWith("local-trash:") && !k.startsWith(".backup-local/") && !k.startsWith("collections/")); },
    async usage() {
      let bytes = 0, count = 0;
      for (const k of [...items.keys()]) {
        if (k.startsWith("local-trash:") || k.startsWith(".backup-local/") || k.startsWith("collections/")) continue;
        const v = items.get(k);
        bytes += (v instanceof Blob ? v.size : (v as Uint8Array | undefined)?.byteLength) || 0;
        count++;
      }
      return { bytes, count };
    },
    async backup(name: string) {
      if (!items.has(name)) throw new Error(`本地无 ${name}，无法备份`);
      const backupName = `.backup-local/${++backing.bk.n}:${name}`;   // 隐藏命名空间 + counter 防撞（测试确定性）；同名多次也唯一
      items.set(backupName, items.get(name)!);              // 复制：原件不动
      return backupName;
    },
    async trash(name: string, deleteEventId: string) {
      // 契约 trash 出 string；本替身在缺名时回 null（测试断言 null），类型按契约擦除。
      if (!items.has(name)) return null as unknown as string;
      const key = `trash/${deleteEventId}:${name}`;   // 真格式（含 deleteEventId），trash-merge 据此配对
      trash.set(key, { name, bytes: items.get(name)! });
      items.delete(name);
      return key;
    },
    async hardDelete(name: string) { items.delete(name); },
    async restore(trashKey: string) {
      const e = trash.get(trashKey);
      if (!e) return null as unknown as string;   // 同上：缺 key 回 null
      // 与真 local-cache 同策略（案卷 §8；沙箱必须与真机同严）：落点占用 → 改名恢复（快照时刻戳），绝不覆盖。
      const inner = trashKey.replace(/^[a-z]+\//, "");
      const target = await restoreTargetName(e.name, (n) => items.has(n), snapshotStampOf(inner), Date.now());
      items.set(target, e.bytes);
      trash.delete(trashKey);
      return target;
    },
    async purgeTrash(trashKey: string) {
      if (trashKey.startsWith(".backup-local/")) items.delete(trashKey);   // 备份腿（splitKey 在真实现走 backupP.del；mock 备份就住 items）
      else trash.delete(trashKey);
    },
    async listTrash(): Promise<TrashEntry[]> { return [...trash.entries()].map(([trashKey, e]) => ({ trashKey, name: e.name })); },
    // 备份分区列举（mock：`.backup-local/<counter>:<name>` 键住在 items）。key 还原原名 = 去 `<prefix>:` 段。
    async listBackup(): Promise<TrashEntry[]> {
      return [...items.keys()].filter((k) => k.startsWith(".backup-local/")).map((k) => ({ trashKey: k, name: k.replace(/^\.backup-local\/\d+:/, "") }));
    },
    // dir-index-cache 分区替身（A3）：内存 map，契约同真实现（JSON 串，store 自产自销）。
    async getDirIndexCache(folder: string) { return dirIndex.get(folder) ?? null; },
    async putDirIndexCache(folder: string, json: string) { dirIndex.set(folder, json); },
  };
  return {
    ...adapter,
    // 测试辅助
    _items: items,
    _trash: trash,
    _dirIndex: dirIndex,
  };
}
