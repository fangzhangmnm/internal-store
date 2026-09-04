// StoreUI.busy 第三参数 key（0.11.4）：宿主据 key 决定画不画遮罩（后台推云/改名不该全屏一暗——WebXiaoHeiWu 审计 L1，2026-09-03 user「改库」）。
// created 2026-09-03 by Claude Fable 5.1
import { describe, it, eq, assert } from "./runner.mjs";
import { createListing } from "../src/listing.ts";
import { createReconcile } from "../src/reconcile.ts";
import { createPendingGone } from "../src/pending-gone.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockEncryption } from "../src/testing/mock-encryption.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createStore } from "../src/create-store.ts";

const bytes = (s) => new TextEncoder().encode(s);
function mkStore({ online = true, signedIn = true } = {}) {
  const keys = [];
  const store = createStore({ reconcilePolicy: "app-driven", encryption: createMockEncryption(), persistence: "none",
    appId: "test",
    provider: createMockProvider(),
    ui: { busy: (_l, fn, key) => { keys.push(key); return fn(); }, resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {} },
    validateAdopt: () => true,
    kv: memKv(), local: createMockLocal(),
    isOnline: () => online, signedIn: () => signedIn,
    skipMigration: true,
  });
  return { store, keys };
}

describe("StoreUI.busy · key 透传（0.11.4）", () => {
  it("推云 → key=sync.pushing；新建文件夹 → folder.creating；删空夹 → folder.deleting；改名 → file.renaming", async () => {
    const { store, keys } = mkStore();
    await store.file("A/a.txt", { isZip: false, mode: "new" }).save(bytes("x"), { tryPush: true });
    assert(keys.includes("sync.pushing"), "push 应带 key sync.pushing，实得 " + JSON.stringify(keys));
    await store.files.newFolder("B");
    assert(keys.includes("folder.creating"), "newFolder 应带 key folder.creating");
    await store.files.deleteFolder("B");
    assert(keys.includes("folder.deleting"), "deleteFolder 应带 key folder.deleting");
    await store.file("A/a.txt", { isZip: false, mode: "existing" }).tryMove("A/b.txt");
    assert(keys.includes("file.renaming"), "tryMove 应带 key file.renaming");
    assert(keys.every((k) => typeof k === "string"), "每次 busy 都带 key");
  });
});
