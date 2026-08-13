# Offline consented-upload replay on reconnect (per-app policy)

> created 20260701

**Status:** accepted (2026-07-01). Implements the **"consented pushes" half of the reconnect drain** that [state-machine.md §4](../20260604-state-machine.md) (`reconnect | drain the offline queue … consented pushes / arrangement ops`) and [potential-bugs.md E4](../20260604-potential-bugs.md) (`重连 → 自动 reconcile（drain 队列）`) **specified but never built**. App-agnostic family pattern; first consumer = JustReadPapers. Builds on ADR-0009 (conflict = surface), ADR-0015 (delete = move-aside, the *already-built* half of the drain), ADR-0016 (parentBase = the only If-Match), ADR-0017 (idle lock governs **pull**, not push), ADR-0008 (phantom-path).

## Context

The founding journal (`journals/20260601 sos.md:13`) set the intent: *"恢复 wifi 只会 conflict resolve 一下"* — reconnect is an **automatic** reconcile moment. The spec named the mechanism: on reconnect, **drain the offline queue in order (consented pushes / arrangement ops)**. Only the **delete** queue (ADR-0015; `drainDeleteQueue`) and the **folder-create** queue (`drainFolders`) were ever implemented. **The push-drain was never built** — no push/upload queue exists in the engine; an offline `file.save` leaves the file `unpushed=1` with nothing to complete it. The file waits for a **manual** re-save.

This was invisible while every app either (a) uploaded only online, or (b) had an explicit **Ctrl+S** the user would naturally re-press (WebPaint: an offline save prints *"已存本地…回到在线再 Ctrl+S 推云端"*). It became a real gap when **JustReadPapers enabled offline PDF upload (2026-07-01)**: JRP has no "push" gesture — dropping a PDF *is* the upload — so an offline-dropped paper saves locally but **never reaches the cloud**, silently breaking JRP's whole promise (*"随手存网盘 → 各端接着读"*). The paper is safe locally (dirty ⇒ never evicted) but invisible on other devices.

Two things had to be separated to decide correctly:

- **The consent gate is deliberate** (ADR-0016; state-machine §6 *"auto-upload iff additively-mergeable"*). An **opaque Work** (painting, PDF-as-bytes) is consent-gated because an auto-push cannot auto-merge a binary 412 → lost-update risk. A **mergeable** shape (Folder tree, reading-position collection) auto-syncs on a debounce — no conflict possible.
- **Completing a consented-but-deferred push is NOT a new consent.** state-machine §6: *"Offline-queue retry = **completing an existing consent**, not a new one."* The offline drop/Ctrl+S *was* the consent; re-pushing on reconnect completes it.

**Red-line audit (MASTER §A) — automatic replay violates none, *provided* it routes through the normal `If-Match` push path:**
- *No LWW / never silently overwrite*: a dirty-edit replay pushes `If-Match: parentBase`; a moved cloud → **412 → surfaced sheet**, never a silent pick (ADR-0016 §4). A never-synced upload has **no cloud version to overwrite**.
- *Partial/interrupted upload*: atomic `If-Match` commit + W1 (size+tail-byte) idempotency; a failed replay stays `unpushed` and retries — never writes a partial a later pull would adopt.
- *Provider dedup / same-name*: `conflictBehavior:"fail"` → `CloudNameCollisionError`, **both copies kept**.
- *Phantom-path (ADR-0008)*: the queue must carry **resolved per-item identity**, never `localStorage.currentPath` — exactly as the delete queue already stores `{name, baseEtag}`.
- **ADR-0017's "explicit > implicit" governs PULL, not PUSH.** Its hazard is *"a creator … who sees [the canvas] mutate on its own"* = **adopting newer cloud bytes under the user's eyes**. Pushing local→cloud changes nothing the user sees; it persists work already made. ADR-0017 says nothing about push.

