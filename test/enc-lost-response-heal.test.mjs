// F-19（周账；安全模型 A3「库待修」）：加密稿推云的回执丢了、页面死掉、下次开页 pushAll 重推**本机那份**密文 →
//   412 → tryHeal 逐字节比云端。2.1.3 及以前 save() 给本机封一次、推云时 doPush 又封一次（两次随机 salt / IV）→
//   本机 ≠ 云端 → 比不出 → 面。现在推的就是落本机的那份 → 相等 → healed，不弹面。created 20261021 by Claude Fable 5.1
import { describe, it, assert, eq } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
// 可枚举的内存 kv：dirty.count / pushAll 靠 kv.keys() 找脏账（cloud-sync 的 memKv 没有 keys → 永远 0 条，不能用来测续推）
const keyedKv = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); }, remove: (k) => { m.delete(k); }, keys: () => [...m.keys()] }; };

const u8 = async (b) => new Uint8Array(b instanceof Blob ? await b.arrayBuffer() : b);
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

function mk() {
  const provider = createMockProvider();
  const enc = createMockEncryption();
  const local = createMockLocal();
  let sheets = 0;
  const ui = { busy: (_l, fn) => fn(), resolveConflict: async () => { sheets++; return { choice: "cancel" }; }, reportError: () => {} };
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", persistence: "none", appId: "test", provider, encryption: enc,
    ui, validateAdopt: () => true, kv: keyedKv(), local, isOnline: () => true, signedIn: () => true, skipMigration: true,
    crypt: { getPassword: () => "pw" }, pushRetry: { maxAttempts: 1 } });   // maxAttempts 1 = 在途不重试，模拟「回执丢了页面就死了」
  const f = () => store.file("doc.txt", { mode: "existing" });
  const cloudBytes = async () => { const it = provider._dump().find((i) => i.path === "doc.txt.zip" || i.name === "doc.txt.zip"); assert(it, "cloud has doc.txt.zip"); return u8(await provider.download(it.ref)); };
  return { store, provider, enc, local, f, cloudBytes, sheets: () => sheets };
}

describe("F-19 · 加密稿丢回执 → 本机密文重推 → 自愈（不弹面）", () => {
  it("save() 推云的字节 == 落本机的 at-rest 字节（逐位）", async () => {
    const c = mk();
    await c.store.file("doc.txt", { mode: "new" }).save(new TextEncoder().encode("v1"));
    eq((await c.f().encrypt()).status, "swapped");
    await c.f().save(new TextEncoder().encode("v2"));
    const loc = await u8(await c.local.get("doc.txt"));
    assert(await c.enc.looksEncryptedContainer(new Blob([loc])), "本机是容器");
    assert(same(loc, await c.cloudBytes()), "★本机密文 == 云端密文（以前是两次封包、两份不同密文）");
  });

  it("回执丢 + 页面死（不在途重试）→ 下次 pushAll 推本机那份 → healed，不弹面、不留 dirty", async () => {
    const c = mk();
    await c.store.file("doc.txt", { mode: "new" }).save(new TextEncoder().encode("v1"));
    eq((await c.f().encrypt()).status, "swapped");
    c.provider.injectFault({ op: "upload", kind: "lostResponse" });            // 写已落盘、回执丢
    const r = await c.f().save(new TextEncoder().encode("v2"));
    eq(r.pushed, false, "回执丢 → 这次 save 没推成（诚实）");
    eq(await c.store.files.dirty.count(), 1, "留 dirty");
    const before = c.sheets();
    const all = await c.store.files.dirty.pushAll();                            // 「下次开页」的续推：推本机那份密文
    eq(all.failed.length, 0, `★pushAll 不该失败：${JSON.stringify(all)}`);
    eq(all.pushed, 1, "自愈算推成");
    eq(c.sheets(), before, "★没弹冲突面");
    eq(await c.store.files.dirty.count(), 0, "dirty 清了");
    assert(same(await u8(await c.local.get("doc.txt")), await c.cloudBytes()), "本机 == 云端");
  });
});
