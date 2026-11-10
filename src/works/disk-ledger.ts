// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// disk-ledger（小深模块，2.3.2）—— 「本机盘上现在是哪一份」的号。纯内存、每个标签页一份、零 IO。
//   created 2026-11-10 by Claude Opus 5.5；设计 = 家族根 ai-docs/20261110-design-store-save-gen-fix.md 第 2.2 节（Fable 5.2）；家族周账 F-238。
//
// 为什么要它：库里几处会宣布「这份文件已经和网盘一致」（清待传 / 把网盘版本号记成基准）。宣布之后，本机那份就允许被别的设备的新版直接换掉、
//   允许被腾空间清掉。所以宣布的那一刻必须同时成立：① 盘上的字节就是我刚才对过 / 推过 / 写下的那一份；② 没有发出了、还没落盘的保存。
//   以前靠 local-head 的「这份文件被保存过几次」（editCount）近似——那个数在保存**发出**时就加一，字节却要过一会儿才落盘：
//   这中间进来的推送拿着上一份字节、看见数没变，就宣布了一致（F-238 = F-188 的复现）。
//
// 号 = 这一页里全局递增的整数（跨名字不重复，从 1 起）；0 = 这一页还没写过这个名字。刷新之后全部从 0 开始：没人在路上、盘上 = 0，
//   读盘来推的拿到的也是 0，对得上。
//
// 三条用法规矩（R1–R3，设计稿 2.2）：
//   R1 谁要宣布一致，谁手里必须有一个号 g，代表它对过 / 推过 / 写下的那份字节；宣布之前 settled(name, g)，为假就不宣布（待传留着）。
//   R2 读盘上的字节来推的，一律在同名串行段里读，号 = 读的那一刻的 disk(name)。（所有写盘都在串行段里 → 读到的和号对得上。）
//   R3 库自己写盘（不是用户保存）之后立刻 wrote(name)，后面要宣布的就用它回的号。
// 没有叠着的保存时 settled 永远为真 → 这层判断不改变任何现有行为。
//
// 2.3.2 和设计稿接口的一处差别：没有 move(from, to)。改名把字节写到新名字那一下按 R3 调 wrote(新名)，旧名跟着 head.forget 一起 forget，
//   两件就够了；move 没有调用者，不留。
export interface DiskLedger {
  /** 一次用户保存发出：在路上的 +1，回这次保存的号。必须和「进同名串行段」在同一个同步步骤里（发出即占位）。 */
  issue(name: string): number;
  /** 那次保存的字节落盘了：盘上 = 这个号，在路上的 -1。 */
  landed(name: string, g: number): void;
  /** 那次保存没落成（封装 / 写盘抛了）：在路上的 -1，盘上不变。 */
  failed(name: string, g: number): void;
  /** 库自己换了盘上的字节（采纳网盘字节、加密转换、改名落到新名字）：盘上 = 一个新号，回它。 */
  wrote(name: string): number;
  /** 盘上现在是几号（这一页没写过 = 0）。 */
  disk(name: string): number;
  /** 唯一的判据：没有在路上的保存 ∧ 盘上就是 g。 */
  settled(name: string, g: number): boolean;
  /** 这个名字的盘上记录清掉（删除 / 腾空间 / 断谱系，随 head.forget）。在路上的保存不动：它们落盘时照样记账。 */
  forget(name: string): void;
}

export function createDiskLedger(): DiskLedger {
  let next = 0;
  const onDisk = new Map<string, number>();
  const inFlight = new Map<string, Set<number>>();   // 发出了、还没落盘（或失败）的保存号

  const flying = (name: string): Set<number> => { let s = inFlight.get(name); if (!s) { s = new Set(); inFlight.set(name, s); } return s; };
  const settle = (name: string, g: number): void => {
    const s = inFlight.get(name);
    if (!s) return;
    s.delete(g);
    if (s.size === 0) inFlight.delete(name);
  };

  return {
    issue(name) { const g = ++next; flying(name).add(g); return g; },
    landed(name, g) { settle(name, g); onDisk.set(name, g); },
    failed(name, g) { settle(name, g); },
    wrote(name) { const g = ++next; onDisk.set(name, g); return g; },
    disk(name) { return onDisk.get(name) ?? 0; },
    settled(name, g) { return !inFlight.has(name) && (onDisk.get(name) ?? 0) === g; },
    forget(name) { onDisk.delete(name); },
  };
}
