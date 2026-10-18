// byte-range 请求的两件小工具（2.0.0，2026-10-17 Claude Fable 5.1）：graph.ts 和 mirror.ts 共用，不 import 上层。
//   readBody：按流读响应体、每到一段报一次累计字节（卡住判定靠它）；没给 onProgress / 环境没有流 → 一口 arrayBuffer()。
//   anySignal：把「传输层超时」和「调度层中止」两个信号合成一个（AbortSignal.any 老浏览器没有，手拼）。

export async function readBody(r: Response, onProgress?: (bytesSoFar: number) => void): Promise<ArrayBuffer> {
  const body = r.body;
  if (!onProgress || !body || typeof body.getReader !== "function") return await r.arrayBuffer();
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.byteLength) { parts.push(value); total += value.byteLength; onProgress(total); }
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.byteLength; }
  return out.buffer;
}

export function anySignal(signals: (AbortSignal | undefined)[]): AbortSignal | undefined {
  const live = signals.filter((s): s is AbortSignal => !!s);
  if (live.length === 0) return undefined;
  if (live.length === 1) return live[0];
  if (typeof AbortController !== "function") return live[0];
  const ctrl = new AbortController();
  for (const s of live) {
    if (s.aborted) { ctrl.abort(s.reason); break; }
    s.addEventListener("abort", () => ctrl.abort(s.reason), { once: true });
  }
  return ctrl.signal;
}
