// EncryptionPort 契约形状替身（同步路径测试用；**真加密**测试住 @internal/encryption 仓）。
// created 2026-08-28 by Claude Fable 5（encryption 立户轮：store 零加密知识，端口注入）。
//
// fake 容器 = [MOCKENC1][u8 pwLen][pw utf8][payload 原样]。⚠ 密码明文可见——这是**形状替身不是加密**，
//   只给 store 的 seal/at-rest/sync 路径当一致的容器语义用。无 peek（scanEncPeekFromEnd 恒 null）。
import type { EncryptionPort } from "../create-store.ts";

const MAGIC = new TextEncoder().encode("MOCKENC1");

async function toBytes(b: Blob | Uint8Array): Promise<Uint8Array> {
  return b instanceof Uint8Array ? b : new Uint8Array(await b.arrayBuffer());
}
function startsWithMagic(u8: Uint8Array): boolean {
  if (u8.length < MAGIC.length) return false;
  for (let i = 0; i < MAGIC.length; i++) if (u8[i] !== MAGIC[i]) return false;
  return true;
}

export function createMockEncryption(): EncryptionPort {
  return {
    looksEncryptedContainer: async (b) => startsWithMagic(await toBytes(b)),
    async packContainer({ dataBytes, password }) {
      if (!password) throw new Error("cannot encrypt without a password");
      const pw = new TextEncoder().encode(password);
      const out = new Uint8Array(MAGIC.length + 1 + pw.length + dataBytes.length);
      out.set(MAGIC, 0);
      out[MAGIC.length] = pw.length;
      out.set(pw, MAGIC.length + 1);
      out.set(dataBytes, MAGIC.length + 1 + pw.length);
      return new Blob([out as unknown as BlobPart]);
    },
    async unpackContainer(b, password) {
      const u8 = await toBytes(b);
      if (!startsWithMagic(u8)) throw new Error("not a mock container");
      const pwLen = u8[MAGIC.length];
      const pw = new TextDecoder().decode(u8.slice(MAGIC.length + 1, MAGIC.length + 1 + pwLen));
      if (pw !== password) {
        const err = new Error("wrong password") as Error & { code?: string };
        err.code = "WRONG_PASSWORD";
        throw err;
      }
      return { dataBlob: new Blob([u8.slice(MAGIC.length + 1 + pwLen) as unknown as BlobPart], { type: "application/zip" }) };
    },
    scanEncPeekFromEnd: () => null,                       // mock 无 peek：byte-range 缩略图路径不进本替身
    decryptPeek: async () => { throw new Error("mock encryption has no peek"); },
    PEEK_TAIL_WINDOW: 98304,
    ENC_PEEK_MIME: "application/x-sync-store-enc-peek",
    CONTAINER_PEEK_ENTRIES: ["peek"],
  };
}
