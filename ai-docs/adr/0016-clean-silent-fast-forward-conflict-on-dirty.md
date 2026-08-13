# Clean-state silent fast-forward; conflict & `.backup` only on dirty divergence
> created 20260606

**Status:** accepted (2026-06-06) — **IMPLEMENTED in pilot (node-tested; real-device regression pending)**. Refines ADR-0009 / ADR-0014 / ADR-0015. See "Pilot impl — landed" below.

## Context

WebPaint (the `sync-store` pilot) shipped the conflict model and real-device testing surfaced **`.backup` spam on serial two-device editing**: A edits→saves, B edits→saves, A→…, and *every* handoff produces a new `.backup` (cloud weak-override + local pull-on-open each stash a copy).

Root cause is the **base-etag leapfrog**. A device's `base-etag` only advances on ① its own push (→ its own new etag) or ② open/pull (→ cloud etag). It **never learns the peer's push that landed while this device sat idle**. So on the next save `server ≠ my base` → 412 → conflict → `.backup`. A single mutable base-etag **cannot express causality**: at a 412, by definition `cloud ≠ base`, so the device can *never* prove "I have already seen this cloud version" — therefore **the 412 / conflict point can never safely silent-overwrite**. Do not try to fix it there.

ADR-0009's refinements *already* state the right rule — **"clean → take-cloud; dirty → options"** and **"`.backup` is gated by a dirty-test; a clean switch never spams a backup"**. The bug is that the pilot only honors "take-cloud" at **file-enter (open)**, not continuously while a clean file stays open — so a device that keeps a Work open while the peer edits leapfrogs anyway.

## Decision

1. **Silent fast-forward of a clean Work is a *feature*, not a risk.** A clean canvas (no `uncommitted` ∧ no `unpushed`) silently re-rendering to the peer's latest, in place, under the user's eyes is **desirable** (always-fresh / quasi-live-collab feel). User-endorsed 2026-06-06. Do not relitigate this as a UX hazard.

2. **"Clean → silent FF / dirty → surface" must hold *continuously*, not only at file-enter — but the network check is *event-driven*, never per-stroke.** A clean open Work fast-forwards to a newer cloud version on **focus / visibilitychange / online** events (the same cheap `fetchMeta`/etag check `open()` already does — *metadata only*; content pull happens only if the etag actually moved). It is **not** triggered by drawing. This dissolves the serial leapfrog naturally: putting down device A and picking up device B raises B's focus/visibility → B fast-forwards to A's version **before** the user draws → B's first stroke is rooted on the latest → B's save is a clean `If-Match` push (**zero 412, zero `.backup`**). Two screens focused at once = genuine concurrent editing → conflict, correctly.

3. **Conflict + `.backup` is reserved for true dirty divergence only** — `dirty ∧ cloud-moved-past-my-parent` (both sides have un-pushed edits from a common ancestor). This is the irreducible case for an opaque binary (no auto-merge); weak-override-via-`.backup` stays the resolution.

4. **Causality lives in a per-edit-session `parentBase`, captured at the `clean → dirty` seam — enforced in the deep module, network-free.** Not the leapfrogging single mutable base. The seam fires **once per edit-episode** (the `localDirty/cloudDirty` flip from clean → dirty, i.e. the first `mark` after a clean state) — **not per stroke**; once dirty, further strokes are local-only and never re-trigger it. At the seam the deep module does **no cloud call** — it just snapshots `parentBase = the current local base-etag` (the value the last *event-driven* FF / open / push set). At push it compares **`parentBase` vs server** — which is exactly the existing `If-Match`/412, so it's free: equal → silent FF push (no `.backup`); 412 → real divergence → `.backup` + sheet. *Bypass-resistance:* producing `dirty` must go through that one seam (the sole door — same single-deep-module discipline as ADR-0009 W2); **push throws if a dirty episode has no `parentBase`**, turning "a new edit path forgot the seam" from a silent lost-update into a loud failure. (See "AI-bypass" note below.)

5. **Out of scope here:** *background* convergence while the app is truly idle (no edit, no focus event) needs the store to poll/subscribe — i.e. become an **active agent**, not a passive call-driven library. A passive library cannot act when nobody calls it. That is a separate, larger decision; this ADR only covers the **edit-/focus-triggered** fast-forward, which already covers the serial-handoff case that matters. **(Update: the *foreground/present* slice of this is now taken — in bounded form — by [ADR-0017](0017-foreground-freshness-staleness-lock-manual-refresh.md): a bounded foreground poll + wall-clock staleness lock + manual refresh. Truly-idle *background* convergence remains out of scope.)**

