# Encryption = 3-layer container (encrypted payload) + encrypted byte-range peek, as a store operator
> created 20260602

**Status:** accepted 2026-06-02 · amended 2026-06-12 (peek abstraction, `.zip` ext, store-operator, **strong-KDF .7z payload via vendored 7z-wasm**)

> The 2026-06-12 amendments come from direct user direction while building the WebPaint impl. They overturn
> two things the original ADR got wrong — a format-aware tail blob, and the weak-KDF "accepted trade".
> **If you are an agent touching this: read the "Hard rules an agent must not re-violate" section first.**

Encrypted files use a **3-layer container**:

```
<name>.zip (plaintext STORE)  →  <GUID> (encrypted .7z payload)  →  data.bin = the ORIGINAL file (.ora/.txt/…), unchanged
                                   + meta.bin (real name + ext)
+ a separate outer `peek` blob (custom AES-GCM, MAGIC) as the last entry — byte-range-able
```

- The **payload `<GUID>` is a real `.7z`** (AES-256 + strong KDF + encrypted headers `-mhe`), made in-browser by **vendored 7z-wasm** (the real 7-Zip compiled to wasm; ~1.6 MB, lazy-loaded, SW-runtime-cached). So **7-Zip recovers the original with just the password** (anti-abandonware). The decision to vendor (2026-06-12, user: *"还是 vendor 7z 吧，某些兄弟项目是有相对高的安全需求"*) overrides the earlier "in-browser .7z is the blocker / weak WinZip-AES is the accepted trade" — the family pays the one-time size cost once, all siblings get strong KDF.
- The **outer plaintext STORE** layer hides encryption from a cloud scanner (no top-level "encrypted" flag — the encryption is one opaque level down) *and* lets a byte-range request reach the `peek`. Why not bare `.7z` (1-step recovery)? Because the whole file must be a *zip* to carry the trailing byte-range `peek` (cheap cloud-only encrypted previews); the user chose peek-preservation over 1-step recovery (2026-06-12).
- **External extension is `.zip`**, not `.ora`/`.txt`. The container *is* a standard zip, so `.zip` is name-true and stops other software from mis-opening it as the original type (`secret.txt` encrypted is `secret.zip`, not a `.txt` that won't parse). The name/path is **plaintext** (identity = path/name, ADR-0011; GUID-as-identity rejected 2026-06-07) — only the bytes are hidden.
- `data.bin` **is the original file verbatim** (e.g. a full `.ora`, which already contains its own `Thumbnails/thumbnail.png`). So manual recovery (7-Zip → password → `data.bin`) yields a normal, thumbnailed file after renaming per `meta.bin`. No inner-thumb duplication needed.
- **`<GUID>` is just an opaque obfuscation name**, regenerated per repack — *not* an identity, needs no stability or anti-collision registry.
- The **`peek` is opaque app bytes** (see "format-blind" below), encrypted as a custom AES-GCM blob anchored on a custom MAGIC (ciphertext has no recognizable magic). One byte-range tail read decrypts it. An **empty peek is still written** (it doubles as the "this is an encrypted container" probe marker).
- Password is **memory-only, never persisted**; **salt is per-file in the payload/peek headers** (not device-bound, no salt file to sync). WebXiaoHeiWu migrates from its custom AES-GCM binary (no external tool opens it) to this model.

## Encryption is a **store-base operator**, not app code (2026-06-12)

The whole mechanism lives in the shared `sync-store` deep module (`src/store/crypto-container.ts` + `store.ts`), reusable by every sibling. **The app is format-blind to encryption end-to-end:**

- `flow.save(name,{encode})` / `flow.load(name)` / `flow.push` / `flow.open` / `flow.acquire` are **transparent**: `encode` always emits **plaintext**, `adopt`/`load` always receive **plaintext**. Sealing/unsealing happens entirely inside the store. The app's codec (`ora.js`) has **zero** encryption knowledge.
- The at-rest encrypted state is **a flag whose single source of truth is the bytes themselves** (tail-MAGIC probe), not a registry that could drift. `flow.encrypt(name)` / `flow.decrypt(name)` toggle it.
- **`store` must never presume a file format.** It does not know what a PNG/thumbnail is. The peek is opaque bytes. The app injects, at assembly time, `makePeek(plaintextData) → opaque bytes` (plaintext→plaintext — the store does the encrypting). WebPaint's `makePeek` pulls the ora's `Thumbnails/thumbnail.png`; a text app could return a snippet. *That one line is the only place "it's a PNG" exists.*
- **Password flows through a seam, never a flow argument; the store never stores it.** Assembly injects `getPassword(name)` (sync, non-interactive), `requestPassword(name,{retry})` (interactive fallback the store loops on the unseal path), `onPasswordVerified(name,pw)` (app records it however it likes). This one shape covers **all** password policies: WebPaint/WXHW unified (one global key) **and** AtlasMaker per-board **and** "a global-password app that imported a file with a different password" (getPassword returns global → store fails to unseal → requestPassword asks for that file → onPasswordVerified records a per-name override). Verification is the GCM tag / WinZip verifier — the store rejects a wrong password without ever touching user data.
- Reading the peek for navigation also routes through the store: `getTailBytes(name,n,{cloud})` auto-routes local-slice vs cloud byte-range; `decryptPeekBytes`/`readPeek` run the password loop. **Batch gallery rendering is non-interactive** (`interactive:false` — decrypt-if-key-in-memory, else show a lock; never ambush a scrolling list with a prompt); only an explicit unlock/open is interactive.

## Hard rules an agent must not re-violate

1. **No format presumption in the store.** `thumbPng`, `PLACEHOLDER_THUMB_PNG`, "image", "PNG" must never appear in `src/store/`. The tail blob is `peek` = opaque bytes; the app supplies/interprets it via `makePeek`. (We shipped a `thumbPng`/placeholder-PNG version on 2026-06-11 — the user rejected it outright. Don't redo it.)
2. **The app never sees ciphertext on the save/load path.** `encode`→plaintext, `load`→plaintext. If you find the app packing/unpacking containers (an earlier WebPaint impl did this in `ora.js`), that's the bug — pull it into the store.
3. **Plaintext (file body *and* peek) never lands on disk; ciphertext does** (so offline still works). IDB stores the container; the cleartext thumbnail lives only in an objectURL.
4. **encrypt/decrypt swap both ends together** (local first = byte truth, then cloud If-Match; on 412/offline-after-synced → mark dirty + anchor parentBase, never leave one side swapped). The 2026-06-11 bug: app pushed cloud-only without swapping local → next save re-pushed plaintext → encryption silently undone.
5. **Unlocked = peeks visible.** Unified-password apps decrypt all previews after one unlock (navigation needs thumbnails). Don't gate previews behind per-open prompts.

## Cipher / KDF — strong `.7z`, vendored (2026-06-12, landed)

User direction, in order: *"用那个好的，7z 能打开就行，不用兼容 winzip"* (use the strong KDF; only need 7-Zip-the-program to open it) → *"不 vendor 太大，有其他选项吗"* (offered 0-KB custom-AES vs Argon2 vs keep-WinZip) → **"还是 vendor 7z 吧，某些兄弟项目有相对高的安全需求"** (decided: vendor it; family-level strong KDF wins over the size cost).

- **Payload = real `.7z`, AES-256 + strong KDF (7-Zip default, SHA-256 many rounds) + encrypted headers (`-mhe`)**, made by **vendored 7z-wasm** (`vendor/7z-wasm/`, ~1.6 MB wasm). 7-Zip opens it natively with the password. This *supersedes* the original weak-WinZip-AES "accepted trade" — `zipPackEncrypted`/`zipUnpackEncrypted` are deleted; `zip.js` now only does plaintext zip (outer shell + the ora itself).
- **Lazy + offline:** the 1.6 MB wasm is NOT precached and NOT bundled (esbuild only sees the string path). `src/sevenzip.js` injects the vendored UMD + fetches the wasm on first encrypt/decrypt; the SW fetch handler runtime-caches it (msal pattern) → used-once-online ⇒ offline-capable thereafter. A non-encrypting user never pays the download.
- HOST-SEAM: `crypto-container.ts` (store base) calls `pack7z`/`unpack7z` from the host's `../sevenzip.js`, same way it calls `../zip.js`. Node tests inject a node loader via `setSevenZipLoader`.
- The **peek** stays strong-KDF AES-GCM (PBKDF2-SHA256 ×250k) — app-only, independent of the payload cipher.
- **Do not pre-stretch the password** (must stay typeable in 7-Zip) and **do not enforce** a strong passphrase (user's responsibility; surface brute-force risk once, non-blocking).
- License: 7-Zip is LGPL (+ unRAR restriction, irrelevant to our zip/7z use); `License.txt` vendored alongside.

## Why record it

Anti-abandonware (ADR-0006) demands recovery *without the app* — a 7-Zip-class tool + the password must yield the original. That forces a standard encrypted archive payload, which forces the outer plaintext wrapper (defeat scanner rejection + hide the encryption flag) and the `.zip` external name. A future reader wondering "why three nested zips with a `.bin` inside, named `.zip`" — this is why.

Full spec: [share-file 20260602-encryption-model.md](../20260602-encryption-model.md). Impl + device-test checklist: WebPaint `docs/20260611-encryption.md`.
