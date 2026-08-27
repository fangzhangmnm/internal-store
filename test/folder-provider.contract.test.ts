// folder provider 契约测试（2026-08-25 拍板 §2/§3/§4；「folder 就是另一朵云」）。
// created 2026-08-26 by Claude Fable 5 (claude-fable-5)
// fake FSA 刻意**大小写敏感**（Linux 口径）且**无 native move**——逼出 provider 的不敏感解析层与
//   copy-先-验-后-删源退路；native move / 真 mtime 行为归真机矩阵（provider 头注释）。
import { test, eq, assert } from "./runner.mjs";
import { createFolderProvider, type FolderDirHandle, type FolderFileHandle, type FolderFile } from "../src/providers/folder.ts";
import { createCloudSync, memKv } from "../src/cloud-sync.ts";

// ── 内存 fake FSA ───────────────────────────────────────────────────────────────
type FileNode = { kind: "file"; bytes: Uint8Array; mtime: number };
type DirNode = { kind: "dir"; children: Map<string, FileNode | DirNode> };
const notFound = (m: string): Error => Object.assign(new Error(m), { name: "NotFoundError" });

function mkFs() {
  const clock = { t: 1000 };
  function fileHandle(dir: DirNode, name: string): FolderFileHandle {
    return {
      kind: "file", name,
      async getFile(): Promise<FolderFile> {
        const n = dir.children.get(name);
        if (!n || n.kind !== "file") throw notFound(name);
        const b = new Blob([n.bytes as unknown as BlobPart]);
        Object.defineProperty(b, "lastModified", { value: n.mtime });   // mtime 快照于 getFile 时刻（close 前读=旧值）
        return b as FolderFile;
      },
      async createWritable() {
        const parts: Uint8Array[] = [];
        return {
          async write(data: Blob | Uint8Array) { parts.push(data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data); },
          async close() {                                              // ★ mtime 在 close 时刻才定（契约 nuance 本尊）
            const total = parts.reduce((s, p) => s + p.length, 0);
            const buf = new Uint8Array(total); let o = 0;
            for (const p of parts) { buf.set(p, o); o += p.length; }
            dir.children.set(name, { kind: "file", bytes: buf, mtime: ++clock.t });
          },
        };
      },
      // 刻意无 move → provider 走 copy-验-删源退路
    };
  }
  function dirHandle(node: DirNode, name: string): FolderDirHandle {
    return {
      kind: "directory", name,
      async getFileHandle(n: string, opts?: { create?: boolean }) {
        const c = node.children.get(n);
        if (c?.kind === "file") return fileHandle(node, n);
        if (c) throw Object.assign(new Error(n), { name: "TypeMismatchError" });
        if (!opts?.create) throw notFound(n);
        node.children.set(n, { kind: "file", bytes: new Uint8Array(0), mtime: ++clock.t });
        return fileHandle(node, n);
      },
      async getDirectoryHandle(n: string, opts?: { create?: boolean }) {
        const c = node.children.get(n);
        if (c?.kind === "dir") return dirHandle(c, n);
        if (c) throw Object.assign(new Error(n), { name: "TypeMismatchError" });
        if (!opts?.create) throw notFound(n);
        const d: DirNode = { kind: "dir", children: new Map() };
        node.children.set(n, d);
        return dirHandle(d, n);
      },
      async removeEntry(n: string) { if (!node.children.delete(n)) throw notFound(n); },
      async *values() {
        for (const [n, c] of node.children) yield c.kind === "file" ? fileHandle(node, n) : dirHandle(c, n);
      },
    };
  }
  const rootNode: DirNode = { kind: "dir", children: new Map() };
  return { root: dirHandle(rootNode, ""), clock };
}
const enc = (s: string): Uint8Array => new TextEncoder().encode(s);
const txt = async (b: Blob): Promise<string> => new TextDecoder().decode(new Uint8Array(await b.arrayBuffer()));
const statusOf = async (p: Promise<unknown>): Promise<number | string> => p.then(() => "ok", (e) => (e as { status?: number }).status ?? (e as Error).message);

