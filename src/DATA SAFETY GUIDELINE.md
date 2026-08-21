## A. Data-safety red-lines — these must NEVER happen

The canonical failure list (from `journals/20260604-potential-bugs.md`, `ai-docs/20260604-potential-bugs.md`) and exactly where the model forbids each. **If a change can cause any row's left column, it crosses a red-line.**

| Must never happen | How the model forbids it | Owner |
|---|---|---|
| Two devices edit offline → reconnect → **LWW silently picks one, the other evaporates** | **No LWW for content.** Conflict = `dirty ∧ cloudMoved` → *surfaced* (sheet), never silent; both sides preserved (`.backup`) | state-machine §1, ADR-0009/0014 |
| Same-device multi-tab: a **stale tab's Ctrl+S clobbers** a newer tab | **Per-file push-serialize + `If-Match` base-etag** → the stale push 412s, can't overwrite | ADR-0009 (W2) |
| **Clock skew** makes LWW judge "older" as "newer" | No LWW; divergence decided by **`If-Match`/etag**, not timestamps. Display clock = **user-action-time** | ADR-0004/0009 |
| **Un-pushed local edits wiped by cache eviction** (deadliest — gone before sync) | **Eviction guard: evict iff `clean ∧ re-fetchable`.** Dirty/unpushed is never evicted (auto-pinned + `.backup`) | ADR-0009 (W2), state-machine §3 |
| **Interrupted upload → truncated/corrupt cloud file → next pull overwrites the good local** | **Atomic commit (`If-Match`) + W1 idempotency**; pull/auto-take only adopts a *complete* newer cloud version; re-entry never adopts a partial | ADR-0009, state-machine §3 |
| **delete-vs-edit**: one deletes, one edits → merge loses something | **edit-wins by default** + delete = **move-to-`.trash`** (recoverable); surfaced, never silent | share-file-model §Offline-delete, ADR-0015 |
| Cloud provider **dedup / rename / scan / quarantine** moves or alters the file | **Identity = path/name** (format-agnostic; the in-file **GUID-in-thumb scheme (ADR-0011) was tried on real devices and ROLLED BACK 2026-06-07** — see `WebPaint/docs/20260607-sync-identity-decision.md`: store parses no file, knows no thumb/guid, so mp3/txt/pdf siblings can share it). Data-safety guarantee that survives: two devices → same name → **never blind-overwrite** (no-base push uses `conflictBehavior:"fail"` + size-check → `CloudNameCollisionError`, both kept). Encryption hides bytes from scanners (3-layer, ADR-0012). *Cross-device rename-split (wart E) = accepted UX blemish, **not** data-loss (re-sync converges).* | ADR-0012; sync-identity-decision-2026-06-07 (**ADR-0011 GUID superseded**) |
| **"Sync succeeded" actually wrote to the wrong account or folder** | **Phantom-path red-line**: destructive ops use the *actually-loaded* path, never `localStorage.currentPath`; the Workbench is never a destructive pointer; account-bound, old-account items **ghost** (never auto-delete) | ADR-0008, share-file-model |
| **Conflict resolution picks one side and silently discards the other** | **Never hard-override a Work** (even with consent); weak-override stashes the loser to `.backup` (never lossy); no destructive "pull" | ADR-0009 |
| **Cold-start / re-entry reads a half-written file** | **Ready-gate** suppresses input until re-entry resolves; re-entry rehydrates from the crash-shadow (local, complete) or a validated cloud version | ADR-0010 |
| **Sibling PWA on the same origin shares this store's IndexedDB/localStorage** → another app's files leak into your gallery; the shared `store.schema` migration stamp gets set by whichever app boots first, so the other **skips migration → its artwork never copies over → shows 0 B**; local caches overwrite each other | **Per-app namespace (required `appId`)**: IDB DB name `${appId}.sync-store-cache` + every localStorage key `${appId}.sync.*`/`${appId}.head.*`/`${appId}.store.schema`/`${appId}.folders.pending`. IndexedDB/localStorage are **origin-scoped, not path-scoped** (GitHub Pages `/app-a/` and `/app-b/` are one origin). Missing `appId` → `createStore` throws, never silently shares. | **ADR-0022** (2026-07-12, real-device incident); see `ai-docs/20260712-store-per-app-namespace.md` |

