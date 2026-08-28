// getEncryptedBlob：at-rest 密文原样读（v415 E1；encryption 立户后改用 mock 端口——
// 本测锁的是「原样搬运不解壳」的 store 契约；「明文绝不出现在容器里」的真加密契约住 @internal/encryption 仓）。
import { describe, it, assert, eq } from "./runner.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { memKv } from "../src/cloud-sync.ts";

const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} };
const mk = (local = createMockLocal()) => ({ local, store: createStore({ reconcilePolicy: "app-driven", persistence: "none",
  appId: "test", provider: createMockProvider(), encryption: createMockEncryption(),
  ui: UI, validateAdopt: () => true, kv: memKv(), local,
  isOnline: () => false, signedIn: () => false, skipMigration: true }) });

describe("getEncryptedBlob · at-rest 密文原样读（v415，E1）", () => {
  it("加密件 → 返密文原样（不解壳、逐位一致）；明文件 → null", async () => {
    const enc = createMockEncryption();
    const { local, store } = mk();
    await store.file("plain", { isZip: true, mode: "new" }).save(new TextEncoder().encode("PLAIN"), { tryPush: false });
    eq(await store.file("plain", { isZip: true, mode: "existing" }).getEncryptedBlob(), null,
       "明文件不得被当成密文发出去");
    const container = await enc.packContainer({ dataBytes: new TextEncoder().encode("SECRET"), fileName: "enc", password: "pw" });
    const containerBytes = new Uint8Array(await container.arrayBuffer());
    await local.save("enc", containerBytes);
    const got = await store.file("enc", { isZip: true, mode: "existing" }).getEncryptedBlob();
    assert(got != null, "加密件必须给得出密文字节");
    const bytes = new Uint8Array(await got.arrayBuffer());
    eq(bytes.length, containerBytes.length, "at-rest 原样（长度）");
    assert(bytes.every((b, i) => b === containerBytes[i]), "★at-rest 原样搬运，没有被解壳/改写");
    assert(await enc.looksEncryptedContainer(new Blob([bytes])), "拿到的仍是容器（探测一致）");
  });
  it("无本地副本（纯云端未缓存）→ null（拿不到 at-rest 就诚实说没有）", async () => {
    const { store } = mk();
    eq(await store.file("nope", { isZip: true, mode: "existing" }).getEncryptedBlob(), null);
  });
});
