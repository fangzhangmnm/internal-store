import { test, eq, assert } from "./runner.mjs";
import { createSeal, LockedError } from "../src/seal.ts";
import type { SealCfg } from "../src/seal.ts";

// ── stub crypto 原语（toy 容器：[0xE0, pwByte, ...data]）→ 测 seal 路由，不碰真 7z ──
const MARK = 0xE0;
const enc = (s: string) => new TextEncoder().encode(s);
async function toBytes(b: Blob | Uint8Array): Promise<Uint8Array> {
  return b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer());
}
const looksContainer = async (b: Blob | Uint8Array) => (await toBytes(b))[0] === MARK;
const pack: SealCfg["pack"] = async ({ dataBytes, password }) =>
  new Blob([new Uint8Array([MARK, password.charCodeAt(0) & 0xff]), dataBytes as BlobPart]);
const unpack: SealCfg["unpack"] = async (blob, password) => {
  const arr = await toBytes(blob as Blob | Uint8Array);
  if (arr[1] !== (password.charCodeAt(0) & 0xff)) { const e = new Error("wrong") as Error & { code?: string }; e.code = "WRONG_PASSWORD"; throw e; }
  return { dataBlob: new Blob([arr.slice(2)]) };
};
function mkSeal(over: Partial<SealCfg> = {}) {
  return createSeal({
    looksContainer, pack, unpack,
    getPassword: () => null,
    getPrev: async () => null,
    ...over,
  });
}

test("明文文件：sealForWrite 原样透传（prev 是明文）", async () => {
  const s = mkSeal({ getPrev: async () => enc("plainprev") });
  const out = await s.sealForWrite("g", enc("hello"));
  eq(new TextDecoder().decode(out), "hello", "明文不包壳");
});

test("加密文件：prev 是容器 + 有密码 → 包壳", async () => {
  const s = mkSeal({ getPrev: async () => new Uint8Array([MARK, 0, 1, 2]), getPassword: () => "secret" });
  const out = await s.sealForWrite("f", enc("hello"));
  eq(out[0], MARK, "输出是容器（包了壳）");
});

test("加密文件 + 无密码 → 写路径响亮 LOCKED（绝不静默存明文）", async () => {
  const s = mkSeal({ getPrev: async () => new Uint8Array([MARK, 0]), getPassword: () => null });
  let err: unknown;
  try { await s.sealForWrite("f", enc("hello")); } catch (e) { err = e; }
  assert(err instanceof LockedError, "无密码 → LockedError");
});

test("输入已是容器（搬运路径）→ 不二次包", async () => {
  const container = new Uint8Array([MARK, 99, 1, 2, 3]);
  const s = mkSeal({ getPrev: async () => new Uint8Array([MARK, 0]), getPassword: () => "x" });
  const out = await s.sealForWrite("f", container);
  eq(out.length, container.length, "原样，没二次包");
});

test("unsealForRead：容器 + 对密码 → 明文", async () => {
  const container = await pack({ dataBytes: enc("payload"), fileName: "f", password: "k" });
  const cu8 = await toBytes(container);
  const s = mkSeal({ getPassword: () => "k" });
  const out = await s.unsealForRead("f", new Blob([cu8]));
  eq(await out?.text(), "payload", "解出明文");
});

test("unsealForRead：错密码 → null（不抛、不弹窗）", async () => {
  const container = await pack({ dataBytes: enc("payload"), fileName: "f", password: "k" });
  const s = mkSeal({ getPassword: () => "WRONG" });
  const out = await s.unsealForRead("f", new Blob([await toBytes(container)]));
  eq(out, null, "锁定 → null");
});

test("unsealForRead：明文 → 原样透传", async () => {
  const s = mkSeal({ getPassword: () => "k" });
  const plain = new Blob([enc("justtext")]);
  const out = await s.unsealForRead("g", plain);
  eq(await out?.text(), "justtext", "明文不动");
});

// ── 2026-09-09 meta.bin 的 ext 按逻辑名推导（同 store 里 .txt 稿 + .xxx.zip 工程并存，store 级单值 crypt.ext 必错一种）──
import { cryptExtFor } from "../src/seal.ts";
test("cryptExtFor · 逻辑名有点 → 最后一个点之后；没点 / 隐藏名 / 尾点 → 回退 cfg.ext；夹名里的点不算", () => {
  eq(cryptExtFor("a.txt", "dat"), "txt");
  eq(cryptExtFor("夏音.webxiaoheiwu.zip", "txt"), "zip", "工程 ext=zip 而非 store 级的 txt");
  eq(cryptExtFor("A/wall.ora", "dat"), "ora");
  eq(cryptExtFor("dir.v2/name", "dat"), "dat", "夹名的点不算，回退");
  eq(cryptExtFor(".hidden", "dat"), "dat");
  eq(cryptExtFor("a.", "dat"), "dat");
  eq(cryptExtFor("bare"), undefined, "无回退 → undefined（encryption 包再回退 bin）");
});