// ── upload / eTag 回采 / If-Match ──────────────────────────────────────────────
test("[folder] upload(fail) 新建 → ref=path、eTag=mtime-size（close 后回采）；replace+对 eTag → 新 eTag", async () => {
  const p = createFolderProvider(mkFs().root);
  const it = await p.upload("a.ora", enc("v1"), { conflictBehavior: "fail" });
  eq(it.ref, "a.ora", "ref = path（方案 A path-as-id）");
  assert(/^\d+-2$/.test(it.eTag), `eTag=mtime-size：${it.eTag}`);
  const again = await p.getItemByPath("a.ora");
  eq(again!.eTag, it.eTag, "getItemByPath 与 mutation 回采一致");
  const it2 = await p.upload("a.ora", enc("v2!"), { conflictBehavior: "replace", eTag: it.eTag });
  assert(it2.eTag !== it.eTag, "replace 后新 eTag（mtime 在 close 后重读，绝非旧值）");
  eq(await txt(await p.download("a.ora")), "v2!", "字节落了");
});

test("[folder] If-Match 读-比-写：陈旧 eTag → 412；blind replace（无 eTag）→ 运行时护栏 throw", async () => {
  const p = createFolderProvider(mkFs().root);
  const it = await p.upload("a.ora", enc("v1"), { conflictBehavior: "fail" });
  await p.upload("a.ora", enc("v2"), { conflictBehavior: "replace", eTag: it.eTag });
  eq(await statusOf(p.upload("a.ora", enc("v3"), { conflictBehavior: "replace", eTag: it.eTag })), 412, "陈旧 eTag 拒");
  const msg = await statusOf(p.upload("a.ora", enc("v3"), { conflictBehavior: "replace" }));
  assert(String(msg).includes("blind overwrite forbidden"), `无 eTag 的 replace 必须被运行时护栏拦：${msg}`);
});

test("[folder] 大小写护栏：解析不敏感（Linux 敏感 fake 上照样命中），upload(fail) 不敏感撞 409，沿用磁盘真实大小写", async () => {
  const p = createFolderProvider(mkFs().root);
  await p.upload("Art/A.ora", enc("x"), { conflictBehavior: "fail" }).catch(() => {});   // 父夹不存在 → 先建
  await p.ensureFolder("Art");
  await p.upload("Art/A.ora", enc("x"), { conflictBehavior: "fail" });
  const hit = await p.getItemByPath("art/a.ora");
  assert(hit, "不敏感解析命中");
  eq(hit!.path, "Art/A.ora", "返回磁盘真实大小写");
  eq(await statusOf(p.upload("ART/a.ora", enc("y"), { conflictBehavior: "fail" })), 409, "不敏感占用 → 409（绝不静默建同名异案文件）");
  eq(await p.ensureFolder("art"), "Art", "ensureFolder 不敏感命中沿用真实名，不另建");
});

test("[folder] downloadRange 切片+越界钳；list 过滤 OS 垃圾、dot 项照返（上层 isHidden 滤）", async () => {
  const { root } = mkFs();
  const p = createFolderProvider(root);
  await p.upload("ABCDEFGH.bin", enc("ABCDEFGH"), { conflictBehavior: "fail" });
  eq(await txt(await p.downloadRange("ABCDEFGH.bin", 5, 100) as Blob), "FGH", "越界自动钳");
  await p.upload("desktop.ini", enc("junk"), { conflictBehavior: "fail" });
  await p.ensureFolder(".trash");
  const names = (await p.list("")).map((i) => i.name).sort().join(",");
  eq(names, ".trash,ABCDEFGH.bin", "junk 滤掉、dot 夹照返");
});

// ── move（fallback=copy-验-删源）/ rename / copy / delete ───────────────────────
test("[folder] move 进 .trash（无 native move → copy-验-删源）：字节保住、源没了、ref 换 path；陈旧 eTag → 412；占用 fail → 409", async () => {
  const p = createFolderProvider(mkFs().root);
  const it = await p.upload("画.ora", enc("bytes"), { conflictBehavior: "fail" });
  await p.ensureFolder(".trash");
  eq(await statusOf(p.move("画.ora", ".trash", { newName: "画 [1].ora", conflictBehavior: "fail", eTag: "0-0" })), 412, "读-比-写拒陈旧");
  const moved = await p.move("画.ora", ".trash", { newName: "画 [1].ora", conflictBehavior: "fail", eTag: it.eTag });
  eq(moved.ref, ".trash/画 [1].ora", "path-as-id：move 后 ref=新 path（行李牌作废换牌）");
  eq(await txt(await p.download(moved.ref)), "bytes", "字节完好");
  eq(await p.getItemByPath("画.ora"), null, "源没了");
  await p.upload("又.ora", enc("z"), { conflictBehavior: "fail" });
  eq(await statusOf(p.move("又.ora", ".trash", { newName: "画 [1].ora", conflictBehavior: "fail" })), 409, "目标占用 fail → 409");
});

