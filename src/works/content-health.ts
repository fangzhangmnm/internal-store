// content-health —— 「文件内容最近下载不下来」这一件事实（作品引擎）。
// created 2026-11-12 by Claude Opus 5.5（小黑屋维修线施工单第 3 条；规矩 = 统筹 Claude Fable 5.2 定，施工单
//   20260516 WebXiaoHeiWu/ai-docs/20261112-content-download-failure-repair-plan.md 第三节）
//
// 只记一件事：**这个页面里（= 这个 store 实例），最近一次下载文件内容是失败的，而且之后还没有成功过。**
//   - 不猜原因（网络拦了 / 微软不稳 / 地址过期都一样记）、不设时限、不落盘（刷新 = 新页面，从头记）。
//   - 下载成功一次就清掉。「最近一次」按结束的先后算（两趟同时在飞，后结束的说了算）。
//   - 「下载文件内容」= 作品引擎向 provider 要字节的那几处：整份 `download`、按范围 `downloadRange`
//     （cloud-sync 的 pull / pullTail / pullRange / 推完核尾巴）。作品和 collections 两个 cloud-sync 实例共用一份。
//     资源那台引擎（stream）不进来：它的中止是调度层自己发的（对冲输了 / 让道），不是「下载不下来」。
//   - 用途只有一个：叫 `ui.resolveConflict` 时当 `contentFailing` 递给宿主，让面说实话（「云端覆盖本地」现在完不成）。
//     **库里任何决定都不看它**——化解的顺序（先备份再覆盖）、派发、自愈一个字不动。
export interface ContentHealth {
  /** 最近一次下载文件内容失败了、之后还没成功过。 */
  failing(): boolean;
  /** 跑一次下载文件内容：失败记上、成功清掉；结果和错误原样透传（不吞、不改）。 */
  track<T>(download: () => Promise<T>): Promise<T>;
}

export function createContentHealth(): ContentHealth {
  let failing = false;
  return {
    failing: () => failing,
    async track<T>(download: () => Promise<T>): Promise<T> {
      let v: T;
      try { v = await download(); }
      catch (e) { failing = true; throw e; }
      failing = false;
      return v;
    },
  };
}
