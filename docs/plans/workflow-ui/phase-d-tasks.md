---
feature: workflow-ui
phase: d
tier: feature
autonomous: false
complexity-budget:
  files: 3
  loc-delta: 300
adopted-patterns:
  - transcript manual-windowing discipline (INITIAL_VISIBLE / LOAD_EARLIER_STEP)
  - React.memo per-row
---

> **Scope**: Perf/scale hardening so a 40+ agent fan-out stays cheap: windowed rows for large phases, collapse-card-after-done, no-CLS live transitions, memoization audit.
> **Design**: docs/design/workflow-ui.md
> **Branch**: feat/workflow-ui

## Status

| state | count |
|---|---|
| todo | 3 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-18 against docs/workflow-ui-design; hardens Phase B+C. B6 elided: Out of scope (see README); Audit item coverage (feature <5 tasks).
-->

## Task list

### D1 — Windowed rows + collapse-after-done
> **Goal**: A phase with more than a threshold (~20) agents renders a windowed slice + a "show N more" affordance (reuse the transcript windowing discipline, not a new virtualization dep); a completed card collapses to a one-line summary once done + scrolled past (D5 lean), tap to re-expand.
> **Files**: web/src/components/WorkflowCard.tsx
> **Acceptance**: A 40-agent fixture at rest (collapsed phases) mounts DOM O(phases) not O(agents); expanding a 40-agent phase mounts only the windowed slice; a done card collapses to one line.
> **Verification**: `npm --prefix web run build` + Playwright DOM-node count on the 40-agent fixture
> **Depends on**: B1
> **Reversibility**: clean-revert

### D2 — No-CLS transitions + memoization audit
> **Goal**: Rows reserve height across state changes; the progress bar animates width only; confirm one agent's tick re-renders exactly one row (not the card) and does not re-normalize the transcript.
> **Files**: web/src/components/WorkflowCard.tsx, web/src/styles.css
> **Acceptance**: Playwright layout-shift < 0.1 when agents flip running→done on the running fixture; a render-count probe shows a single-agent update re-renders one row.
> **Verification**: Playwright layout-shift check + a render-count test
> **Depends on**: D1
> **Reversibility**: clean-revert

### D3 — 40-agent fixture + perf sign-off
> **Goal**: Add a synthetic 40-agent / multi-phase fixture and record the DOM-node bound + layout-shift results as the perf sign-off.
> **Files**: test/fixtures/workflow-large.json
> **Acceptance**: Documented DOM-node count (collapsed vs one-phase-expanded) under the agreed threshold; CLS < 0.1; results noted in the PR body.
> **Verification**: Playwright pass on the 40-agent fixture
> **Depends on**: D1, D2
> **Reversibility**: clean-revert

## Dependencies between tasks
- D1 depends on B1; D2 depends on D1; D3 depends on D1+D2.

## Review sign-off checklist
- [ ] 40-agent fixture: DOM O(phases) at rest — P1.
- [ ] CLS < 0.1 on live transitions — P4.
- [ ] One agent tick → one row re-render — P3.
- [ ] No new virtualization dependency added — S3.
