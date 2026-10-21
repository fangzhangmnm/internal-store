// F-54 store 级：createStore({ uploads: { resumable: true } }) 才给 provider.upload 递 session（token = 这份字节的 sha256）；
//   ≤ 4 MB 不递（简单上传没会话）；不开 = 不递。created 20261021 by Claude Fable 5.1
import { describe, it, assert, eq } from "./runner.mjs";
import { TEST_KINDS } from "./kinds.mjs";
import { createStore } from "../src/create-store.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { memKv } from "../src/works/cloud-sync.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";

const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} };
function mk(uploads) {
  const provider = createMockProvider();
  const seen = [];
  const orig = provider.upload.bind(provider);
  provider.upload = (path, bytes, opts) => { seen.push({ path, session: opts?.session ?? null }); return orig(path, bytes, opts); };
  const store = createStore({ docKinds: TEST_KINDS, reconcilePolicy: "app-driven", persistence: "none", appId: "test", provider, encryption: createMockEncryption(),
    ui: UI, validateAdopt: () => true, kv: memKv(), local: createMockLocal(), isOnline: () => true, signedIn: () => true, skipMigration: true, ...(uploads ? { uploads } : {}) });
  return { store, seen };
}
const big = () => new Uint8Array(5 * 1024 * 1024).fill(7);

describe("F-54 · store 把上传会话记忆面递给 provider", () => {
  it("开了 resumable：> 4 MB 的推带 session，token = 64 位 hex、同一份字节两次一样、字节变了就不一样", async () => {
    const { store, seen } = mk({ resumable: true });
    await store.file("a.txt", { mode: "new" }).save(big());
    assert(seen[0].session && /^[0-9a-f]{64}$/.test(seen[0].session.token), `token: ${seen[0].session?.token}`);
    const t1 = seen[0].session.token;
    await store.file("a.txt", { mode: "existing" }).save(big());
    eq(seen[1].session.token, t1, "同一份字节 → 同一个 token（续传认得）");
    const other = big(); other[123] = 9;
    await store.file("a.txt", { mode: "existing" }).save(other);
    assert(seen[2].session.token !== t1, "字节变了 → token 变（不会把两份字节拼进一条会话）");
    // 记忆面读写走 store 的 kv（provider 零感知）
    await seen[2].session.save({ uploadUrl: "u", total: 1, eTag: null, token: seen[2].session.token, createdAt: 0, expiresAt: null });
    eq((await seen[2].session.load())?.uploadUrl, "u");
    await seen[2].session.clear();
    eq(await seen[2].session.load(), null);
  });
  it("≤ 4 MB 不递 session；没开 resumable 永不递", async () => {
    const a = mk({ resumable: true });
    await a.store.file("s.txt", { mode: "new" }).save(new TextEncoder().encode("small"));
    eq(a.seen[0].session, null);
    const b = mk(undefined);
    await b.store.file("a.txt", { mode: "new" }).save(big());
    eq(b.seen[0].session, null, "默认关（库政策）");
  });
});
