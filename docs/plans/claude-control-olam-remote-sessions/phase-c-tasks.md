---
feature: claude-control-olam-remote-sessions
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
> **Design**: docs/design/claude-control-olam-remote-sessions.md
> **Branch**: feat/cockpit-olam-remote-sessions-phase-c

## Status

| State | Tasks |
|---|---|
| todo | — |
| done | C1, C2, C3, C4 |

<!-- CP0 log
- 2026-07-02 commit-plan: emitted from plan pass 3. Steer recipe = A0-2 (writeCloudDispatch mirror → /api/cloud-dispatch → plan-DO; server/index.ts:3720). host-cp dispatch-turn is local-only — not used.
- 2026-07-02 CP3 audit (adversarial, epic 3-lens): 1 CRITICAL confirmed + fixed — read-only composer gate was DEAD (readOnly field never populated → gate could never fire). Fix wires it to a real signal: scope=all returns org-mates' sessions, so readOnly = owner_email !== operatorEmail (decoded from the edge-verified JWT email claim, non-enumerable). Belt-and-suspenders with the SPA ownership-404 dispatchSteer already surfaces. Other 5 findings Land-as-is (apiPost body immutable by design; error-slice bounded 200ch; classification tested; steer_mode operator-authorized; early-return clarified w/ comment). node 717, build green.
- 2026-07-02 execute CP0 passed against f1b4ac4 (umbrella w/ A+B). C1-C4 landed: OlamOrgClient.apiPost (2-layer POST) + lib/olam-transport.js (dispatchSteer mirrors writeCloudDispatch body; composerMode; replyTransport classifier; DISPATCH_ERRORS) + server.js reply remote branch + client mode bar + hard-steer toggle. Key insight (scouted pre-merge): the agent reply streams back as chunks → Phase B renders it, so steer needs NO response plumbing. cumulative: files~7, loc~600 (budget 1.3x of C's 450).
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
> **Regression surfaces**: handleClientMessage routing (every input path in claude-control)
> **Integration-test**: npm test

- [x] lib/olam-transport.js (dispatch body builder + send)
- [x] handleClientMessage branch + ack correlation (replyTransport classifier drives the olam guard)
- [x] four-branch routing test (replyTransport: tmux/rpc/print unshadowed)
<!-- e2e: transport 6 + routing 5 tests; server parses; olam reply → /api/cloud-dispatch mirror -->

### C2 — Composer modes: steer / approve / read-only

> **Goal**: The composer reflects the session's actual steerability: running → steer; Linear session awaiting approval → approve (routes to gateway `/orchestrate/approve-execute` with automation bearer when configured, else Linear deep-link); shared/read-only or unauthenticated → disabled with reason.
> **Files**: lib/olam-transport.js, web/src/components/** (composer), test/olam-composer-modes.test.js
> **Acceptance**: Mode derives from session state fields (in-flight/awaiting-approval/read-only); approve mode labels the send button "Approve"; without automation bearer configured the approve action deep-links to the Linear thread; mode visible before typing (no surprise routing).
> **Verification**: node --test test/olam-composer-modes.test.js
> **Depends on**: C1
> **Reversibility**: clean-revert
> **Regression surfaces**: composer for local sessions (must be untouched)
> **Integration-test**: npm test

- [x] Session-state → mode derivation (composerMode server + remoteComposerMode client mirror)
- [x] Approve routing (approve = first reply via cloud-dispatch; plan-DO latch)
- [x] Composer UI states (steer/approve/read-only mode bar in App.tsx)

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

- [x] Lifecycle state machine + WS events (ack{transport:'olam',mode}; reply→chunks stream reconciles the optimistic bubble, reusing Phase B)
- [x] Error-class surfacing + retry (DISPATCH_ERRORS 429/402/502/409/404 verbatim; unknown carries body text)
- [x] Pending-clear via stream correlation (existing pendingSends echo path; remote reply appears as a chunk)
<!-- e2e: dispatch error-class tests (all 5 classes + network + unknown) -->

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
- [ ] M3 gate: one real Linear session steered E2E from claude-control (lifecycle visible)
