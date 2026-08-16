// dir-index-cache（A3，2026-08-15 user 批）—— 冷首帧目录索引缓存（非 SSoT）+ 修「一次订阅打两遍 Graph」双拉。
// 验：
//   · 双拉修复：一次 watchFolder 订阅 → provider.list 恰好 1 次（reconcile 与 listing 共享现场帧）。
//   · 落底：完整云帧 → dir-index-cache 分区写 {v:1, files, folders}；partial 不落底。
//   · 冷首帧：新 store 实例（同一本地）→ 首帧含 stale cloud-only 缺项、stale:true、complete:false。
//   · badge 不被 stale 污染：本地有副本的项照旧塌本地视角（绝不因快照旧 eTag 闪 newer-on-cloud）、不重复。
//   · 登出不掺快照（别把云端名单给未登录视角）。
//   · 红线：快照绝不喂 gone 判定——云列举失败时，快照里「没有」的本地 clean 文件分毫不动。
//   · 写后重画（notifyFolderOf 本地帧）仍含 stale cloud-only 项（不闪没）。
import { describe, it, assert, eq } from "./runner.mjs";
import { createListing } from "../src/listing.ts";
import { memKv } from "../src/cloud-sync.ts";
import { createMockProvider } from "../src/testing/mock-provider.ts";
import { createMockLocal } from "../src/testing/mock-local.ts";
import { createStore } from "../src/create-store.ts";

const bytes = (s) => new TextEncoder().encode(s);
const tick = () => new Promise((r) => setTimeout(r, 5));
const UI = { busy: (_l, fn) => fn(), resolveConflict: async () => ({ choice: "cancel" }), reportError: () => {}, onReplayStatus: () => {} };

function mkStore({ provider = createMockProvider(), local = createMockLocal(), kv = memKv(), signedIn = () => true, online = () => true } = {}) {
  const store = createStore({
    appId: "test", provider, local, kv, ui: UI,
    validateAdopt: () => true, isOnline: online, signedIn, skipMigration: true,
  });
  return { store, provider, local, kv };
}

// 订阅一夹并攒帧；返回 frames 数组（unsubscribe 由 caller 收尾）。
function watchFrames(store, folder) {
  const frames = [];
  const un = store.files.watchFolder(folder, (s) => frames.push(s));
  return { frames, un };
}

describe("dir-index-cache · 双拉修复", () => {
  it("一次订阅 → provider.list 恰好 1 次（reconcile+listing 共享现场帧）", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("A"));
    let listCalls = 0;
    const origList = provider.list.bind(provider);
    provider.list = (f) => { listCalls++; return origList(f); };
    const { store } = mkStore({ provider });
    const { frames, un } = watchFrames(store, "");
    await tick(); await tick(); un();
    assert(frames.length >= 2, `两帧到齐（实=${frames.length}）`);
    eq(listCalls, 1, "★双拉已修：现场云帧只拉一遍");
    const cloudItem = frames.at(-1).items.find((i) => i.path === "a.mp3");
    assert(cloudItem && cloudItem.syncState === "cloud-only", "云端帧内容不受共享影响");
  });
});

describe("dir-index-cache · 快照落底 + 冷首帧", () => {
  it("完整云帧 → 写入 dir-index-cache 分区（v1 schema：files 带 name/eTag/size）", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const { store, local } = mkStore({ provider });
    const { un } = watchFrames(store, "");
    await tick(); await tick(); un();
    const raw = local._dirIndex.get("");
    assert(raw, "根夹快照已落底");
    const p = JSON.parse(raw);
    eq(p.v, 1);
    assert(Array.isArray(p.files) && p.files.some((f) => f.name === "a.mp3" && typeof f.eTag === "string" && typeof f.size === "number"), "files 条目形状");
    assert(Array.isArray(p.folders), "folders 数组");
  });

  it("冷首帧：新 store（同一本地、云端帧未到）→ 首帧含 stale cloud-only 缺项", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const local = createMockLocal();
    const kv = memKv();
    { const { store } = mkStore({ provider, local, kv }); const { un } = watchFrames(store, ""); await tick(); await tick(); un(); }   // 第一世：跑出快照
    // 第二世：provider.list 挂死（模拟冷启动云端帧未到），同一 local
    const p2 = createMockProvider();
    p2.list = () => new Promise(() => {});
    const { store: s2 } = mkStore({ provider: p2, local, kv });
    const { frames, un } = watchFrames(s2, "");
    await tick(); un();
    assert(frames.length >= 1, "首帧已到（不等云）");
    const f0 = frames[0];
    eq(f0.stale, true, "★首帧标 stale");
    eq(f0.complete, false, "stale 帧不权威");
    const it0 = f0.items.find((i) => i.path === "a.mp3");
    assert(it0 && it0.syncState === "cloud-only", `★冷首帧即显云端缺项（实=${it0 && it0.syncState}）`);
    eq(it0.size, 3, "size 从快照带出");
  });

  it("partial 云帧（complete:false）不覆盖快照", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const local = createMockLocal();
    const kv = memKv();
    { const { store } = mkStore({ provider, local, kv }); const { un } = watchFrames(store, ""); await tick(); await tick(); un(); }
    const before = local._dirIndex.get("");
    const p2 = createMockProvider();   // 空 provider + list 抛错 → live=null → 不写
    p2.list = async () => { throw new Error("网抖"); };
    const { store: s2 } = mkStore({ provider: p2, local, kv });
    const { un } = watchFrames(s2, "");
    await tick(); await tick(); un();
    eq(local._dirIndex.get(""), before, "★列举失败不落底（旧快照原样）");
  });
});

