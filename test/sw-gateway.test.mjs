// SW 网关（A2b spike）——node 可测的纯函数部分。整条 206/流式路径浏览器专用 → 真机验（spike 批）。
import { describe, it, assert, eq } from "./runner.mjs";
import { parseRange } from "../src/sw/gateway.ts";

describe("sw-gateway · parseRange", () => {
  it("bytes=0- → {0,null}；bytes=0-1 → {0,1}；bytes=500-999 → 精确", () => {
    eq(JSON.stringify(parseRange("bytes=0-", 1000)), JSON.stringify({ start: 0, end: null }));
    eq(JSON.stringify(parseRange("bytes=0-1", 1000)), JSON.stringify({ start: 0, end: 1 }));
    eq(JSON.stringify(parseRange("bytes=500-999", 1000)), JSON.stringify({ start: 500, end: 999 }));
  });
  it("越界钳到 size-1；无/怪头 → null（当 bytes=0- 处理）", () => {
    eq(JSON.stringify(parseRange("bytes=500-2000", 1000)), JSON.stringify({ start: 500, end: 999 }));
    eq(JSON.stringify(parseRange("bytes=9999-", 1000)), JSON.stringify({ start: 999, end: null }));
    eq(parseRange(null, 1000), null);
    eq(parseRange("bytes=1-0", 1000) && "parsed", "parsed", "倒置区间照 parse（媒体元素不发这种；上层 clamp 兜）");
    eq(parseRange("items=0-1", 1000), null);
  });
});
