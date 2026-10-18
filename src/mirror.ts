// 替代来源（镜像）—— 2.0.0，2026-10-17 Claude Fable 5.1。user 10-17：本机 / Tailscale 上开一个服务器当替代 CDN（可以记多条，PC 上还能直接用本机文件）；
//   「然后想一下本地或者其他source的cdn应该怎么设计。比如file api? 然后怎么样自愈，有什么风险」。
//
//   镜像 = 「同名同尺寸的另一份字节」的来源：这台设备上的文件（File API）、局域网 / Tailscale 上任何支持 Range 的 HTTP 主机。
//   **身份仍归云端 item**（库对内容盲，镜像只是运输）：download-session 开会话时按名字 + 尺寸问镜像有没有；拿到的片抽样和云端比字节，
//   不一样 → 这份文件这一版不再用这个镜像，它给的没验过的片一并清掉（见 download-session）。镜像出错 / 卡住 → 回落云端，镜像进冷却。
//
//   消费方（app）的义务：镜像主机是用户自配的外接服务，要在 app 的 CLAUDE.md 黄线区登记这一类；HTTPS 页面只能打 HTTPS 或 localhost
//   （`tailscale serve` 给 tailnet 域名发证书；裸 http://100.x.x.x 会被浏览器当混合内容拦掉）；主机要回 CORS 头
//   （Access-Control-Allow-Origin、Access-Control-Expose-Headers: Content-Range, Content-Length）并支持 Range（回 206）。
import type { MirrorHandle, MirrorSource } from "./download-session.ts";
import type { RangeOpts } from "./chunk-scheduler.ts";
import { anySignal, readBody } from "./providers/range-body.ts";

/** 这台设备上的文件当镜像（File API：`<input type=file>` / showOpenFilePicker 拿到的 File，slice 白送、零网络）。
 *  lookup 按云端文件名给 File；没有 → null。尺寸不等 = 不是同一份 → 不用。 */
export function createFileMirror(label: string, lookup: (name: string) => File | Blob | null | Promise<File | Blob | null>): MirrorSource {
  return {
    label,
    async open(name, size) {
      const f = await lookup(name);
      if (!f || f.size !== size) return null;
      return {
        async read(offset, length) {
          const start = Math.max(0, Math.min(offset, f.size));
          return new Uint8Array(await f.slice(start, Math.min(f.size, start + Math.max(0, length))).arrayBuffer());
        },
      };
    },
  };
}

export interface HttpMirrorOptions {
  /** 每种请求的超时（ms）；不传 = 不设超时（调度层的 stallMs 另算）。 */
  timeoutMs?: number;
  /** 测试注入。 */
  fetch?: typeof fetch;
}

/** 任何支持 Range 的 HTTP 主机当镜像。urlFor 把云端文件名映射成这个主机上的地址（没有 → null）。
 *  open：打一个 `Range: bytes=0-0` 探针——必须回 206 且 Content-Range 的总长 == 云端尺寸，否则这个主机没有这份（同名不同尺寸也算没有）。
 *  read：Range GET → 必须 206、长度必须正好；按流读、报进度（卡住判定）；signal 中止。 */
export function createHttpMirror(label: string, urlFor: (name: string) => string | null, opts: HttpMirrorOptions = {}): MirrorSource {
  const doFetch = opts.fetch ?? ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => fetch(input, init));
  const timed = (): AbortSignal | undefined =>
    opts.timeoutMs && typeof AbortSignal !== "undefined" && typeof (AbortSignal as { timeout?: unknown }).timeout === "function" ? AbortSignal.timeout(opts.timeoutMs) : undefined;
  return {
    label,
    async open(name, size): Promise<MirrorHandle | null> {
      const url = urlFor(name);
      if (!url) return null;
      let r: Response;
      try { r = await doFetch(url, { headers: { Range: "bytes=0-0" }, signal: timed() }); }
      catch { return null; }                                          // 够不着 = 这次没有（下次开会话再问）
      try { await r.body?.cancel(); } catch { /* 探针的字节不要 */ }
      if (r.status !== 206) return null;                              // 不支持 Range（200 整份）/ 404 / 5xx 都当没有
      const m = /\/(\d+)\s*$/.exec(r.headers.get("Content-Range") ?? "");
      if (!m || Number(m[1]) !== size) return null;                   // 尺寸不等 = 不是同一份
      return {
        async read(offset: number, length: number, o: RangeOpts = {}): Promise<Uint8Array> {
          let res: Response;
          try { res = await doFetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` }, signal: anySignal([timed(), o.signal]) }); }
          catch (e) { throw new Error(`mirror "${label}": range fetch failed (${String(e)})`, { cause: e }); }
          if (res.status !== 206) { try { await res.body?.cancel(); } catch { /* */ } throw new Error(`mirror "${label}": range GET → ${res.status}`); }
          let buf: ArrayBuffer;
          try { buf = await readBody(res, o.onProgress); }
          catch (e) { throw new Error(`mirror "${label}": range body failed (${String(e)})`, { cause: e }); }
          if (buf.byteLength !== length) throw new Error(`mirror "${label}": range returned ${buf.byteLength} bytes, wanted ${length}`);
          return new Uint8Array(buf);
        },
      };
    },
  };
}
