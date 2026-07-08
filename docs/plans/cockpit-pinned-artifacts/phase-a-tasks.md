---
feature: cockpit-pinned-artifacts
phase: a
tier: feature
autonomous: true
complexity-budget: { files: 5, loc-delta: 250 }
adopted-patterns: [vitest .vitest.ts convention, reserved-box discipline]
umbrella-branch: feat/cockpit-pinned-artifacts-integration
---

# Phase A — Iframe/render stability foundation

> **Scope**: transcript re-renders stop remounting embedded iframes; app state survives churn.
> **Design**: docs/design/cockpit-pinned-artifacts.md
> **Branch**: feat/cockpit-pinned-artifacts-phase-a

## Status
| state | tasks |
|---|---|
| todo | A1, A2, A3 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08; B6 elided: Dependencies (linear), Out of scope (see README) -->

## Audit item coverage
| Task | Rubric |
|---|---|
| A2, A3 | T1 |

## Task list

### A1 — Narrow convertedMessages dependency churn
> **Goal**: thread rows stop recomputing on unrelated session/liveness frames.
> **Files**: web/src/App.tsx
> **Acceptance**: `convertedMessages` no longer lists `cockpit.sessions` (App.tsx:721); working-indicator derives from a memoized selected-session working flag; typing in another session produces zero re-renders of the active thread (React DevTools profiler or render-count probe).
> **Verification**: cd web && npx tsc -b --pretty false && npx vitest run
> **Depends on**: none
> **Reversibility**: clean-revert

### A2 — Churn-survival spike: does identity stabilization stop iframe remounts? (decides OQ3)
> **Goal**: produce a written verdict — stable refs + memo suffice, or row DOM moves force the hoist layer.
> **Files**: web/scratch/prototype-cockpit-uiproof/** (harness), web/src/lib/* (probe helper if needed)
> **Acceptance**: harness drives 20 appended messages + working-row toggle + hiddenCount window shift over a stateful embedded app; verdict recorded in tracker CP0 log + plan Assumptions log with iframe reload-count evidence (0 = stabilize path; >0 = hoist path).
> **Verification**: node ~/.claude/skills/prototype-component/scripts/run.mjs web/scratch/prototype-cockpit-uiproof --spec <churn-spec>.json
> **Depends on**: A1
> **Reversibility**: clean-revert
> **E2E test**: n/a (harness IS the test)

### A3 — Land the stability fix per A2 verdict
> **Goal**: embedded app iframes survive 20-message churn with zero reloads (success signal 1).
> **Files**: web/src/App.tsx, web/src/components/MessageParts.tsx, web/src/components/EmbeddedMedia.tsx (+ web/src/components/AppFrameLayer.tsx ONLY if hoist verdict)
> **Acceptance**: A2 harness re-run reports 0 iframe reloads across churn matrix; 531-baseline vitest green; no layout shift regressions.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false && npm run build
> **Depends on**: A2
> **Reversibility**: load-bearing

## Review sign-off checklist
- [ ] Success signal 1 demonstrated with capture evidence
- [ ] No `cockpit.sessions` wide dep reintroduced
- [ ] PR targets umbrella branch, not main
