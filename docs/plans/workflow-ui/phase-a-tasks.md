---
feature: workflow-ui
phase: a
tier: feature
autonomous: false
complexity-budget:
  files: 5
  loc-delta: 600
adopted-patterns:
  - lib/subagents.js incremental-scanner (mtime-keyed cache)
  - lib/sessions.js payload seam
---

> **Scope**: Backend detection + parsing — a new `lib/workflows.js` that reads `wf_<runId>.json`, groups the flat `workflowProgress` into phases→agents, and surfaces a structured slice on the existing per-session payload. Headless + fully unit-testable against the specimen.
> **Design**: docs/design/workflow-ui.md
> **Branch**: feat/workflow-ui

## Status

| state | count |
|---|---|
| todo | 4 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-18 against docs/workflow-ui-design; tier=feature; B2 note: 4-phase count is the only feature→epic signal — all epic markers (multi-service/migration/regression-blast/cross-service dep) absent + clean-revert → remain feature. B3 PASS (Existing patterns referenced + Reuse decisions added to plan). B6 elided: Out of scope (see README). B7: single sequential branch feat/workflow-ui (not stacked) — acknowledged.
-->

## Audit item coverage

| Rubric | Task | Reuse-ref |
|---|---|---|
| T1 (path trust) | A1 | lib/subagents.js path derivation |
| T2 (model-string escaping) | A1 | — (data shaping; render-escape enforced in Phase B) |
| P2 (mtime-skip re-parse) | A1 | lib/subagents.js:274 `_scanIncremental` |
| S1 (no new transport) | A2 | lib/sessions.js:1315/1495 |
| S2 (separate module) | A1 | — |

## Task list

### A1 — `lib/workflows.js`: parse + phase-group + mtime cache
> **Goal**: `computeWorkflowActivity({transcriptPath})` returns per-run structured objects `{runId, workflowName, summary, status, agentCount, startTime, durationMs, totalTokens, totalToolCalls, done, total, active, phases:[{index,title,detail,agents:[...]}]}`, grouping the flat `workflowProgress` by phase.
> **Files**: lib/workflows.js
> **Acceptance**: Given the specimen `wf_dc36fa0e-3c0.json`, returns 1 run, status "completed", 1 phase "Review" with 6 agents all state "done", each carrying agentType/model/tokens/durationMs/resultPreview; multiple `wf_*.json` → multiple runs; a truncated/mid-write JSON file → skipped (not thrown); re-read skipped when mtime unchanged (mtime-keyed cache mirroring `_scanIncremental`).
> **Verification**: `node --test test/workflows.test.js`
> **Depends on**: none
> **Reversibility**: load-bearing

### A2 — Wire into `lib/sessions.js` payload
> **Goal**: Per-poll, compute the workflow slice for each session and attach `workflows` (array), `workflowActive` (bool), `workflowSummary` ({name, activePhaseTitle, done, total, status}) to the per-window payload, beside the existing subAgent fields — no new endpoint/transport.
> **Files**: lib/sessions.js
> **Acceptance**: `/api/sessions` payload (or the WS session frame) for a session with a workflow includes the `workflows`/`workflowActive`/`workflowSummary` fields; a session without workflows gets `workflowActive:false, workflows:[]`; the existing subAgentActive path is untouched (its tests still pass).
> **Verification**: `node --test` (sessions suite) && node -e "verify payload shape against specimen session"
> **Depends on**: A1
> **Reversibility**: clean-revert

### A3 — Thread frontend types + hook
> **Goal**: Add the `Workflow`/`WorkflowPhase`/`WorkflowAgent` types to `web/src/lib/types.ts` and thread the `workflows`/`workflowActive`/`workflowSummary` slice through `web/src/hooks/useCockpit.ts` so components can read it by session + runId.
> **Files**: web/src/lib/types.ts, web/src/hooks/useCockpit.ts
> **Acceptance**: `tsc -b` clean with the new types consumed; the hook exposes the workflow slice per session; no runtime change yet (no component renders it).
> **Verification**: `npm --prefix web run build`
> **Depends on**: A2
> **Reversibility**: clean-revert

### A4 — Parser tests
> **Goal**: `test/workflows.test.js` covers phase-grouping, multi-run, partial/mid-write JSON, failed/errored status, pipelined (multiple active phases), and mtime-skip.
> **Files**: test/workflows.test.js
> **Acceptance**: ≥6 test cases green; includes the real specimen as a fixture + a synthetic running/errored fixture.
> **Verification**: `node --test test/workflows.test.js`
> **Depends on**: A1
> **Reversibility**: clean-revert

## Dependencies between tasks
- A2 depends on A1; A3 depends on A2; A4 depends on A1. A1 is the load-bearing seam.

## Review sign-off checklist
- [ ] Parser never throws on malformed/partial JSON (skips the run).
- [ ] mtime cache proven to skip re-parse (P2).
- [ ] Path derived from trusted transcriptPath, never request input (T1).
- [ ] subAgentActive path untouched (no regression to #298).
- [ ] `tsc`/`node --test` green.
