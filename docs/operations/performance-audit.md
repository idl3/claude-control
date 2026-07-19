# Claude Control/Cockpit Performance Audit

Last updated: 2026-07-19

## Current Hot Paths

- Session discovery: `SessionRegistry` refreshes every 4 seconds. Each successful pass lists tmux panes, takes one `ps` snapshot, tail-reads bounded transcript candidates, and emits only when the serialized session list changes. A transient tmux failure preserves the previous state.
- Context polling: model/context capture runs every 12 seconds. It skips print-transport sessions.
- Thinking/picker polling: active panes are scraped every 2 seconds only while they are flagged active, pending, errored, missing a transcript, or recently changed. Idle transcript-backed panes are skipped.
- Transcript streaming: each subscribed local transcript uses a bounded initial tail, one `fs.watch`, and a 1 second fallback poll. The subscription is torn down when the last client leaves.
- WebSocket fan-out: broadcasts serialize each frame once. Slow clients are now terminated once their queued send buffer exceeds `CLAUDE_CONTROL_WS_BUFFER_LIMIT_MB` / `COCKPIT_WS_BUFFER_LIMIT_MB` (default 32 MB), so a stalled browser cannot retain unbounded server memory.
- Resource sampling: `ResourceMonitor` runs every 5 seconds. On macOS it samples reclaimable memory with `vm_stat` every tick and power status with `pmset` every fifth tick. Over-limit trims are rate-limited to once per 60 seconds.
- Sub-agent details: Claude sub-agent watchers are subscription-scoped, poll on parent append plus a 30 second sweep, follow at most 32 live agents, and retain detailed transcript content for at most 40 agents. Historical transcript loads are bounded and concurrency-limited to 4.
- Remote Olam sessions: if enabled, org session lists poll every 10 seconds. Liveness is on-demand only: session select and pre-send.
- Media app hot reload: watches `media/apps` with recursive `fs.watch` plus a 2 second poll fallback. This is native Cockpit background work.
- Upload/capture retention: sweeps at startup and every 24 hours unless `CLAUDE_CONTROL_NO_REAP=1`.
- Cleanup script: `npm run cleanup:stale-dev` is not a daemon. It is an operator-run dry run/apply tool for scoped stale Vite/esbuild groups under this checkout and its worktrees. It explicitly protects Claude/Codex ancestry.

## Runtime Sweep Notes

- No scoped stale Cockpit Vite/esbuild process groups were found by `scripts/cleanup-stale-dev.mjs`.
- The process snapshot showed Cockpit `server.js` resident at roughly 467 MB RSS during the audit. This is inside the 768 MB default RSS budget.
- The same snapshot showed the tmux server itself sampling around 20% CPU with frequent status-line helper shells from the user tmux configuration. That is not Cockpit native cleanup work and should be treated separately from Cockpit process hygiene. If it stays high, reduce tmux status-line shell frequency or `status-interval` in the tmux config rather than changing Cockpit.
- Chrome DevTools MCP was unavailable in this Codex session, so a live Core Web Vitals trace could not be captured. Static code/bundle audit still found a network win: content-hashed Vite assets are now cacheable as immutable while `index.html` remains no-store.

## Mobile / On-device Diagnostics

- Enable the browser-side diagnostics overlay from the command palette: **Show device performance diagnostics**. It can also be forced at load with `?perf=1`, `?diagnostics=1`, or `?cc_perf=1`.
- The overlay is opt-in. When disabled it does not run a RAF loop, timers, PerformanceObservers, or websocket/render counters.
- Metrics sampled on the phone: FPS, worst frame gap, estimated dropped/janky frames, event-loop lag, Long Task API totals, Long Animation Frame API totals where available, JS heap where exposed, websocket message/KB rate, app-render rate, DPR/viewport, reduced-motion state, and WebGL renderer metadata where available.
- Browsers do not expose device temperature, so use these samples for correlation: heat + long tasks/render bursts points at JS/React work; heat + clean main-thread metrics but WebGL/iframe/compositor stress points at GPU/layer pressure.
- Use the overlay's **Copy** action after reproducing the heat. It copies a compact JSON report with the latest sample and the last ~120 seconds of history.
- While the overlay is open, the phone also POSTs a small sample batch every ~10 seconds to the same Cockpit server. Samples stay local in `~/.claude-control/logs/client-perf.jsonl` (or `$CLAUDE_CONTROL_DIR/logs/client-perf.jsonl`) and rotate at 10 MB with one `.1` backup.
- Local summary: `GET /api/client-perf?limit=500` returns recent-tail aggregates for avg/min FPS, worst frame, max loop lag, long-task totals, websocket rate, render rate, and stressed/hot sample counts.

## Remaining Optimization Backlog

- Split rarely opened panels such as Studio, config, process monitor, raw events, and artifact gallery with `React.lazy` once a browser trace confirms the main bundle is load-bound.
- Consider serving precompressed static assets (`.br`/`.gz`) if tailnet or mobile cold-load latency becomes visible after immutable caching.
- Move session/pane lookup to the proposed SQLite manifest once the shadow-write phase proves reconciliation quality.
- Add an authenticated `/api/debug/runtime` snapshot that reports subscription counts, tailer counts, watcher counts, websocket buffered bytes, and cache sizes without requiring `ps`.