test("[folder] rename 同夹换名；copy 源原位不动、目标撞名 409；delete 硬删带 If-Match、missing → 404", async () => {
  const p = createFolderProvider(mkFs().root);
  const it = await p.upload("a.ora", enc("v1"), { conflictBehavior: "fail" });
  const rn = await p.rename("a.ora", "b.ora", it.eTag);
  eq(`${rn.ref}|${await p.getItemByPath("a.ora") === null}`, "b.ora|true", "rename=换 path、旧名没了");
  const cp = await p.copy("b.ora", "/", "c.ora");
  eq(`${cp.ref}|${(await p.getItemByPath("b.ora"))?.ref}`, "c.ora|b.ora", "copy 源原位不动");
  eq(await statusOf(p.copy("b.ora", "/", "c.ora")), 409, "copy 目标撞名 409");
  eq(await statusOf(p.delete("c.ora", "0-0")), 412, "硬删陈旧 eTag 拒（v435 同纪律）");
  await p.delete("c.ora", cp.eTag);
  eq(await statusOf(p.delete("c.ora")), 404, "missing → 404");
});

test("[folder] deleteEmptyFolder 四态：空→deleted；有内容→non-empty；只剩 OS 垃圾→deleted；missing→already-gone；根拒删", async () => {
  const p = createFolderProvider(mkFs().root);
  await p.ensureFolder("空夹");
  eq((await p.deleteEmptyFolder("空夹")).status, "deleted");
  await p.ensureFolder("有货");
  await p.upload("有货/x.ora", enc("x"), { conflictBehavior: "fail" });
  eq((await p.deleteEmptyFolder("有货")).status, "non-empty");
  await p.ensureFolder("垃圾夹");
  await p.upload("垃圾夹/desktop.ini", enc("j"), { conflictBehavior: "fail" });
  eq((await p.deleteEmptyFolder("垃圾夹")).status, "deleted", "OS 垃圾不算内容（否则 Windows 下永远删不掉夹）");
  eq((await p.deleteEmptyFolder("不存在")).status, "already-gone");
  eq((await p.deleteEmptyFolder("")).status, "non-empty", "根永远拒删");
});

// ── 「另一朵云」集成冒烟：cloud-sync 直接骑 folder provider，引擎零特判 ─────────────────────
test("[folder] cloud-sync over folder provider：push 新建→fetchMeta 对账；陈旧 base push → CloudConflictError；trash 腿照走", async () => {
  const p = createFolderProvider(mkFs().root);
  const cloud = createCloudSync({ provider: p, kv: memKv(), fileName: (n: string) => n });
  const { item } = await cloud.push("画.ora", enc("v1"), { baseEtag: null });   // 新建：conflictBehavior=fail 路径
  assert(item && item.eTag, "push 回采 item.eTag");
  const meta = await cloud.fetchMeta("画.ora");
  eq(meta!.etag, item!.eTag, "fetchMeta 与 push 回采一致（谱系不中毒）");
  const { item: item2 } = await cloud.push("画.ora", enc("v2"), { baseEtag: item!.eTag });
  const stale = await cloud.push("画.ora", enc("v3"), { baseEtag: item!.eTag }).then(() => "ok", (e) => (e as Error).name);
  eq(stale, "CloudConflictError", "陈旧 base → 412 → CloudConflictError（If-Match 家规原样工作）");
  await cloud.trash("画.ora", "20260826120000-guid", { baseEtag: item2!.eTag });
  const tr = await cloud.listTrash();
  eq(tr.length, 1, ".trash 腿在 folder 云上照走");
  eq(await cloud.fetchMeta("画.ora"), null, "原位没了");
});
