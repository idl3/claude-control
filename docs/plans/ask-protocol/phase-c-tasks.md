---
feature: ask-protocol
phase: c
tier: epic
milestone: M1
autonomous: false
complexity-budget:
  files: 4
  loc-delta: 500
adopted-patterns:
  - existing user-message send channel (server.js reply op)
  - App.tsx activePrompt/askActive send-guard pattern
  - answeredToolUses TTL-dedupe pattern (mirror for qid)
---

> **Scope**: The content-block envelope + strict provenance + structured answer channel — detect `<pleri:ask>` (strict rule), render via Phase B, inject `<pleri:answer>` as a user message correlated by qid, with a composer send-guard + qid dedupe-lock. Deletes the keystroke path for pleri:ask (native stays). This is the milestone's shippable value.
> **Design**: docs/design/ask-protocol.md
> **Branch**: feat/ask-protocol-m1

## Status

| state | count |
|---|---|
| todo | 4 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-19 on docs/ask-protocol; M1. Depends on A (lib+gate) + B (renderer). B6 elided: Out of scope (see README).
-->

## Audit item coverage

| Rubric | Task | Reuse-ref |
|---|---|---|
| T3/OQ8/OQ13 strict provenance | C1 | design strict-structural rule |
| OQ12 emission telemetry | C1/C4 | per-skill counter |
| OQ17 send-guard + dedupe | C3 | App.tsx askActive; answeredToolUses |
| H5 no keystroke | C2 | reuse reply op, not buildAnswerProgram |

## Task list

### C1 — strict-provenance `<pleri:ask>` detection
> **Goal**: Detect a `<pleri:ask>` block ONLY when it is the sole top-level content of a FINALIZED assistant message — never a substring, never inside a fenced code block, never nested under a tool_result/quoted region. Feature-flagged. Emit a per-skill native-vs-pleri emission counter (telemetry).
> **Files**: web/src/hooks/useCockpit.ts (or lib/transcript.js parse), web/src/App.tsx
> **Acceptance**: a valid sole-content block renders a picker; a `<pleri:ask>` inside a code fence / quoted / mid-prose does NOT; malformed → lenient skip + (dev) log. XSS/forgery fixture (injected `<pleri:ask>` in quoted content) does NOT render.
> **Verification**: `npm --prefix web run test -- provenance`
> **Depends on**: A1
> **Reversibility**: load-bearing
> **Regression surfaces**: transcript parse (useCockpit/App.tsx)
> **Integration-test**: n/a

### C2 — answer injection channel (structured, no keystrokes)
> **Goal**: On submit, `serializeAnswer` → inject `<pleri:answer>{...}` (single line) as a user message via the EXISTING send channel (server.js reply op), correlated by qid. NO buildAnswerProgram/send-keys for pleri:ask.
> **Files**: web/src/App.tsx (submit handler), server.js (reply op — confirm carries the block intact)
> **Acceptance**: submitting a pleri picker sends the answer as a user message the agent parses next turn; the keystroke path is NOT invoked for pleri:ask; native answering path untouched.
> **Verification**: `node --test test/pleri-ask-roundtrip.test.js` (extends A3) + manual live smoke
> **Depends on**: A3, C1, B1
> **Reversibility**: load-bearing
> **Regression surfaces**: server.js reply op; native answer path
> **Integration-test**: test/pleri-ask-roundtrip.test.js

### C3 — send-guard + qid dedupe-lock
> **Goal**: While a pleri:ask is pending, gate the composer (client + server) on an askActive-equiv so a stray chat message can't consume the qid's turn; add a qid-keyed submit dedupe-lock (mirror `answeredToolUses` TTL + single-flight) so a double-submit doesn't waste an agent turn.
> **Files**: web/src/App.tsx, web/src/components/Composer.tsx, server.js
> **Acceptance**: composer refuses/queues a plain message while a pleri:ask is open; a double-click submit applies once; native pending-guard unregressed.
> **Verification**: `npm --prefix web run test -- send-guard`
> **Depends on**: C2
> **Reversibility**: clean-revert
> **Regression surfaces**: composer send path; native pending-guard
> **Integration-test**: n/a

### C4 — live verification
> **Goal**: Emit a real `<pleri:ask>` from a session, render + answer via the content-block channel end-to-end on a scratch build; confirm no keystroke-puppeteering + the round-trip.
> **Files**: (verification; no shipped code)
> **Acceptance**: Python-playwright: a pleri picker renders, answering sends a structured `<pleri:answer>` user message, the agent resumes; screenshot to ~/.claude-control/media/ask-protocol/.
> **Verification**: Playwright scratch-port pass
> **Depends on**: C1, C2, C3
> **Reversibility**: clean-revert
> **Regression surfaces**: none
> **Integration-test**: the live smoke itself

## Dependencies between tasks
- C1 depends on A1; C2 depends on A3+C1+B1; C3 depends on C2; C4 depends on C1+C2+C3. C1/C2 load-bearing.

## Cross-phase regression checks
- Native AskUserQuestion answering (buildAnswerProgram path) fully intact — dual-support; its tests green.
- The reply op / send channel unregressed for normal chat messages.

## Rollback rehearsal
- Feature-flag OFF → agents use native AskUserQuestion; the keystroke path is still present (not deleted for native). `git revert` the M1 merge → clean (native path present).

## Review sign-off checklist
- [ ] Strict provenance: forgery/false-positive fixtures do NOT render (T3/OQ8/OQ13).
- [ ] No keystroke path for pleri:ask (H5).
- [ ] Send-guard + qid dedupe work; native guard unregressed (OQ17).
- [ ] Live end-to-end round-trip verified.
