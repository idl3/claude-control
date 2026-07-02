# Olam surface contract (per-org recipes)

Live-verified recipes the remote-sessions feature builds on. Re-check any org with:

```bash
node scripts/olam-contract-check.mjs --org atlas [--org grain] [--org pleri]
```

Sources: plan A0 spike (2026-07-02, `~/.claude/plans/cockpit-olam-remote-sessions.md`) + this script's live runs. Olam refs: ADR-062 (session_id join key), ADR-063/064 (automation-bearer pattern), `docs/runbooks/linear-agent-sandbox-workflow.md`.

## Recipes

| Concern | Recipe | Auth | Status |
|---|---|---|---|
| List sessions | `GET <spa>/api/plan-chat/v1/sessions?type=chat&scope=all` — returns `{session_id, world_id, total_usd, budget_usd_cap, in_flight_turn_id, halted_at, last_turn_at, created_at, summary, origin_chat_id}`; NO pool/linear/phase columns | CF Access JWT (operator, via `cloudflared access token`) | source-verified (`neon-handlers.ts:458`); live check pending Access login |
| Metadata join | `session_id === Linear AgentSession id === planId` (ADR-062). Linear linkage derives from the id; phase enriches from runner status; pool defaults by origin (`linear` for Linear-delegated, `sandbox` for plan-origin), probe-confirmed | — | source-verified |
| Steer (chat/Linear session) | `POST <spa>/api/cloud-dispatch` mirroring `writeCloudDispatch` (sessionId, prompt, idempotencyKey) → plan-DO; resume semantics; identity = verified CF Access sub | CF Access JWT | source-verified (`App.tsx` handleSend cell #4; `server/index.ts:3720`) |
| Steer (dispatch session) | `POST .../v1/dispatch-turn {session_id, prompt, mode?: soft|hard}` → 200 turn / 202 `{queued, mode, steer_id}`; errors 401/400/404(ownership)/409(in-flight lock)/402(budget)/502(cost-unknown) | bearer (local path) / JWT (cloud) | source-verified (`plan-chat-service.mjs:1023`) |
| Stream conversation | Electric shape long-poll on `chunks` by `session_id` via `<spa>/api/plan-chat/v1/shape` | CF Access JWT (posture probe: non-401 with params-level response = cleared) | pending Access login |
| Runner status | `GET <runner>/agent-run/status?sessionId&pool` → `{sessionId, phase, done, clones, prs, prCount, detail, feed, feedCursor}`. 200 even for unknown sessions — existence comes from the list, never from status. `feed`/`feedCursor` = incremental event feed (degraded-mode source) | `Authorization: Bearer <runner token>` | **live-verified (atlas, 2026-07-02)** |
| Terminal / replay | `POST <runner>/agent-run/terminal-token?sessionId&pool&ttl` → `{sessionId, pool, expiresAt, ttlSeconds, wsUrl, uiUrl, replayUrl, replayUiUrl, uploadUrl}`; URLs embed a short-TTL HMAC `?token=` — the only credential allowed client-side | bearer (mint), HMAC (use) | **live-verified (atlas, 2026-07-02)** |

## Per-org coordinates

| Org | Runner | SPA | Runner token candidates (probe-arbitrated, in order) |
|---|---|---|---|
| atlas | `olam-worker-runner-sandbox.atlas-kitchen.workers.dev` | `olam.dev-atlas.kitchen` (CF Access team `atlas-development`) | GSM `olam-atlas-sandbox-runner-token` → `~/.olam/secrets/sandbox-runner-token` → `~/.olam/secrets/atlas-olam-task-token` |
| grain | `olam-worker-runner-sandbox.grain.workers.dev` *(unverified)* | `olam.grain.kitchen` *(unverified)* | GSM `olam-grain-sandbox-runner-token` → `~/.olam/secrets/grain-olam-task-token` |
| pleri | `olam-worker-runner-sandbox.kaluga.workers.dev` *(unverified)* | `olam.kaluga.co` | GSM `olam-pleri-sandbox-runner-token` → `~/.olam/secrets/pleri-olam-task-token` |

grain/pleri coordinates are provisional until their D2 contract runs (`wrangler.<org>.toml` in olam is authoritative).

## Live-run findings (atlas, 2026-07-02)

- Runner status + terminal-token: **200 PASS** with the rotation-file bearer.
- **Secret drift is real and current**: GSM `olam-atlas-sandbox-runner-token` (sha256:9e9c10ca…) returns 401 against the live worker; `~/.olam/secrets/sandbox-runner-token` (sha256:e6e0884d…) works. The probe, not any single store, is the arbiter — cockpit's health probe must implement exactly this candidate walk. *Escalation: cut a new GSM version matching the live worker (operator-gated secret write).*
- SPA legs skipped: no cloudflared Access session yet. Unlock: `cloudflared access login https://olam.dev-atlas.kitchen`, then re-run the script — it records the sessions-list field snapshot + shape auth posture.

## Known forks (planned responses)

- **Shape rejects operator JWT** (unexpected): fall to degraded feed/logTail mode (plan T3); durable fix = ADR-063-pattern additive automation bearer on the SPA worker (deploy via `/pleri-deploy-orgs`).
- **List metadata insufficient in practice**: additive SELECT of existing `planning_sessions` columns (`linear_issue_id` exists at `chunks/src/schema.ts:176`).
