---
feature: prompt-optimiser
phase: b
tier: feature
autonomous: true
complexity-budget:
  files: 5
  loc-delta: 350
adopted-patterns:
  - web/src/lib/api.ts authFetch
  - .modal / PromptModal review-modal pattern
  - composer-toolbar (Send/AddAttachment) mount point
umbrella-branch: SKIPPED
---

# Phase B — Composer enhance UX

> **Scope**: enhance icon right of Send → background enhance → suggestion modal → Accept replaces composer text.
> **Design**: ~/.claude/plans/prompt-optimiser.md
> **Branch**: main (commit-to-main workflow)

## Status
| State | Tasks |
|---|---|
| todo | B1, B2, B3, B4 |
| done | — |

<!-- CP0 log: emitted by 100x:commit-plan; tier feature; umbrella SKIPPED -->

## Task list

### B1 — API client
> **Goal**: `web/src/lib/api.ts` `optimizePrompt(text, intent?) → {optimized,rationale,changes,mode}` via authFetch (POST /api/optimize).
> **Files**: web/src/lib/api.ts
> **Acceptance**: returns the parsed result; throws on non-OK.
> **Verification**: cd web && npx tsc --noEmit -p tsconfig.json
> **Depends on**: A4
> **Reversibility**: clean-revert

### B2 — Enhance icon (right of Send) + background trigger
> **Goal**: `Composer.tsx` — an ✨ enhance icon in `.composer-toolbar` to the RIGHT of the Send button (optional ⌘/Ctrl+O). Click → call `optimizePrompt(currentText)` in the background (icon→spinner; composer stays usable; disabled when empty) → on result open the suggestion modal.
> **Files**: web/src/components/Composer.tsx
> **Acceptance**: icon sits right of Send; clicking on a non-empty draft shows a spinner then opens the modal; empty draft → disabled.
> **Verification**: cd web && npm run build
> **Depends on**: B1
> **Reversibility**: clean-revert

### B3 — Suggestion modal (Accept replaces composer)
> **Goal**: new `web/src/components/OptimizeReview.tsx` — modal showing the SUGGESTED prompt (diff vs original) + rationale/changes + a mode badge (claude -p / rules). Actions: **Accept** → replace composer text with the suggestion (editable, never auto-send) · Edit · Discard. Reuse `.modal`/PromptModal (Esc/backdrop close, focus).
> **Files**: web/src/components/OptimizeReview.tsx (new)
> **Acceptance**: Accept sets the composer text to the suggestion; Discard closes with no change; Esc/backdrop close.
> **Verification**: cd web && npm run build
> **Depends on**: B2
> **Reversibility**: clean-revert

### B4 — Settings fields + styles
> **Goal**: `ConfigModal.tsx` adds `optimizeModel` + optional claude-bin path fields (no API key field); `styles.css` adds enhance-icon + diff/modal styling (reuse tokens).
> **Files**: web/src/components/ConfigModal.tsx, web/src/styles.css
> **Acceptance**: fields load/save via /api/config; enhance icon + modal render on-theme; no horizontal overflow.
> **Verification**: cd web && npm run build
> **Depends on**: B2
> **Reversibility**: clean-revert

## Dependencies between tasks
A4 → B1 → B2 → B3 ; B4 after B2.
