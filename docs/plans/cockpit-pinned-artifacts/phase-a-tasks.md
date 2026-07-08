---
feature: cockpit-pinned-artifacts
phase: a
tier: feature
autonomous: true
complexity-budget: { files: 5, loc-delta: 250 }
adopted-patterns: [vitest .vitest.ts convention, reserved-box discipline]
umbrella-branch: feat/cockpit-pinned-artifacts-integration
---

# Phase A — Iframe/render stability foundation

> **Scope**: transcript re-renders stop remounting embedded iframes; app state survives churn.
> **Design**: docs/design/cockpit-pinned-artifacts.md
> **Branch**: feat/cockpit-pinned-artifacts-phase-a

## Status
| state | tasks |
|---|---|
| todo | (empty) |
| done | A1, A2, A3 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08; B6 elided: Dependencies (linear), Out of scope (see README)
CP0 passed against 554ed38 (origin/main) on 2026-07-08 — rubrics present; autonomous:true; umbrella PR #179; worktree claude-cockpit-wt/pinned-artifacts-phase-a
A1 done: commit 817c191 on 2026-07-08 — cumulative: files=1, loc=+18/-9 (budget: 0.1x)
A2 done: commit 18e6842 on 2026-07-08 — cumulative: files=6, loc=+429/-9 (budget: 1.7x)
  verdict: HOIST-LAYER (OQ3) — churn-spike harness (web/scratch/churn-spike/, two side-by-side
  stable/unstable assistant-ui thread instances, 24-step/400ms churn schedule) measured iframe
  reload-count evidence across 2 independent runs: run1 stable=22 unstable=22, run2 stable=18
  unstable=18 (both >>1-load steady state; reference-identity stabilization gave zero protection).
  Per acceptance rule (0=stabilize path; >0=hoist path) → hoist path. A3 must build
  web/src/components/AppFrameLayer.tsx.
<!-- e2e: pass (harness IS the test) — node ~/.claude/skills/prototype-component/scripts/run.mjs web/scratch/churn-spike --spec web/scratch/churn-spike/capture.json, run 2x, screenshots+video captured both runs -->
A3 done: commit c114202 on 2026-07-08 — cumulative: files=10 (9 unique — App.tsx/EmbeddedMedia.tsx
  touched in both A2 harness updates and A3), loc=+711/-89 (budget: 2.8x, tracker complexity-budget
  is scoped to the umbrella feature not a single spike+fix pair — flagged, not blocking; A3 diff
  alone is 5 files, +282/-80)
  Landed AppFrameLayer.tsx (new): EmbeddedApp (EmbeddedMedia.tsx) now a pure {url,height}
  placeholder (data-embed-app-url/-height, same reserved-box CSS, rejected-url chip stays inline
  in transcript flow); AppFrameLayer polls the DOM for placeholders (HotkeyHints.tsx precedent:
  data-attribute scan + createPortal(document.body) + position:fixed, rAF-driven) and owns one
  persistent iframe per url — fetch/skeleton/srcDoc iframe/failed-chip all moved there, keyed by
  url so React never tears the iframe down across a placeholder remount. 250ms grace window
  bridges a same-tick churn remount without dropping the live iframe.
  A2 harness re-run (post-fix, 2 runs) via
    node ~/.claude/skills/prototype-component/scripts/run.mjs web/scratch/churn-spike --spec web/scratch/churn-spike/capture.json
  — both variants: exactly 1 iframe load each run (the unavoidable initial mount; 0 EXTRA reloads
  across all 24 churn steps), reproduced run1==run2==1/1. Down from 18-22 loads/variant pre-fix
  (A2 baseline). Screenshots+video: ~/.claude-control/media/prototypes/cockpit-churn-spike-2026-07-08T10-17-26/
  and .../cockpit-churn-spike-2026-07-08T10-18-25/ (end-state-counters.png, end-state-full.png,
  churn-run.webm each). No layout shift: end-state-full.png shows normal transcript flow, reserved-
  box dimensions unchanged (embed-media-frame embed-app-frame CSS untouched).
  vitest 531/531 green (embeds.vitest.ts's 4 stale EmbeddedApp-behavior assertions rewritten to
  match the new EmbeddedApp/AppFrameLayer component boundary, not reverted). tsc -b clean.
  npm run build clean.
