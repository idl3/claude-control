---
feature: cockpit-protocol-split-native-heads
phase: a
tier: epic
autonomous: true
milestone: "M0-M1.5"
complexity-budget: { files: 25, loc-delta: 3500 }
adopted-patterns: [ws, node-pty, "@xterm/xterm+webgl", zod, lib/terminal.js-attach-model]
---

# Phase A — PTY-direct terminal + protocol seed (kill ttyd) + adoption spike

> **Scope**: In-app terminal over a direct binary PTY bridge; lib/protocol seed + fingerprint gate; ttyd retired behind a soak flag; disposable Tauri site-wrapper spike; latency baseline FIRST.
> **Design**: docs/design/cockpit-protocol-split-native-heads.md
> **Branch**: feat/cockpit-protocol-phase-a

## Status
| state | tasks |
|---|---|
| todo | A1 A2 A3 A4 A5 A6 A7 A8 |
| done | — |

<!-- CP0 log: emitted 2026-07-15 by /100x:commit-plan; B3 missing-sections authored at commit; B6 elided: none (epic full shape); B7 stacked-PR: acknowledged 2026-07-15 — sequential phase branches, re-target-then-merge per stacked-pr-merge-order.md -->

## Audit item coverage
| Audit | Covered by | Reuse-ref |
|---|---|---|
| T3, T6 | A4, A5 | lib/terminal.js model; xterm.js |
| P1 | A2 | latency harness |
| S1 | A3 | zod plain-JS convention |
| B1 | A7 | A-spike |

## Task list

### A1 — Terminal-panel design pass (OPEN Phase-A blocker)
> **Goal**: /100x:design output for the in-app terminal exists covering focus handoff, hotkey-passthrough table, scrollback/copy-mode vs tmux, disconnect/reconnect visual states.
> **Files**: docs/design/cockpit-protocol-split-native-heads.md
> **Acceptance**: all four decision areas have concrete, implementable rules (no TBDs).
> **Verification**: grep -c "focus handoff\|passthrough\|copy-mode\|reconnect state" docs/design/cockpit-protocol-split-native-heads.md → ≥4 sections
> **Depends on**: none
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (docs only)
> **Integration-test**: n/a

### A2 — Latency harness + ttyd calibration baseline
> **Goal**: keystroke-echo harness (p50/p95/p99 over 500 keys, path-type logged) runs against CURRENT ttyd and records the baseline before any bridge code lands.
> **Files**: scripts/latency-harness/ (new), docs/plans/cockpit-protocol-split-native-heads/baseline.md (new)
> **Acceptance**: baseline.md carries ttyd p50/p95/p99 on loopback + direct tailnet, 3 runs, ±10% variance rule applied.
> **Verification**: node scripts/latency-harness/run.mjs --target ttyd --runs 3
> **Depends on**: none
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: n/a

