# Olam surface contract (per-org recipes)

Live-verified recipes the remote-sessions feature builds on. Re-check any org with:

```bash
node scripts/olam-contract-check.mjs --org atlas [--org grain] [--org pleri]
```

Sources: plan A0 spike (2026-07-02, `~/.claude/plans/cockpit-olam-remote-sessions.md`) + this script's live runs. Olam refs: ADR-062 (session_id join key), ADR-063/064 (automation-bearer pattern), `docs/runbooks/linear-agent-sandbox-workflow.md`.

## Recipes

| Concern | Recipe | Auth | Status |
|---|---|---|---|
| List sessions | `GET <spa>/api/plan-chat/v1/sessions?type=chat&scope=all` — LIVE returns `{session_id, world_id, total_usd, budget_usd_cap, in_flight_turn_id, halted_at, last_turn_at, created_at, summary, origin_chat_id, actor_id, title, linear_issue_id, planned, plan_status, owner_email}` (richer than the source snapshot — `linear_issue_id` IS present; no pool/phase, enrich via runner) | two-layer (below) | **live-verified (atlas, 43 rows, 2026-07-02)** |
| Metadata join | `session_id === Linear AgentSession id === planId` (ADR-062). Linear linkage derives from the id; phase enriches from runner status; pool defaults by origin (`linear` for Linear-delegated, `sandbox` for plan-origin), probe-confirmed | — | source-verified |
| Steer (chat/Linear session) | `POST <spa>/api/cloud-dispatch` mirroring `writeCloudDispatch` (sessionId, prompt, idempotencyKey) → plan-DO; resume semantics; identity = verified CF Access sub | CF Access JWT | source-verified (`App.tsx` handleSend cell #4; `server/index.ts:3720`) |
| Steer (dispatch session) | `POST .../v1/dispatch-turn {session_id, prompt, mode?: soft|hard}` → 200 turn / 202 `{queued, mode, steer_id}`; errors 401/400/404(ownership)/409(in-flight lock)/402(budget)/502(cost-unknown) | bearer (local path) / JWT (cloud) | source-verified (`plan-chat-service.mjs:1023`) |
| Stream conversation | Electric shape long-poll via `<spa>/api/plan-chat/v1/shape?table=chunks\|message_usage\|planning_artifacts\|planning_sessions` by `session_id` | two-layer (below) | **live-verified auth-cleared (400 params-level) — Phase B GO, full mode** |
| Runner status | `GET <runner>/agent-run/status?sessionId&pool` → `{sessionId, phase, done, clones, prs, prCount, detail, feed, feedCursor}`. 200 even for unknown sessions — existence comes from the list, never from status. `feed`/`feedCursor` = incremental event feed (degraded-mode source) | `Authorization: Bearer <runner token>` | **live-verified (atlas, 2026-07-02)** |
| Terminal / replay | `POST <runner>/agent-run/terminal-token?sessionId&pool&ttl` → `{sessionId, pool, expiresAt, ttlSeconds, wsUrl, uiUrl, replayUrl, replayUiUrl, uploadUrl}`; URLs embed a short-TTL HMAC `?token=` — the only credential allowed client-side | bearer (mint), HMAC (use) | **live-verified (atlas, 2026-07-02)** |

## Per-org coordinates

| Org | Runner | SPA | Runner token candidates (probe-arbitrated, in order) |
|---|---|---|---|
| atlas | `olam-worker-runner-sandbox.atlas-kitchen.workers.dev` | `olam.dev-atlas.kitchen` (CF Access team `atlas-development`) | GSM `olam-atlas-sandbox-runner-token` → `~/.olam/secrets/sandbox-runner-token` → `~/.olam/secrets/atlas-olam-task-token` |
| grain | `olam-worker-runner-sandbox.grain.workers.dev` *(unverified)* | `olam.grain.kitchen` *(unverified)* | GSM `olam-grain-sandbox-runner-token` → `~/.olam/secrets/grain-olam-task-token` |
| pleri | `olam-worker-runner-sandbox.kaluga.workers.dev` *(unverified)* | `olam.kaluga.co` | GSM `olam-pleri-sandbox-runner-token` → `~/.olam/secrets/pleri-olam-task-token` |

grain/pleri coordinates are provisional until their D2 contract runs (`wrangler.<org>.toml` in olam is authoritative).

## SPA machine-client auth recipe (two layers, live-verified)

1. **CF Access JWT** (operator identity): `cloudflared access token --app=<spaBase>` (one-time `cloudflared access login <spaBase>` per org per machine). Send as `cf-access-token: <jwt>` — the Access edge validates it and injects the assertion the worker verifies (aud/team pinned per org; atlas: `dc225d66…` / `atlas-development`).
2. **App bearer**: `GET <spa>/api/bootstrap` with the JWT → `{token}` = the plan-chat read bearer, handed by design to Access-authenticated clients. Send as `Authorization: Bearer <token>` on every `/api/plan-chat/v1/*` call.

Sending only layer 1 yields the worker's `401 {"error":"unauthorized"}` from the route-level bearer gate (`neon-handlers.ts checkAuth`) — that 401 does NOT mean the JWT failed.

## Live-run findings (atlas, 2026-07-02)

- Runner status + terminal-token: **200 PASS** with the rotation-file bearer.
- **Secret drift is real and current**: GSM `olam-atlas-sandbox-runner-token` (sha256:9e9c10ca…) returns 401 against the live worker; `~/.olam/secrets/sandbox-runner-token` (sha256:e6e0884d…) works. The probe, not any single store, is the arbiter — cockpit's health probe must implement exactly this candidate walk. *Escalation: cut a new GSM version matching the live worker (operator-gated secret write).*
- SPA legs: **PASS** after operator SSO — sessions 200 (43 rows, full field snapshot above); shape auth cleared (400 params-level; tables: chunks, message_usage, planning_artifacts, planning_sessions). Phase B ships FULL mode.

## Known forks (planned responses)

- ~~Shape rejects operator JWT~~ — did not fire; two-layer recipe clears. Degraded feed/logTail mode remains the per-org fallback if an org's SPA deploy drifts.
- ~~List metadata insufficient~~ — did not fire; the live list carries `linear_issue_id`/`title`/`plan_status`.
- **App bearer rotation**: `/api/bootstrap` re-fetch on 401 (built into `OlamOrgClient.invalidateAccessToken()` path).
