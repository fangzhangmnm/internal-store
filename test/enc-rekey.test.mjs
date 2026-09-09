// rekey（0.12.0）：换密码 = 密文→密文，**明文永不上云**。
// created 2026-09-09 by Claude Fable 5.1（user 2026-09-09「保留换密码，加 api」；起因 = 加密合规审计：宿主换密码走 decrypt→encrypt，
//   中间态把明文 push 上 OneDrive，版本历史永久留明文）。mock 容器 = [MOCKENC1][pwLen][pw][payload]，形状替身非真加密，
//   但足以锁「上云的每一份字节都是容器、旧密码打不开、新密码打得开」这三条 store 契约。
import { describe, it, assert, eq } from "./runner.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { memKv } from "../src/cloud-sync.ts";

const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} };
const text = (b) => new TextDecoder().decode(b instanceof Uint8Array ? b : new Uint8Array(b));

/** 建一个在线、已登录、带 seam 密码的 store；spy 住 provider 的每一次上传字节。 */
function mk({ online = true, password = "old" } = {}) {
  const provider = createMockProvider();
  const uploaded = [];
  for (const m of Object.keys(provider)) {
    if (typeof provider[m] !== "function") continue;
    if (!/upload|put|push|write|create/i.test(m)) continue;
    const orig = provider[m];
    provider[m] = async (...a) => { for (const x of a) if (x instanceof Uint8Array || x instanceof Blob) uploaded.push(x instanceof Blob ? new Uint8Array(await x.arrayBuffer()) : x); return orig.apply(provider, a); };
  }
  const enc = createMockEncryption();
  const local = createMockLocal();
  const seam = { pw: password };
  const store = createStore({ reconcilePolicy: "app-driven", persistence: "none", appId: "test", provider, encryption: enc,
    ui: UI, validateAdopt: () => true, kv: memKv(), local, isOnline: () => online, signedIn: () => true, skipMigration: true,
    crypt: { ext: "txt", getPassword: () => seam.pw } });
  const f = () => store.file("doc", { isZip: true, mode: "existing" });
  return { store, provider, enc, local, seam, uploaded, f };
}
async function cloudBytes(provider, name) {
  const item = provider._dump().find((i) => i.path === name || i.name === name);
  assert(item, `cloud has ${name}`);
  return new Uint8Array(await (await provider.download(item.ref)).arrayBuffer());
}
async function seedEncrypted(ctx) {
  await ctx.store.file("doc", { isZip: true, mode: "new" }).save(new TextEncoder().encode("SECRET"));   // 明文落地 + 推云（tracked）
  eq((await ctx.f().encrypt()).status, "swapped", "先用旧密码加密，作为换密码的起点");
  assert(await ctx.enc.looksEncryptedContainer(await cloudBytes(ctx.provider, "doc.zip")), "起点：云端已是容器");
}

