# Shared-engine storage names anchor on JRP; convergence via explicit versioned migration, not lazy healing

> created 20260709

**Status:** accepted (2026-07-09) — decided, not yet built. Governs the WebPaint→JRP `sync-store` byte-identical convergence. Builds on the store README §复用规则 (engine is peer-copied between apps, no central repo), ADR-0009/0014/0015/0016 (red-line semantics that must survive convergence), ADR-0008 (phantom-path).

## Context

`sync-store` is copied verbatim between siblings. WebPaint forked it (`FORK-BASE 2e9a809`, 2026-06-16); JRP then evolved it 15 days into a deep-module shape (thin `create-store.ts` + `local-head`/`push`/`freshness`/`delete`/`identity`/`safe-resolve`/`seal`/`trash`/`offload`/`listing`/`collection`/`settings`/`upload-queue`). We want the two `src/store/` trees **byte-identical** again, JRP's structure as the base.

The two engines diverged on **storage names**, over otherwise-identical structure (verified 2026-07-09, `docs/reports/20260708-store-byte-identical-convergence-and-degenerate-restore.html`):

| | WebPaint (prod) | JRP |
|---|---|---|
| IDB db / store | `webpaint` / `sessions` | `sync-store-cache` / `blobs` |
| record byte field | `ora` | `blob` |
| local trash / backup prefix | `trash:` / `.backup-local/` | `local-trash:` / `.backup-local/` |
| kv etag prefix | `webpaint.etag:` (appKey) | `sync.etag:` (default) |
| kv work-file dirty | `webpaint.dirty:` (cloud-sync) | `head.dirty:` (local-head) |

Two anchoring choices:

- **Anchor on WebPaint** — JRP's arbitrary AI-chosen names revert; WebPaint data untouched (zero migration). *But* the shared engine then carries WebPaint-specific vocabulary (`webpaint` db, `ora` field) that pollutes a **content-blind** engine and is wrong for every other sibling.
- **Anchor on JRP** — names stay neutral/clean (`sync-store-cache`, `blob`, `sync.etag:`), correct for all siblings and future consumers. WebPaint pays a **one-time migration** of its prod local data.

The migration itself can be done two ways:

- **Lazy healing** — read-fallbacks (`rec.blob ?? rec.ora`), key-fallbacks smeared through hot read paths, self-healing on next write. Cheap to write, but leaves a **permanent compat smell** in every reader with no expiry — the "屎山税" a hobby codebase accumulates invisibly.
- **Explicit versioned migration** — one bounded module runs once at boot, rewrites the data to current names, stamps a version; readers stay clean forever.

**Risk context (2026-07-09):** the only user is solo; all Works live on OneDrive (clean, re-fetchable). Orphaning local cache = re-download, not loss. The migration's dangerous half (preserving un-pushed world-only copies) barely triggers today **provided everything is pushed before cutover** — but the module must still be written correctly, because it ships to JRP and to future-us where un-pushed edits will exist.

## Decision

1. **Anchor the shared engine's storage names on JRP.** Neutral names win for a content-blind, family-shared engine. WebPaint migrates its prod local data to them.

2. **Convergence is an explicit, versioned migration — never lazy healing.** No `?? ora` read-fallbacks. A dedicated **`migration` deep module** (in `src/store/`, travels with the engine) owns it: read the kv version stamp → run pending migrations in order → stamp the new version. Data is *clean after migration*; readers carry no compat branches.

3. **kv holds a store schema-version stamp, format `vNNN-yyyymmdd`** (e.g. `v001-20260709`). Absent/older ⇒ run pending migrations; then write current. Ordered registry; each future kv/IDB shape change adds one migration entry.

4. **First migration `v001-20260709` (webpaint-anchor):** IDB `webpaint/sessions`→`sync-store-cache/blobs` (record `{name,updatedAt,ora,thumb}`→`{blob,thumb,updatedAt}`); local `trash:`→`local-trash:`; kv `webpaint.etag:`→`sync.etag:`; kv dirty split per ADR-0020. **Crash-safe & idempotent:** copy-then-stamp-then-delete-old (never delete a source blob until its target is durably written *and* the version stamped); a mid-migration crash re-runs from scratch (put-by-key is overwrite). A **boot ready-gate** suppresses all store reads until migration completes. For a fresh JRP/other-sibling install this migration finds no `webpaint.*` keys → **no-op → stamp** (harmless; byte-identical shipping cost is one dormant entry + a comment).

## Consequences

The shared engine keeps clean, sibling-neutral names; WebPaint's prod OneDrive-backed data survives a one-time in-place rename with no permanent reader cruft. The cost is a real red-line data-touching module (must escalate + real-device verify; IDB is not node-testable) whose only genuinely hard logic is the ADR-0020 dirty split. The version stamp additionally makes "how old is this client's on-disk schema" inspectable — aligned with the family doctrine of making staleness visible. **Not covered:** app-side `localStorage` settings migration (ADR-0021) and the dirty-track semantics (ADR-0020), decided separately.