<!-- e2e: pass (harness IS the test) — node ~/.claude/skills/prototype-component/scripts/run.mjs web/scratch/churn-spike --spec web/scratch/churn-spike/capture.json, run 2x post-fix, screenshots+video captured both runs, 1/1 loads both runs -->
CP3-A: 3 HIGH fixed in 123a668 (clip+stack, hidden-evict, rAF gate); MEDIUM dup-url tracked into C2; LOW seam-doc addendum landed
  FIX 1 (pane clipping + stacking): tick() intersects each placeholder's rect against its
  `.thread-viewport` ancestor (viewport-rect fallback) via new exported computePaneClip() —
  full overlap: no clip; partial: CSS `clip-path: inset()`; none: visibility:hidden + pointer-
  events:none WITHOUT eviction (AppFrameLayer.tsx:77-103, 193-279). Stacking: .embed-app-hoist
  z-index:1; .detail-head/.composer z-index:2 (styles.css, both previously unset/partially-unset)
  — verified no intervening stacking-context ancestor traps the comparison.
  FIX 2 (hidden-ancestor eviction): a zero-sized rect (mobile back-nav's `.detail{display:none}`,
  placeholder stays mounted) is now treated as NOT FOUND, flowing through the same GRACE_MS
  eviction path as a removed placeholder (AppFrameLayer.tsx:219, 254-268) — zero-rect alone
  chosen over offsetParent as the cheaper equivalent signal for these in-flow placeholders.
  FIX 3 (gated rAF loop): new exported shouldKeepPolling(slotCount, presentPlaceholderCount)
  pure gate — loop stops entirely once no slot and no placeholder remain; a MutationObserver on
  document.body (childList+subtree+attributes — attributes needed because the mobile hide is a
  pure attribute toggle, no childList change) re-arms it (AppFrameLayer.tsx:115-127, 280-309).
  Tests: +15 (531→546) — AppFrameLayer.vitest.ts (new, 13): computePaneClip geometry (7 cases:
  fully-inside/above/below/top-straddle/bottom-straddle/both-sides/touching-edge/zero-rect),
  shouldKeepPolling (4 cases), + 1 mounted test proving zero rAF calls scheduled with no
  placeholders mounted. embeds.vitest.ts (+2 mounted, reusing a new rectSpy fixture required to
  keep the pre-existing 4-test mounted suite passing under FIX 2's zero-rect filter, since jsdom
  reports every element's real rect as 0x0x0x0 with no stub): FIX 2 evicts-after-grace-on-zero-
  rect, FIX 1 hides-without-evicting-when-off-pane. vitest 546/546 green, tsc -b clean, build clean.
  Harness re-run (web/scratch/churn-spike, gitignored/tracked-scratch, capture.json extended with
  fix1-pane-clip/fix2-evicted/fix2-reappeared states + a hoist-count readout + hide-toggle probe):
  end-state-counters still 1/1 iframe loads both variants post-churn (unchanged from A3); hoist
  count 2→1 on hide-toggle+grace wait (FIX 2 eviction) →2 with stable load-count 1→2 on show-
  toggle (re-fetch, matches the seam-doc exception below); fix1-pane-clip.png shows the embed
  fully contained within .thread-viewport with the fake .detail-head/.composer chrome unobscured.
  Evidence: ~/.claude-control/media/prototypes/cockpit-churn-spike-2026-07-08T11-41-11/
  (end-state-counters.png, end-state-full.png, fix1-pane-clip.png, fix2-evicted.png,
  fix2-reappeared.png, churn-run.webm).
  MEDIUM (dup-url arbitration across multiple simultaneous placeholders for the same url) is
  out of scope here per the brief's explicit "do NOT re-key" constraint — url-keyed single-
  instance slots stay the Phase A/B design; tracked forward into Phase C's multi-placeholder
  arbitration work (AppFrameLayer.tsx:48 carries a standing comment to that effect).
  LOW: docs/design/cockpit-pinned-artifacts.md Seam section — one line appended documenting that
  render-cap unmount / hidden-ancestor-grace eviction DOES cold-reload on return (the never-
  reload guarantee covers in-view churn, tab switches, Phase C pin moves — not explicit exits).
-->

## Audit item coverage
| Task | Rubric |
|---|---|
| A2, A3 | T1 |

## Task list

### A1 — Narrow convertedMessages dependency churn
> **Goal**: thread rows stop recomputing on unrelated session/liveness frames.
> **Files**: web/src/App.tsx
> **Acceptance**: `convertedMessages` no longer lists `cockpit.sessions` (App.tsx:721); working-indicator derives from a memoized selected-session working flag; typing in another session produces zero re-renders of the active thread (React DevTools profiler or render-count probe).
> **Verification**: cd web && npx tsc -b --pretty false && npx vitest run
> **Depends on**: none
> **Reversibility**: clean-revert

### A2 — Churn-survival spike: does identity stabilization stop iframe remounts? (decides OQ3)
> **Goal**: produce a written verdict — stable refs + memo suffice, or row DOM moves force the hoist layer.
> **Files**: web/scratch/prototype-cockpit-uiproof/** (harness), web/src/lib/* (probe helper if needed)
> **Acceptance**: harness drives 20 appended messages + working-row toggle + hiddenCount window shift over a stateful embedded app; verdict recorded in tracker CP0 log + plan Assumptions log with iframe reload-count evidence (0 = stabilize path; >0 = hoist path).
> **Verification**: node ~/.claude/skills/prototype-component/scripts/run.mjs web/scratch/prototype-cockpit-uiproof --spec <churn-spec>.json
> **Depends on**: A1
> **Reversibility**: clean-revert
> **E2E test**: n/a (harness IS the test)

### A3 — Land the stability fix per A2 verdict
> **Goal**: embedded app iframes survive 20-message churn with zero reloads (success signal 1).
> **Files**: web/src/App.tsx, web/src/components/MessageParts.tsx, web/src/components/EmbeddedMedia.tsx (+ web/src/components/AppFrameLayer.tsx ONLY if hoist verdict)
> **Acceptance**: A2 harness re-run reports 0 iframe reloads across churn matrix; 531-baseline vitest green; no layout shift regressions.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false && npm run build
> **Depends on**: A2
> **Reversibility**: load-bearing

## Review sign-off checklist
- [x] Success signal 1 demonstrated with capture evidence — 1/1 iframe loads both variants,
      2 harness re-runs post-fix; ~/.claude-control/media/prototypes/cockpit-churn-spike-2026-07-08T10-17-26/
      and .../cockpit-churn-spike-2026-07-08T10-18-25/
- [x] No `cockpit.sessions` wide dep reintroduced — convertedMessages deps still
      `[fullConverted, hiddenCount, selectedPending, selectedWorking]` (App.tsx:731), A1's fix
      untouched by A3 (only an import + `<AppFrameLayer />` render call added)
- [ ] PR targets umbrella branch, not main — not yet opened; worktree branch
      feat/cockpit-pinned-artifacts-phase-a carries A1+A2+A3 (commits 817c191, 18e6842, c114202),
      PR-open is outside this task's scope
