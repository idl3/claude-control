---
feature: cockpit-prototype-studio
phase: b
tier: feature
autonomous: true
complexity-budget: { files: 6, loc-delta: 500 }
adopted-patterns: [AppFrameLayer placeholder-hosting seam]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase B — Studio hosting + device modes

> **Scope**: 'studio' arbitration tier + device-mode placeholder resizing. ⚠️ HARD PREREQUISITE: the in-flight scroll-sync PR (feat/app-hoist-scroll-sync — sync repositioning, fade-during-scroll, elevate attr) MUST be merged first; branch this phase off the umbrella AFTER rebasing the umbrella on the main that contains it (or merge main→umbrella).
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-b

## Status
| state | tasks |
|---|---|
| todo | B1, B2, B3 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

## Audit item coverage
| Task | Rubric |
|---|---|
| B1 | T1 (arbitration), P1 |

## Task list

### B1 — 'studio' context tier
> **Goal**: placeholders may declare data-embed-app-context='studio'; pickHost prefers studio > panel > transcript while studio is open; studio hosts elevate above the studio overlay (z 310 via the generalized elevate mechanism from the scroll PR).
> **Files**: web/src/components/AppFrameLayer.tsx, web/src/components/EmbeddedApp.tsx (context prop union), web/src/components/AppFrameLayer.vitest.ts
> **Acceptance**: with transcript+panel+studio placeholders for one url, studio hosts; closing studio returns hosting to panel-then-transcript with ZERO iframe reloads (mounted load-count assertions); chip semantics on non-hosts remain coherent ('open in studio'? keep existing chip text — non-host chip text stays as-is this phase).
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: scroll-sync PR merged (external); none in-phase
> **Reversibility**: load-bearing

### B2 — Device modes = placeholder resize
> **Goal**: StudioModal's body hosts the app placeholder at 390×844 / 768×1024 / 1280×800 (letterboxed, centered); switching modes resizes the placeholder only.
> **Files**: web/src/components/StudioModal.tsx, web/src/styles.css
> **Acceptance**: zero iframe reloads across mode switches (load-count); iframe media queries respond (verify with an artifact that renders its own innerWidth); gated modes unreachable at small screens.
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: B1
> **Reversibility**: clean-revert

### B3 — Enter/exit transitions + evidence
> **Goal**: polished open/close (no layout shift, correct clip/z at every step) with harness captures proving the seam.
> **Files**: web/scratch harness (gitignored), web/src/styles.css touch-ups
> **Acceptance**: harness video: transcript embed → studio (state intact) → device switches (state intact) → close → panel/transcript hosting resumes (state intact); PNGs read + confirmed.
> **Verification**: harness run + cd web && npx vitest run
> **Depends on**: B2
> **Reversibility**: clean-revert
> **E2E test**: harness capture (state-intact across the full journey)

## Review sign-off checklist
- [ ] Zero reloads across enter/switch/exit (evidence)
- [ ] Scroll-PR behaviors (fade/sync) still green post-merge
- [ ] PR targets umbrella branch
