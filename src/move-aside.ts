// 深模块策略：move-aside（删除 / 覆盖前留底）的**命名 + 隐藏命名空间**约定。规则只写在这里，
// 不散到 app。tier 无关——cloud 用 .trash/ /.backup/ 文件夹，local 用 blob-partition 的 trash/backup 分区
// （不是键前缀：v415 前这里写的「.backup-local/ 键前缀」已不是事实）；命名与防撞这一份策略两边共用。
//
// 名字 = `<base> [<yyyymmddhhmmss>-<guid>]`：
//   - yyyymmddhhmmss：人读的秒级时间，一眼看出「哪个时间点的备份」；
//   - guid：防撞用真随机 GUID（不是秒级时间能保证的——同秒多次留底、跨 reload 都不撞；
//     与本仓「identity = GUID」一脉，见 MASTER.md）。
// 纯叶子模块（只依赖 Date/crypto），cloud-sync / local-adapter / session.js 都可安全 import（无环）。

// （LOCAL_BACKUP_PREFIX 已删 v415：本地备份改走 blob-partition 的 backup 分区、键是 `backup/<inner>`，
//   这个字符串前缀零引用。它最后一个消费者是 session.listSessions 的图库过滤，那个也在 v415 删了。）

function pad(n: number, w = 2) { return String(n).padStart(w, "0"); }

function yyyymmddhhmmss(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
         `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function guid() {
  const c = globalThis.crypto;
  if (c && c.randomUUID) return c.randomUUID();
  // fallback：手搓 v4
  const a = new Uint8Array(16);
  if (c && c.getRandomValues) c.getRandomValues(a);
  else for (let i = 0; i < 16; i++) a[i] = Math.floor(Math.random() * 256);
  a[6] = (a[6] & 0x0f) | 0x40; a[8] = (a[8] & 0x3f) | 0x80;
  const h = Array.from(a, (b) => b.toString(16).padStart(2, "0"));
  return `${h.slice(0,4).join("")}-${h.slice(4,6).join("")}-${h.slice(6,8).join("")}-${h.slice(8,10).join("")}-${h.slice(10,16).join("")}`;
}

/** move-aside 防撞标：`<yyyymmddhhmmss>-<guid>`。ms 由调用方给（cloud-sync 注入时钟便于测试；local 用 Date.now）。 */
export function asideStamp(ms: number) { return `${yyyymmddhhmmss(ms)}-${guid()}`; }

// ── 恢复撞名策略（案卷 20260825-cloud-override-adopt-noop-case.md §8，2026-08-25 user 拍板）────
// 落点被占（活文件 / 正打开的文档 / 未推 dirty）→ **绝不覆盖**（§A：every overwrite is move-aside 的对偶：
// restore 也不许 clobber），改名恢复。戳 = **快照自己的时刻**（user 语义：「backup 的时间分辨率」——
// 恢复出来的是"那个时间点的版本"，名字就该写那个时间点），取 aside stamp 前 14 位；拿不到才退恢复时刻。
// 本地腿（local-cache）/ mock（mock-local）/ 云端腿（cloud-sync.restore 候选名）三处共用，防沙箱与真机漂移。
// added by Claude Fable 5, 2026-08-25.

/** aside stamp（`<yyyymmddhhmmss>-<guid>`）开头抽 14 位快照时刻；抽不到 → null。 */
export function snapshotStampOf(s: string | null | undefined): string | null {
  const m = s ? /^(\d{14})-/.exec(s) : null;
  return m ? m[1] : null;
}

/** 恢复撞名的展示戳 `yyyymmdd-hhmmss`：优先快照时刻（stamp14），缺失退 fallbackMs（恢复时刻）。 */
export function restoreStampDisplay(stamp14: string | null | undefined, fallbackMs: number): string {
  const s = stamp14 && /^\d{14}$/.test(stamp14) ? stamp14 : yyyymmddhhmmss(fallbackMs);
  return `${s.slice(0, 8)}-${s.slice(8)}`;
}

/** 恢复落点名：orig 空闲 → 原名；被占 → `base [yyyymmdd-hhmmss].ext`（仍占再补 `-2`/`-3`…）。 */
export async function restoreTargetName(
  orig: string,
  occupied: (name: string) => Promise<boolean> | boolean,
  stamp14: string | null | undefined,
  fallbackMs: number,
): Promise<string> {
  if (!(await occupied(orig))) return orig;
  const disp = restoreStampDisplay(stamp14, fallbackMs);
  const dot = orig.lastIndexOf(".");
  const mk = (suf: string) => (dot > 0 ? `${orig.slice(0, dot)} [${suf}]${orig.slice(dot)}` : `${orig} [${suf}]`);
  let target = mk(disp);
  for (let i = 2; await occupied(target); i++) target = mk(`${disp}-${i}`);
  return target;
}
