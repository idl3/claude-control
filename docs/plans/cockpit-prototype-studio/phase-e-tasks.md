---
feature: cockpit-prototype-studio
phase: e
tier: feature
autonomous: true
complexity-budget: { files: 6, loc-delta: 400 }
adopted-patterns: [appBridge protocol, harness capture conventions]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase E — Inspector, console stub, E2E + docs

> **Scope**: read-only DOM inspection, console coming-soon slot, full-journey evidence, artifact-contract docs. Last phase — umbrella goes ready-for-review after this.
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-e

## Status
| state | tasks |
|---|---|
| todo | E1, E2, E3 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

## Audit item coverage
| Task | Rubric |
|---|---|
| E1 | S1 |

## Task list

### E1 — Inspector tab
> **Goal**: cc-dom-outline-request → depth-limited serialized outline (tag/id/class/text-preview/child-count, depth ≤12, nodes ≤2000) → collapsible tree in the studio with refresh; read-only.
> **Files**: bridge template, web/src/lib/appBridge.ts, web/src/components/StudioInspector.tsx (new), styles.css, tests
> **Acceptance**: counter + composer outlines render; oversized DOMs truncate with a notice; zero interaction affordances (read-only v1).
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: clean-revert

### E2 — Console slot
> **Goal**: Console tab ships as disabled "coming soon" with the cc-console-entry protocol reserved; IMPLEMENT live forwarding only if it is genuinely trivial (bridge wraps console.* → capped ring buffer → studio list) — judgment call, justify either way in the tracker log.
> **Files**: StudioModal.tsx, bridge template (reservation), tests if implemented
> **Acceptance**: tab present + honest state; if implemented: entries stream with level badges, capped at 500, cleared on reload.
> **Verification**: cd web && npx vitest run
> **Depends on**: none
> **Reversibility**: clean-revert

### E3 — Full-journey E2E + contract docs
> **Goal**: harness captures of the complete studio journey (desktop + 390px): open → device switch → props edit → invalid prop → crash+reload → screenshot → annotate → save → inspector; docs/design contract section documents manifest schema v1 + bridge protocol + degrade rules.
> **Files**: web/scratch harness, docs/design/cockpit-prototype-studio.md, README updates
> **Acceptance**: PNGs/video read + confirmed; docs let a third party build a conforming artifact.
> **Verification**: harness run + full suites (web + server) green
> **Depends on**: E1
> **Reversibility**: clean-revert
> **E2E test**: the journey harness itself

## Review sign-off checklist
- [ ] Full journey evidence on both form factors
- [ ] Contract docs complete (schema + protocol + degrade)
- [ ] Umbrella ready-for-review flipped after merge
