---
feature: cockpit-olam-remote-sessions
phase: b
tier: epic
autonomous: true
milestone: M2 — Phase B full-mode or explicitly-degraded per org
complexity-budget:
  files: 6
  loc-delta: 500
adopted-patterns:
  - claude-cockpit lib/transcript.js TranscriptTailer append-event contract
  - olam Electric shape long-poll consumption (plan-chat-spa useSessionChunks)
  - olam ADR-062 session_id canonical join key
umbrella-branch: feat/cockpit-olam-remote-sessions-integration
---

# Phase B — Conversation streaming (TranscriptSource)

> **Scope**: Chunks-backed transcript source for the selected remote session (Electric shape long-poll, offset resumption), mapped to `TranscriptTailer`'s append-event contract; degraded logTail/feed fallback with visible banner. No steering.
> **Design**: docs/design/cockpit-olam-remote-sessions.md
> **Branch**: feat/cockpit-olam-remote-sessions-phase-b

## Status

| State | Tasks |
|---|---|
| todo | B3, B4 |
| done | B1, B2 |

<!-- CP0 log
- 2026-07-02 commit-plan: emitted from plan pass 3. Go/no-go per org on first authenticated shape read (decision 6/plan Phase B).
- 2026-07-02 execute CP0 passed against 3a802b2 (umbrella tip w/ merged Phase A). Phase B GO full-mode (A1 live-verified shape auth cleared). B1+B2 landed as one module lib/olam-transcript.js (ShapeSubscriber + chunksToMessages). Caught+fixed a live-poll hot-loop (starved node:test reporter) — added livePollDelayMs bound. cumulative: files=2, loc=~430 (budget 0.86x of B's 500)
-->

## Audit item coverage

| Rubric | Covered by | Reuse-ref |
|---|---|---|
| T3 | B1, B3 | cloudflared JWT (Phase A3 wrapper) |
| P1 | B1, B4 | selected-session-only subscription |
| P2 | B2 | TranscriptTailer 64KB/1MB bounds analogue |

## Task list

### B1 — Electric shape long-poll client

> **Goal**: A server-side shape subscriber long-polls the org's chunks shape for one `session_id` with offset/handle resumption and clean teardown.
> **Files**: lib/olam-transcript.js, test/olam-transcript.test.js
> **Acceptance**: Against a mock shape server: initial snapshot + incremental rows delivered in order; offset persisted so a restart resumes without duplicates; teardown closes the poll; auth failures produce a typed DegradedRequired signal (never a crash).
> **Verification**: node --test test/olam-transcript.test.js
> **Depends on**: none (branches off umbrella containing Phase A)
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (new module)
> **Integration-test**: node --test test/olam-transcript.test.js

- [x] Long-poll loop with offset/handle state (persisted per session)
- [x] Backoff + reconnect semantics (livePollDelayMs; 409 rehydrate)
- [x] Typed degraded signal on auth/shape failure
<!-- e2e: 12/12 (B1+B2 combined module); hot-loop fix (live-poll delay) verified -->

### B2 — Chunk rows → TranscriptTailer append events

> **Goal**: Chunk rows render through the existing message renderer by emitting the exact `append` event shape `TranscriptTailer` produces, with bounded initial backfill.
> **Files**: lib/olam-transcript.js, test/olam-transcript-mapping.test.js
> **Acceptance**: Fixture chunk rows (operator + agent + tool chunks) map to append events the existing renderer displays; initial backfill bounded by row count (config, default mirrors 64KB/1MB tail semantics); malformed rows skipped with a counted warning, never a crash.
> **Verification**: node --test test/olam-transcript-mapping.test.js
> **Depends on**: B1
> **Reversibility**: clean-revert
> **Regression surfaces**: message renderer receives a new producer — local transcript rendering must be untouched (existing tests)
> **Integration-test**: npm test

- [x] Row→event mapping table (chunk kinds → message roles)
- [x] Backfill bounds + ordering guarantees
- [x] Malformed-row tolerance

### B3 — Degraded fallback (runner logTail + feed)

> **Goal**: When shape auth is unavailable for an org, the selected session still streams runner `status.logTail`/`feed` increments as plain-text events under a persistent "degraded — log tail only" banner.
> **Files**: lib/olam-transcript.js, web/src/components/** (banner), test/olam-transcript-degraded.test.js
> **Acceptance**: DegradedRequired flips the source to feed polling (`feedCursor` incremental); banner visible + non-dismissable while degraded; recovery to full mode on next successful shape read; per-org go/no-go recorded in health state.
> **Verification**: node --test test/olam-transcript-degraded.test.js
> **Depends on**: B1
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: node --test test/olam-transcript-degraded.test.js

- [ ] Feed/logTail poller behind the same TranscriptSource interface
- [ ] Degraded banner state through WS to frontend
- [ ] Recovery path

### B4 — Selected-session lifecycle wiring

> **Goal**: Selecting a remote session subscribes exactly one stream (shape or degraded), deselecting/switching tears it down, and events ride the existing WS fan-out unchanged.
> **Files**: server.js, test/olam-stream-lifecycle.test.js
> **Acceptance**: Selecting remote session → one subscription; switching sessions → old torn down before new opens; local session selection path untouched (snapshot); ≤1 long-poll open at any time (P1 assertion in test).
> **Verification**: node --test test/olam-stream-lifecycle.test.js
> **Depends on**: B2, B3
> **Reversibility**: clean-revert
> **Regression surfaces**: server.js WS connection handler (all clients)
> **Integration-test**: npm test

- [ ] Subscribe/teardown on selection messages
- [ ] Single-subscription invariant
- [ ] Local-path snapshot guard

## Dependencies between tasks

B1 → (B2 ∥ B3) → B4.

## Cross-phase regression checks

- Re-run Phase A snapshots (`test/sessions-remote-merge.test.js`, `test/ws-protocol-compat.test.js`) after B4 — streaming must not alter list/WS shapes.

## Rollback rehearsal

```bash
cd ~/Projects/claude-cockpit && git revert "$PHASE_B_MERGE_SHA"   # Phase A remains functional (read-only fleet)
```

## Review sign-off checklist

- [ ] All 4 tasks done + verifications green
- [ ] T3/P1/P2 coverage demonstrated
- [ ] Live check: one real atlas session streamed end-to-end (full or explicitly-degraded, banner correct)
