// disk-ledger（2.3.2）单元测试：发出 / 落盘 / 失败 / 库自己写 / 清，各种先后。created 2026-11-10 by Claude Opus 5.5（家族周账 F-238）
import { describe, it, eq, assert } from "./runner.mjs";
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
  it("盘上这一份没了：记成负的新号，不回到 0；在路上的保存不丢账，落盘时照样记", () => {
    const l = createDiskLedger();
    const g1 = l.issue("a"); l.landed("a", g1);
    const g2 = l.issue("a");
    l.forget("a");
    assert(l.disk("a") < 0, "没了 = 负号");
    eq(l.settled("a", 0), false, "还有一次在路上");
    l.landed("a", g2);
    eq(l.disk("a"), g2); eq(l.settled("a", g2), true);
  });
  it("没了之后不和「这一页还没写过」撞号：刷新后读过盘的人手里是 0，中间落过保存又被清掉 → 对不上（审稿补）", () => {
    const l = createDiskLedger();
    eq(l.settled("a", 0), true, "刚开页：0 对得上");
    const g = l.issue("a"); l.landed("a", g);          // 手里拿着 0 的人还没回来，盘上已经换了
    l.forget("a");
    eq(l.settled("a", 0), false, "不许回到 0");
    l.forget("a");
    eq(l.settled("a", 0), false);
  });
  it("pendingAfter：有保存在路上 / 盘上换成别的一份 = 还算待传；盘上没了 = 不算（没有字节可传）（审稿补）", () => {
    const l = createDiskLedger();
    const g1 = l.issue("a"); l.landed("a", g1);
    eq(l.pendingAfter("a", g1), false, "盘上就是推上去的那份");
    const g2 = l.issue("a");
    eq(l.pendingAfter("a", g1), true, "有保存在路上");
    l.landed("a", g2);
    eq(l.pendingAfter("a", g1), true, "盘上是后一份");
    eq(l.pendingAfter("a", g2), false);
    l.forget("a");
    eq(l.pendingAfter("a", g2), false, "盘上没了：不算待传");
    eq(l.settled("a", g2), false, "但也不许拿它认领成已同步");
    const g3 = l.issue("a");
    eq(l.pendingAfter("a", g2), true, "删的那一下还有保存在路上：算");
    l.landed("a", g3);
    eq(l.pendingAfter("a", g2), true, "它落盘之后盘上是别的一份：算");
    const w = l.wrote("a");
    eq(l.pendingAfter("a", w), false); eq(l.pendingAfter("b", 0), false, "没写过的名字");
  });
});
