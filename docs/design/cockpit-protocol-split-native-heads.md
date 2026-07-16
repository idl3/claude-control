# Design — cockpit-protocol-split-native-heads

> Scaffolded by /100x:commit-plan from plan Risk candidates ([known]+[assumed] rows).
> TODO: fill prose. The /100x:design terminal-panel pass (task A1) lands its output HERE.

## Threat model
| # | Threat | Mitigation |
|---|---|---|
| T1 | Richer tailnet-exposed API widens attack surface | layered tailnet+bearer; zero new unauth surfaces; ttyd ?token= deletion is net reduction; scoped tokens deferred (Decision 14) |
| T2 | Control-mode desync (%output, %pause, version drift) | pre-B spike gate; compat layer; periodic full reconcile; TMUX_MODE=poll escape hatch |
| T3 | PTY bridge = keystroke injection into live panes | same flat bearer gate as replies; audit-log line per attach (Decision 15) |
| T4 | Tauri auto-update = code-execution trust boundary | signature verification; key in secret manager; TLS pinned origin; rotation runbook pre-D |
| T5 | Client caches hold transcripts unencrypted multi-device | FileVault as stated at-rest boundary; purge on revoke/logout; delete tombstones; bounds (Decision 12) |
| T6 | xterm.js renders raw PTY output (escape sequences) | pin patched version; OSC-52/clipboard disabled by default; CVE tracking |

## Performance findings
| # | Concern | Target | Measured by |
|---|---|---|---|
| P1 | Keystroke echo | p95 <40ms direct path; DERP tripwire (>20% relayed AND p95>80ms at B-close → predictive echo promoted) | latency harness, path-type logged per run |
| P2 | Transcript open / reconnect / zod parse | warm <300ms; reconnect <1s zero-refetch; zod <2ms p95 per batch on WKWebView-class | SPA perf marks; Playwright throttle E2E |
| P3 | Control-mode output flooding | no missed lifecycle events at ≥1MB/s pane output | pre-B spike flood test; per-pane throttle |

## Simplicity findings
| # | Temptation | What we do instead |
|---|---|---|
| S1 | Ceremony (service split / schema toolchain) | one Node process; zod ceiling until falsifier-1 fires |
| S2 | Cache-sync CRDT | append-only seq replay |
| S3 | Tauri plugin sprawl | hotkeys+notifications+auto-update only; rest adoption-gated |

## PM-lens rows
| # | Class | Row |
|---|---|---|
| B1 | business | invisible protocol work stalls momentum → Phase A visible win + A-spike front-loaded |
| C1 | customer | web parity regression → checklist gate per phase |
| C2 | customer | native onboarding friction → operator-only first |
| F1 | feasibility | L overall; C largest; spike-gated control-mode; handshake for cutover |

## Principles & Seams
Seam: protocol SHAPE (mux'd WS + seq cursors + binary PTY framing + host-scoped IDs); schema language swappable (zod → protobuf on falsifier-1). Unwind: ~15 files in lib/protocol + adapters.
