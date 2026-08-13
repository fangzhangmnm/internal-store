# Share-file conflict model: two check vectors, override-permission dial, `.backup`
> created 20260602

**Status:** accepted (2026-06-01)

The only conflict surface is **Workbench → cloud**, checked at two moments. **No unsolicited override is ever allowed** (old must never silently clobber new); the accepted lesser evil is duplicate-spam, mitigated by `.backup/`.

**Vector 1 — consent-save.** The conflict-security level is *which override operations are permitted*:
- **HIGH** (manuscript, painting): hard-override of the cloud is **forbidden even with user consent**. Options: no-op · rename-and-push · **weak-override** = stash the cloud version into `.backup/` then push (never lossy).
- **MEDIUM** (brush rack): hard-override-cloud is allowed (keep-local · override-from-cloud · override-cloud).

**Vector 2 — file-enter / session-start** (etag check; must fall back to local when offline — deferred). Cases: unpinned shadow → auto-update; pinned shadow → options (override-local stashing local to `.backup` · no-op · rename-local); Workbench → same, with Workbench and the pinned shadow kept as two distinct versions.

**`.backup/`** is the universal preserve-before-overwrite folder — symmetric (cloud and local), **always a new non-colliding name**.

**Timestamps everywhere are user-action-time** (the last user action, never save/update/sync) — both for choosing the surviving branch and for showing the user "last edited X ago". This is the same clock as context-cue merge (ADR-0004) and is the reason the Ready-gate (ADR-0010) must block input until Re-entry resolves: a stray touch on stale content would re-stamp it *now* and pick the wrong branch.

## Why record it

Earlier designs offered pull / keep-local / save-as-branch at every conflict, which is confusing and — for a Work — *wrong*, because "pull/override" can destroy authored work. Pinning the rule "HIGH forbids hard-override, only weak-override-via-`.backup`" makes never-lose structural: even the user cannot delete their newer work by overriding. The MEDIUM tier exists so a brush rack doesn't interrupt the user with the full ceremony.

## Consequences

- HIGH conflict UX needs only {no-op, rename-push, weak-override}; no "pull" at save time (you're committing, not opening).
- `.backup/` and `.trash/` are sibling system folders, never name-collide, never auto-pruned silently.
- Timeout-lock (ADR-0008) is a *soft* staleness guard; this save-time check is the hard never-override guarantee.
- Offline-fallback for Vector 2, name-conflict handling, and version-conflict UX are deferred (see 20260602-share-file-model.md §7).

## Refinement (2026-06-02) — base-etag mechanism; no git tree; eviction invariant

- **Conflict detection = a single per-Workbench `base-etag` + `If-Match`.** Record the etag at open; push `If-Match: base-etag`; a 412 *is* a real divergence. No list of etags, no version history — `If-Match` answers "is the cloud still my direct ancestor?" for free, and **etag (RFC 7232) is provider-agnostic** (prefer it over a proprietary versions API — anti-abandonware).
- **No git tree** — a full version tree of large binary works is storage-prohibitive and can't auto-merge; restore-to-previous is the provider's concern. *Logged so it isn't re-proposed.*
- **`.backup` is gated by a dirty-test** — stash only on genuine uncommitted edits; a clean switch never spams a backup.
- **Eviction invariant (storage-layer, not UI): a Workbench is evictable iff `clean ∧ re-fetchable`.** Otherwise `evict()` retains it (auto-pinned) + `.backup` if dirty. Enforced in the deep module, not by a disabled UI button. Opening a *different* file triggers the guarded eviction; quitting to the gallery evicts nothing → offline-safe (the plane case dissolves: offline ⇒ not re-fetchable ⇒ not evictable).

## Refinement (2026-06-03) — one-record model, validated

- **One IDB record per file** `{ data, base-etag, uncommitted, unpushed, pinned }` (RAM → record → cloud). **"Workbench" is no longer a separate copy / LRU=1** — it's the record of the open file. The old `localDirty/cloudDirty` become **`uncommitted`** (autosaved, not Ctrl+S'd — local-only by consent) and **`unpushed`** (committed, not yet on cloud); `dirty = either`.
- **Conflict is `dirty ∧ cloud-moved`, not `pinned`.** Pin is orthogonal (durability/eviction only). The earlier Vector-2 "pinned shadow → options" was a bug: clean → take-cloud; dirty → options.
- **W1 — 412 idempotency:** a lost push *response* makes the retry's `If-Match` 412 against the client's *own* write. On 412, compare the cloud content to what we'd push: equal → success (adopt etag, clear `unpushed`); differ → real conflict.
- **W2 — structural deep module:** push-serialize (**per-file**), the eviction guard, idempotency, `If-Match`, consent-on-commit, list→bulk-cache-invalidate, and the Ready-gate are all enforced in one deep storage module — never by UI. Multiple simultaneous conflicts **queue** (one sheet at a time). Auth-401 surfaces as `unpushed` (never silent), silent-re-auth + retry on reconnect.
- **Adversarially validated** (flaky network · button-mash · auth-expiry · two-iPad edit-A/B drama): each file converges independently via `If-Match + .backup + sheet`; the server's atomic `If-Match` precludes lost-update. The skeleton is the standard local-first + etag optimistic-concurrency pattern (CouchDB/PouchDB, S3 conditional, Git working-tree→commit→push); only the consent/no-auto-merge UX is bespoke.
