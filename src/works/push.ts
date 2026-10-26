// ⚠ 使用前必读 README.md + CONTEXT.md。app 不直接 import——经 createStore。
//
// push（深模块）—— 串行 + If-Match + 重试 + 冲突 surface 的推。单一职责 = 同步**编排**：
//   它自己不持谱系/不解加密/不化解冲突，而是**编排**三个深模块：
//     local-head.ifMatchFor（If-Match + bypass 守卫）· seal.sealForWrite（明文→at-rest 包壳）·
//     safe-resolve.tryHeal/resolveConflict（自愈/永不丢字节化解）· local-head.onPushed（落地谱系）。
//   串行 = substrate.serialize（同 name 串行，B1）。
import { toU8 } from "../base/substrate.ts";
import type { BytesSource } from "../base/substrate.ts";
import type { CloudSync, UploadSessionPort } from "../base/types.ts";
import type { LocalHead } from "./local-head.ts";
import type { Seal } from "./seal.ts";
import type { SafeResolve, ResolveChoice } from "./safe-resolve.ts";

type Busy = <T>(label: string, fn: () => Promise<T>) => Promise<T>;
const passBusy: Busy = (_l, fn) => fn();
const isConflict = (e: unknown) => !!e && ((e as { name?: string }).name === "CloudConflictError" || (e as { status?: number }).status === 412);
// 默认 = 0.17.0：4 次 × 200·n ms（共 2 s）。0.17.1 曾改成 5 次 1/2/4/8 s（熬 iOS 切网络），0.17.2 退回默认、改成消费方显式开
//   （createStore({ pushRetry: { maxAttempts: 5, backoffMs: 1000, exponential: true } })；user 2026-10-15「行为变更默认关」）。模块级可改只给测试。
export const pushRetryDefaults = { maxAttempts: 4, backoffMs: 200, exponential: false };

function retriable(e: unknown): boolean {
  const x = e as { status?: number; name?: string } | null;
  const s = x?.status;
  if ((x as { message?: string } | null)?.message === "Not signed in") return false;   // 0.14.0：auth 缺席重试也不会好（1.2s 白退避）；正常路径已由 isOnline∧signedIn 早退，这里是兜底
  return (s == null || s === 429 || (s >= 500 && s <= 599)) && x?.name !== "CloudConflictError" && x?.name !== "CloudNameCollisionError";
}

type AdoptFn = (plain: Blob, name: string) => unknown | Promise<unknown>;

