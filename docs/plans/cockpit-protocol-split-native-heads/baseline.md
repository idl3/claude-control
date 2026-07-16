# Phase A — ttyd keystroke-echo latency baseline (task A2)

**Purpose:** calibrate the CURRENT ttyd path's keystroke-echo round-trip latency
BEFORE any PTY-bridge code (A4) lands, so Phase A's "AC1 latency budget met
(direct path, vs baseline)" review-gate has a real number to compare against
instead of a vibe. This doc is the results sheet; the harness that produces
these numbers lives in `scripts/latency-harness/`.

**Status: no live run has happened yet.** Every numeric cell below is a
placeholder. This harness was built and unit-tested (synthetic math only) as
task A2; running it against a live ttyd is a follow-up action, not something
that can be faked from a headless dev shell. Do not fill in any cell with an
invented number — replace `⏳ AWAITING LIVE RUN` only with a real measured
value from an actual `run.mjs` invocation, and paste the raw run output (or a
link to it) alongside the table when that happens.

## Results — summary

| Target | p50 (ms) | p95 (ms) | p99 (ms) | Path type | Variance OK (±10%) |
|---|---|---|---|---|---|
| ttyd — loopback (127.0.0.1) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| ttyd — direct tailnet | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |

`Path type` must read `loopback`, `direct` (tailnet peer-to-peer, confirmed via
`tailscale status`), or `derp` (relayed — see the DERP tripwire note below).
**A `direct-tailnet` row filled in while the actual path type was `derp` is not
a valid baseline** — re-run once `tailscale status`/`tailscale ping <peer>`
confirms a direct path, or record the DERP-relayed number separately and
labeled as such.

## Per-run raw data (3 runs each, 500 keys/run, ±10% cross-run variance rule)

### ttyd — loopback (127.0.0.1)

| Run | p50 (ms) | p95 (ms) | p99 (ms) | Path type |
|---|---|---|---|---|
| 1 | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| 2 | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| 3 | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| **Cross-run variance verdict** | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | — |

### ttyd — direct tailnet

| Run | p50 (ms) | p95 (ms) | p99 (ms) | Path type |
|---|---|---|---|---|
| 1 | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| 2 | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| 3 | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) |
| **Cross-run variance verdict** | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | ⏳ AWAITING LIVE RUN on host + direct tailnet peer (verify not DERP via tailscale status) | — |

## DERP tripwire

The harness logs the tailnet path type (`loopback` / `direct` / `derp` /
`unknown`) on **every** run by shelling out to `tailscale status --json` and
inspecting the peer matching `--host`. A `derp` (relayed) reading on what was
meant to be a "direct tailnet" run invalidates that run for baseline purposes
— DERP relay adds variable, often much higher, latency than a direct
WireGuard path, and mixing the two silently would make the "AC1 latency
budget met (direct path, vs baseline)" review gate meaningless. Phase A's
review sign-off checklist should treat a `derp` reading on a nominally-direct
run as a hard blocker on trusting that row, not just a footnote.

## How to run

From the repo root, with the live cockpit server up (`node server.js`,
default `:4317`) and a real tmux-backed session/window you're willing to
dedicate to calibration (pick an idle plain shell prompt — the harness types
literal keystrokes into it and immediately erases them, but that's a
best-effort courtesy for shell readlines, not a guarantee for TUIs/pagers/
pickers): first run `node scripts/latency-harness/run.mjs --list-sessions` to
see live session ids, then run
`node scripts/latency-harness/run.mjs --target ttyd --id "<tmux-target>" --runs 3 --keys 500`
for the loopback row (default `--host 127.0.0.1`), and the same command with
`--host <tailnet-magicdns-name-or-ip>` pointed at a real tailnet peer for the
direct-tailnet row — first confirm the path is actually direct (not DERP)
with `tailscale status` (or `tailscale ping <peer>`), since the harness's own
per-run path-type log is a courtesy cross-check, not a substitute for
checking the tailnet state before you start. The harness deliberately
requires an explicit `--id` and never auto-attaches to "whatever session it
finds" — a probe keystroke landing in the wrong session (e.g. toggling an
open AskUserQuestion picker, which also binds Space) would corrupt real
state, not just measure latency. Paste each run's stdout (which includes
p50/p95/p99, path type, and the ±10% cross-run variance verdict) into the
tables above, replacing the matching `⏳ AWAITING LIVE RUN` cells — never
hand-type a number that didn't come out of the harness.
