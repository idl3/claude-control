---
feature: artifact-side-panel
phase: b
tier: feature
autonomous: true
complexity-budget:
  files: 5
  loc-delta: 350
adopted-patterns:
  - matchMedia (useIsNarrow hook)
  - SubAgentPanel drawer CSS
  - native <details> → controlled useState
umbrella-branch: SKIPPED
---

# Phase B — Tabs, mobile sheet, trigger split

> **Scope**: Tab strip of recents (LRU 8), mobile bottom sheet, tap-name/caret-peek trigger split, a11y.
> **Design**: TBD (~/.claude/plans/artifact-side-panel.md)
> **Branch**: main (commit-to-main workflow)

## Status

| State | Tasks |
|---|---|
| todo | B1, B2, B3, B4 |
| done | — |

<!-- CP0 log: emitted by 100x:commit-plan; tier feature; umbrella SKIPPED -->

## Task list

### B1 — Tab strip of recents
> **Goal**: Panel header is a `role="tablist"` of recent artifacts — roving-tabindex, dedup by id (reopen → move-to-front + select), LRU cap 8 (evict oldest = tab leaves strip), per-tab close, close-active → select neighbour, close-last → panel closes. Body `role="tabpanel"`.
> **Files**: web/src/components/ArtifactPanel.tsx, web/src/components/ArtifactContext.tsx, web/src/styles.css
> **Acceptance**: Opening 9 distinct artifacts keeps 8 tabs (oldest gone); reopening an existing one re-selects without adding a tab; closing the last tab closes the panel.
> **Verification**: cd web && npm run build
> **Depends on**: A4
> **Reversibility**: clean-revert

### B2 — Mobile bottom sheet
> **Goal**: <760px, the panel renders `data-mode="sheet"` — `position:fixed` bottom-anchored, height = state (dvh); drag handle uses pointer events + `setPointerCapture`, snaps to {peek ≈40dvh, full ≈90dvh} or closes below ~25dvh; `touch-action:none` on the handle only; body `overscroll-behavior:contain`; `prefers-reduced-motion` disables the snap transition.
> **Files**: web/src/components/ArtifactPanel.tsx, web/src/styles.css
> **Acceptance**: On a narrow viewport, opening an artifact shows a draggable sheet over the chat; chat scrolls at peek; dragging down past threshold dismisses.
> **Verification**: cd web && npm run build
> **Depends on**: B3
> **Reversibility**: clean-revert

### B3 — useIsNarrow hook + mode switch
> **Goal**: A `useIsNarrow()` hook (`matchMedia('(max-width:760px)')`, subscribed) drives split-vs-sheet; the SAME ArtifactPanel renders in-flow (split) or fixed (sheet) by mode.
> **Files**: web/src/hooks/useIsNarrow.ts (new), web/src/App.tsx
> **Acceptance**: Crossing 760px live switches presentation without remounting/losing artifacts.
> **Verification**: cd web && npx tsc --noEmit -p tsconfig.json
> **Depends on**: A3
> **Reversibility**: clean-revert

### B4 — Trigger split (name→panel, caret→peek)
> **Goal**: Replace `ToolPart`'s `<details>/<summary>` with a controlled row — caret button toggles a local `useState` inline peek; the name is a button calling `open()`. Code `CodeHeader` gets an explicit open-in-panel button (code stays inline). Openable only when there's content. Focus to panel on open, back to chat on close.
> **Files**: web/src/components/MessageParts.tsx, web/src/components/MarkdownText.tsx, web/src/styles.css
> **Acceptance**: Tapping a tool name opens the panel; the caret toggles a short inline preview independently; code blocks show an open-in-panel control.
> **Verification**: cd web && npm run build
> **Depends on**: A4
> **Reversibility**: clean-revert

## Dependencies between tasks
A4 → B1; A3 → B3 → B2; A4 → B4.
