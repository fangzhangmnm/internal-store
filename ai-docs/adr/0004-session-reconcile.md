# Cross-device session reconcile: never-block launch, edit-timestamp merge, advisory, attunement isolation
> created 20260602

**Status:** accepted (2026-06-01)

Rules for reconciling cross-device session / current state without losing data or jarring the user. They exist because auto-syncing the "last session" pointer caused real damage (phantom-current ate an encrypted file in AtlasMaker 0.7.2; a stale device's progress-0 overrode a newer progress-1 in JustReadBooks).

- **Never-block launch** (Continuity priority) — a Continuity app must show the last-known current *instantly* and reconcile in the background; it must never block launch on cloud sync. A launch gap defeats the whole "after a short nap" purpose.
- **Edit-timestamp merge** — Co-synced values (reading progress, settings) reconcile by the timestamp of the *edit*, monotonic-forward — not by push-order. A stale device's older-timestamped value can never clobber a newer one by pushing last. (Fixes the JustReadBooks override and the WebXiaoHeiWu duplicate-drafts.)
- **Advisory reconcile** — surface newer remote state as a dismissible offer ("continue from page 40, synced from your iPad?"), never an automatic jump, load, or overwrite. Used in Shared-doc, and for active-session changes in Singular.
- **Attunement isolation** — syncing Attunement (especially the Session pointer) must never block, corrupt, or risk a Work or Collection class. The Session pointer is never authoritative in a way that can drive a destructive op, which kills phantom-current and stale-override at the root.

## Why record it

These are the resolutions of the "session pointer auto-sync brings trouble" incidents. Each is the kind of rule a future implementer would skip — and then re-suffer the exact file-eating / progress-loss bug.

## Consequences

- The Session pointer stays device-local or advisory; it is never cloud-authoritative in a destructive path.
- Progress / settings sync needs an edit-version cursor (timestamp), not push-order coalescing.
- Continuity apps optimize launch for instant local current; sync correctness happens after the user is already in context.

## Refinement (2026-06-02) — context-cue Cue model

Grilling the context-cue axis sharpened Edit-timestamp merge into three rules:

- **The timestamp MUST be last *user-input* time — never last save / update / sync time.** A device that auto-saves on resume after a week carries a fresh *save* time but week-old *input*; only user-input-time makes it correctly lose (the lock-5-min-actually-1-week bug).
- **Merge is additive — it never deletes.** A missing entry is never a deletion; deletion is a separate explicit op (out-of-band, blocking, Destruction-gate). This subsumes any shrink-guard / tombstone.
- **The library exposes a Merge interface (app-supplied), staying data-agnostic** (like the provider abstraction). It guarantees user-input-time inputs + additive output; the app decides field precedence (position = newest user-input; bookmarks = set union).
- The Cue (`{pointer, progress}`) lives in **localStorage** (synchronous → loads first), cloud as SSoT. Pointer = low-safety (Singular-synced / Separated-device-local); progress = higher-safety (additive per-entry merge, never-drop). Arrangement is *not* part of the Cue — it is the cloud folder tree, handled by the block/hamster layer (explicit, blocking ops).
