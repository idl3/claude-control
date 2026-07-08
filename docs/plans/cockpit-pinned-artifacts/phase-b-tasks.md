---
feature: cockpit-pinned-artifacts
phase: b
tier: feature
autonomous: true
complexity-budget: { files: 5, loc-delta: 300 }
adopted-patterns: [authFetch srcdoc delivery, failure-chip discipline, vitest convention]
umbrella-branch: feat/cockpit-pinned-artifacts-integration
---

# Phase B — Reload affordance + crash beacon

> **Scope**: crashed or stale apps recover in place; optional beacon surfaces crashes; EmbeddedApp extracted.
> **Design**: docs/design/cockpit-pinned-artifacts.md
> **Branch**: feat/cockpit-pinned-artifacts-phase-b

## Status
| state | tasks |
|---|---|
| todo | B1, B2, B3 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08; B6 elided: Dependencies (linear), Out of scope (see README) -->

## Audit item coverage
| Task | Rubric |
|---|---|
| B2 | T2 |

## Task list

### B1 — Extract EmbeddedApp to its own module
> **Goal**: EmbeddedApp + useAppHtml live in web/src/components/EmbeddedApp.tsx (EmbeddedMedia.tsx nears the 800-line cap).
> **Files**: web/src/components/EmbeddedApp.tsx (new), web/src/components/EmbeddedMedia.tsx, web/src/lib/embeds.vitest.ts
> **Acceptance**: pure move (no behavior change); all imports updated; vitest green.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: clean-revert

### B2 — Reload affordance + optional crash beacon
> **Goal**: a Reload control re-fetches srcdoc + bumps iframe key in both views; `{type:'cc-app-error'}` postMessage from an app surfaces a "crashed — reload?" strip.
> **Files**: web/src/components/EmbeddedApp.tsx, web/src/styles.css, web/src/lib/appBeacon.ts (new), web/src/lib/appBeacon.vitest.ts (new)
> **Acceptance**: reload restores a crashed counter without page refresh; beacon listener accepts only `event.source === iframe.contentWindow` + exact shape (unit-tested with spoofed source/shape rejected); manual reload works with NO beacon present.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: B1
> **Reversibility**: clean-revert

### B3 — Counter artifact adopts the beacon (demo + contract doc)
> **Goal**: apps/counter.html rebuilt with beacon emit in its error boundary; artifact contract documented.
> **Files**: web/scratch/counter-app/counter.tsx, web/scratch/counter-app/build.mjs, docs/design/cockpit-pinned-artifacts.md (contract section), ~/.claude-control/media/apps/ artifact
> **Acceptance**: crash-it button → host strip appears → reload recovers; contract section documents beacon as OPTIONAL.
> **Verification**: cd web && npx vitest run; capture via prototype harness
> **Depends on**: B2
> **Reversibility**: clean-revert
> **E2E test**: prototype-harness capture showing crash → strip → reload → recovered

## Review sign-off checklist
- [ ] Reload works beacon-less (contract holds)
- [ ] Spoofed-source beacon rejected in unit test
- [ ] PR targets umbrella branch
