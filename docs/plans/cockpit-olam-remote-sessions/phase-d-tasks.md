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
| todo | D1, D2 |
| done | — |

<!-- CP0 log
- 2026-07-02 commit-plan: emitted from plan pass 3. Pool comes from Phase A enrichment; runner leg already live-verified (A0-4).
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

- [ ] Mint endpoint on cockpit server (org client call)
- [ ] Frontend links + TTL clamp
- [ ] no-secret guard extended to terminal URLs (HMAC-only assertion)

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

- [ ] Re-mint affordance
- [ ] grain/pleri config + Access logins + contract check
- [ ] M4 sign-off notes

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
