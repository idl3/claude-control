# Design — Claude Control ⇄ Olam remote sandbox sessions

> Scaffolded by /100x:commit-plan from `~/.claude/plans/cockpit-olam-remote-sessions.md` (pass 3).
> TODO: fill prose as phases land. Rubric rows harvested from the plan's `## Risk candidates`.

## Threat model

| # | Threat | Mitigation |
|---|---|---|
| T1 | Org bearer/JWT leakage to browser | All org-authed calls server-side in `OlamOrgClient`; only short-TTL HMAC terminal URLs cross to the client; bundle-grep + WS-frame assertion test (`test/no-secret-in-bundle.test.js`). |
| T2 | Secret drift (reproduced live in A0: 2 of 3 atlas token copies stale) | GSM-first + rotation-file fallback; 401 → single re-read + non-secret digest audit log + 3-strikes/60s backoff + red badge; probe spans runner/SPA/brain. |
| T3 | Operator-JWT refresh brittleness (CF Access session expiry mid-stream) | `cloudflared access token` auto-refresh; UI re-login prompt; named upgrade = ADR-063-pattern additive automation bearer on the SPA worker. |
| T4 | Sending into an approval-gated session via dispatch does the wrong thing | Composer modes (steer/approve/read-only) driven by session state; approve routes via gateway automation bearer or Linear deep-link. |
| T5 | Claude Control process compromise exposes bearers in memory | Claude Control auth token mandatory-on with remote orgs (fail-loud startup); localhost bind default; `ulimit -c 0` documented; token-file path validation; no token logging. |
| T6 | Dispatch failure classes (429 rate-cap / 402 budget / 502 cost-unknown) eaten silently | Surfaced verbatim in-thread, retriable; covered by `test/olam-transport-steer.test.js`. |

## Performance findings

| # | Concern | Target / How measured |
|---|---|---|
| P1 | Polling fan-out across 3 orgs | list+status ≤0.3 req/s total; ≤1 chunks long-poll open (selected session only); counted at the org client. |
| P2 | Chunk→append mapping cost | O(new rows), bounded initial backfill (row-count analogue of 64KB/1MB tail bounds); stream latency p95 ≤5s claude-control-added, Neon/Electric lag excluded (measured once in Phase B bring-up). |

## Simplicity findings

| # | Temptation | What we do instead |
|---|---|---|
| S1 | Build an olam-side fleet aggregator | Consume A0-verified recipes on deployed surfaces; at most an additive SELECT + ADR-063-pattern bearer. |
| S2 | Custom xterm/WS terminal bridge | Link/iframe the runner-minted `uiUrl` / `replayUiUrl`. |
| S3 | Generic remote-backend plugin framework | One concrete `'olam'` transport; extract an interface only when a second remote backend exists. |

## Principles & Seams

Seam: all remote state enters through one per-org `OlamOrgClient` adapter over olam's public HTTP surfaces (A0-verified recipes; `session_id` join key per olam ADR-062). Bet: recipes hold live; at most an additive SELECT and/or one automation bearer lands olam-side.

## Unwind cost

Falsified recipe → hybrid fallback (claude-control list + SPA deep-links), confined to `lib/olam-client.js` / `lib/olam-transcript.js`; Phases A/D survive. Full rollback: remove `~/.cockpit/olam.json` (feature-flag) or `git revert` per-phase commits; no data migration.
