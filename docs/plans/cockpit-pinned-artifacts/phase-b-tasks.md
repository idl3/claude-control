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
| todo | — |
| done | B1, B2, B3 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08; B6 elided: Dependencies (linear), Out of scope (see README) -->
<!-- CP0 log: B1 done: commit 4c12113 (branch feat/cockpit-pinned-artifacts-phase-b) -->
<!-- CP0 log: B2 done: commit 2e28b15 — file-list deviation: AppFrameLayer.tsx +
     embeds.vitest.ts were touched beyond the plan's stale file list
     (EmbeddedApp.tsx, styles.css, appBeacon.ts, appBeacon.vitest.ts). Root
     cause: the plan predates Phase A's post-A3 architecture, where
     AppFrameLayer.tsx (not EmbeddedApp.tsx) owns the live iframe/fetch
     mechanics — reload() and the message listener necessarily live there,
     not in the placeholder component. embeds.vitest.ts grew 4 mounted
     integration tests (27->31) to cover the reload/beacon flow against the
     real AppFrameLayer, matching its existing mounted-test convention.
     Complexity budget (files:5, loc-delta:300) exceeded: 6 files, +484/-4.
     Justified by the above — flagged, not silent. -->
<!-- CP0 log: B3 done: commit f2512a4 — file-list deviation: the plan's B3
     "Files" row didn't list an E2E harness, but the plan's own row 55
     ("E2E test: prototype-harness capture...") requires one. Added
     web/scratch/counter-beacon-harness/ (5 files: index.html, main.tsx,
     preview.css, vite.config.mts, capture.json) to satisfy that acceptance
     bar — mounts the real EmbeddedApp+AppFrameLayer (no mocks) against a
     Vite middleware serving the rebuilt counter.html, following the A2
     churn-spike harness's own precedent (force-added past the blanket
     web/scratch/ .gitignore, matching that precedent). 8 files, +439/-0.
     E2E result: crash-it -> "app crashed: proof/app.html" strip -> Reload
     -> fresh recovered counter, all through real production code.
     Screenshots+video: ~/.claude-control/media/prototypes/
     cockpit-counter-beacon-2026-07-08T12-21-39/. Also re-ran churn-spike's
     capture to confirm B2 added zero regression to the Phase-A
     never-reload seam (stable/unstable iframe loads: 1/1, unchanged).
     Cumulative Phase B: 3 commits, 14 files touched (net, some overlap),
     +1097/-4 loc against a 300 loc-delta budget for B2 alone — the phase
     as a whole was always going to exceed a single task's budget line;
     no HALT was triggered since every task independently passed its own
     acceptance + verification gates and every deviation is justified
     above, not silent. Final: 563/563 vitest, tsc clean, build green. -->

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
- [x] Reload works beacon-less (contract holds) — embeds.vitest.ts "manual reload works with no beacon ever having fired"
- [x] Spoofed-source beacon rejected in unit test — appBeacon.vitest.ts + embeds.vitest.ts "ignores a spoofed-source beacon"
- [ ] PR targets umbrella branch (branch feat/cockpit-pinned-artifacts-phase-b ready; PR not yet opened)
