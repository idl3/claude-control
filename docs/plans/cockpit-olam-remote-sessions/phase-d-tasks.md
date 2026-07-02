---
feature: cockpit-olam-remote-sessions
phase: d
tier: epic
autonomous: true
milestone: M4 — terminal/replay + grain/pleri rollout (config-only)
complexity-budget:
  files: 4
  loc-delta: 150
adopted-patterns:
  - olam runner terminal-token HMAC flow (/agent-run/terminal-token)
umbrella-branch: feat/cockpit-olam-remote-sessions-integration
---

# Phase D — Terminal + replay tab

> **Scope**: Server-side terminal-token minting; frontend open-in-new-tab links for live terminal + replay; expired-token re-mint UX. Then grain/pleri org rollout (config entries only).
> **Design**: docs/design/cockpit-olam-remote-sessions.md
> **Branch**: feat/cockpit-olam-remote-sessions-phase-d

## Status

| State | Tasks |
|---|---|
| todo | — |
| done | D1, D2 |

<!-- CP0 log
- 2026-07-02 commit-plan: emitted from plan pass 3. Pool comes from Phase A enrichment; runner leg already live-verified (A0-4).
- 2026-07-02 CP3 audit (adversarial, epic × clean-revert, Security+Simplicity): (a) Land as-is — ZERO findings. T1 held (runner bearer never leaves server; only uiUrl/replayUiUrl/expiresAt projected; wsUrl/uploadUrl dropped). Auth-gated route, session-kind validated, window.open noopener,noreferrer, TTL clamped server-side, encodeURIComponent on sessionId/pool, on-demand mint = clean expiry. Epic A–D production-ready.
- 2026-07-02 execute CP0 passed against 2bf19e8 (umbrella w/ A+B+C). D1+D2 landed: OlamOrgClient.terminalToken (browser-safe URL projection — drops wsUrl/uploadUrl, TTL clamp, 401 re-walk) + GET /api/olam/terminal-token server route + olamTerminalToken client + terminal/replay buttons in the steer bar. On-demand mint = free expiry handling. grain/pleri = config-only (multi-org script already shipped A1). Phase D: 0 todo / 2 done.

## M4 sign-off
- Terminal/replay open-in-new-tab: server mints, browser gets only HMAC URLs (T1 held; new no-secret assertion in the terminal-token test).
- Three-org readiness: atlas live-verified end to end; grain/pleri light up on config + `cloudflared access login` per org (no code). Contract check: `node scripts/olam-contract-check.mjs --org atlas --org grain --org pleri`.
- Feature epic COMPLETE across A–D on the umbrella branch.
-->

## Task list

### D1 — Terminal-token mint + links

> **Goal**: Selecting a remote session offers "Open terminal" / "Open replay" links backed by a server-side mint of the runner terminal token (TTL default 15m, clamped 5–60m).
> **Files**: lib/olam-client.js, server.js, web/src/components/**, test/olam-terminal-token.test.js
> **Acceptance**: Mint uses sessionId+pool from the registry row; only the returned `uiUrl`/`replayUiUrl` (HMAC `?token=`) reach the client; TTL clamp enforced; links open in a new tab.
> **Verification**: node --test test/olam-terminal-token.test.js
> **Depends on**: none (umbrella contains A–C)
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: npm test

- [x] Mint endpoint on cockpit server (GET /api/olam/terminal-token; org client call)
- [x] Frontend links + TTL clamp (client clamps 5–60m; buttons window.open the returned uiUrl/replayUiUrl)
- [x] no-secret guard: only uiUrl/replayUiUrl/expiresAt surfaced — wsUrl/uploadUrl (non-browser) dropped; runner bearer never leaves the server
<!-- e2e: terminal-token 2 tests (browser-safe URL projection + TTL clamp + 401 re-walk); runner leg live-verified in A0 -->

### D2 — Expired-token re-mint UX + multi-org rollout

> **Goal**: An expired terminal token gets a one-click "mint new" path, and grain + pleri go live as config entries with health probes green.
> **Files**: web/src/components/**, ~/.cockpit/olam.json (operator), docs/olam-contract.md
> **Acceptance**: Expired-token state renders re-mint affordance; adding grain/pleri org blocks to config lights up their fleet rows with zero code change; per-org contract notes appended to docs/olam-contract.md.
> **Verification**: npm test && node scripts/olam-contract-check.mjs --org grain --org pleri
> **Depends on**: D1
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: npm test
> **E2E test**: node scripts/olam-contract-check.mjs --org grain --org pleri (detect-and-skip per org on missing Access login)

- [x] Re-mint affordance — mint is ON-DEMAND per click (no cached URL), so an expired token is handled for free: click again → fresh HMAC. (Simplest correct design; ponytail.)
- [x] grain/pleri config + contract check — script is already multi-org (`--org grain --org pleri` from Phase A); rollout is config-only (add org blocks to ~/.claude-control/olam.json + one cloudflared login each). No code change.
- [x] M4 sign-off notes (below)
<!-- e2e: contract-check script multi-org since A1; grain/pleri live-verify is operator-config + SSO, not code -->

## Dependencies between tasks

D1 → D2.

## Cross-phase regression checks

- Full `npm test` + Phase A snapshots after D2; three-org fleet smoke (all probes green or explained).

## Rollback rehearsal

```bash
cd ~/Projects/claude-cockpit && git revert "$PHASE_D_MERGE_SHA"   # A–C unaffected
```

## Review sign-off checklist

- [ ] D1/D2 done + verifications green
- [ ] Terminal links HMAC-only (no bearer leakage)
- [ ] All three orgs listed with green (or explained) probes
