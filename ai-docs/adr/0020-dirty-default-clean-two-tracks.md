# Dirty is default-clean and split into two tracks (work-file local-head / collection cloud-sync)

> created 20260709

**Status:** accepted (2026-07-09) — part of the WebPaint→JRP convergence (ADR-0019). Refines ADR-0014 (dirty ⇒ never evicted) and ADR-0016 (parentBase = the only If-Match).

## Context

"Dirty" (a file has un-pushed local edits) is durably recorded in kv so it survives reload. The two engines encode it differently:

- **WebPaint (prod):** one track, in `cloud-sync` — `webpaint.dirty:<name>`, value `"1"`/`"0"`, **missing key ⇒ default `true` (dirty)**. This conservative default was a belt-and-suspenders: an *unknown* file is assumed dirty so it can never be evicted by mistake.
- **JRP:** **two tracks by concern.** Work-files (the opaque `.ora`/`.pdf` Works) track dirty in **`local-head`** — `head.dirty:<name>`, value `"1"`/removed, **missing key ⇒ default `false` (clean)**, coupled to local-head's invariant *"dirty-without-parent is unrepresentable"* (`recordEdit` atomically sets dirty + captures parentBase). Collections (mergeable JSON: reading-state, brush-rack, syncedSettings) keep their dirty in **`cloud-sync`** (`sync.dirty:`, default-dirty), because a collection's dirty is a different thing (a debounced auto-sync flag, not a parentBase-anchored branch).

The default flip is the one place a rename would silently change *meaning*, not just a key name. Does default-clean lose data? **No, in practice:** WebPaint writes `setDirty(name,true)="1"` on every edit, so a genuinely dirty Work **always carries `"1"`** — `local-head` reads `=== "1"` → dirty, unchanged. A missing key only ever meant "never edited" = clean. The dropped behaviour is solely the narrow crash-window belt (bytes written, dirty flag not yet) — and that window is exactly what local-head's atomic `recordEdit` closes structurally.

## Decision

1. **Adopt JRP's model as the converged shape: dirty default-clean, two tracks.** Work-file dirty lives in `local-head` (`head.dirty:`, missing⇒clean); collection dirty stays in `cloud-sync` (`sync.dirty:`, missing⇒dirty). WebPaint drops its single-track conservative default-dirty.

2. **The v001 migration (ADR-0019) must *route* WebPaint's conflated `webpaint.dirty:` correctly:** a known **collection name** → `sync.dirty:` (value kept); anything else → **work-file** → `head.dirty:` (`"1"`→`"1"`; `"0"`/absent → key removed, i.e. clean). **Conservative rule (red-line):** an *unrecognised* name is routed as **work-file dirty and kept dirty** — never dropped to clean, so no un-pushed Work can be silently evicted by a mis-route. The migration therefore couples to a small known-collection-names list.

## Consequences

The converged engine has one clean model (default-clean + the unrepresentable-bypass invariant) instead of two conflicting defaults. No real dirty Work is lost — dirty Works always carry `"1"`. The only true semantic given up is WebPaint's "unknown ⇒ assume dirty" margin, superseded by local-head's structural guarantee. Cost is concentrated in the migration's dirty-split (its only genuinely hard logic) and a small coupling to the collection-names list. ADR-0014's red-line (dirty ⇒ never evicted) is preserved: it keys off `head.isDirty`, which now reads the migrated `head.dirty:` correctly.
