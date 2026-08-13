# The Home axis + consent-on-commit (supersedes the Content-model axis)
> created 20260602

**Status:** accepted (2026-06-01) — supersedes ADR-0002 for the share-file (authored + hamster) side.

A file's behaviour is governed by its **Home** — the location of its authoritative copy — not by a per-class "Content model". **Home is local** for a Workbench (currently editing), a pinned file, a created/imported-not-yet-uploaded file, or any file when accountless; **Home is cloud** for an unpinned cached mirror. **Pin = the user declaring Home-local.** A Home-local file's cloud copy is an *untrustful declaration of relationship* — a backup reference that can never override the local home. **SSoT = the bound cloud if present, else local.**

This collapses the old `Shared-doc` vs `Cloud-mirror` distinction: every non-current file is a hamster mirror, the only mutable thing is the Workbench, and the difference between a Work and a consumable is no longer a storage model but **consent-on-commit** + a conflict-security level (ADR-0009).

## Why record it

ADR-0002 made auto-pull hinge on "Content model = Cloud-mirror," and treated Shared-doc and Cloud-mirror as different storage models. Grilling showed they're the same storage model (mirror + Workbench) seen from two Homes; the real driver is *which copy is Home* and *whether the user consented to commit*. Without this, a reader sees two axes where there is one, and "pin before edit" survives as needless ceremony.

## Consequences

- "Pin-before-edit" is removed; editing pulls a file into the Workbench (Home-local) automatically.
- Auto-pull is replaced by the file-enter check (ADR-0009): unpinned mirror → auto-update; pinned/Workbench → options.
- Accountless is structurally first-class: local files are originals, never disposable caches.
- The Content-model vocabulary in CONTEXT.md is retained only as descriptive shorthand, marked superseded.
- **Scope:** this governs share-file. The context-cue axis (ADR-0003/0004) is unchanged.
