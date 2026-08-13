# Content model is the single sync axis (auto-pull, precious side, conflict) — no separate Authority
> created 20260602

**Status:** **superseded by ADR-0007** (2026-06-01) for the share-file side — the Shared-doc/Cloud-mirror distinction collapsed into the Home axis + consent-on-commit + the Workbench (see [20260602-share-file-model.md](../20260602-share-file-model.md)). Retained for history; the Content-model vocabulary survives only as descriptive shorthand. The *precious-side* and *conflict* observations here still hold; *auto-pull* is now the file-enter check (ADR-0009).

Each Data class has one **Content model** describing how its bytes relate across devices. It is the *single* axis that determines whether auto-pull is allowed, which side is precious, and how conflicts resolve. Truth-ownership is folded in — there is no separate "Authority" concept.

Four values:
- **Shared-doc** — one document co-editable from any device, no version round-trip. Local-authored, precious **Work**; conflict → explicit consent / override guardrails; **never auto-pull**. (writing, drawing)
- **Cloud-mirror** — cloud is SSoT, local is a read-only cache. Content is cheap **Collection**, the **Arrangement** is precious; conflict → **auto-pull safe**. (readers, radio, RealHome)
- **Co-synced** — small low-stakes state both devices write (Attunement · Setting). Auto-merged by Edit-timestamp / last-write, no consent; must never silently overwrite precious data (see Attunement isolation, ADR-0004).
- **Device-local** — no sync, disposable. (ScratchPad)

**Auto-pull is permitted iff Cloud-mirror.**

## Why record it

The sibling scan found a real reversal — WebPaint forbids auto-pull, JustReadBooks embraces it. Same care, different Content model; without this a reviewer "fixes" one of them. An earlier draft expressed this with two near-identical axes ("Authority" {local/cloud/co} and "Content model" {Shared-doc/Cloud-mirror/Device-local}), both claiming to gate auto-pull. Collapsed to **one axis named Content model** — the concrete vocabulary actually used (google-doc vs hamster-hoard) — with a fourth value (Co-synced) absorbing the old `co-authoritative` Settings case.

## Consequences

- The sync library keys auto-pull, precious side, and conflict policy on a per-Data-class Content model.
- Preciousness (the 3-risk profile, ADR-0001) still governs eviction, Trash, encryption, and consent strength — but **not** auto-pull. Keep the two separate.
- Content model predicts the precious side (Shared-doc → Work; Cloud-mirror → Arrangement). It is **orthogonal to Pointer mode** (ADR-0003), which does not.
