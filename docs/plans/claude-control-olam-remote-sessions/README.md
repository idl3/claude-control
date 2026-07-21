# claude-control-olam-remote-sessions — tracker index

One unified claude-control pane that lists, watches (conversation-grade, live), and steers every ongoing remote olam agent session (atlas/grain/pleri, incl. Linear-delegated) alongside local tmux sessions — org credentials confined to the claude-control server process.

- Plan: `~/.claude/plans/cockpit-olam-remote-sessions.md` (pass 3, tier epic, autonomous: true, confidence 97)
- Design: [docs/design/claude-control-olam-remote-sessions.md](../../design/claude-control-olam-remote-sessions.md)
- Umbrella branch: `feat/cockpit-olam-remote-sessions-integration` (phase PRs target this; umbrella PR is the single review surface)

| Phase | Tracker | Goal | Milestone |
|---|---|---|---|
| A | [phase-a-tasks.md](./phase-a-tasks.md) | Org config + read-only fleet (SessionSource) | M1 — live on atlas, probe green 1 week |
| B | [phase-b-tasks.md](./phase-b-tasks.md) | Conversation streaming (TranscriptSource) | M2 — full-mode or explicitly-degraded per org |
| C | [phase-c-tasks.md](./phase-c-tasks.md) | Steering (Transport) | M3 — lifecycle E2E on one real Linear session |
| D | [phase-d-tasks.md](./phase-d-tasks.md) | Terminal + replay tab | M4 — + grain/pleri rollout (config-only) |

Dependency topology: A → (B ∥ C ∥ D). B/C/D have no edges between them.

## Out of scope

- Olam-side changes beyond the two named escape hatches (additive SELECT columns; ADR-063-pattern automation bearer) — deploy via `/pleri-deploy-orgs` if they fire.
- Container lifecycle actions from claude-control (teardown/exec); multi-operator attribution; mobile-specific UI; replay recording pipeline; full Linear-API delegation reconciliation.
