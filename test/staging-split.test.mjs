// 2.2.0（道 6 F-58 §8 第 1 件，user 2026-10-21「同意」）：流式暂存区住自己的库 `${appId}.${databaseId}.staging`；主库旧 staging/ 键由 v001 迁移整批删；
//   顺带：MSAL authority 默认 /consumers、/common 拒（家规 #7，周账道 1 审计查出）。created 20261021 by Claude Fable 5.1
import { describe, it, assert, eq } from "./runner.mjs";
import { storeNamespace, runMigrations, MIGRATIONS } from "../src/works/migration.ts";
import { configureOneDriveAuth, authAuthority } from "../src/base/providers/auth.ts";

const memMkv = () => { const m = new Map(); return { get: (k) => (m.has(k) ? m.get(k) : null), set: (k, v) => { m.set(k, String(v)); }, remove: (k) => { m.delete(k); }, keys: () => [...m.keys()] }; };

describe("2.2.0 · staging 分库", () => {
  it("库名 = 主库名 + .staging（钉字符串）；databaseId 以 .staging 结尾 → 拒", () => {
    const ns = storeNamespace("kudsrocket", "defaultStore");
    eq(ns.dbName, "kudsrocket.defaultStore");
    eq(ns.stagingDbName, "kudsrocket.defaultStore.staging", "★新库名");
    assert(ns.stagingDbName.startsWith("kudsrocket."), "仍在 appId. 前缀内 → wipeAppNamespace 自动覆盖");
    let err = null; try { storeNamespace("x", "foo.staging"); } catch (e) { err = e; }
    assert(err && /\.staging/.test(err.message), "撞库的 databaseId 响亮拒");
  });
  it("v001 迁移：主库里的 staging/ 键整批删、别的键不碰、盖戳；没有 blobs 面（测试 / 无 IDB）只盖戳", async () => {
    const keys = new Set(["files/a.ora", "staging/meta:x", "staging/chunk:x:0", "trash/…", "collections/c"]);
    const blobs = { keys: async () => [...keys], del: async (k) => { keys.delete(k); } };
    const kv = memMkv(); const ns = storeNamespace("wp", "defaultStore");
    eq(MIGRATIONS[0].version, "v001-20261021");
    await runMigrations({ kv, ns, blobs }, MIGRATIONS);
    eq([...keys].sort().join(","), "collections/c,files/a.ora,trash/…", "★只删 staging/ 前缀");
    eq(kv.get(ns.schemaKey), "v001-20261021", "盖戳");
    const kv2 = memMkv();
    await runMigrations({ kv: kv2, ns }, MIGRATIONS);
    eq(kv2.get(ns.schemaKey), "v001-20261021", "没 blobs 面也盖戳（IDB 那半跳过）");
    await runMigrations({ kv, ns, blobs }, MIGRATIONS);   // 幂等
    eq([...keys].length, 3);
  });
});

describe("2.2.0 · MSAL authority（家规 #7）", () => {
  it("默认 /consumers；传 /consumers 可以；传 /common 或别的租户 → 拒", () => {
    eq(authAuthority(), "https://login.microsoftonline.com/consumers", "★默认不再是 /common");
    configureOneDriveAuth({ clientId: "c", authority: "https://login.microsoftonline.com/consumers" });
    eq(authAuthority(), "https://login.microsoftonline.com/consumers");
    for (const bad of ["https://login.microsoftonline.com/common", "https://login.microsoftonline.com/organizations", "https://login.microsoftonline.com/some-tenant-id"]) {
      let err = null; try { configureOneDriveAuth({ authority: bad }); } catch (e) { err = e; }
      assert(err && /consumers/.test(err.message), `拒 ${bad}`);
      eq(authAuthority(), "https://login.microsoftonline.com/consumers", "拒了就不改");
    }
  });
});
