---
feature: cockpit-prototype-studio
phase: a
tier: feature
autonomous: true
complexity-budget: { files: 8, loc-delta: 600 }
adopted-patterns: [reserved-box discipline, vitest conventions]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase A — Chrome, suppression, dedupe (no AppFrameLayer files)

> **Scope**: Open rename + fullscreen affordance + StudioModal shell + hotkey suppression seam + styles dedupe. AppFrameLayer.tsx and ArtifactPanel.tsx hosting logic are OFF-LIMITS (other work owns/queues them).
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-a

## Status
| state | tasks |
|---|---|
| todo | A1, A2, A3, A4 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

## Audit item coverage
| Task | Rubric |
|---|---|
| A3 | T4 |

## Task list

### A1 — styles.css composer-token dedupe
> **Goal**: the byte-duplicated composer-token CSS block (collision from #190/#191) exists exactly once.
> **Files**: web/src/styles.css
> **Acceptance**: one copy remains; grep count for `.composer-goal-pill {` is 1; visual parity (composer highlight unchanged in a quick harness shot).
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: none
> **Reversibility**: clean-revert

### A2 — "Pin to panel" → "Open"
> **Goal**: the affordance reads Open (aria-label 'Open in panel'); all tests/assertions updated.
> **Files**: web/src/components/EmbeddedApp.tsx, web/src/components/AppFrameLayer.vitest.ts or embeds.vitest.ts (assertion text only)
> **Acceptance**: button renders 'Open in panel' label/tooltip; pin behavior unchanged; no test references the old label.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: clean-revert

### A3 — Hotkey suppression seam (capture-phase interceptor)
> **Goal**: one window keydown interceptor (capture phase, registered early in App mount) suppresses cockpit hotkey combos while a shared suppression ref is ON; NONE of the 20 existing keydown listeners are edited.
> **Files**: web/src/lib/hotkeySuppression.ts (new), web/src/App.tsx (one registration + provider), web/src/lib/hotkeySuppression.vitest.ts (new)
> **Acceptance**: with suppression ON, a synthetic Cmd+K reaches no existing listener (mounted test w/ spy listener registered after); OFF restores; Escape is never suppressed (carve-out); cleanup on unmount restores globals.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: load-bearing

### A4 — StudioModal shell
> **Goal**: fullscreen studio opens from a new Fullscreen button next to Open: translucent overlay (z 300), header (app name + version tag + close), device-mode bar with dynamic gating (modes wider than the screen are disabled w/ tooltip), suppression toggle (default ON, persisted per session), Escape closes; body shows a reserved placeholder frame ("hosting arrives in Phase B").
> **Files**: web/src/components/StudioModal.tsx (new), web/src/components/EmbeddedApp.tsx (button), web/src/styles.css, web/src/components/StudioModal.vitest.ts (new)
> **Acceptance**: opens/closes from an embed on desktop + 390px (gating shows only Mobile there); suppression toggles the A3 ref; z-order above panel sheet (200)/elevated hoists (210), below lightbox (1000); no reload of the app's iframe on open/close (it stays hosted wherever it was — Phase B moves it).
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false && npm run build
> **Depends on**: A3
> **Reversibility**: clean-revert

## Review sign-off checklist
- [ ] Cmd+K provably inert under suppression (spy-listener test)
- [ ] 390px gating verified
- [ ] PR targets umbrella branch
