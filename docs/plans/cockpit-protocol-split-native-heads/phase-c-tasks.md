---
feature: cockpit-protocol-split-native-heads
phase: c
tier: epic
autonomous: true
milestone: "M3"
complexity-budget: { files: 70, loc-delta: 7000 }
adopted-patterns: [zod, lib/protocol, ws.ts-reconnect-pattern, IndexedDB]
---

# Phase C — Protocol cutover + client cache + version handshake

> **Scope**: Full API surface modeled in lib/protocol; SPA migrates; version handshake (first frame); IndexedDB cache with bounds; legacy endpoints DELETED at close.
> **Design**: docs/design/cockpit-protocol-split-native-heads.md
> **Branch**: feat/cockpit-protocol-phase-c

## Status
| state | tasks |
|---|---|
| todo | C1 C2 C3 C4 C5 C6 |
| done | — |

<!-- CP0 log: emitted 2026-07-15 by /100x:commit-plan; B6 elided: Out of scope (see README) -->

## Audit item coverage
| Audit | Covered by | Reuse-ref |
|---|---|---|
| T5 | C4 | cache bounds/purge |
| P2 | C3, C4 | perf marks + zod budget |
| C1 (parity) | C5 | parity-checklist |
| S2 | C4 | seq replay only |

## Task list

### C1 — Full protocol surface in lib/protocol
> **Goal**: sessions, transcripts (seq cursors), replies, approvals, uploads/media, config, push modeled as zod schemas; host-scoped session IDs; PROTOCOL_VERSION bumped per fingerprint gate.
> **Files**: lib/protocol/*.js, test/protocol-fingerprint.test.js
> **Acceptance**: every /api/* + WS frame the SPA uses has a schema; fingerprint green.
> **Verification**: node --test test/protocol-fingerprint.test.js
> **Depends on**: none (builds on A3)
> **Reversibility**: load-bearing
> **Regression surfaces**: olam remote source (host-scoping — test/olam-*.test.js)
> **Integration-test**: node --test (full suite)

### C2 — Server stream mux + version-first-frame handshake
> **Goal**: ONE multiplexed WS carries session events + transcript deltas + PTY channels; version-announce is the FIRST server frame; client defers re-subscribe until check passes.
> **Files**: server.js, lib/protocol/mux.js (new), test/ws-protocol-compat.test.js
> **Acceptance**: mismatched client receives announce before any other frame; reconnect resumes from seq cursor.
> **Verification**: node --test test/ws-*.test.js
> **Depends on**: C1
> **Reversibility**: load-bearing
> **Regression surfaces**: transcript streaming (test/transcript.test.js), ws heartbeat
> **Integration-test**: node --test + Playwright reconnect E2E

### C3 — SPA data-layer migration
> **Goal**: web/src/lib/ws.ts + convert.ts + api.ts consume the protocol client (@protocol alias, z.infer types); zod parse budget <2ms p95 per batch instrumented.
> **Files**: web/src/lib/ws.ts, web/src/lib/convert.ts, web/src/lib/api.ts, web/src/lib/protocol-client.ts (new)
> **Acceptance**: full vitest suite green; perf marks show parse budget met.
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: C2
> **Reversibility**: forward-fix-only
> **Regression surfaces**: entire SPA data layer; ?protocol=legacy escape flag until C5
> **Integration-test**: Playwright full-suite

### C4 — Client cache (IndexedDB, bounded)
> **Goal**: cache keyed (host, sessionId, seq); per-session 20MB/5k records; global 200MB LRU; purge on logout/revoke; server-delete tombstones; delta resume on reconnect. IndexedDB primary; OPFS Chrome-only optimization behind capability probe.
> **Files**: web/src/lib/cache/ (new), web/src/lib/ws.ts
> **Acceptance**: AC3 (reconnect <1s zero-refetch) + warm open <300ms; eviction tests green.
> **Verification**: cd web && npx vitest run cache && npx playwright test reconnect
> **Depends on**: C3
> **Reversibility**: clean-revert
> **Regression surfaces**: transcript virtualization
> **Integration-test**: Playwright throttle E2E

### C5 — Parity gate + legacy deletion (C-close)
> **Goal**: parity checklist (A8) fully green on protocol-only build; THEN legacy WS frames + endpoints deleted; ?protocol=legacy flag removed.
> **Files**: server.js, web/src/lib/*, docs/plans/cockpit-protocol-split-native-heads/parity-checklist.md
> **Acceptance**: AC5; zero legacy frame handlers left (grep gate).
> **Verification**: full backend + web suites + checklist sign-off
> **Depends on**: C4, C6
> **Reversibility**: forward-fix-only (git revert of cutover sha is the documented rollback)
> **Regression surfaces**: EVERYTHING — this is the cutover; parity checklist is the gate
> **Integration-test**: full CI + manual smoke on live host

### C6 — Stale-client reload policy + E2E
> **Goal**: Decision 16 policy — auto-reload on mismatch, prompt-and-defer when a pane has active PTY input; stale-bundle Playwright E2E (tab left open across cutover reloads correctly; installed-PWA lazy-update case).
> **Files**: web/src/lib/ws.ts, web/src/components/UpdateBanner.tsx, e2e (new spec)
> **Acceptance**: stale tab auto-recovers <5s; active-terminal tab prompts instead.
> **Verification**: npx playwright test stale-bundle
> **Depends on**: C2
> **Reversibility**: clean-revert
> **Regression surfaces**: UpdateBanner flow, PWA service worker
> **Integration-test**: Playwright stale-bundle spec

## Dependencies between tasks
C1 → C2 → C3 → C4 → C5; C2 → C6 → C5.

## Cross-phase regression checks
PTY bridge (A4) frames ride the C2 mux unchanged; control-mode events (B) feed session schema (C1).

## Rollback rehearsal
Pre-C5: flip ?protocol=legacy client flag. Post-C5: git revert <c-cutover-sha> + rebuild + kickstart (blast radius: all clients drop + reconnect ≤30s).

## Review sign-off checklist
- [ ] AC3, AC5 green
- [ ] parity checklist signed
- [ ] legacy grep gate zero
- [ ] fingerprint gate green at close