6. **Device-local view state must not live in the synced Work bytes.** Embedding `viewport` (zoom/pan) etc. in the `.ora` makes two devices with identical pixels produce different bytes → the W1 byte-equality heal (412-idempotency, ADR-0009) never matches cross-device, and a *pure pan + save* registers as a content conflict. View state is per-device UI, not Work content — keep it out (or heal compares only pixel-bearing parts).

7. **Hard cost ceiling (non-negotiable): zero network in the drawing hot path.** Per stroke = **0** cloud calls. Per edit-episode = **0** (the seam is local-only). Cloud `fetchMeta` fires **only** on focus / visibilitychange / online while clean (event-driven, human-paced — a handful per session), and a content pull happens only when the etag actually moved. Saves stay Ctrl+S-driven (+ 3-min / visibility autosave), unchanged. If any design turns "fast-forward" into a per-stroke or per-edit poll, it is **wrong** — reject it.

## Why

The only place a silent overwrite is provably safe is **before you have edits to lose** — i.e. while clean, where adopting the peer's version is a *fast-forward*, not an override. ADR-0009 forbids unsolicited override of a Work; relocating convergence to the clean state respects that *and* eliminates the spam, because a clean FF destroys nothing. Trying to be "smart" at the 412 (e.g. "if my base already passed it, overwrite") is unsound: a single etag is opaque and acausal, and at a 412 you have by construction *not* seen the cloud version.

**On enforcing it in the deep module (the "AI will bypass it" worry):** full background convergence can't be forced into a passive library — idle means nobody calls it. But the serial case *can* be forced by owning the two transitions the library does control — `clean → dirty` (capture `parentBase`, fast-forward) and `push` (compare `parentBase`, throw if absent). The structural lock is that `dirty` has exactly one constructor (the begin-edit seam); a future contributor (human or AI) adding an edit path either goes through it or produces an un-pushable doc that throws — discipline becomes a failing test, not a code-review hope.

## Consequences

- HIGH-tier conflict UX shrinks further: the "keep / pull / branch" sheet (and `.backup`) fire **only** for dirty divergence. Clean opens/handoffs are silent and lossless.
- `_safePull` must honor the dirty-test it currently violates: skip the local `.backup` when the local copy is clean (it's a re-fetchable known version — nothing unseen to lose). Matches ADR-0009 "a clean switch never spams a backup."
- One more reason view/UI state belongs out of the Work file (also helps W1 heal and cross-device byte-identity).

## Pilot impl — landed (2026-06-06, node-tested; real-device regression pending)

WebPaint `src/store/` + `app.js` now implement this decision (node adversarial tests green; **not yet real-device verified** — WSL can't open a browser). Touch points, all done:

- **Store:** `parentBase` authority (`_parent` Map) captured at the `clean → dirty` seam (`cloudState.setDirty(name,true)` false→true edge); push uses `parentBase` as the sole `If-Match` source (cross-tab `cloud.getETag` fallback in `baseFor` **removed**); push **throws** on dirty-with-known-base-without-parentBase (bypass guard); `adoptBase` re-captures for already-dirty items so a dirty episode survives reload.
- **App:** `flow.refresh(name)` = event-driven clean fast-forward, called from focus / visibilitychange / online (reused the SW-update-poke hooks) via `maybeFastForwardActive`; gated on clean; viewport preserved across FF. **Not** per-stroke. `flow.open` now silently fast-forwards a clean doc (no sheet) and only surfaces keep/pull/branch on dirty divergence.
- **Encode:** `viewport` dropped from **all** `.ora` bytes — local IDB save and cloud sync both omit it (`_buildOraMeta`, single shape), so all `.ora` bytes are uniform (local == cloud). Trade-off (user-chosen 2026-06-06): reopen always `fitToScreen`, viewport not remembered; the *live* event-driven FF preserves the in-memory viewport (no byte involvement) so a background fast-forward doesn't jolt the view. (An earlier "viewport in local bytes only" variant was rejected — local≠cloud bytes for the same version is a smell, and rename-of-a-non-active item would leak viewport into the cloud file.)
- **`_safePull`:** local `.backup` gated on `uncommitted ∨ unpushed` (clean fast-forward no longer spams `.backup-local`).
- **Wiring fix:** app's `setCloudDirty` now routes through `store.cloud.setDirty` (the seam) instead of the low-level `cloud.setDirty`, so the edit path actually captures `parentBase`.
- **Did NOT** add background polling (still the separate active-agent decision, §5).

**Real-device verify list:** serial two-device handoff no longer spams `.backup`; clean device picking up auto-renders peer's latest before drawing; two screens focused at once still surfaces conflict on save; pure pan + save no longer registers as a content conflict; a dirty doc edited across a reload still pushes (no spurious bypass throw).
