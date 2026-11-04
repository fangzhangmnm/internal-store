// listing-cloud-sealed —— Item.cloudSealed：云端那份是加密容器（2.2.6；gallery 0.8.11 加密态的第三路；user 2026-11-04「列表带加密可以」）。
// created 2026-11-04 by Claude Fable 5.1
// 判定只用列举已经拿到的名字：cloud-sync 给的 path（云端真实名）≠ name（toName 后的身份）= 加密容器。零多余请求；不碰 syncState。
import { test, eq } from "./runner.mjs";
import { createListing } from "../src/works/listing.ts";

const CTX_ON = { signedIn: true, online: true };
function mk(files) {
  const cloud = {
    async listFolder() { return { files, folders: [], complete: true }; },
    async listAll() { return { files, folders: [], complete: true }; },
    getETag: () => null,
  };
  const local = { async appKeys() { return []; } };
  const head = { seenBase: () => null, isDirtyAnywhere: () => false };
  return createListing({ cloud, local, head });
}

test("[cloud-sealed] 云端名带容器后缀（path ≠ name）→ cloudSealed:true；明文 → 没有这个键；老 mock 没给 path → 没有这个键；badge 不受影响", async () => {
  const listing = mk([
    { path: "a.dat.zip", name: "a.dat", eTag: "e1", size: 9 },   // 加密容器：toName 去了尾 .zip
    { path: "b.dat", name: "b.dat", eTag: "e2", size: 3 },       // 明文
    { name: "c.dat", eTag: "e3", size: 1 },                      // 老 mock / stale 视图：没 path
  ]);
  const snap = await listing.listFolder("", CTX_ON);
  const by = Object.fromEntries(snap.items.map((i) => [i.identifier, i]));
  eq(by["a.dat"].cloudSealed, true, "容器 → true");
  eq("cloudSealed" in by["b.dat"], false, "明文不写这个键");
  eq("cloudSealed" in by["c.dat"], false, "不知道就不说");
  eq(by["a.dat"].syncState, "cloud-only", "不碰 badge");
  eq(by["b.dat"].syncState, "cloud-only");
});
