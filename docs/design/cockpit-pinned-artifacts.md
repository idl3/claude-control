# Design — cockpit-pinned-artifacts

> Scaffolded by /100x:commit-plan from the plan's Risk candidates. TODO: fill prose as phases land.

## Threat model

| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | An `<iframe>` reloads whenever moved/reparented in the DOM (tab switch, reducer reorder, list reflow) | Mount-ordered persistent container; CSS visibility only; regression test with stateful app across tab switches + 20-message churn | [known] |
| T2 | postMessage crash-beacon spoofing (opaque origin ⇒ `event.origin === 'null'`) | Validate `event.source === iframe.contentWindow` + strict shape; beacon only drives reload-offer UI | [known] |
| T3 | macOS fs.watch double/rename-only events on atomic writes | 300ms debounce + mtime/ETag compare before re-fetch; polling is the named fallback | [assumed] |
| T4 | Sandbox/scope widening temptation | `allow-scripts` only, media-root-only sources, versioned paths through mediaUrl.ts validation | [known] |

## Performance findings

| # | Concern | Target | Measured |
|---|---|---|---|
| P1 | N pinned live iframes on iPad | No visible jank with 4 pinned; mounted-app cap 6 with evict-to-placeholder | TBD Phase C |
| P2 | WS flood on rapid rebuild loops | Server 300ms debounce; client coalesces to latest mtime | TBD Phase D |

## Simplicity findings

| # | Temptation | What we do instead |
|---|---|---|
| S1 | Version manifest DB/DO | Directory naming convention `apps/<name>/<stamp>[-label].html` + `latest` pointer + one listing endpoint |
| S2 | Generic windowing/plugin system | One new artifact kind + fixed affordances (pin, reload, version picker) |

## Principles & Seams
Seam: pinned apps are ArtifactPanel tabs whose iframes live in a permanently-mounted, mount-ordered container with visibility toggling and LRU pin-exemption.
Seam: placeholders unmounted by the thread's render cap ("Load earlier") or evicted after hidden-ancestor grace DO cold-reload on return — the never-reload guarantee covers in-view churn, tab switches, and (Phase C) pin moves, not explicit view exits.

## Unwind cost
Dedicated PrototypePanel extraction (~4–6 files) if ArtifactPanel resists; embeds/transport/version layers carry over unchanged.
