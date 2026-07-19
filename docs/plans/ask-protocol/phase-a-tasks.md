---
feature: ask-protocol
phase: a
tier: epic
milestone: M1
autonomous: false
complexity-budget:
  files: 6
  loc-delta: 700
adopted-patterns:
  - pleri-ask core lib (NEW — pure, framework-agnostic)
  - lib/tmux.js sendText (proven single-line transport)
  - lib/claude-print.js + codex rpc (the other 2 transports)
---

> **Scope**: The `pleri-ask` core lib — pure (no DOM/harness deps) DSL types, out-of-band enum schema, parse/serialize/validate, qid correlation, native-adapter, efficiency benchmark — PLUS the early 3-transport answer round-trip gate that must pass before the renderer is built.
> **Design**: docs/design/ask-protocol.md
> **Branch**: feat/ask-protocol-m1

## Status

| state | count |
|---|---|
| todo | 4 |
| done | 0 |

<!-- CP0 log
- committed 2026-07-19 on docs/ask-protocol; epic tier, M1 milestone. B3: epic sections in the plan. B7: feat/ask-protocol-m1 (single M1 branch, not stacked) — acknowledged.
-->

## Audit item coverage

| Rubric | Task | Reuse-ref |
|---|---|---|
| T3 ask-forgery (strict provenance) | A1 (parse contract) | design strict-structural rule |
| T2 escaped strings | A1 | serialize escapes; no HTML |
| P1 efficiency budget | A4 | benchmark test |
| OQ11/OQ14 3-transport round-trip | A3 | lib/tmux.js, lib/claude-print.js, codex rpc |
| OQ17 single-line answer | A1 | serializeAnswer invariant |

## Task list

### A1 — core lib: DSL + enum schema + parse/serialize
> **Goal**: `pleri-ask` module exports the DSL types + out-of-band enum tables (question kind/flag; preview preview-type/wireframe-element/variant; answer status) keyed by `v`, plus `parseAsk`/`serializeAsk`/`parseAnswer`/`serializeAnswer`; `serializeAnswer` emits a SINGLE physical line (JSON, no raw newlines).
> **Files**: web/src/lib/pleri-ask/index.ts (or a shared module), web/src/lib/pleri-ask/schema.ts
> **Acceptance**: round-trips the design's reference ask + all answer kinds (int/array/string/confirm); serializeAnswer output has zero `\n`; unknown enum value / extra key parses without throwing (forward-compat).
> **Verification**: `npm --prefix web run test -- pleri-ask`
> **Depends on**: none
> **Reversibility**: load-bearing
> **Regression surfaces**: none (new module)
> **Integration-test**: n/a (unit)

### A2 — native-AskUserQuestion → DSL adapter
> **Goal**: A pure adapter mapping the native AskUserQuestion shape → the DSL (questions/options/multiSelect→kind, "(Recommended)"→recommended index) for RENDER normalization.
> **Files**: web/src/lib/pleri-ask/nativeAdapter.ts
> **Acceptance**: a native AskUserQuestion payload maps to an equivalent DSL question set (single + multi + free-text); render output matches.
> **Verification**: `npm --prefix web run test -- pleri-ask`
> **Depends on**: A1
> **Reversibility**: clean-revert
> **Regression surfaces**: none
> **Integration-test**: n/a

### A3 — 3-transport round-trip GATE
> **Goal**: An integration test proving a `<pleri:answer>` (single-line) sent via EACH transport (tmux `sendText`, print `claudePrint.submit`, codex rpc) arrives byte-exact as the agent's next input, correlated by qid. This gate blocks Phase B.
> **Files**: test/pleri-ask-roundtrip.test.js
> **Acceptance**: all 3 transports pass byte-exact round-trip; a multi-line answer is rejected/escaped (not sent raw via the `-l` fallback).
> **Verification**: `node --test test/pleri-ask-roundtrip.test.js`
> **Depends on**: A1
> **Reversibility**: clean-revert
> **Regression surfaces**: server.js reply op; lib/tmux.js sendText
> **Integration-test**: test/pleri-ask-roundtrip.test.js

### A4 — efficiency benchmark
> **Goal**: A test asserting the reference ask serializes ≥30% smaller than the native AskUserQuestion equivalent and the reference answer ≤~40B.
> **Files**: web/src/lib/pleri-ask/efficiency.vitest.ts
> **Acceptance**: benchmark passes the budget; fails if the ask ≥ native or the answer carries labels/keys.
> **Verification**: `npm --prefix web run test -- efficiency`
> **Depends on**: A1
> **Reversibility**: clean-revert
> **Regression surfaces**: none
> **Integration-test**: n/a

## Dependencies between tasks
- A2/A3/A4 depend on A1. A3 (round-trip gate) blocks Phase B.

## Cross-phase regression checks
- Native AskUserQuestion rendering + answering untouched (dual-support) — existing AskInline native tests stay green.

## Rollback rehearsal
- Delete the pleri-ask module + the round-trip test; no runtime wiring yet in Phase A → clean-revert.

## Review sign-off checklist
- [ ] serializeAnswer single-line invariant tested.
- [ ] forward-compat (unknown enum/key) tested.
- [ ] all 3 transports pass the round-trip gate.
- [ ] efficiency budget met.
