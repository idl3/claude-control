---
feature: cockpit-olam-remote-sessions
phase: a
tier: epic
autonomous: true
milestone: M1 — Phase A live on atlas, health probe green 1 week
complexity-budget:
  files: 10
  loc-delta: 900
adopted-patterns:
  - claude-cockpit lib/sessions.js SessionRegistry merge + refresh loop
  - olam plan-chat cloud surface (/api/plan-chat/v1/sessions)
  - olam ADR-062 session_id canonical join key
umbrella-branch: feat/cockpit-olam-remote-sessions-integration
---

# Phase A — Org config + read-only fleet (SessionSource)

> **Scope**: Per-org config + GSM-first secrets, `OlamOrgClient` (list + status enrichment + operator-JWT auth), health probe, `RemoteSessionSource` merged into `SessionRegistry`, frontend fleet view. Read-only — no steering, no streaming.
> **Design**: docs/design/cockpit-olam-remote-sessions.md
> **Branch**: feat/cockpit-olam-remote-sessions-phase-a

## Status

| State | Tasks |
|---|---|
| todo | A1, A2, A3, A4, A5, A6 |
| done | — |

<!-- CP0 log
- 2026-07-02 commit-plan: emitted from plan pass 3 (autonomous: true, confidence 97). B3 gate: plan amended with ## Reuse decisions + ## Dependency topology (authored from established plan content). B6 elided: none (epic keeps full scaffold).
- 2026-07-02 execute CP0 passed against 776bcd0 (rubrics present: T1-T6/P1-P2/S1-S3, seams, unwind cost). CP1.5 umbrella resolved: feat/cockpit-olam-remote-sessions-integration (PR #143). A1 partial-landed (SPA legs await operator SSO); advancing to A2 per DAG (A1 || A2). cumulative: files=2, loc=~330 (budget: 0.2x)
-->

## Audit item coverage

| Rubric | Covered by | Reuse-ref |
|---|---|---|
| T1 | A2, A6 | cockpit auth token config pattern (lib/auth.js) |
| T2 | A2, A4 | GSM-first + rotation-file fallback (plan A0-4) |
| T3 | A3 | cloudflared access token flow |
| T5 | A2 | lib/auth.js checkToken/checkWsToken |
| P1 | A3, A5 | SessionRegistry 4s refresh cadence (remote: 10s) |

## Task list

### A1 — Live-verify the SPA contract (finish A0 residue)

> **Goal**: The four A0 recipes are confirmed against live atlas with authenticated calls, documented in `docs/olam-contract.md`.
> **Files**: docs/olam-contract.md, scripts/olam-contract-check.mjs
> **Acceptance**: Script exits 0 against atlas: sessions list 200 (fields snapshot recorded), shape endpoint auth behavior recorded, runner status/terminal-token 200; findings (incl. any recipe corrections) written to docs/olam-contract.md.
> **Verification**: node scripts/olam-contract-check.mjs --org atlas
> **Depends on**: none
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (new files only)
> **Integration-test**: n/a (this task IS the integration check)
> **E2E test**: node scripts/olam-contract-check.mjs --org atlas (detect-and-skip with `[e2e:skipped] reason: no Access session` when cloudflared login absent)

- [ ] Complete `cloudflared access login https://olam.dev-atlas.kitchen` (operator SSO; prompt if absent)
- [ ] Authenticated GET sessions list — snapshot returned fields; confirm absence of pool/linear metadata; record ADR-062 join recipe
- [ ] Probe shape endpoint auth with the operator JWT; record accept/reject
- [x] Re-run runner status/terminal-token checks; record `feed`/`feedCursor` shape
- [x] Write docs/olam-contract.md (per-org recipe table; correction notes if any recipe diverges)
<!-- e2e: pass-with-skips (runner legs PASS live; SPA legs [e2e:skipped] no Access session) on 2026-07-02 -->
<!-- A1 partial: 3 SPA subtasks blocked on operator SSO (cloudflared access login https://olam.dev-atlas.kitchen) -->
<!-- live finding: GSM olam-atlas-sandbox-runner-token stale (401) vs rotation file (200) - probe-arbitrated; GSM version refresh escalated -->

### A2 — Org config + GSM-first secret loading + mandatory cockpit auth

> **Goal**: Cockpit loads per-org config from `~/.cockpit/olam.json`, resolves secrets GSM-first with rotation-file fallback, and refuses to start remote sources without its own auth token enabled.
> **Files**: lib/olam-config.js, server.js, test/olam-config.test.js
> **Acceptance**: Config with `{org, runnerUrl, spaBase, gsmProject, secrets}` parses; GSM read path (`gcloud secrets versions access`) preferred with file fallback; startup with orgs configured + no cockpit token exits 1 with a clear message; token values never appear in logs; token-file paths validated (absolute, no traversal/symlink escape).
> **Verification**: node --test test/olam-config.test.js
> **Depends on**: none
> **Reversibility**: clean-revert
> **Regression surfaces**: server startup path (cockpit without olam.json must boot exactly as before)
> **Integration-test**: node --test test/olam-config.test.js

- [ ] Config schema + loader (absent file → remote sources disabled, zero behavior change)
- [ ] Secret resolver: GSM-first (`ernest.codes@gmail.com` account), file fallback, in-memory only
- [ ] Mandatory-auth gate (decision 7) — fail-loud startup
- [ ] Path validation + no-logging discipline + tests

### A3 — OlamOrgClient: list + enrichment + operator-JWT auth

> **Goal**: A per-org client returns a normalized remote-session array `{sessionId, org, phase, pool, linearRef, lastActivity}` from the sessions endpoint + runner status enrichment, authenticating via cloudflared-minted operator JWTs with auto-refresh.
> **Files**: lib/olam-client.js, test/olam-client.test.js
> **Acceptance**: Against a mock SPA/runner: list normalizes; pool derived origin-first (`linear`→probe-confirm); phase from runner status; JWT minted via `cloudflared access token`, refreshed on expiry, re-login surfaced as a typed error (not a crash); 401 triggers the T2 re-read path once.
> **Verification**: node --test test/olam-client.test.js
> **Depends on**: A2
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated (new module)
> **Integration-test**: node --test test/olam-client.test.js

- [ ] JWT mint/refresh wrapper around cloudflared (typed NoAccessSession error)
- [ ] Sessions list fetch + ADR-062 join normalization
- [ ] Runner status enrichment batch (≤1 cycle/10s/org) + pool probe-confirm
- [ ] 401 → single token re-read (audit digest log) hook

### A4 — Per-org health probe with error classification

> **Goal**: Each org shows green/amber/red from a probe spanning runner, SPA, and linear-agent brain `/health install_present`, with auth-vs-transient classification and 3-strikes backoff.
> **Files**: lib/olam-health.js, test/olam-health-probe.test.js
> **Acceptance**: 401/403 → red after one re-read (digest audit line emitted); timeout/5xx → amber with auto-retry; ≥3 consecutive auth failures in 60s → stop retrying until manual refresh; `install_present: false` → red with reason "Linear app install missing".
> **Verification**: node --test test/olam-health-probe.test.js
> **Depends on**: A3
> **Reversibility**: clean-revert
> **Regression surfaces**: isolated
> **Integration-test**: node --test test/olam-health-probe.test.js

- [ ] Probe loop + error classes + backoff
- [ ] Brain `/health` check integration
- [ ] Health state exposed on the org client for A5/A6

### A5 — RemoteSessionSource merged into SessionRegistry

> **Goal**: Remote sessions appear in the registry as `kind: 'remote'`, `transport: 'olam'` rows alongside tmux sessions, refreshing ~10s/org, with local discovery byte-identical to today.
> **Files**: lib/sessions.js, lib/olam-sessions.js, test/sessions-remote-merge.test.js, test/ws-protocol-compat.test.js
> **Acceptance**: Merge test proves tmux rows unchanged (snapshot) + remote rows carry {org, sessionId, phase, pool, linearRef}; WS protocol snapshot shows no new required fields on local sessions; removing olam.json restores the exact pre-feature registry output.
> **Verification**: node --test test/sessions-remote-merge.test.js test/ws-protocol-compat.test.js
> **Depends on**: A3, A4
> **Reversibility**: clean-revert
> **Regression surfaces**: SessionRegistry refresh loop, WS session-list payloads (every cockpit client sees these)
> **Integration-test**: npm test

- [ ] RemoteSessionSource adapter (registry-facing shape)
- [ ] Merge + eviction semantics (org unhealthy → rows greyed, not dropped)
- [ ] Snapshot tests for local-path invariance

### A6 — Frontend fleet view

> **Goal**: The session list shows per-org groups below tmux groups with org badge, phase, Linear link, health badge, and loading/empty/error states; no org secret reaches the client.
> **Files**: web/src/lib/types.ts, web/src/hooks/useCockpit.ts, web/src/components/** (session list + badges), test/no-secret-in-bundle.test.js
> **Acceptance**: Remote rows render grouped per org with states (loading skeleton, per-org error banner, empty "no remote sessions"); Linear link derives from session id; bundle-grep + WS-frame fixture test passes (only `?token=` HMAC URLs allowed client-side).
> **Verification**: npm run build:web && node --test test/no-secret-in-bundle.test.js
> **Depends on**: A5
> **Reversibility**: clean-revert
> **Regression surfaces**: session list rendering for local sessions (visual + snapshot)
> **Integration-test**: npm test && npm run build:web

- [ ] Types + hook plumbing for remote fields
- [ ] Org group headers, badges, health dot, per-org states
- [ ] no-secret-in-bundle test

## Dependencies between tasks

A1 ∥ A2 → A3 → A4 → A5 → A6 (A1 informs A3's recipes; hard dep only if A1 finds a recipe correction).

## Cross-phase regression checks

- After A5/A6 land: full `npm test` + manual smoke of a pure-local cockpit (no olam.json) — byte-identical session list and WS frames.
- Phase B/C/D worktrees branch off the umbrella tip — re-run `test/sessions-remote-merge.test.js` after each phase merges.

## Rollback rehearsal

```bash
mv ~/.cockpit/olam.json ~/.cockpit/olam.json.off && pkill -f 'node.*claude-cockpit'  # feature-flag off
cd ~/Projects/claude-cockpit && git revert "$PHASE_A_MERGE_SHA"                      # full revert
```

## Review sign-off checklist

- [ ] All 6 tasks done + verification commands green
- [ ] T1/T2/T3/T5/P1 rubric rows demonstrably covered (see Audit item coverage)
- [ ] Local-only cockpit behavior byte-identical (snapshots)
- [ ] docs/olam-contract.md committed with live-verified recipes
