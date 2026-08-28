// A4 只读镜像（readOnlyFiles，ADR-0022 预排的 readOnlyMirror）—— files 写路径全拒、读/离线副本面照常、collections 不受影响。
import { describe, it, assert, eq } from "./runner.mjs";
import { memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createStore, ReadOnlyFilesError } from "../src/create-store.ts";

const bytes = (s) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 5));
const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {}, onReplayStatus: () => {} };

function memStaging() {
  const m = new Map();
  return { async get(k) { return m.get(k) ?? null; }, async put(k, b) { m.set(k, b); }, async del(k) { m.delete(k); }, async keys() { return [...m.keys()]; } };
}
function mk() {
  const provider = createMockProvider();
  const local = createMockLocal();
  const store = createStore({ persistence: "none",
    appId: "test", provider, local, kv: memKv(), staging: memStaging(), ui: UI, readOnlyFiles: true,
    validateAdopt: () => true, isOnline: () => true, signedIn: () => true, skipMigration: true,
  });
  return { store, provider, local };
}
const rejectsRO = async (p, label) => {
  let err = null;
  try { await p(); } catch (e) { err = e; }
  assert(err instanceof ReadOnlyFilesError, `${label} → ReadOnlyFilesError（实=${err && err.name}）`);
};

describe("readOnlyFiles · 只读镜像", () => {
  it("files 写路径全拒（save/tryMove/delete/reupload/encrypt/decrypt/建删夹/回收站类）", async () => {
    const { store } = mk();
    const f = store.file("a.mp3", { isZip: false, mode: "existing" });
    await rejectsRO(() => f.save(bytes("X")), "save");
    await rejectsRO(() => f.tryMove("b.mp3"), "tryMove");
    await rejectsRO(() => f.delete(), "delete");
    await rejectsRO(() => f.reupload(), "reupload");
    await rejectsRO(() => f.encrypt(), "encrypt");
    await rejectsRO(() => f.decrypt(), "decrypt");
    await rejectsRO(() => store.files.ensureFolder("F"), "ensureFolder");
    await rejectsRO(() => store.files.newFolder("F"), "newFolder");
    await rejectsRO(() => store.files.deleteFolder("F"), "deleteFolder");
    await rejectsRO(() => store.files.restoreTrash({ trashKey: "trash/x:a" }), "restoreTrash");
    await rejectsRO(() => store.files.emptyTrash({ scope: "both" }), "emptyTrash");
  });

  it("读/离线副本面照常：watchFolder + open + keepOffline/offload + openStream", async () => {
    const { store, provider, local } = mk();
    provider._seed("t.mp3", bytes("HELLO"));
    let snap = null; const un = store.files.watchFolder("", (s) => { snap = s; }); await tick(); await tick(); un();
    assert(snap && snap.items.some((i) => i.path === "t.mp3"), "列举照常");
    const f = store.file("t.mp3", { isZip: false, mode: "existing" });
    await f.keepOffline();
    assert(local._items.has("t.mp3"), "keepOffline 照常");
    const h = await f.openStream();
    eq(h.totalSize, 5, "openStream 照常（本地面）");
    h.close();
    await f.offload();                                    // clean shadow → 合法 offload
    assert(!local._items.has("t.mp3"), "offload 照常");
  });

  it("collections 不受影响（阅读位置类照写）", async () => {
    const { store } = mk();
    const c = store.collection("positions");
    await c.init();
    c.setItem("track1", { sec: 42 });
    eq(c.getItem("track1").sec, 42, "collection 写读照常");
  });
});