| **An encrypted work's decrypted bytes reach a persistent layer** — the 7z container protects the cloud copy, but a plaintext derivative (ora bytes / layer bitmaps / a 256px thumbnail) written to IndexedDB, localStorage, a checkpoint, or an export file silently defeats the whole scheme: anyone with device access reads the artwork without the password, and the user believes it is encrypted | **Plaintext of an encrypted work lives in RAM only, never on any persistent layer.** `seal.sealForWrite` wraps *before* every local write (so IDB holds ciphertext too); missing password → `LockedError`, never a silent plaintext fallback; `unsealForRead` returns an in-memory Blob only; `getPeek` returns the **ciphertext** peek for encrypted files (app caches it as-is) — the store never decrypts for caching; checkpoints of an encrypted work store the ciphertext container; the local cache record has **no thumbnail/preview field at all** (a dead `.peek` field was removed 2026-07 after it was found writing plaintext 256px thumbnails to IDB) | this file (2026-07-18); `ai-docs/20260611-encryption.md`; `seal.ts` / `local-cache.ts` |

| **A local write is reported as success but never reached disk** — IndexedDB fires the *request's* `onsuccess` **before** the transaction commits, so on a quota wall the real order is `req.success → tx.abort(QuotaExceededError)`. Resolving on `onsuccess` hands the app a success for bytes that were rolled back: the app clears its dirty flag, autosave stops retrying, and the exit-time "retry / discard" prompt is disarmed — the user's edit is gone with no error anywhere (not even an unhandled rejection) | **A write is successful only when its transaction commits.** `idb-store.reqTx` resolves on `t.oncomplete` and rejects on `t.onabort` (never on the bare request event); `rename`/`usage` were already shaped this way — do not fork them back. Regression guard = `tools/idb-tx-commit-check.mjs`, which drives the **real built `dist/idb-store.js`** under a CDP-shrunk quota and fails if a rolled-back write ever resolves | **v0.3.1** (2026-08-21, reproduced with a control group); see WeebPaint `ai-docs/20260821-storage-eviction-investigation.md` §B.2 |

**One-line invariants behind all of the above:** every push is `If-Match` · every delete/overwrite is **move-aside** (`.trash`/`.backup`, same-tier, never cross-network) · authority is **stateful** (dirty→local, clean→cloud) · identity is **path/name** (format-agnostic; in-file GUID superseded 2026-06-07) · **decrypted plaintext never touches a persistent layer** · the **deep storage module** enforces these, never the UI.


### A.1 Scope limit — what §A does **not** cover

§A governs **this library's own decisions**. Two things sit outside it, and pretending otherwise would be
the gaslighting the house rules forbid — so they are written down instead of quietly assumed away.

1. **Browser-initiated eviction of the whole origin.** The red-line "un-pushed local edits are never
   evicted" constrains *the store's* `offload` path (which does guard on `isDirtyAnywhere`). It cannot
   constrain the browser: under storage pressure a UA may evict a non-persistent origin wholesale (LRU),
   and WebKit additionally deletes script-writable storage for an origin with no user interaction in the
   last seven days of browser use. **That bypasses every code path in this library, dirty or not.**
   The only mitigations are outside the store: `navigator.storage.persist()` (MDN: eviction "skips over
   origins that have been granted data persistence"), a cloud copy, and the user exporting a real file.
   **The library does not call `persist()` itself** — when to ask is a product decision (Firefox shows a
   permission prompt), so it belongs to the host app; see WeebPaint `src/storage-persist.ts` for the
   reference shape. A host that ships without it is running on best-effort storage.
2. **Anything the user's OS or another app does to the profile** (clearing site data, private windows,
   profile deletion). Same reasoning: outside the module, so stated rather than implied.

> as-of 2026-08-21 (v0.3.1). Source: WeebPaint `ai-docs/20260821-storage-eviction-investigation.md`
> (§A platform matrix, escalation E3). If a later real-device run contradicts a claim here, trust the run.

> _§A identity row + invariant corrected as-of 2026-06-19 (JRP review): the GUID-in-thumb identity (ADR-0011) was rolled back 2026-06-07; store is format-agnostic, identity = path/name, **no thumbnail required**. Trust code over stale doc._