describe("rekey · 换密码不经明文（0.12.0）", () => {
  it("★旧密码→新密码：本地与云端都换成新容器；新密码打得开、旧密码打不开；上云的每一份字节都是容器", async () => {
    const ctx = mk();
    await seedEncrypted(ctx);
    const before = ctx.uploaded.length;
    eq((await ctx.f().rekey({ newPassword: "new" })).status, "swapped");
    // 本地
    const loc = await ctx.local.get("doc");
    const locBytes = loc instanceof Blob ? new Uint8Array(await loc.arrayBuffer()) : loc;
    assert(await ctx.enc.looksEncryptedContainer(locBytes), "本地仍是容器");
    eq(text(await (await ctx.enc.unpackContainer(locBytes, "new")).dataBlob.arrayBuffer()), "SECRET", "新密码解得开本地");
    let threw = false; try { await ctx.enc.unpackContainer(locBytes, "old"); } catch { threw = true; } assert(threw, "旧密码打不开本地");
    // 云端
    const cb = await cloudBytes(ctx.provider, "doc.zip");
    assert(await ctx.enc.looksEncryptedContainer(cb), "云端是容器");
    eq(text(await (await ctx.enc.unpackContainer(cb, "new")).dataBlob.arrayBuffer()), "SECRET", "云端是新密码的容器");
    // 上云字节审计：rekey 这一趟上传过（不许 spy 空转），且没有任何一份是明文
    assert(ctx.uploaded.length > before, "rekey 确实推了云（spy 没空转）");
    for (const u of ctx.uploaded.slice(before)) assert(await ctx.enc.looksEncryptedContainer(u), "★上云的字节必须是容器，绝不是明文");
    // seam 只负责旧密码：换完 seam 还是 old，读会锁（宿主换完再改自己的内存密码——库不替它改）
    eq(await ctx.f().open(), null, "seam 仍给旧密码 → 透明读锁定（诚实 null，不是明文）");
    ctx.seam.pw = "new";
    eq(text(await (await ctx.f().open()).arrayBuffer()), "SECRET", "seam 换成新密码后透明读回明文");
  });
  it("seam 无密码 → locked，本地云端一个字节不动", async () => {
    const ctx = mk();
    await seedEncrypted(ctx);
    const before = await cloudBytes(ctx.provider, "doc.zip");
    const n = ctx.uploaded.length;
    ctx.seam.pw = null;
    eq((await ctx.f().rekey({ newPassword: "new" })).status, "locked");
    eq(ctx.uploaded.length, n, "没有上传");
    const after = await cloudBytes(ctx.provider, "doc.zip");
    assert(after.length === before.length && after.every((b, i) => b === before[i]), "云端原样");
  });
  it("seam 给错的旧密码 → locked（错密码前置出局，任何持久改动前）", async () => {
    const ctx = mk();
    await seedEncrypted(ctx);
    ctx.seam.pw = "wrong";
    const n = ctx.uploaded.length;
    eq((await ctx.f().rekey({ newPassword: "new" })).status, "locked");
    eq(ctx.uploaded.length, n, "没有上传");
    const loc = await ctx.local.get("doc");
    const locBytes = loc instanceof Blob ? new Uint8Array(await loc.arrayBuffer()) : loc;
    eq(text(await (await ctx.enc.unpackContainer(locBytes, "old")).dataBlob.arrayBuffer()), "SECRET", "本地仍是旧密码容器");
  });
  it("已同步过云端 + 离线 → offline（两端要一起换，绝不只换一端）", async () => {
    // 同一实例先在线建好 tracked 状态（eTag 记录在这个 store 里），再把在线旗翻成假
    let online = true;
    const provider = createMockProvider();
    const enc = createMockEncryption();
    const local = createMockLocal();
    const seam = { pw: "old" };
    const store = createStore({ reconcilePolicy: "app-driven", persistence: "none", appId: "test", provider, encryption: enc,
      ui: UI, validateAdopt: () => true, kv: memKv(), local, isOnline: () => online, signedIn: () => true, skipMigration: true,
      crypt: { ext: "txt", getPassword: () => seam.pw } });
    await store.file("doc", { isZip: true, mode: "new" }).save(new TextEncoder().encode("SECRET"));
    eq((await store.file("doc", { isZip: true, mode: "existing" }).encrypt()).status, "swapped");
    online = false;
    eq((await store.file("doc", { isZip: true, mode: "existing" }).rekey({ newPassword: "new" })).status, "offline");
    const loc = await local.get("doc");
    const locBytes = loc instanceof Blob ? new Uint8Array(await loc.arrayBuffer()) : loc;
    eq(text(await (await enc.unpackContainer(locBytes, "old")).dataBlob.arrayBuffer()), "SECRET", "离线拒绝后本地仍是旧容器");
  });
  it("明文件 → not-encrypted；无本地 → no-local；newPassword 空 → 抛（调用方 bug）", async () => {
    const ctx = mk();
    await ctx.store.file("doc", { isZip: true, mode: "new" }).save(new TextEncoder().encode("PLAIN"));
    eq((await ctx.f().rekey({ newPassword: "new" })).status, "not-encrypted");
    eq((await ctx.store.file("nope", { isZip: true, mode: "existing" }).rekey({ newPassword: "new" })).status, "no-local");
    let threw = false; try { await ctx.f().rekey({ newPassword: "" }); } catch { threw = true; } assert(threw, "空新密码必须响亮抛");
  });
  it("从未上云（untracked）的加密件 → 只换本地，swapped，不推云", async () => {
    const ctx = mk({ online: false });
    const container = await ctx.enc.packContainer({ dataBytes: new TextEncoder().encode("SECRET"), fileName: "doc", password: "old" });
    await ctx.local.save("doc", new Uint8Array(await container.arrayBuffer()));
    eq((await ctx.f().rekey({ newPassword: "new" })).status, "swapped");
    eq(ctx.uploaded.length, 0, "untracked 不推云");
    const loc = await ctx.local.get("doc");
    const locBytes = loc instanceof Blob ? new Uint8Array(await loc.arrayBuffer()) : loc;
    eq(text(await (await ctx.enc.unpackContainer(locBytes, "new")).dataBlob.arrayBuffer()), "SECRET");
  });
});
