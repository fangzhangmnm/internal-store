# 改库记录：0.15.0 一件——`RawFile.getHead({bytesLength, source})` 头片 peek

> created 20260920 · by Claude Fable 5.1 · as-of 0.15.0 · 起因 = CatsUp 转正纪元接 store + gallery（`../../20260627 CatsUp/ai-docs/20260906-ledger-next-agents.md` A18 ②③）。
> user 2026-09-20：A18 ② 报告列的「store 通用头片 peek——纯云端文档现在没封面」→ 「234批准，做」（2 = 缩略图 IDB、3 = 崩溃影子 IDB、4 = 本件）。escalate 本身在 0.5.0 开工前已提（CatsUp commit 2c2b137「A18 ② 开工前要 user 的三件」）。

## 1. 为什么库要长这个面

- CatsUp 文件 = 一个 `.glb`（glTF 2.1 语义），封面 = `asset.thumbnail` 指向的 image，字节放 **BIN 首段**（契约 §3：JSON ≈ 2 KB + JPEG ≈ 5–12 KB，全在文件前 ~20 KB）。
- 库现有的预览面只有 `ZipFile.getPeek`：先拉**尾片**解 EOCD/CD 按名取 entry——是 zip「目录在尾」的形状，对 GLB/PDF/ID3/RIFF 这类「头在前」的格式一字不用。
- `openStream()` 不是替代品：它是 2 MiB 分片 + staging tee 的流式面，为一张 10 KB 封面开会话 = 每个 cloud-only tile 落 2 MiB 暂存（一夹 100 张 = 200 MB），且没有 `source:"cloud"` 的「绝不落回本地」护栏。
- app 侧绕不过（铁律 0.3）：没有 provider 面就只能 `open()` 整份下载再截头——纯云端图库变成「开图库 = 下载全部文档」。

## 2. 语义（JSDoc 在 `create-store.ts` RawFile.getHead）

- 返回文件**开头** `bytesLength` 字节的**明文** Blob（无 type，格式盲）；超过文件 → 整份；0 → 空 Blob（文件存在）。
- 路由与 `getPeek` 同一纪律（2026-08-21 护栏）：`source:"local"` = 本地有副本 → `Blob.slice`（零网络）、无 → 云端 `pullRange(0,n)`；`source:"cloud"` = 只看云端，**绝不落回本地**。云端拉到的头片**不落本地**。
- **加密件 → null**：本地经 `enc.looksEncryptedContainer`，云端经 `_find` 的加密名判定（`pullTail/pullRange` 返回值新增 `encrypted: boolean`）。密文外壳的头对 app 无意义；库绝不为了预览解密（解密只走 `open`）。
- **云端不可达 → 抛**，不是 null：gallery thumb-cache 契约「null = 确定没有（缓存）；抛 = 未知（不缓存）」。云腿闸沿用 0.14.0 `isOnline ∧ signedIn`（离线/未登录直接 null，不打 range）。
- `ZipFile extends RawFile` → zip 文件也有 `getHead`（PDF 类明文 zip？无所谓，形状继承）。

## 3. 红线自查（DATA SAFETY §A）

纯读面：不写本地、不写云、不动 etag/dirty/If-Match/move-aside。唯一副作用 = 一次 byte-range GET。`pullTail/pullRange` 返回值加字段是超集（既有调用点零改动，typecheck 绿）。

## 4. 测试

`test/get-head.test.ts` 7 件：纯云端 range(0,n) 一次且不落本地 / 本地 slice 零网络 / source cloud vs local 各看各的 / 越界钳 + 0 字节 / 加密名 null / 无处可取 null + 离线不打云腿 / ZipFile 继承。全套 420 绿。

## 5. 版本

**0.15.0（minor）**：`RawFile` 新门牌（新公开方法 = 接口面扩张，不是 bugfix/polish，家族版本约定 minor=新功能）。user 2026-09-20「234批准，做」= 批准。消费者：CatsUp 0.5.2 `src/app/gallery-host.ts`（`policy.thumbs.fetch` 改走 `getHead` 两步：先 64 KB，头片不够再按 JSON 长度补拉）。
