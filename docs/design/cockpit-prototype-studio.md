# Design — cockpit-prototype-studio

> Scaffolded by /100x:commit-plan from the plan's Risk candidates. TODO: prose as phases land.

## Threat model
| # | Threat | Mitigation | Status |
|---|---|---|---|
| T1 | Grown postMessage surface (props-set/capture/outline) | source-identity + strict shape per message family (appBeacon pattern); size caps; no eval; bridge never touches parent DOM | [known] |
| T2 | Captures endpoint = new authed write path | NAME_RE, size cap (8MB), atomic temp+rename, media-root-only, constant-time bearer | [known] |
| T3 | docgen on complex TS types (unions/generics/ReactNode) | un-inferable props degrade to rawType + JSON input; manifest optional; build never blocks on docgen failure | [assumed] |
| T4 | Hotkey suppression fail-safe | capture-phase interceptor; scoped to studio-open; suppression released EAGERLY at close-request (not animation-gated — CP3-A HIGH) with unmount cleanup as backstop; Escape carve-out; Cmd+C/V/X pass (Cmd+A currently suppressed — revisit if studio content needs select-all) | [known] |

## Performance findings
| # | Concern | Target | Measured |
|---|---|---|---|
| P1 | Oversized device preset on small screens | dynamic gating (mode hidden when screen < preset) | by construction |
| P2 | In-sandbox capture on large components | async + progress + 10s timeout → error chip | Phase D: implemented as designed; +13.5KB raw / +5.0KB gzip bundle growth (well under the 80KB budget); live-probe round-trip (capture → annotate → save → fetch) confirmed in a real browser |

## Simplicity findings
| # | Temptation | What we do instead |
|---|---|---|
| S1 | Generic devtools/remote-inspector protocol | read-only DOM outline + reserved console slot |
| S2 | Manifest DSL with control/layout config | types in → typed inputs out; raw JSON escape hatch |

## Principles & Seams
Seam: programmable artifacts — producer-baked bridge (manifest + validated postMessage) is the single contract between cockpit tooling and sandboxed component code. Studio hosting = third arbitration tier (studio > panel > transcript); enter/exit is a placeholder move (never-reload).

## Unwind cost
Bridge contract wrong → freeze protocol v1-deprecated; studio A/B chrome survives; C/D/E degrade to "no manifest" paths (~6-8 files).
