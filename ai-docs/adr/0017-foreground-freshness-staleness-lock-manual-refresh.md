# Foreground freshness: bounded auto-check + staleness lock + manual refresh
> created 20260606

**Status:** accepted (2026-06-06). Resolves the part of **ADR-0016 §5** that was deferred ("background convergence while truly idle"), in a **bounded** form. App-agnostic family pattern (WebPaint, JustReadBooks, WebXiaoHeiWu, …). Builds on ADR-0016 (`flow.refresh` = clean fast-forward) and ADR-0004 (user-action-time).

## Context

ADR-0016 made a clean open Work fast-forward to the cloud's latest on **focus / visibilitychange / online** events, and explicitly **deferred** the "app is foreground but nobody switched focus" case (§5): the device sits on the canvas/reader, a peer pushes, and nothing fires an event → the user only converges by leaving and coming back. Deferring it kept the store a passive call-driven library rather than an "active agent."

Real-device use (WebPaint, 2026-06) showed this gap is felt: to pick up the peer's version you have to exit to the gallery and re-enter. Sibling apps that show *live-ish* shared state (a reading position synced across phone/tablet, a shared list) hit the same wall. The family already converges on a UI idiom for it: a **freshness indicator that greys out when stale, tap to refresh**.

The hard part is **not** the polling — it's **staleness across suspend**. A PWA's `setInterval` does **not** fire while the tab is backgrounded / the device is asleep. If "freshness" is tracked by counting timer ticks, a device closed for a week reopens believing it is still fresh (no ticks elapsed in its mind) and shows stale data as current. Freshness must be a function of **wall-clock time since the last confirmed check**, evaluated **on resume**, not of timer activity.

## Decision

1. **Freshness is a wall-clock property of the active synced item, not a timer artifact.** Track `lastCheckedAt` = the time of the last *successful* cloud freshness check (a metadata/etag probe) for the currently-open item. The item is **fresh** while `now − lastCheckedAt < STALE_AFTER`, **stale** otherwise. All staleness decisions read this timestamp; **nothing trusts "the timer kept us fresh."**

2. **Re-evaluate freshness on every resume signal, and that is the load-bearing trigger.** On `visibilitychange→visible` / `focus` / `online` / cold-start, recompute `now − lastCheckedAt`. This is what makes the 1-week-suspend case correct: the timer was dead the whole time, but the first resume sees a huge elapsed interval → **immediately stale** → triggers a check. **Never** replay missed ticks; do **one** check and reset `lastCheckedAt`.

3. **No silent foreground convergence — idle ⇒ an explicit lock screen.** *(Revised 2026-06-06 — supersedes the original "bounded silent poll" draft, which was wrong.)* A clean open item that goes **idle** (no draw / no operation / no dirty for `IDLE_LOCK_AFTER`, e.g. a few minutes) raises a **lock screen** over the work — the same idiom as an idle device dimming/auto-locking. The screen covers the canvas; **nothing is fetched or adopted yet**. Convergence happens **only when the user explicitly taps "continue"** — then (and only then) it checks the cloud and fast-forwards a clean item (ADR-0016 `flow.refresh`). Any content change is therefore **behind the lock, after an explicit tap — solicited, never witnessed as a mutation under the user's hand**. The lock is gated to exactly the case a silent poll would have fired: **foreground ∧ active item ∧ clean ∧ signed-in ∧ online ∧ idle-long-enough**; dirty / offline / in-gallery → no lock.

4. **The lock screen *is* the staleness surface; a tap *is* the refresh.** There is no separate greyed-icon-then-poll dance. Idle → lock; tap continue → explicit check + fast-forward + unlock with the latest. (A lighter always-tappable refresh affordance on the save control may complement it — also explicit, also no silent change — but the lock is the primary gate.) Manual refresh must work whenever (just-opened, offline→online, etc.).

5. **Hot-path zero-network is preserved (ADR-0016 §7 still holds).** The auto-check is human-paced (minutes, foreground-only) and does **metadata/etag only** (content pull only when the etag actually moved). It is **never** per-stroke / per-edit / per-scroll. A dirty item never auto-fast-forwards (would clobber unpushed edits); it stays stale-but-mine until the user saves/resolves.

6. **App-agnostic.** "Active synced item" is the Work (WebPaint), the reading position (JustReadBooks/Papers), the list/Cue (WebXiaoHeiWu) — anything with a per-item `lastCheckedAt` and a cloud freshness probe. The mechanism (timestamp + resume-recompute + bounded foreground poll + stale indicator + manual refresh) lives at the sync layer / shared UI idiom, framed around an opaque "item," **not** around any one app's edit verb (drawing, page-turn, …).

## Why

**Unsolicited content change is intolerable for content creation.** The original draft of this ADR proposed a bounded *silent* foreground poll that fast-forwards under the user. Real-device feedback killed it: a creator staring at the canvas who sees it **mutate on its own** — even to a "correct" peer version — reacts with alarm, not delight. ADR-0016 §1's "silent fast-forward is a feature" holds **only when the user is *not* present at the moment of change** (returning via an explicit open / gallery round-trip — they expect freshness on arrival). While the user is *present and idle*, the right idiom is the one every device already uses: **idle ⇒ lock; tap ⇒ resume**. The lock makes the subsequent change **solicited** — the user asked to continue, the cloud version arrives behind the cover, and they never watch their work twitch. "explicit > implicit" is the governing rule here.

This also keeps the store passive in spirit: it does not act on data nobody is looking at, and it never acts *without an explicit user gesture* while someone *is* looking. And anchoring freshness/idle to **wall-clock timestamps recomputed on resume** is the only correct way under a runtime that freezes timers: the alternative (tick-counting) silently presents week-old state as fresh — and a device asleep for a week must, on wake, see the lock, not stale-pretending-fresh content.

## Consequences

- The app gains per-active-item `lastActivityAt` (idle clock) and `lastCheckedAt` (cloud-freshness clock), both wall-clock. Activity resets on draw/operation/dirty.
- An idle-check (fires the lock) + a lock screen + an explicit refresh on continue. **No silent foreground fast-forward exists.** The idle-check timer is best-effort; **correctness rests on resume-recompute** (lock shows on the first visibility/focus after wake) and the **explicit tap**, never on a timer firing.
- ADR-0016 §5's "separate larger decision" is now **partly** taken — and deliberately *not* via silent convergence: the *foreground/​present* case is handled by an explicit lock gate. Truly-idle background convergence (push subscriptions / service-worker sync) remains out of scope.
- Per-app `IDLE_LOCK_AFTER` / `STALE_AFTER` (default a few minutes; WebPaint ≈ 3 min). Dirty items never lock and never auto-FF (the user's unpushed work stays put).

## Pilot

WebPaint implements first (extends ADR-0016's `flow.refresh` + `maybeFastForwardActive`): wall-clock `lastActivityAt` reset on pointerdown/keydown/edit, an idle-check tick + visibility/focus/online recompute that raises a **lock screen** (reusing the sync-gate overlay) when a clean synced doc has been idle ≥ ~3 min, and convergence (`flow.refresh`, behind a blocking busy) only on the explicit "continue" tap. The save control also shows a blue cloud (fresh) / refresh-arrows (stale) that refreshes on tap — also explicit. **No silent foreground content swap.** Siblings adopt the same idiom.
