---
feature: workflow-ui
phase: b
tier: feature
autonomous: false
complexity-budget:
  files: 5
  loc-delta: 700
adopted-patterns:
  - MessageParts ExitPlanPart/ToolPart specialization
  - single sub-agent transcript viewer
  - meta chips + cosmos tokens + React.memo
---

> **Scope**: The inline Workflow Card — header + phase-grouped agent rows — mounted at the `Workflow` tool block (keyed by the `runId` the block carries), reading LIVE state from the polled slice. Plus the Agent View (inline result → full-transcript overlay reusing the sub-agent viewer).
> **Design**: docs/design/workflow-ui.md
> **Branch**: feat/workflow-ui

## Status

| state | count |
|---|---|
| todo | 4 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-18 against docs/workflow-ui-design; depends on Phase A payload slice. B6 elided: Out of scope (see README).
-->

## Audit item coverage

| Rubric | Task | Reuse-ref |
|---|---|---|
| T2 (render-escape previews) | B1 | React text nodes; NO dangerouslySetInnerHTML (#303 lesson) |
| P3 (per-row memo) | B1 | React.memo on (agentId,state,lastToolName,tokens) |
| Seam (inline-at-tool-block by runId) | B2 | MessageParts.tsx:185/241 |
| S4 (reuse agent viewer) | B3 | single sub-agent transcript viewer |

## Task list

### B1 — `WorkflowCard.tsx` + styles
> **Goal**: Render one workflow from the slice: header (name · summary · status chip · done/total · tokens · elapsed) + phase groups (Gestalt common-region) with agent rows (state dot [○ queued / ◐ running / ● done / ✕ error] + label/agentType + model chip + tokens + duration + running `lastToolName` caption); collapse-by-default; per-row `React.memo`.
> **Files**: web/src/components/WorkflowCard.tsx, web/src/styles.css
> **Acceptance**: Renders the specimen slice (1 phase × 6 done agents) with legible text over 1px rings (no filled gradients); state distinguishable in greyscale (shape+text, not hue-only); previews shown as escaped text; one agent's prop change re-renders only that row.
> **Verification**: `npm --prefix web run build` && `npm --prefix web run test -- WorkflowCard`
> **Depends on**: A3
> **Reversibility**: load-bearing

### B2 — Mount at the `Workflow` tool block
> **Goal**: In `MessageParts.tsx`, add a specialized part (like `ExitPlanPart`) that, for the `Workflow` toolName, extracts the `runId` from the tool block and renders `<WorkflowCard>` bound to the live slice for that runId (falls back to a fixed-slot render only if runId extraction fails).
> **Files**: web/src/components/MessageParts.tsx
> **Acceptance**: A transcript containing a `Workflow` tool block renders the live card (not the frozen tool_result); the card updates when the polled slice changes; the App.tsx `identityConvertMessage` fast-path is not broken (verified: no full-transcript re-normalize on a workflow tick).
> **Verification**: `npm --prefix web run build` (+ Playwright against the specimen session in Phase B verify)
> **Depends on**: B1
> **Reversibility**: load-bearing

### B3 — Agent View (inline result → transcript overlay)
> **Goal**: Tapping an agent row expands its `resultPreview` inline; an "open full transcript" action opens the existing single sub-agent transcript viewer against `<session>/subagents/workflows/<runId>/agent-<agentId>.jsonl`.
> **Files**: web/src/components/WorkflowCard.tsx, (reuse) the sub-agent transcript viewer component
> **Acceptance**: Expanding an agent shows its resultPreview; "open transcript" renders the agent's JSONL in the reused viewer overlay; back returns to the card.
> **Verification**: `npm --prefix web run build` + Playwright (specimen)
> **Depends on**: B1
> **Reversibility**: clean-revert

### B4 — WorkflowCard render tests + specimen Playwright
> **Goal**: `WorkflowCard.vitest.ts` renders the specimen fixture (states, phase grouping, previews); a Playwright pass screenshots the specimen card on the live/scratch build.
> **Files**: web/src/components/WorkflowCard.vitest.ts
> **Acceptance**: Vitest green; screenshot saved to ~/.claude-control/media/workflow-ui/ showing the completed specimen card (1 phase × 6 done agents).
> **Verification**: `npm --prefix web run test -- WorkflowCard`
> **Depends on**: B1, B2
> **Reversibility**: clean-revert

## Dependencies between tasks
- B1 depends on A3; B2 depends on B1; B3 depends on B1; B4 depends on B1+B2. B1 and B2 are load-bearing.

## Review sign-off checklist
- [ ] Previews rendered as escaped text (no dangerouslySetInnerHTML) — T2.
- [ ] State encoded by shape+text, not color alone.
- [ ] 1px rings, legible text (no mask-composite filled-gradient regression).
- [ ] Per-row memo confirmed (one tick → one row) — P3.
- [ ] `identityConvertMessage` fast-path intact.
