---
feature: cockpit-protocol-split-native-heads
phase: d
tier: epic
autonomous: true
milestone: "M4-M5"
complexity-budget: { files: 30, loc-delta: 2500 }
adopted-patterns: [tauri-v2, IndexedDB-reuse, keychain-deferred]
---

# Phase D — Minimal Tauri v2 macOS head

> **Scope**: Bundled-asset Tauri app (origin-allowlist line item), reusing the web cache layer; hotkeys + notifications + signed auto-update; falsifier-2 counter live.
> **Design**: docs/design/cockpit-protocol-split-native-heads.md
> **Branch**: feat/cockpit-protocol-phase-d

## Status
| state | tasks |
|---|---|
| todo | D1 D2 D3 D4 |
| done | — |

<!-- CP0 log: emitted 2026-07-15 by /100x:commit-plan; B6 elided: Out of scope (see README). Gate: M1.5 A-spike verdict must be >=20% before this phase starts. -->

## Audit item coverage
| Audit | Covered by | Reuse-ref |
|---|---|---|
| T4 | D4 | signed updater |
| T5 | D3 | WebKit storage path |
| S3 | D1-D2 | minimal plugin set |
| C2 | D4 | operator-only distribution |

## Task list

### D1 — Tauri app shell (bundled assets)
> **Goal**: Tauri v2 app bundling web/dist; origin-allowlist extended for tauri://localhost (explicit backend line item per feasibility F4); window model per pre-D design note.
> **Files**: app/ (new Tauri project), server.js (isAllowedOrigin), web/vite.config.ts
> **Acceptance**: app connects over tailnet; terminal + transcripts functional.
> **Verification**: manual smoke + Playwright-driven webview where feasible
> **Depends on**: none (gated on M1.5 + M3)
> **Reversibility**: clean-revert
> **Regression surfaces**: origin allowlist (test/server-hardening.test.js — extend)
> **Integration-test**: backend suite + app smoke

### D2 — Native affordances (minimal set)
> **Goal**: global hotkeys + own keybinding namespace; native notifications (approval-needed, session-error, @-mention; click focuses correct session; per-session throttle). NO keychain/menubar/MLX (adoption-gated per S3).
> **Files**: app/src/, web/src (notification triggers)
> **Acceptance**: hotkey summons app from background; notification click lands on the right session.
> **Verification**: manual smoke checklist
> **Depends on**: D1
> **Reversibility**: clean-revert
> **Regression surfaces**: web notification path (no regression — additive)
> **Integration-test**: n/a (manual)

### D3 — Cache reuse + storage verification + falsifier-2 counter
> **Goal**: web IndexedDB cache works under WKWebView (1-week soak; SQLite trigger documented if eviction observed); WebKit storage path (~/Library/WebKit/<bundle-id>) confirmed + added to uninstall docs; falsifier-2 per-head counter reporting.
> **Files**: app/, docs/plans/cockpit-protocol-split-native-heads/ (soak + counter reports)
> **Acceptance**: offline cache read works; storage path verified; counter distinguishes heads.
> **Verification**: soak report + counter output
> **Depends on**: D1
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: 1-week soak

### D4 — Signed auto-update + T4 controls
> **Goal**: Tauri updater with signature verification; signing key in secret manager (never dev laptop); pinned origin (GitHub Releases); key-rotation runbook written BEFORE first shipped update.
> **Files**: app/tauri.conf.json, docs/plans/cockpit-protocol-split-native-heads/update-runbook.md (new)
> **Acceptance**: update path exercised once end-to-end with signature check proven (tampered artifact rejected).
> **Verification**: manual signed-update drill, documented
> **Depends on**: D1
> **Reversibility**: load-bearing
> **Regression surfaces**: isolated (app-only; server untouched)
> **Integration-test**: signed-update drill

## Dependencies between tasks
D1 → D2, D3, D4 (parallel after shell).

## Cross-phase regression checks
Server changes limited to origin allowlist (D1) — everything else app-side. Falsifier-2 window (M5) opens at D-close.

## Rollback rehearsal
rm -rf app bundle + Application Support + Caches + ~/Library/WebKit/<bundle-id> + keychain entry (playbook block; trips G-006 — confirm-and-proceed).

## Review sign-off checklist
- [ ] AC6 counter live, window open
- [ ] T4 drill passed (tampered artifact rejected)
- [ ] WebKit storage path documented
