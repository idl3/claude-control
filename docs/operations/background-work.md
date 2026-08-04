# Background work and cleanup

This file lists long-running work owned by `claude-control` itself, plus external sweeps operators should know about.

## Native Cockpit work

- Session registry refresh: every 4s. Lists tmux panes, reconciles transcript bindings, and emits session changes.
- Context/model poll: every 12s. Captures lightweight TUI status for visible agent panes.
- Thinking/prompt poll: every 2s for active/scrape-worthy panes only.
- Resource monitor: every 5s. Samples process RSS/heap/CPU and system memory; emits over-limit trim events at most once per 60s while pressure continues.
- WebSocket heartbeat: every 30s. Pings clients and terminates dead sockets.
- Transcript tailers: per subscribed session. Each uses `fs.watch` plus a 1s poll fallback, bounded by `CLAUDE_CONTROL_MAX_BUFFER` and `CLAUDE_CONTROL_TAIL_BYTES`.
- Sub-agent followers: per subscribed parent session. Follows up to 32 live sub-agent transcripts, polls each followed file every 5s, and sweeps status every 30s.
- Remote Olam session list: every 10s when `olam.json` is configured.
- Remote Olam transcript stream: one Electric long-poll per selected remote session; degraded mode polls runner feed every 3s.
- Media app watcher: watches `~/.claude-control/media/apps` and also polls every 2s for atomic rebuilds.
- Upload/capture retention: startup sweep, then every 24h, unless `CLAUDE_CONTROL_NO_REAP=1`.
- Duplicate server reap: startup only; kills only same `server.js` instances scoped to this port.
- MLX optimizer: lazy by default; prewarm only when `CLAUDE_CONTROL_MLX_PREWARM=1`.

## External sweep

- `npm run cleanup:stale-dev`: dry-run stale Cockpit Vite/esbuild process groups.
- `npm run cleanup:stale-dev:apply`: sends `SIGTERM` only to stale scoped Vite/esbuild groups, after revalidating lineage and excluding Claude/Codex ancestry.

The cleanup script is not a daemon. It should be run manually or by an operator-owned scheduler if stale dev servers recur.
