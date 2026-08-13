# Four storage shapes; the brush rack is a Folder, not a singleton blob
> created 20260602

**Status:** accepted (2026-06-02) · **refined 2026-06-06: four shapes → two (Work-file, Folder) + orthogonal dials; see Refinements below.**

> ⛔ **Superseded in part — 2026-06-07.** The **in-file GUID identity** mechanism this ADR introduced (Folder = "GUID-keyed" tree; identity rides in a byte-range thumb/header block) was tried on real devices and **rolled back**: identity is now **path/name**, format-agnostic, **no minted id, no id↔path registry, no thumbnail required** (see `WebPaint/ai-docs/20260607-sync-identity-decision.md` + ADR-0012). The **storage-shapes** decision (Work-file vs Folder + orthogonal dials) and the Folder **merge model** (union, uat-LWW, `.trash`, `reset-at` watermark) remain **CURRENT** — only the *identity carrier* changed. Read every "GUID-keyed" / "stable GUID" / "same-GUID" below as **"name/path-keyed"**.

User data takes one of four shapes, each with its own conflict model:

- **Work-file** — an opaque single blob (canvas, manuscript). Whole-file conflict at commit only (ADR-0009): *leave / save-as / weak-override*. Sub-dial: **precious** (no hard-override) vs **reconstructable** (hard-override allowed).
- **Folder** — a tree of **GUID-keyed** files: the OneDrive content tree *and* the **brush rack** (a folder, not a singleton). Merge = **union** of active entries; same-GUID conflict → **duplicate** ⚠(refined 2026-06-06: this is a **per-class dial** `{duplicate | last-user-action-time-wins}`, not universal — see Refinement below); **rename / move = a mutable attribute on the stable GUID** (so mass-rename / re-subfolder never conflicts); **delete = move-to-`.trash`** (the `.trash` *is* the deletion record — recoverable, bounded, self-cleaning — not a parallel tombstone list); **factory-reset / replace-all = a `reset-at` `user-action-time` watermark** (merge drops any entry with `user-action-time ≤ reset-at`; the watermark is max-wins). ⚠(refined 2026-06-06: "tree of GUID-keyed **files**" is one **transport**, not the only one — the logical Folder can equally ride a **single blob of GUID-keyed entries**; see Refinement.)
- **Registry** — a thin flat map inside the Cue (bookmarks, progress, settings). Per-entry additive merge, last-`user-action-time`, never-drop (ADR-0004). ⚠(refined 2026-06-06: a Registry is just a **Folder on the Cue transport** — same per-entry merge engine — and collapses into Folder. See Refinement 2026-06-06b.)
- **Hamster mirror** — a cached consumable (drop-if-Home-cloud-and-bound; never silently for Home-local). ⚠(refined 2026-06-06: **not a shape** — the Substrate **eviction dial** (`evict-iff-clean∧refetchable`), orthogonal to shape. See Refinement 2026-06-06b.)

`.trash` rule that makes Folder merge safe: **`.trash` presence = a real deletion (propagate); mere absence from the list = transient (empty-list safety net — never delete on absence).**

## Why record it

The brush rack first looked like "a singleton blob with lower security." But a *singleton* can't keep-both (rename/sibling-copy is impossible — there's only one active rack), and a *blob* can't merge — so two devices editing *different* brushes would silently lose one. Modeling the rack as a **Folder of GUID-keyed files** dissolves both: each brush is a duplicable file, so union-merge is lossless for different brushes and "duplicate" handles a true same-brush clash. GUID-identity removes the mass-rename / re-subfolder hazard. `.trash` + a single `reset-at` watermark cover deletion and factory-reset without any parallel tombstone or generation structure.

## Consequences

- Brushes (and folder files generally) carry a **GUID** — identity is the GUID, never name/path.
- The rack reuses the *entire* file-system model: re-entry folder-list, `.trash`, blocking folder-ops for mass-import/rename/move/factory-reset.
- Only **one** extra synced field on a Folder: `reset-at`.
- Losing a brush is rare (you **pull-before-edit** via the Ready-gate) and acceptable + recoverable (`.trash`).
- "HIGH vs MEDIUM security level" was a mis-frame: it's **blob vs folder**, plus the precious/reconstructable sub-dial on blobs.

## Refinement (2026-06-03) — GUID identity for *all* files; it lives in the byte-range thumb block

- **Identity = a stable GUID for every file, not just Folder-items.** Path (folder + name) is a **mutable attribute** keyed on the GUID. **rename / move = same-GUID, new-path** → reconcile matches by GUID → a folder reorg never spawns duplicates (the "duplicate" outcome is reserved for a true same-GUID clash, last-resort). This also dissolves the *rename-a-currently-open-dirty-file* edge: the GUID is unchanged, the dirty record (keyed by GUID) survives, the next push targets the new path — no copy+delete fight.
- **The GUID rides in the byte-range-readable thumb/header block** (chosen over filename-embedding and per-folder manifests). For our containers this is *free*: the outer plaintext STORE zip already names its payload entry by the GUID, and a zip's central directory sits at the **tail** — so the **same one-shot byte-range tail read** that fetches the thumbnail also yields the GUID (ADR-0012). Reconcile/dedup therefore reads identity **without a full download**, **cloud-agnostic** (zip bytes, not a backend item-id), and **even on locked files** (the GUID is the *outer plaintext* entry name; it's an opaque token, so exposing it leaks no content — only your-own-device linkage, which sync wants).
- **Local store keeps a `GUID ↔ path` index** so in-app moves are zero-read (we did them). Only an **out-of-band move** (the user reorganizing directly in OneDrive) desyncs the index → re-matched on the next list by byte-range-reading the GUID of just the changed files (bounded cost). A **foreign file** dropped into OneDrive (no GUID inside) gets a GUID assigned on first sight *(mechanism deferred)*.
- This is the **"existence value" of the thumb block**: it is not only a preview — it is the cheap, partial-download, cloud-agnostic carrier of **identity + name/ext + thumbnail** for listing, reconcile, and dedup.