**The never-synced case is categorically safe.** `parentBase = null` → no divergence is *possible*; the only adverse outcome is a same-name `CloudNameCollisionError` (both kept). **A dirty *edit to an existing synced* Work is the only case where auto-replay has a real cost** — not data loss (the 412 surfaces), but the UX friction of a stale offline change (e.g. a rename/move) popping a conflict on reconnect. That friction is the lived reason WebXiaoHeiWu *cut* auto-pull/auto-reconcile ([cloud-ux-lessons.md](../20260602-cloud-ux-lessons.md)).

## Decision

1. **Build the missing reconnect push-drain, scoped to never-synced consented uploads only.** On reconnect / boot / gallery-list, drain a **persisted unpushed-upload queue** through the normal push path (`If-Match: null` → establish ref; same-name → `CloudNameCollisionError` surfaced, both kept). **Dirty EDITS to already-synced Works are NOT auto-replayed** — they stay consent-surfaced (ADR-0016/0017). Mergeable shapes (Folder, reading-position collection) keep their existing debounced auto-sync. This is the exact parallel of `drainDeleteQueue`, for the "consented pushes" the spec always listed first.

2. **Per-app policy — store ctor `offlineUploadReplay: 'auto' | 'ask' | 'manual'`:**
   - **`auto`** — silently drain on reconnect (completing consent).
   - **`ask`** — on each **reconnect / successful connect**, if the queue is non-empty, **prompt** (`"N 篇离线上传，现在同步到云端？"`) → drain on confirm. Safe default for **metered / slow networks** (a large PDF on a bad link must not silently push).
   - **`manual`** — wait for an explicit user re-save (WebPaint's current behaviour-by-omission).
   - **WebPaint = `manual`** (unchanged until it opts in). **JustReadPapers = `ask`** (no push gesture + large PDFs over phone data → confirm-per-reconnect fits). The store selects behaviour off this flag exactly as `keepOnOpen` selects consumption mode — a per-app policy, not a red-line.

3. **Mandatory UI seam, no noop.** When policy ≠ `manual`, the drain **must** surface through a required `StoreUI` seam (an `ask` confirm for `ask` mode + a progress/collision status callback) — the same hard contract as `busy` / `resolveConflict` / `reportError`. The drain is **never silent**; a collision routes to `resolveConflict`/`reportError`, progress to a status line.

4. **Non-blocking — the drain never runs under `busy`.** Offline-upload sync happens **in the background**; the user keeps reading / browsing while it runs. There is deliberately **no full-screen overlay** for it (unlike a user-initiated destructive write). The cost of not serialising under `busy` is race exposure, handled by §5.

5. **Interruption- and race-safety (the price of §4's non-busy background drain):**
   - **Persisted queue** — a mid-upload app-close (large file, slow net) leaves the item **queued** (dequeued only after a *confirmed* push) → re-attempted next reconnect. No half-state is trusted.
   - **Idempotency (W1)** — size + tail-byte fingerprint detects "the upload actually landed but we lost the response" → **adopt, don't duplicate** (no dup cloud file after a flaky-network interruption).
   - **Atomic commit** — `If-Match` commit; a truncated upload is never adopted (MASTER §A partial-upload).
   - **Per-name serialize** — each drain push takes the store's per-name serialize lock, so it **never overlaps** a user `save`/`delete`/`rename` on the same file.
   - **Supersede** — a user `delete`/`rename` of a queued upload **dequeues** it; the drain re-checks *"still queued ∧ still local ∧ still never-synced"* under the lock before pushing, and skips a superseded item.
   - **Phantom-path (ADR-0008)** — the queue stores resolved per-item identity, never `currentPath`.

## Consequences

Offline-dropped papers reach the cloud on the next reconnect (JRP's promise restored) without crossing any red-line; opaque-Work edit divergence stays surfaced; WebPaint is untouched (`manual`). The un-decisioned gap between the spec (`state-machine §4` / `potential-bugs E4`) and the code (delete-queue-only) is closed. **Not covered here:** auto-replay of dirty *edits* to synced Works, and of stale offline *renames/moves* — those remain consent-surfaced by design; revisit only with a separate ADR if a mergeable-diff scheme for opaque Works ever exists.
