---
feature: cockpit-protocol-split-native-heads
phase: b
tier: epic
autonomous: true
milestone: "M2"
complexity-budget: { files: 15, loc-delta: 2000 }
adopted-patterns: [tmux-control-mode, lib/tmux.js, CLAUDE_CONTROL_TMUX_MODE-flag]
---

# Phase B — Control-mode integration (spike-gated)

> **Scope**: Persistent tmux -CC client replaces list-panes/capture-pane polling for state; scraping stays only as picker fallback. GO/NO-GO spike gate first.
> **Design**: docs/design/cockpit-protocol-split-native-heads.md
> **Branch**: feat/cockpit-protocol-phase-b

## Status
| state | tasks |
|---|---|
| todo | B1 B2 B3 B4 |
| done | — |

<!-- CP0 log: emitted 2026-07-15 by /100x:commit-plan; B6 elided: Out of scope (see README) -->

## Audit item coverage
| Audit | Covered by | Reuse-ref |
|---|---|---|
| T2, P3 | B1, B2 | control-mode compat layer |
| P1 (DERP tripwire review) | B4 | latency telemetry |

## Task list

### B1 — Control-mode spike (pre-B gate, quantitative)
> **Goal**: timeboxed spike against real Claude/Codex TUI panes under tmux 3.6a produces a fixture corpus + GO/NO-GO verdict: GO = zero unrecovered desyncs across corpus, flood ≥1MB/s single-pane with zero missed lifecycle events + state-lag <500ms, drift-resync <2s.
> **Files**: test/fixtures/tmux-cc/ (new), docs/plans/cockpit-protocol-split-native-heads/spike-b-report.md (new)
> **Acceptance**: report carries all three measured numbers; NO-GO halts phase (stay on polling).
> **Verification**: node --test test/tmux-cc-spike.test.js (fixture replay)
> **Depends on**: none
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (spike)
> **Integration-test**: real tmux -L cc-test run, recorded

### B2 — lib/tmux-cc.js control client
> **Goal**: persistent -CC client: %output subscription, pane/window lifecycle events, %pause flow-control handling, periodic full-reconcile resync, per-pane throttle + visible-panes-only subscription.
> **Files**: lib/tmux-cc.js (new ~800 LOC), test/tmux-cc.test.js (new, fixture-driven)
> **Acceptance**: parser green on the full B1 fixture corpus incl. %pause + interleaving cases.
> **Verification**: node --test test/tmux-cc.test.js
> **Depends on**: B1
> **Reversibility**: load-bearing
> **Regression surfaces**: session discovery (test/sessions*.test.js)
> **Integration-test**: node --test against tmux -L cc-test

### B3 — Registry integration behind mode flag
> **Goal**: SessionRegistry consumes control-mode events when CLAUDE_CONTROL_TMUX_MODE=cc (default after soak); list-panes 4s polling + capture-pane state paths retired in cc mode; scraping kept for picker fallback only.
> **Files**: lib/sessions.js, server.js, test/sessions-cc.test.js (new)
> **Acceptance**: AC4 — zero list-panes calls in steady state (command-log instrumentation); pane create/kill reflected <500ms.
> **Verification**: node --test test/sessions-cc.test.js test/sessions*.test.js
> **Depends on**: B2
> **Reversibility**: forward-fix-only (flag reverts behavior, code stays)
> **Regression surfaces**: pane↔transcript binding, pane-registry hook, reply targeting
> **Integration-test**: full backend suite + manual soak on live host

### B4 — Flag plumbing + DERP tripwire review
> **Goal**: CLAUDE_CONTROL_TMUX_MODE in install-service.sh (TOKEN_ENV conditional-omit pattern); rollback rehearsal logged; DERP telemetry from Phase A reviewed against tripwire (>20% relayed AND p95>80ms → promote predictive echo to scope).
> **Files**: bin/install-service.sh, docs/plans/cockpit-protocol-split-native-heads/derp-review.md (new)
> **Acceptance**: rehearsal verified via launchctl getenv; derp-review.md records verdict.
> **Verification**: manual rehearsal + review doc present
> **Depends on**: B3
> **Reversibility**: clean-revert
> **Regression surfaces**: launchd service env
> **Integration-test**: n/a

## Dependencies between tasks
B1 → B2 → B3 → B4 (linear).

## Cross-phase regression checks
Control-mode events must not touch the PTY bridge (A4) — separate tmux clients.

## Rollback rehearsal
launchctl setenv CLAUDE_CONTROL_TMUX_MODE poll && kickstart; verify polling resumes; flip back.

## Review sign-off checklist
- [ ] B1 GO criteria met (numbers in report)
- [ ] AC4 green
- [ ] DERP tripwire verdict recorded
