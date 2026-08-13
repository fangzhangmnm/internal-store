# Workbench is a crash-shadow of RAM, not a source of truth; one working float
> created 20260602

**Status:** accepted (2026-06-01)

While editing, the **SSoT is RAM** (the live editor). The **Workbench in IndexedDB is just an autosave / crash-shadow of RAM**, never a second source of truth. The data flow is **RAM → IDB (Workbench) → cloud**: the editor always persists to IDB first, and the cloud syncs in the background *from* IDB on explicit consent.

The Workbench is a **float**: a new document never creates a gallery/cloud item before consent (Ctrl+S / smart-save); it may point to a last-save path, to null, or to a now-conflicted file. `shift-F5` recovers RAM from the Workbench; an open tab means RAM is alive and trusted. **ScratchPad is the same model with cloud disabled and the Workbench permanently an orphan.**

## Why record it

Making RAM the SSoT and demoting the Workbench to a crash-shadow dissolves the phantom-current-path class of data-loss bugs (AtlasMaker 0.7.2): a pure autosave can never be a destructive pointer. It also unifies four app shapes — drawing, writing, scratchpad, and the working copy of a reader — under one mechanism, and lets a user burn a throwaway doodle without polluting the gallery.

## Consequences

- A failed/blank load can never delete a real file, because the only mutable thing is the Workbench autosave, decoupled from the file's identity.
- Background cloud sync reads from IDB → the re-read-after-PUT race must be handled (20260602-cloud-ux-lessons.md §6).
- Timeout-lock flushes RAM → Workbench (always safe) before re-entry; RAM is trusted, never "distrusted".

## Refinement (2026-06-03)

**One IDB record per file, not a separate "Workbench copy" vs "pinned copy".** "Workbench" is just the record of the currently-open file. The earlier "Workbench and a pinned shadow are two distinct versions" consequence was wrong and is **withdrawn** — collapsing to one record per file `{ data, base-etag, uncommitted, unpushed, pinned }` removes the divergence bug. See ADR-0009's 2026-06-03 refinement and 20260602-share-file-model.md §The local store.
