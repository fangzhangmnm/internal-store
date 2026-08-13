# The app's store surface is exactly {file, collection, localSettings, syncedSettings}; app never touches kv

> created 20260709

**Status:** accepted (2026-07-09) — sharpens store README §0 (app must not touch `localStorage`/`IndexedDB`/vendor) into an enumerated allow-list, and makes the WebPaint settings consolidation mandatory under the convergence (ADR-0019). Relates to the long-standing "scattered settings" gap.

## Context

The store README already forbids the app from touching `localStorage`/`IndexedDB`/cloud vendors directly — "全部走本库". But WebPaint's app **still does**: ~23 scattered `localStorage` keys across a dozen files (three access paths: raw `localStorage`, `safe-ls`, a copy of `safeLS` in `color-panel`), plus runtime pointers (`currentSessionName`, `lastSessionSignedIn`, `galleryFolder`), plus an app-constructed `lsKv` handed into `createStore`. The ban existed; it was never enforced.

Anchoring on JRP (ADR-0019) makes enforcement unavoidable: the app must not know the engine's kv key structure, precisely because the migration owns and rewrites those keys. An app that reads `webpaint.pixelGrid` directly is reading a namespace the engine is about to renumber.

The engine already provides the complete settings home: **`localSettings`** (device-local KV, over kv) and **`syncedSettings`** (cross-device, over a collection, per-key LWW). There is no app-side setting that lacks a home in one of these.

## Decision

1. **The app-facing store surface is exactly four things: `file`, `collection`, `localSettings`, `syncedSettings`** (plus the folder/trash/list verbs those compose into). The app **never** touches `kv`, `IndexedDB`, `localStorage`, or a cloud vendor — not even by injecting its own `kv` into `createStore` (the store defaults its own `localStorageKv`). `kv` is the store's internal organ; the app cannot see it.

2. **All app settings move to `localSettings` / `syncedSettings`, with a single defaults SSoT in the app** (`get` gives no default — by design). Device-local prefs (theme, zoom, UI layout, tool toggles, panel positions) → `localSettings`; content-following prefs (language, theme-follows-you, export defaults) → `syncedSettings`. Runtime pointers (`currentSessionName` etc.) → `localSettings`, **preserving the phantom-path red-line (ADR-0008): destructive ops use the actually-loaded path, never the stored pointer.**

3. **Migration policy for existing scattered keys:** content-type prefs are migrated (in the v001 migration or a sibling step); pure device toggles **may be reset to default** rather than migrated (low-stakes, saves migration surface). Decided per-key at implementation.

## Consequences

The engine's kv/IDB namespace becomes fully owned by the store — a precondition for ADR-0019's migration to be safe (nothing outside the store reads a key the migration renames). WebPaint's scattered-settings debt is paid off as a forced side-effect of convergence, not a separate optional project. The cost is a broad-but-mechanical app-layer rewrite (every `localStorage.*` / `safeLS` call site → `localSettings`/`syncedSettings`) plus dropping the `lsKv` injection. `safe-ls.ts` and `syncable-prefs.ts` (the half-built aggregation seam) are retired.