### A3 — lib/protocol seed + schema-fingerprint gate
> **Goal**: lib/protocol/*.js (plain JS + JSDoc + zod) defines PTY-stream + session-list schemas + PROTOCOL_VERSION; fingerprint test fails on shape change without version bump; zod added as direct root dep; web vite alias @protocol wired.
> **Files**: lib/protocol/*.js, test/protocol-fingerprint.test.js, package.json, web/vite.config.ts
> **Acceptance**: fingerprint test red on unbumped schema edit, green otherwise; web build resolves @protocol.
> **Verification**: node --test test/protocol-fingerprint.test.js && cd web && npm run build
> **Depends on**: none
> **Reversibility**: load-bearing
> **Regression surfaces**: npm packaging (lib/ already in files allowlist — verify npm pack --dry-run)
> **Integration-test**: npm pack --dry-run | grep lib/protocol

### A4 — PTY bridge (server)
> **Goal**: WS binary PTY bridge — ONE node-pty `tmux attach` per session, N-view fan-out, ref-count teardown, largest-client sizing, resize/backpressure, dead-target typed error (no auto-retry), LRU cap on attached sessions, bearer-gated, audit-log per attach.
> **Files**: lib/pty-bridge.js (new), server.js, test/pty-bridge.test.js (new)
> **Acceptance**: multi-attach test asserts exactly ONE tmux client per session; dead-target returns typed error frame; unauth WS rejected.
> **Verification**: node --test test/pty-bridge.test.js test/server-hardening.test.js
> **Depends on**: A3
> **Reversibility**: load-bearing
> **Regression surfaces**: reply/send-keys path (test/answer.test.js, test/tmux-sendtext.test.js), terminal auth
> **Integration-test**: node --test test/pty-bridge.test.js (isolated tmux -L cc-test; CI job per OQ11 — finalize here)

### A5 — In-app terminal panel (web)
> **Goal**: xterm.js WebGL panel replaces the ttyd iframe, implementing A1's focus/hotkey/scrollback/reconnect rules; OSC-52 disabled by default (T6).
> **Files**: web/src/components/TerminalPanel.tsx, web/src/components/TerminalPane.tsx, web/src/lib/pty-client.ts (new), web/package.json
> **Acceptance**: typing round-trips through the bridge; hotkey-passthrough table honored; reconnect state visible per design.
> **Verification**: cd web && npx vitest run && npx playwright test terminal
> **Depends on**: A1, A4
> **Reversibility**: clean-revert
> **Regression surfaces**: composer hotkeys, transcript scroll
> **Integration-test**: Playwright terminal round-trip E2E

### A6 — ttyd retirement behind soak flag
> **Goal**: CLAUDE_CONTROL_TERMINAL flag (default: bridge; ttyd = fallback) using TOKEN_ENV conditional-omit plist pattern; after soak, ttyd spawn/proxy/checkTerminalToken/?token= deleted.
> **Files**: server.js, lib/terminal.js, bin/install-service.sh, test/server-hardening.test.js
> **Acceptance**: flag flip rehearsed via launchctl setenv+kickstart and VERIFIED with launchctl getenv; post-soak grep gate: zero runtime ttyd refs.
> **Verification**: node --test test/server-hardening.test.js && ! grep -rn "ttyd" lib/ server.js --include="*.js" -l
> **Depends on**: A5
> **Reversibility**: forward-fix-only (deletion after soak)
> **Regression surfaces**: terminal auth, self-update flow
> **Integration-test**: manual soak week + rollback rehearsal (launchctl getenv check)

### A7 — A-spike: Tauri site-wrapper + adoption counter
> **Goal**: disposable Tauri v2 app pointing WKWebView at the deployed tailnet URL (origin already allowlisted — zero backend changes); server logs per-head client-id on WS connect for the adoption counter.
> **Files**: spike/tauri-wrap/ (new, outside npm files allowlist), server.js (client-id log line), lib/protocol/ (client-id field)
> **Acceptance**: wrap connects over tailnet, sessions usable; counter distinguishes wrap vs browser opens.
> **Verification**: manual smoke + grep client-id in server log
> **Depends on**: A3
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (origin allowlist untouched)
> **Integration-test**: n/a (disposable spike)

### A8 — Parity checklist draft
> **Goal**: docs/plans/cockpit-protocol-split-native-heads/parity-checklist.md enumerates the full current web control-action surface (reply, approve, session create/kill/rename, terminal, uploads, media, config, push, pins, skills).
> **Files**: docs/plans/cockpit-protocol-split-native-heads/parity-checklist.md (new)
> **Acceptance**: every SPA control action listed with a verification method; reviewed against web/src/App.tsx + components.
> **Verification**: manual review; checklist referenced by C5
> **Depends on**: none
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (docs)
> **Integration-test**: n/a

## Dependencies between tasks
A1 → A5; A3 → A4 → A5 → A6; A3 → A7. A2, A8 parallel-free.

## Cross-phase regression checks
lib/protocol (A3) is consumed by Phase C — fingerprint gate guards it. PTY bridge untouched by B/C.

## Rollback rehearsal
Phase-A close requires one rehearsed flag-flip: launchctl setenv CLAUDE_CONTROL_TERMINAL ttyd && kickstart, verify getenv + ttyd path serves, flip back.

## Review sign-off checklist
- [ ] AC1 latency budget met (direct path, vs baseline)
- [ ] AC2 ttyd retired (grep gate)
- [ ] AC7 spike counter live
- [ ] web parity checklist drafted (A8)
- [ ] rollback rehearsal logged
