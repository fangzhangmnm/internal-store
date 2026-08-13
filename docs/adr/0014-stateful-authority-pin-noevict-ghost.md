# Stateful authority, pin = no-evict, and the cloud-delete ghost
> created 20260603

**Status:** accepted (2026-06-03) — refines ADR-0007 (Home axis) and ADR-0009 (conflict model)

## Context

The model oscillated between "**local is SSoT**" and "**cloud is SSoT**." Pin had quietly accreted three meanings (durability + "don't silently overwrite" + "survive a remote delete"), and "what does no-evict mean when the cloud *deletes* a pinned file?" was ambiguous. Two concrete bugs surfaced while grilling:

- "Don't let the cloud silently overwrite a pinned file" ⇒ **`.backup` flood** when alternately drawing the same file on two devices.
- Keeping a permanent record for a cloud-deleted file ⇒ the **WebXiaoHeiWu ghost-flood** ("怎么删都删不干净").

## Decision

1. **Authority is stateful, not a per-file flag.** While a record is **dirty** (un-synced edits — `uncommitted ∨ unpushed`) the **local copy is authority** (the cloud cannot clobber in-progress work). While **clean**, the **cloud is authority** (changes flow down). "local-is-SSoT" was *always* only the dirty state; "cloud-is-SSoT" the clean state — one model, authority shifts with dirty/clean. **Conflict is exactly `dirty ∧ cloud-moved`** — independent of pin.

2. **Pin = no-evict, and nothing else.** It keeps a durable local copy under cache pressure / long offline. It does **not** change authority, does **not** make a cloud-change a conflict, and carries **no** "don't-silently-overwrite" rule. (Withdraws the "pin ⇒ Home-local ⇒ cloud can never override" framing and the session's earlier "pin survives delete" property.)

3. **clean + cloud-moved → auto-take on enter** — lossless, so **no prompt and no `.backup`**. Alternating cross-device edits never spawn backups as long as each side is clean on return (each pushed before switching).

4. **The ⟳ "newer-on-cloud" badge stays** (informational, in the gallery). Without it: *didn't enter to refresh + airplane mode = unknowingly stuck on the old version*. Pinned files are **not** silently background-refreshed — the badge is the signal; enter (or tap the badge) refreshes — so you can top-up before going offline.

5. **`.backup` appears in exactly one place: a `dirty ∧ cloud-moved` real conflict** (the weak-override option stashes the loser). Never on a clean take.

6. **Cloud-delete handler = a visible, actionable 👻 ghost** for any file that *has a local copy* (i.e. **pinned ∨ dirty** — a clean unpinned file has no local copy ⇒ no ghost, no flood). The ghost offers **[reupload]** (re-create on the cloud) and **[delete]** (drop locally). This disambiguates no-evict at delete time: no-evict means "don't auto-drop for cache pressure"; a cloud-delete is a *distinct event* resolved by **explicit user choice**. The ghost is **visible** (a hidden ghost = doesn't-exist — useless) and **rare** (only deliberate/dirty files) ⇒ no flood.

7. **No local `.trash` ceremony for the ghost-delete.** Recovery already exists: the cloud's own soft-delete (cloud `.trash`) + the **[reupload] escape present at decision time**. For a **dirty** ghost, **[delete] routes the un-pushed version to `.backup` first** (never bare-lose un-pushed work).

8. **The folder-list is cached** (offline-robust is first-class). Offline shows the last-known list; only **local/pinned/dirty** items open; uncached items are **hidden + "N 项需联网"** hint (anti-ADHD), never per-item "unavailable" rows.

## Red-line check

The ghost-delete does **not** violate *never-silently-lose*: it is an **explicit user choice** (not silent), the **[reupload]** escape preserves the work at decision time, the cloud soft-delete keeps a recoverable copy, and a dirty ghost's `[delete]` routes to `.backup`. The local `.trash` is skipped only because recovery already exists elsewhere — not because loss-safety is dropped.

## Consequences

- **Supersedes** ADR-0007's "Pin = declare Home-local / cloud can never override." Home now means *binding/durability*, not a fixed SSoT; the SSoT question is answered by stateful authority.
- The session's earlier "pin survives delete" property (and ADR-0008's withdrawn "two distinct versions" line) are replaced by the single ghost handler.
- **Gallery badge set:** `↑ unpushed` · `⚠ conflict` (dirty ∧ cloud-moved) · `📌 pin` (no-evict) · `⟳ newer-on-cloud` (clean, auto-takes on enter) · `👻 ghost` (cloud-deleted but locally-held → reupload/delete). **No hidden ghosts.**
- **Cloud-agnostic, no delta API:** "disappeared from the list" needs no delete-vs-transient discrimination, because the safe action is identical either way — drop a clean unpinned list-entry (re-fetches if it returns), keep pinned/dirty (→ ghost). A whole-list-empty/shrink is a failed-fetch guard (don't reconcile).