export interface PushCfg {
  cloud: Pick<CloudSync, "push"> & Partial<Pick<CloudSync, "fetchMeta">>;
  head: Pick<LocalHead, "ifMatchFor" | "onPushed" | "recordEdit"> & Partial<Pick<LocalHead, "editCount" | "seenBase" | "markSeen">>;
  seal: Pick<Seal, "sealForWrite" | "isContainer">;
  safeResolve: Pick<SafeResolve, "tryHeal" | "resolveConflict">;
  serialize: <T>(name: string, fn: () => Promise<T>) => Promise<T>;
  /** F-54：给这次推的字节一个「上传会话记忆面」（createStore 开了 uploads.resumable 才有）。不给 = 2.1.3 行为。 */
  sessionFor?: (name: string, bytes: Uint8Array) => Promise<UploadSessionPort | undefined>;
  editVersion: () => number;                  // 编辑游标（B2）；opts 可冻结覆盖
  busy?: Busy;
  maxAttempts?: number;
  backoffMs?: number;
  /** 退避 backoffMs × 2^(n-1)（封顶 15 s）；默认线性 backoffMs × n。 */
  exponential?: boolean;
  /** 2.2.1（默认 true）：**谱系丢了的脏副本，推之前先问一次云端**。什么时候算丢：If-Match 算不出来（脏、没捕到 parent、内存 base 空 = 刷新冲掉了）
   *  ∧ 磁盘上有这份上次同步到的 etag（durable；真·新文件没有）。问到云端 === durable（没人动）→ markSeen 重捕 parent → 带 If-Match 推——
   *  这和 freshness.open 在线时对脏副本做的是**同一条规则**（freshness.ts「reload 后内存 _base 空…markSeen 重捕」那段），只是搬到推之前再做一次；
   *  问到云端 ≠ durable（真动过）→ 不再盲推撞 409，直接走 412 同一条路：tryHeal → 冲突面（cloudState 真的是 changed）；
   *  云端没了 / 问不到 → 照旧（无 If-Match 推：没了就建回去、问不到就撞 409 让上层 surface）。
   *  修的是 2026-10-26 CatsUp「正常编辑天天弹『云端有新版本』」：刷新前 30 s 内改过 → 刷新后本地恢复先于登录 → 0.18.0 只给干净副本接谱系、
   *  脏的没人补 → 之后每次推都是盲推 → 409 被当成撞名 → pushAll 报 failed、自动保存弹假面、「处理…」要按两次（家族根 ai-docs/20261026-cloud-conflict-ux-postmortem.md §3）。
   *  为什么默认开（10-21 规矩：默认开要先写为什么）：它只去掉一个**假阳性**——If-Match 仍然是云端此刻的版本、真分叉照样 412 → 面，不新增任何覆盖路径；
   *  多标签页的顾虑和 open 在线时已有的重捕完全一样大；而且 0.18.0 的干净那半已经默认开，两半一开一关没法向消费方解释。false = 2.2.0 行为。 */
  recaptureLineage?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export interface PushOpts {
  encode: () => BytesSource | Promise<BytesSource>;
  getEditVersion?: () => number;
  /** 真分叉时问人。2.2.1 起 ctx 可能带 cloudState（推之前刚问过云端时顺手给，省一趟 fetchMeta；没带 = 调用方自己去问）。 */
  onConflict?: (ctx: { name: string; cloudState?: "changed" | "absent" }) => ResolveChoice | Promise<ResolveChoice>;
  adopt?: AdoptFn;
  // 谱系断裂（无 base 推撞上云端同名）时的去向。见 doPush 的 isCollision 分支。
  //   false（默认）= 抛 CloudNameCollisionError（**真·新建**该走这条：两设备各建同名不同物，护栏正确）
  //   true          = 走 onConflict 冲突面（**编辑既有文件**该走这条：本地云端都有、只是谱系断了）
  surfaceCollision?: boolean;
  /** 0.17.0：上传进度透传 provider.upload（宿主画进度条）。 */
  onProgress?: (done: number, total: number) => void;
  /** 2.1.0：keepMine 时输的那份进不进 .backup（默认进；二等自动备份传 false）。 */
  loserBackup?: boolean;
}

// push 的终态全集（收成联合类型，别再用裸 string —— "deferred" 拼错要在编译期就炸）：
//   pushed     落地已确认（拿到新 etag）· deferred 落地**未**确认（provider 没回 item/eTag）→ 仍算未推
//   healed     lost-response 自愈 · resolved/unresolved/cancelled 由 safeResolve.resolveConflict 产出
export type PushStatus = "pushed" | "deferred" | "healed" | "resolved" | "unresolved" | "cancelled";

export interface PushResult { status: PushStatus; dirtyAfter?: boolean; resolution?: string; reason?: string; backupName?: string; backedUp?: string | null }

export function createPush(cfg: PushCfg) {
  const { cloud, head, seal, safeResolve, serialize, editVersion, recaptureLineage = true,
    busy = passBusy, maxAttempts = pushRetryDefaults.maxAttempts, backoffMs = pushRetryDefaults.backoffMs, exponential = pushRetryDefaults.exponential, sleep = (ms) => new Promise<void>((r) => setTimeout(r, ms)) } = cfg;

  async function doPush(name: string, { encode, getEditVersion = editVersion, onConflict, adopt, surfaceCollision = false, onProgress, loserBackup }: PushOpts): Promise<PushResult> {
    let ifMatch = head.ifMatchFor(name);                // 封装 bypass：dirty 缺 parent 且 base 已知 → throw BypassError
    const v0 = getEditVersion();
    // 0.15.2：这个文件的保存计数。全局游标（getEditVersion）要宿主自己推进，拆库后没人推进过 → dirtyAfter 恒 false：
    //   推送途中 save() 又落了新字节，推完却把 dirty 清掉。计数由 recordEdit 自己涨，不靠宿主。
    const e0 = head.editCount?.(name) ?? 0;
    const editedSince = (): boolean => getEditVersion() !== v0 || (head.editCount?.(name) ?? 0) !== e0;
    // encode 出明文 → seal 按 at-rest 态包壳（调用方对加密零感知）。只编码+包壳一次，重试复用（B5 逐字节比对要相等）。
    const bytes = await seal.sealForWrite(name, await toU8(await encode()));
    const isEnc = await seal.isContainer(bytes);
    const session = cfg.sessionFor ? await cfg.sessionFor(name, bytes) : undefined;   // F-54：同一份字节重试 / 下次开页都认得这条会话
    // 2.2.1 谱系重捕（JSDoc 见 PushCfg.recaptureLineage）：If-Match 算不出来 ∧ 这份以前同步过 → 先问云端，而不是盲推撞 409。
    let staleKnown = false;   // 问出来云端 ≠ durable：别再 PUT 了（必 412），直接走冲突那条路
    const durable = head.seenBase?.(name) ?? null;
    if (ifMatch == null && recaptureLineage && durable != null && cloud.fetchMeta && head.markSeen) {
      let meta: Awaited<ReturnType<NonNullable<typeof cloud.fetchMeta>>> | undefined;
      try { meta = await cloud.fetchMeta(name); } catch { meta = undefined; }   // 问不到 = 未知 → 照旧盲推（撞了由上层 surface），不据此下结论
      if (meta && meta.etag === durable) { head.markSeen(name, meta.etag); ifMatch = head.ifMatchFor(name); }   // 云端没动：重捕 parent（= freshness.open 同一条规则）
      else if (meta) staleKnown = true;                                                                           // 云端动过：真分叉
      // meta === null（云端没了）：照旧无 If-Match 推 = 建回去（ghost 的 save 语义不在本次改动范围）
    }
    const onCloudConflict = async (): Promise<PushResult> => {
      if (await safeResolve.tryHeal(name, bytes)) {   // lost-response 自愈
        const dirtyAfter = editedSince();
        if (dirtyAfter) head.recordEdit(name);        // 编辑发生在推期间 → 基于刚自愈的版本重标脏（B2）
        return { status: "healed", dirtyAfter };
      }
      const choice = onConflict ? await onConflict({ name, cloudState: "changed" }) : "cancel";   // 真分叉 → 交 ui 选（默认 cancel=留 dirty）
      return await safeResolve.resolveConflict(name, choice, { bytes, adopt, inChain: true, loserBackup });   // 推送本身就站在同名串行链上（push / identity / 离线补推都是）
    };
    return busy("sync.pushing", async () => {
      if (staleKnown) return onCloudConflict();
      let attempt = 0, lastErr: unknown;
      while (attempt < maxAttempts) {
        attempt++;
        try {
          const { item } = await cloud.push(name, bytes, { baseEtag: ifMatch, encrypted: isEnc, onProgress, session });
          // F0 红线：provider 没回 item/eTag = **落地未确认**（分块响应 / 代理吞 body / provider 违约）。
          //   绝不能当成功——onPushed(null,false) 会清 dirty 且 base 停在旧值，未推字节随后被 offload
          //   合法驱逐（MASTER §A「dirty 永不驱逐」直接失守），UI 还显示「已同步」。
          //   → 不调 onPushed（dirty/parent 原样保住），报 deferred，让上层重推。
          if (!(item && item.eTag)) return { status: "deferred", dirtyAfter: true };
          const dirtyAfter = editedSince();   // PUT 期间又改过 → 仍 unpushed
          head.onPushed(name, item.eTag, dirtyAfter);
          return { status: "pushed", dirtyAfter };
        } catch (e: unknown) {
          if (isConflict(e)) return onCloudConflict();
          // 谱系断裂：无 base 推撞上云端同名（cloud-sync 的 409 + 尾字节 differ → CloudNameCollisionError）。
          //   两种情形共用这一个错误，但该走的路完全相反：
          //     ① **真·新建**（surfaceCollision=false）→ 云端那个是「别的设备建的同名不同物」。
          //        抛错、两份都留着，是 MASTER §A 身份行明写的保证（both kept）。不动。
          //     ② **编辑既有文件**（surfaceCollision=true）→ 本地有、云端有，只是本机不知道自己派生自哪一版
          //        （reload 冲掉内存谱系、durable etag 又从没写过）。抛 collision 在这里是**假原因 + 死路**：
          //        用户的保存一个字节都上不去，且自我延续（永远推不成功 = 永远不写 etag = 每次版本更新必复发）。
          //        → 交给和 412 同一个冲突面：拉云端 / 留本地 / 以我的覆盖（云端 loser 进 .backup，never-lose）。
          //   两条路都不盲目覆盖、都不丢字节；差别只是 ② 给了用户一条出路。
          if (surfaceCollision && (e as { name?: string })?.name === "CloudNameCollisionError") {
            const choice = onConflict ? await onConflict({ name }) : "cancel";
            return await safeResolve.resolveConflict(name, choice, { bytes, adopt, inChain: true, loserBackup });   // 推送本身就站在同名串行链上（push / identity / 离线补推都是）
          }
          if (retriable(e) && attempt < maxAttempts) { lastErr = e; await sleep(exponential ? Math.min(backoffMs * 2 ** (attempt - 1), 15_000) : backoffMs * attempt); continue; }
          throw e;
        }
      }
      throw lastErr;
    });
  }

  // 同 name 串行（B1）：每次 push 等前一次跑完才启动。
  function push(name: string, opts: PushOpts): Promise<PushResult> {
    return serialize(name, () => doPush(name, opts));
  }
  // doPush = 未串行版：给已在自己 serialize/serialize2 段内的调用方（identity 的 rename/saveAs），
  //   避免同名嵌套 serialize 自锁。
  return { push, doPush };
}
