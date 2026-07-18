# Workflow UI — implementation trackers

Render Claude Code **Workflows** (phased multi-agent fan-outs) as a first-class cockpit surface: an inline Workflow Card in the transcript + a persistent live dock above the composer + a rail indicator — driven by the existing session poll off `wf_<runId>.json`, bounded at 40+ agents.

- **Plan:** `~/.claude/plans/workflow-ui.md`
- **Design:** [docs/design/workflow-ui.md](../../design/workflow-ui.md) (committed @ `origin/docs/workflow-ui-design`)
- **Tier:** feature · **Ships as:** v1.12.8 · **Branch:** `feat/workflow-ui` (single sequential branch, not stacked)
- **Reversibility:** clean-revert (additive; separate `lib/workflows.js`, no migration, no effect on sub-agent detection)

## Phases

| Phase | Tracker | Delivers |
|---|---|---|
| A | [phase-a-tasks.md](./phase-a-tasks.md) | Backend `lib/workflows.js` parse + `lib/sessions.js` payload + types (headless, testable) |
| B | [phase-b-tasks.md](./phase-b-tasks.md) | Inline `WorkflowCard` at the `Workflow` tool block + Agent View |
| C | [phase-c-tasks.md](./phase-c-tasks.md) | Persistent live dock (above composer) + rail indicator |
| D | [phase-d-tasks.md](./phase-d-tasks.md) | Perf/scale hardening (windowing, no-CLS, 40-agent bound) |

Phases are sequential: B depends on A (the payload slice), C depends on A+B, D hardens B+C.

## Out of scope
- Workflow control from the cockpit (pause/kill/resume/re-run) — read-only v1.
- Rendering the workflow `script` source or full `result` object.
- A general list-virtualization dependency (phase-collapse + windowing suffices).
- Desktop pipelined-phase columns; nested (spawnDepth>1) agent hierarchy — both flat/vertical v1.

## Verify against
- Completed specimen: `~/.claude/projects/-Users-ernie-Projects-pleri-org-olam-wt-claudex-plan/3a959a04-0c7a-43f5-8dd2-13948cef80fe/workflows/wf_dc36fa0e-3c0.json` (1 phase "Review" × 6 done agents).
- Synthetic `running` fixture (flip status + a couple agent states) for live-state UI.
- Synthetic 40-agent fixture for the perf bound.
