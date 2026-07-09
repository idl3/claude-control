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
Seam (CP3-C): pinned panel apps survive mobile back-nav (hide-not-evict, cap-bounded); transcript embeds keep the documented evict-on-view-exit exception.

## Unwind cost
Dedicated PrototypePanel extraction (~4–6 files) if ArtifactPanel resists; embeds/transport/version layers carry over unchanged.

## Artifact contract (Phase B, B3)

Any HTML shipped under `~/.claude-control/media/apps/` for an
`<embedded-app url="…" height="…" />` embed must satisfy:

- **Single-file HTML.** No external `<script src>`/`<link rel=stylesheet>` —
  the artifact loads via `srcDoc` on the host iframe, which has no base URL,
  so any relative or absolute external reference silently fails to load. CSS
  and JS must be inlined (see `web/scratch/counter-app/build.mjs` for the
  esbuild-IIFE + inline-`<style>` reference build).
- **Sandbox `allow-scripts` only.** The host always sets
  `sandbox="allow-scripts"` with no `allow-same-origin`, giving the frame an
  opaque (`null`) origin: it can run its own JS but cannot reach the parent
  DOM, `localStorage`, or cookies. Artifacts must not assume same-origin
  access to anything outside the frame.
- **OPTIONAL `cc-app-error` crash beacon.** An artifact MAY report an
  in-frame crash it has already contained (e.g. inside its own error
  boundary) by calling
  `window.parent.postMessage({ type: 'cc-app-error', message: String(error) }, '*')`.
  The host (`AppFrameLayer.tsx`) validates this against the exact shape
  `{ type: 'cc-app-error', message?: string }` and the beacon's `event.source`
  against the specific iframe's own `contentWindow` (see T2 above —
  `event.origin` is always the literal string `'null'` for this sandbox
  configuration and is never consulted). A validated beacon marks the slot
  crashed and shows a reload affordance; an unvalidated or absent beacon
  changes nothing — a user-triggered reload (`cockpit:app-reload`) works
  identically whether or not an artifact ever posts one. This is a one-way,
  best-effort signal, not a required part of the contract: an artifact with
  no error boundary and no beacon simply shows as a blank/broken frame with
  no automatic crashed-strip, same as before Phase B.
- **Reference implementation:** `web/scratch/counter-app/counter.tsx` +
  `build.mjs` — a React app with its own root, own error boundary, and a
  `componentDidCatch` that posts the beacon above.
