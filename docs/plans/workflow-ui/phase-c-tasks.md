---
feature: workflow-ui
phase: c
tier: feature
autonomous: false
complexity-budget:
  files: 4
  loc-delta: 400
adopted-patterns:
  - SubAgentStrip above-composer docked surface + visualViewport pinning
  - SessionRail hasRunningSubagents indicator plumbing
---

> **Scope**: The persistent live dock above the composer (visible while a workflow runs) + the rail indicator. Both read the same polled slice by runId.
> **Design**: docs/design/workflow-ui.md
> **Branch**: feat/workflow-ui

## Status

| state | count |
|---|---|
| todo | 3 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-18 against docs/workflow-ui-design; depends on Phase A slice + Phase B card. B6 elided: Out of scope (see README); Audit item coverage (feature <5 tasks, reuse-only).
-->

## Task list

### C1 — `WorkflowLiveDock.tsx` (above composer, running only)
> **Goal**: A compact dock reusing the SubAgentStrip above-composer surface: shows the active phase title + a progress bar (width-only animation, `done/total`) + the current running agent's `lastToolName`; visible only while `workflowActive`; `visualViewport`-pinned above the mobile keyboard; tap → scroll to / expand the inline card.
> **Files**: web/src/components/WorkflowLiveDock.tsx, web/src/styles.css
> **Acceptance**: With a running fixture, the dock renders above the composer, bar reflects done/total, dock hides when no workflow is running; on a 390px viewport with the keyboard open the dock sits above the keyboard (visualViewport), not behind it.
> **Verification**: `npm --prefix web run build` + Playwright (running fixture, desktop + 390px)
> **Depends on**: A3
> **Reversibility**: clean-revert

### C2 — Rail indicator
> **Goal**: In `SessionRail.tsx`, a session with `workflowActive` shows a workflow glyph (⚙) + `N/M` (mirroring the `hasRunningSubagents` "cloning" indicator plumbing), fading shortly after completion.
> **Files**: web/src/components/SessionRail.tsx
> **Acceptance**: A session with a running workflow shows `⚙ N/M` on its rail row; a session without shows nothing; done → glyph fades. Does not clobber the existing sub-agent cloning indicator (both can coexist).
> **Verification**: `npm --prefix web run build` + Playwright
> **Depends on**: A3
> **Reversibility**: clean-revert

### C3 — Live verification (running fixture)
> **Goal**: Construct a synthetic `running` fixture (copy the specimen json; flip `status:"running"`, a couple agents to `running`/`queued`, drop their resultPreview) and verify the dock + rail + card live states.
> **Files**: (fixture only; no shipped code) test/fixtures/workflow-running.json
> **Acceptance**: Screenshots (desktop + 390px) at ~/.claude-control/media/workflow-ui/ show queued/running/done states in the card, the dock above the composer, and the rail `N/M`.
> **Verification**: Playwright pass; screenshots saved
> **Depends on**: C1, C2, B2
> **Reversibility**: clean-revert

## Dependencies between tasks
- C1, C2 depend on A3 (slice); C3 depends on C1+C2+B2.

## Review sign-off checklist
- [ ] Dock hidden when no workflow running; visible + accurate while running.
- [ ] Mobile: dock above the keyboard (visualViewport), not behind.
- [ ] Rail indicator coexists with the sub-agent cloning icon (no clobber).
- [ ] Progress bar animates width only (no CLS).
