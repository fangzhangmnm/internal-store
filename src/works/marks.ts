// ⚠ 使用前必读 README.md + DATA SAFETY GUIDELINE.md。store 内部深模块——app 经 createStore 的 store.files.star / unstar / fold / unfold，读 Item.starred / Item.folded。
//
// marks（深模块，2.3.0）—— 人给一份文件做的记号：星、收起。created 2026-11-08 by Claude Fable 5.1
//   星（user 2026-11-08）：「星星的语义实际上就是手游里面的星星，就是说防止你把一些稀有卡牌不小心当做狗粮给删掉了…你要删之前，你必须得先把星星给撤掉。」
//     → 库这一层：加了星的，拒绝送进回收站（file.trash / 冲突面里选「这份进回收站」/ 云端没了过宽限的自动送回收站）。
//   收起（user 2026-11-08）：「防止你嫌烦，然后删，就是你可以收起而不是删」「它应该是一个纯 UI 层面的事情，就是它文件的归属还是应该是平铺的」
//     → 库只存这个记号、列举时带出来；**库不因为它藏任何东西、不拦任何动作**。图库拿它决定画不画成一条细条。
//   存在哪（user 2026-11-08「星星能做一个同步文件」；收起记在同一份 = user 同夜「可以」）：一份 store 自己的 collection（`.${appId}/` 下，
//     和 app 的设置同一套设施：逐条合并、带墓碑、If-Match）。条目 = 身份 → { starred?, folded? }；两样都没了 = 删条目（墓碑）。
//   它是人的决定，不是能重建的缓存：这份文件丢了 = 星没了（保护失效，作品不丢）、手动收起的重新露出来（都是往安全的方向坏）。
//   已知的洞：两台设备离线各点一次，逐条「后改的为准」；别的设备还没同步到这颗星之前，在那台上照样删得掉。
//
// 身份 = 文件的 identifier（路径）。改名 / 移动成功 → 记号跟着新身份走（create-store 的 tryMove 调 rename）。
//   文件进了回收站，条目留着不动（加了星的本来就进不去；收起的还原回来还是收起的）。条目不随文件的生死清理——每条几十字节。
import type { Collection } from "./collection.ts";

/** 一份文件上的记号。只在 true 时有这个键。 */
export interface FileMarks { starred?: true; folded?: true }

/** 记号那份 collection 的名字（云端 = `.${appId}/store.file-marks.json`）。带 `store.` 前缀 = 库自己的，app 别用这个名字开 collection。 */
export const MARKS_COLLECTION = "store.file-marks";

export interface Marks {
  /** 记号读进内存了没有（本机缓存读完即可，不等云端）。读失败 → reject。 */
  ready(): Promise<void>;
  /** 这一份的记号（ready 之前问 = 空）。 */
  get(identifier: string): FileMarks;
  /** 改记号：true = 加上，false = 去掉；没提到的不动。 */
  set(identifier: string, patch: { starred?: boolean; folded?: boolean }): Promise<void>;
  /** 改名 / 移动成功：记号跟着新身份走。 */
  rename(from: string, to: string): Promise<void>;
  /** 现在加着星的全部身份（ready 之前问 = 空）。清空回收站「不连坐」用。 */
  starredIdentifiers(): string[];
  /** 记号变了（这台改的、别的设备同步来的都算）→ 回调变了的那些身份。返退订。 */
  onChange(cb: (identifiers: string[]) => void): () => void;
  /** 去云端对一次（开夹的云端帧到了时顺手叫；云端没变 = 一次 fetchMeta）。不等、不抛。 */
  reconcile(): void;
}

const clean = (v: unknown): FileMarks => {
  const o = (v && typeof v === "object" ? v : {}) as { starred?: unknown; folded?: unknown };
  const out: FileMarks = {};
  if (o.starred === true) out.starred = true;
  if (o.folded === true) out.folded = true;
  return out;
};

/** collection 懒开：第一次要用才开（开 = 建云端那份文件）。getCollection 由 create-store 给（走 store.collection 同一个工厂 → 单例、scaffold、dispose 都有人管）。 */
export function createMarks(cfg: { getCollection: () => Collection; onError: (e: unknown) => void }): Marks {
  let coll: Collection | null = null, readyP: Promise<void> | null = null, reconciling = false;
  const c = (): Collection => (coll ??= cfg.getCollection());
  const ready = (): Promise<void> => (readyP ??= c().init());
  return {
    ready,
    get: (identifier) => (coll ? clean(coll.getItem(identifier)) : {}),
    async set(identifier, patch) {
      await ready();
      const cur = clean(c().getItem(identifier));
      const next: FileMarks = { ...cur };
      if (patch.starred === true) next.starred = true; else if (patch.starred === false) delete next.starred;
      if (patch.folded === true) next.folded = true; else if (patch.folded === false) delete next.folded;
      if (!!next.starred === !!cur.starred && !!next.folded === !!cur.folded) return;   // 没变：不写（不白盖一次时间戳）
      if (next.starred || next.folded) c().setItem(identifier, next); else c().deleteItem(identifier);
      const r = await c().flushLocal();   // 人刚点的星：立刻落本机，不等防抖（关页也不丢）
      if (!r.ok) throw r.error instanceof Error ? r.error : new Error(`marks: local write failed for "${identifier}"`);
    },
    async rename(from, to) {
      await ready();
      const cur = clean(c().getItem(from));
      if (!cur.starred && !cur.folded) return;
      c().setItem(to, cur); c().deleteItem(from);
      const r = await c().flushLocal();
      if (!r.ok) throw r.error instanceof Error ? r.error : new Error(`marks: local write failed moving "${from}" → "${to}"`);
    },
    starredIdentifiers: () => (coll ? coll.entries().filter((e) => clean(e.value).starred).map((e) => e.id) : []),
    onChange: (cb) => c().onChange((ids: string[]) => cb(ids)),
    reconcile() {
      if (reconciling) return;
      reconciling = true;
      void ready().then(() => c().reconcileWithRemote()).then((r) => { if (r.status === "error") cfg.onError(r.error); }, cfg.onError).finally(() => { reconciling = false; });
    },
  };
}