## Refinement (2026-06-06) — the Folder body over-fixed three things as universal; they are per-class **dials** (ADR-0001)

The original body baked three universals into the Folder shape. ADR-0001 already says sync config is chosen **per Data class**, so these are **dials**, not laws — the logical Folder model (GUID-keyed entries · union over different GUIDs · `.trash` · `reset-at`) is unchanged; only the settings vary per class. (Driven out by the WebPaint brush-rack design; WebPaint's specific dial settings live in that app's `CONTEXT.md`, not here.)

1. **Same-GUID resolution dial** `{ duplicate | last-user-action-time-wins }`. Union over *different* GUIDs is always lossless and automatic (no conflict UI); the dial governs only the *same-GUID* clash.
   - *duplicate* (original body) — never lose, user prunes; right when each entry is precious and a clash is a genuine fork worth keeping both.
   - *last-user-action-time-wins* — apply ADR-0004's edit-time merge per entry: newer `user-action-time` entry wins, older dropped; right when entries are cheap / re-creatable and duplicate-clutter is worse than a rare lost edit. **The time MUST be last user-input time — never save / sync / upload time** (ADR-0004 red-line).

2. **Transport dial** `{ GUID-keyed files | single blob of GUID-keyed entries }`. The *logical* Folder is independent of storage. Many small entries with high per-file listing cost may ride **one transport blob** (merged in-library after a whole-blob pull); large entries stay **per-file**. Identity and merge semantics are identical either way. (A blob transport means whole-blob `If-Match` instead of per-file — acceptable when entries are small and co-edited rarely.)

3. **Backup-surfacing dial** (grades ADR-0015 per ADR-0001 preciousness). Whether a dropped / over-written entry is **surfaced for recovery** is graded: a Folder of re-importable entries may keep **no surfaced `.backup`** (loss-safety net = the user's own export / re-import); a precious Folder surfaces recovery. `.trash` (the deletion *record*, needed so "absence ≠ deletion" holds) is separate from `.backup` (the overwrite casualty) and remains **required for merge correctness regardless of this dial**.

**Also clarified — a Folder does not own the "active / current entry" pointer.** "Which entry is current" belongs to whatever **references** the entry (a Work-file, the Cue), and is resolved against the Folder by **GUID → name** fallback — it is *not* a field stored on the Folder. (The body's "only one extra synced field: `reset-at`" already implied this; spelling it out kills a recurring app-side hallucination that parks the pointer on the Folder. WebPaint hit exactly this: a vestigial `rack.activeByTool` that the real code never reads — the active brush is a per-painting ref.)

**Folder merge is deterministic — the callback has a built-in default.** Because a Folder entry is the atomic unit, the per-entry merge is fixed: **whole-entry LWW by `user-action-time`** + `.trash` (edit-wins) + max-wins `reset-at`. The engine needs only `{id, uat}` (plus `name` for the GUID→name reference fallback) and treats the rest of each entry as **opaque, JSON-serialized payload** — so brushes, filter/doc presets, and per-entity registries (e.g. per-book reading-position) reuse one engine with **zero injected logic**; the app supplies only the folder's cloud name. The merge is *technically* a callback, but the library ships the LWW default, so "no callback" and "app-supplied merge" are the two ends of one knob: the app overrides **only** for entries needing field-level merge (next section).

## Refinement (2026-06-06b) — the four shapes are really **two shapes + orthogonal dials**

Carrying the dials above to their conclusion (driven out by the WebPaint brush-rack + reader-progress designs): two of the four "shapes" were never distinct storage mechanisms.

- **Registry → Folder (one shape).** A Registry is just a **Folder on the Cue transport**. Both are id-keyed collections of `{id, uat, …}` entries merged per-entry; the merge defaults to **whole-entry LWW by `user-action-time`**, overridden **only** for entries with field-level merge (`position` = LWW but `bookmark-set` = union *within one record* — e.g. real bookmarks, later). "Registry" was never a separate merge engine. The only real axis separating the two is **transport/locality**, which stays an explicit, deliberate choice:
  - *own cloud blob, async load* — large / many entries (brush rack, filter presets); must not bloat boot.
  - *Cue (localStorage + synchronous boot-load)* — scalar entries needed instantly at launch (pointer, per-book reading-position); never-block Continuity (ADR-0010).
  - A degenerate Folder of **one** entry = a single LWW cell = the **pointer**.
- **Hamster is not a shape — it is the Substrate eviction dial.** "Cached consumable" = the `evict-iff-clean ∧ re-fetchable` rule (MASTER §A, ADR-0014) applied to a local mirror, **orthogonal to shape**: a cached blob = Work-file + droppable; a cached list = Folder + droppable. No separate Hamster conflict model exists.
- **Work-file stays distinct.** It has *no entries* and needs *human* conflict resolution (leave / save-as / weak-override, ADR-0009); it cannot collapse into Folder's automatic per-entry merge.

**Net taxonomy — two shapes + orthogonal dials:**

- **Work-file** — opaque blob, human whole-file conflict.
- **Folder** — id+uat entries · merge-callback (default = whole-entry LWW) · `.trash` · `reset-at` · transport = `blob | Cue` · **absorbs the old Registry**.
- **Dials** (ADR-0001, Substrate-enforced, orthogonal to shape): precious vs reconstructable · pin = no-evict · encryption · **droppable (= the old "Hamster")**.

The original "four shapes" framing is kept above for history; **this two-shape model is operative.**