describe("dir-index-cache · badge/登出纪律", () => {
  it("本地有副本的项：badge 塌本地视角，绝不被快照旧 eTag 拉成 newer-on-cloud、不重复", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const local = createMockLocal();
    const kv = memKv();
    {   // 第一世：open 拉到本地（everSynced）+ 快照落底
      const { store } = mkStore({ provider, local, kv });
      await store.file("a.mp3", { isZip: false, mode: "existing" }).open();
      const { un } = watchFrames(store, ""); await tick(); await tick(); un();
    }
    // 云端悄悄变版（快照里的 eTag 已旧）；第二世 provider 挂死 → 只有 stale 首帧
    await provider.upload("a.mp3", bytes("BBBB"));
    const p2 = createMockProvider();
    p2.list = () => new Promise(() => {});
    const { store: s2 } = mkStore({ provider: p2, local, kv });
    const { frames, un } = watchFrames(s2, "");
    await tick(); un();
    const hits = frames[0].items.filter((i) => i.path === "a.mp3");
    eq(hits.length, 1, "不重复");
    assert(hits[0].syncState !== "newer-on-cloud" && hits[0].syncState !== "synced", `★本地项塌本地视角（实=${hits[0].syncState}）`);
  });

  it("登出（signedIn:false）→ 首帧不掺快照（不给未登录视角看云端名单）", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const local = createMockLocal();
    const kv = memKv();
    { const { store } = mkStore({ provider, local, kv }); const { un } = watchFrames(store, ""); await tick(); await tick(); un(); }
    const { store: s2 } = mkStore({ provider, local, kv, signedIn: () => false, online: () => false });
    const { frames, un } = watchFrames(s2, "");
    await tick(); un();
    assert(frames.length >= 1);
    assert(!frames[0].stale, "无 stale 标");
    assert(!frames[0].items.some((i) => i.path === "a.mp3"), "★登出首帧无云端项");
  });

  it("红线：云列举失败时，快照绝不参与 gone 判定（本地 clean synced 文件分毫不动）", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const local = createMockLocal();
    const kv = memKv();
    {   // 第一世：a.mp3 拉到本地（everSynced+clean）+ 快照落底
      const { store } = mkStore({ provider, local, kv });
      await store.file("a.mp3", { isZip: false, mode: "existing" }).open();
      const { un } = watchFrames(store, ""); await tick(); await tick(); un();
    }
    // 第二世：云列举永远失败（快照在、且快照里其实有 a.mp3——就算快照被篡改成没有，也不许据快照判 gone）
    local._dirIndex.set("", JSON.stringify({ v: 1, folder: "", savedAt: 0, files: [], folders: [] }));   // 对抗：缓存谎称云端空
    const p2 = createMockProvider();
    p2.list = async () => { throw new Error("云不可达"); };
    const { store: s2, local: l2 } = { store: mkStore({ provider: p2, local, kv }).store, local };
    const { un } = watchFrames(s2, "");
    await tick(); await tick(); un();
    assert(l2._items.has("a.mp3"), "★本地副本原样（快照谎报空也不动）");
    eq(l2._trash.size, 0, "★没有任何 trash 动作");
  });

  it("写后重画：本地保存触发的帧仍含 stale cloud-only 项（不闪没）", async () => {
    const provider = createMockProvider();
    provider._seed("a.mp3", bytes("AAA"));
    const local = createMockLocal();
    const kv = memKv();
    { const { store } = mkStore({ provider, local, kv }); const { un } = watchFrames(store, ""); await tick(); await tick(); un(); }
    const p2 = createMockProvider();
    p2.list = () => new Promise(() => {});
    const { store: s2 } = mkStore({ provider: p2, local, kv });
    const { frames, un } = watchFrames(s2, "");
    await tick();
    await s2.file("b.txt", { isZip: false, mode: "new" }).save(bytes("B"), { tryPush: false });   // → notifyFolderOf("") 重画
    await tick(); un();
    const last = frames.at(-1);
    assert(last.items.some((i) => i.path === "b.txt"), "新文件在");
    assert(last.items.some((i) => i.path === "a.mp3" && i.syncState === "cloud-only"), "★stale 云端项没闪没");
  });
});

describe("dir-index-cache · listing 单元级 scope 守卫", () => {
  it("staleCloud 追加尊重直属 scope：别夹/深层项进不来", async () => {
    const listing = createListing({
      cloud: { async listFolder() { return { files: [], folders: [], complete: true }; }, async listAll() { return { files: [], folders: [], complete: true }; }, getETag: () => null },
      local: { async appKeys() { return []; } },
      head: { seenBase: () => null, isDirty: () => false },
    });
    const snap = await listing.listFolder("A", { signedIn: false, online: false }, {
      staleCloud: { files: [{ name: "A/ok.mp3" }, { name: "B/evil.mp3" }, { name: "A/deep/x.mp3" }, { name: "root.mp3" }], folders: [] },
    });
    eq(snap.items.length, 1, "只 A/ok.mp3 进来");
    eq(snap.items[0].path, "A/ok.mp3");
    eq(snap.stale, true);
  });
});
