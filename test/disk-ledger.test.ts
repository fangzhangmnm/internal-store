// disk-ledger（2.3.2）单元测试：发出 / 落盘 / 失败 / 库自己写 / 清，各种先后。created 2026-11-10 by Claude Opus 5.5（家族周账 F-238）
import { describe, it, eq } from "./runner.mjs";
import { createDiskLedger } from "../src/works/disk-ledger.ts";

describe("disk-ledger", () => {
  it("没写过：盘上 = 0，拿 0 去对 = 对得上", () => {
    const l = createDiskLedger();
    eq(l.disk("a"), 0); eq(l.settled("a", 0), true);
  });
  it("发出一次保存：在路上的时候谁都对不上；落盘之后只有它自己的号对得上", () => {
    const l = createDiskLedger();
    const g = l.issue("a");
    eq(l.settled("a", 0), false, "在路上 → 拿旧号对不上");
    eq(l.settled("a", g), false, "在路上 → 拿它自己的号也对不上（还没落盘）");
    l.landed("a", g);
    eq(l.disk("a"), g); eq(l.settled("a", g), true); eq(l.settled("a", 0), false);
  });
  it("两次叠着：第一次落了、第二次还在路上 → 拿第一次的号对不上", () => {
    const l = createDiskLedger();
    const g1 = l.issue("a"), g2 = l.issue("a");
    l.landed("a", g1);
    eq(l.settled("a", g1), false, "后一次还在路上");
    l.landed("a", g2);
    eq(l.settled("a", g1), false, "盘上已经是后一次的了");
    eq(l.settled("a", g2), true);
  });
  it("没落成：在路上的减掉、盘上不变 → 之前的号照样对得上（不会永远卡在待传）", () => {
    const l = createDiskLedger();
    const g1 = l.issue("a"); l.landed("a", g1);
    const g2 = l.issue("a");
    eq(l.settled("a", g1), false);
    l.failed("a", g2);
    eq(l.disk("a"), g1); eq(l.settled("a", g1), true);
  });
  it("库自己写：盘上换成一个新号；之前拿着旧号的对不上", () => {
    const l = createDiskLedger();
    const g1 = l.issue("a"); l.landed("a", g1);
    const w = l.wrote("a");
    eq(l.disk("a"), w); eq(l.settled("a", g1), false); eq(l.settled("a", w), true);
    const g2 = l.issue("a");
    eq(l.settled("a", w), false, "库写完之后又发出了保存");
    l.landed("a", g2); eq(l.settled("a", g2), true);
  });
  it("号跨名字不重复；名字之间互不影响", () => {
    const l = createDiskLedger();
    const a = l.issue("a"), b = l.issue("b"), w = l.wrote("c");
    eq(new Set([a, b, w]).size, 3);
    l.landed("a", a);
    eq(l.settled("a", a), true, "b 在路上不影响 a");
    eq(l.settled("b", 0), false);
  });
  it("清掉：盘上回到 0；在路上的保存不丢账，落盘时照样记", () => {
    const l = createDiskLedger();
    const g1 = l.issue("a"); l.landed("a", g1);
    const g2 = l.issue("a");
    l.forget("a");
    eq(l.disk("a"), 0);
    eq(l.settled("a", 0), false, "还有一次在路上");
    l.landed("a", g2);
    eq(l.disk("a"), g2); eq(l.settled("a", g2), true);
  });
});
