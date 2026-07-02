---
feature: cockpit-olam-remote-sessions
phase: c
tier: epic
autonomous: true
milestone: M3 — steer lifecycle E2E on one real Linear session
complexity-budget:
  files: 6
  loc-delta: 450
adopted-patterns:
  - claude-cockpit lib/codex-rpc.js remote-transport pattern (CodexRpcManager)
  - olam plan-chat cloud surface (/api/cloud-dispatch)
  - olam ADR-063/064 additive GSM-mirrored automation-bearer pattern
umbrella-branch: feat/cockpit-olam-remote-sessions-integration
---

# Phase C — Steering (Transport)

> **Scope**: `transport: 'olam'` branch in `handleClientMessage`: cloud-dispatch mirror for chat/Linear sessions, composer modes (steer/approve/read-only), lifecycle + dispatch error classes surfaced in-thread. Session-state detection from Phase A/B data.
> **Design**: docs/design/cockpit-olam-remote-sessions.md
> **Branch**: feat/cockpit-olam-remote-sessions-phase-c

## Status

| State | Tasks |
|---|---|
| todo | C1, C2, C3, C4 |
| done | — |

<!-- CP0 log
- 2026-07-02 commit-plan: emitted from plan pass 3. Steer recipe = A0-2 (writeCloudDispatch mirror → /api/cloud-dispatch → plan-DO; server/index.ts:3720). host-cp dispatch-turn is local-only — not used.
-->

## Audit item coverage

| Rubric | Covered by | Reuse-ref |
|---|---|---|
| T4 | C2 | session-state composer modes |
| T6 | C3 | dispatch 429/402/502 verbatim surfacing |
| T1 | C1 | server-side dispatch (no client creds) |

## Task list

### C1 — `'olam'` transport branch + cloud-dispatch mirror

> **Goal**: `sendReply` on a remote session POSTs the org's `/api/cloud-dispatch` with a `writeCloudDispatch`-shaped body (sessionId, prompt, idempotency key) using the operator JWT, server-side.
> **Files**: server.js, lib/olam-transport.js, test/transport-routing.test.js
> **Acceptance**: Transport routing test covers all four branches (tmux/rpc/print/olam) with the first three byte-unchanged; olam branch builds a correct dispatch body incl. idempotency key; success ack correlates to the originating WS message id.
> **Verification**: node --test test/transport-routing.test.js
> **Depends on**: none (umbrella contains A+B)
> **Reversibility**: clean-revert
> **Regression surfaces**: handleClientMessage routing (every input path in cockpit)
> **Integration-test**: npm test

- [ ] lib/olam-transport.js (dispatch body builder + send)
- [ ] handleClientMessage branch + ack correlation
- [ ] four-branch routing test

### C2 — Composer modes: steer / approve / read-only

> **Goal**: The composer reflects the session's actual steerability: running → steer; Linear session awaiting approval → approve (routes to gateway `/orchestrate/approve-execute` with automation bearer when configured, else Linear deep-link); shared/read-only or unauthenticated → disabled with reason.
> **Files**: lib/olam-transport.js, web/src/components/** (composer), test/olam-composer-modes.test.js
> **Acceptance**: Mode derives from session state fields (in-flight/awaiting-approval/read-only); approve mode labels the send button "Approve"; without automation bearer configured the approve action deep-links to the Linear thread; mode visible before typing (no surprise routing).
> **Verification**: node --test test/olam-composer-modes.test.js
> **Depends on**: C1
> **Reversibility**: clean-revert
> **Regression surfaces**: composer for local sessions (must be untouched)
> **Integration-test**: npm test

- [ ] Session-state → mode derivation
- [ ] Approve routing (bearer path + deep-link fallback)
- [ ] Composer UI states

### C3 — Steer lifecycle + dispatch error classes in-thread

> **Goal**: Every send shows optimistic echo → accepted → agent-resumed (operator chunk visible in stream) → or failed with the verbatim dispatch error (429 rate-cap / 402 budget / 502 cost-unknown / 409 duplicate), retriable.
> **Files**: lib/olam-transport.js, web/src/components/**, test/olam-transport-steer.test.js
> **Acceptance**: Mock SPA returns each error class → thread shows the verbatim reason with retry affordance; success path correlates the operator chunk from Phase B stream to clear "pending"; nothing is ever silently dropped.
> **Verification**: node --test test/olam-transport-steer.test.js
> **Depends on**: C1
> **Reversibility**: clean-revert
> **Regression surfaces**: thread rendering
> **Integration-test**: npm test
> **E2E test**: scripts/olam-steer-e2e.sh (real atlas session; detect-and-skip `[e2e:skipped] reason: no live session/Access login` )

- [ ] Lifecycle state machine + WS events
- [ ] Error-class surfacing + retry
- [ ] Pending-clear via stream correlation

### C4 — Soft/hard steer toggle for dispatch-type sessions

> **Goal**: Dispatch-type sessions (only) get the soft/hard steer toggle mirroring the SPA composer; chat/Linear sessions send plain dispatches.
> **Files**: web/src/components/** (composer toggle), lib/olam-transport.js, test/olam-composer-modes.test.js
> **Acceptance**: Toggle renders only for dispatch-type sessions; mode rides the dispatch body (`mode: soft|hard`); 202 queued+steer_id path renders as "queued" lifecycle state.
> **Verification**: node --test test/olam-composer-modes.test.js
> **Depends on**: C2, C3
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: npm test

- [ ] Type-gated toggle
- [ ] mode field + 202 handling

## Dependencies between tasks

C1 → (C2 ∥ C3) → C4.

## Cross-phase regression checks

- Re-run Phase A/B suites after C lands; four-branch transport test is the standing guard for local input paths.

## Rollback rehearsal

```bash
cd ~/Projects/claude-cockpit && git revert "$PHASE_C_MERGE_SHA"   # A+B remain (read+watch without steer)
```

## Review sign-off checklist

- [ ] All 4 tasks done + verifications green
- [ ] T1/T4/T6 coverage demonstrated
- [ ] M3 gate: one real Linear session steered E2E from cockpit (lifecycle visible)
