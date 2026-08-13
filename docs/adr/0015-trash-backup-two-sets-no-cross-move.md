# `.trash` / `.backup`: two same-tier sets, delete = move, no cross-network move
> created 20260603

**Status:** accepted (2026-06-03) — refines ADR-0009 (`.backup`) and ADR-0014 (ghost)

## Context

`.trash` (delete) and `.backup` (preserve-before-overwrite) are the never-lose safety nets. Open questions: are they **cloud** folders, **local** folders, or **synced**? And what does a "delete" physically do?

## Decision

1. **Delete = move, not erase.** Deleting moves the binary into `.trash/` (a new non-colliding name); overwriting moves the old version into `.backup/`. **The folder *is* the deletion / override record** — there is no separate tombstone list.

2. **Two independent same-tier sets — no cross-network move.** A **cloud** binary's delete/override is a **cloud-side move** (into cloud `.trash`/`.backup`, no download); a **local** binary's is a **local-side move** (into local `.trash`/`.backup`, no upload). `.trash`/`.backup` are **never synced across the network** — you never upload a local backup nor download a cloud-trash item. *Cloud binary → moves within cloud; local binary → moves within local.*

3. **Device-loss is acceptable.** The local `.trash`/`.backup` is device-local and **not** backed up; losing the device loses it — fine, because this whole layer is a **fallback for network-sync errors**, not a primary feature. Cross-device recovery rides on the **cloud** `.trash`/`.backup`, which exists independently on the cloud tier.

4. **The local store is filepath-aware — a folder tree mirroring the cloud Arrangement** (not a flat GUID map). Local `.trash`/`.backup` are local sibling folders in that tree. The cloud folder tree remains the Arrangement SSoT (ADR-0005/0011); the local tree mirrors it.

## Why

Cross-network-moving the safety nets would (a) spend bandwidth on a *fallback* layer, (b) entangle the two tiers' recovery, and (c) risk re-uploading exactly what the cloud deliberately deleted. Keeping each tier's net same-tier is simpler and robust; the only cost — a lost device loses its *local* net — is acceptable because the **cloud** net already covers cross-device recovery.

## Consequences

- **Ghost `[delete]` (ADR-0014)** is a *local-side* move: clean → local copy into local `.trash`; dirty → un-pushed bytes into local `.backup`. No cross-move; "不用走 local trash 一遍" means no UX ceremony, not no safety-move.
- **Weak-override (ADR-0009)** stashes the cloud version *cloud-side* into cloud `.backup`, then pushes — same-tier.
- `.trash`/`.backup` are auto-pruned **per tier** eventually, never silently mid-session, never a forced UX step.
- Each tier's net is self-contained → an offline device can delete/override safely (local move) and the cloud reconciles its own net on its own ops.
