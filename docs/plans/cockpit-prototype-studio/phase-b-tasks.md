---
feature: cockpit-prototype-studio
phase: b
tier: feature
autonomous: true
complexity-budget: { files: 6, loc-delta: 500 }
adopted-patterns: [AppFrameLayer placeholder-hosting seam]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase B — Studio hosting + device modes

> **Scope**: 'studio' arbitration tier + device-mode placeholder resizing. ⚠️ HARD PREREQUISITE: the in-flight scroll-sync PR (feat/app-hoist-scroll-sync — sync repositioning, fade-during-scroll, elevate attr) MUST be merged first; branch this phase off the umbrella AFTER rebasing the umbrella on the main that contains it (or merge main→umbrella).
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-b

## Status
| state | tasks |
|---|---|
| todo | — |
| done | B1, B2, B3, CP3-B |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

<!-- CP0 log: /100x:execute 2026-07-10, worktree claude-cockpit-wt/studio-phase-b, branch feat/cockpit-prototype-studio-phase-b -->

### B1 — done — sha `2ba82de`
'studio' context tier: pickHost prefers studio > panel > transcript while open; STUDIO_HOIST_Z_INDEX=310 unconditional elevation, clearing `.studio-overlay`'s z-index 300. Verified via real-Chromium `elementFromPoint` hit-test (jsdom can't prove this) at `.studio-frame` center — resolves to the live IFRAME, not the backdrop. `npx vitest run` + `npx tsc -b --pretty false` green at commit time.

### B2 — done — sha `d4d6e93`
Device-mode placeholder resizing: StudioModal body hosts the placeholder at 390×844 / 768×1024 / 1280×800, letterboxed/centered; mode switches resize the placeholder only, zero iframe reloads (load-count assertions). `npx vitest run` + `npm run build` green at commit time.

### B3 — done — sha `9b55cc5`
Harness evidence (`web/scratch/studio-phase-b-harness/`, gitignored): stateful counter embedded in transcript → open studio (count intact) → mobile 390 / iPad 768 / desktop 1280 switches (count intact each) → increment in studio → close (count intact, hosting resumes in transcript). Zero iframe reloads across the full journey — constant `HOTRELOAD1783531324` id string in every captured frame/still. 8 PNGs read and confirmed; video `studio-phase-b-flow.webm` captured. `hit-test.mjs` re-run post-fix: elevation still PASSes.

**Deviation (loud, in-scope but beyond the literal "capture evidence" brief):** frame-by-frame video inspection (ffmpeg `fps=15` extraction, not visible in the discrete PNG stills alone) surfaced a real visual defect — `.embed-app-hoist` is portaled to `document.body`, a separate DOM subtree from `.studio-panel`, so `StudioModal`'s GSAP enter/exit tween (~280ms opacity/scale, `useModalTransition`) never reached the hoisted iframe. The iframe's rect is driven declaratively by JSX (`transform`/`width`/`height`, no `opacity` in that style object), so it snapped to its new bounds fully opaque while the surrounding backdrop/toolbar were still mid-fade — confirmed via real pre-fix video frames at both the open (~t=1.6s) and close (~t=4.4s) transitions. This directly regresses the B3 acceptance bar ("polished open/close ... correct clip/z at every step"), so it was fixed in-phase rather than filed for later: `shouldCrossFadeHoist(prevContext, nextContext)` (pure edge-detector, fires only on a studio enter/exit) imperatively zeroes the hoist span's opacity for one frame then releases it next rAF, letting the pre-existing unconditional `.embed-app-hoist { transition: opacity 100ms }` CSS rule (already shared with the scroll-fade mechanism) cross-fade it back in. No new CSS, no new deps — reuses existing infrastructure entirely. Re-captured evidence after the fix confirms the pop is gone at both transitions (fresh fps=15 frames f-023→f-026 open, f-064→f-067 close). 6 new regression tests added for `shouldCrossFadeHoist`.

**Other deviations flagged:**
- The coordinator's original re-brief referenced a `prototype-cockpit-uiproof` skill path that does not exist in this environment; the harness was built directly against the `prototype-component` skill's `run.mjs` pattern instead (same output contract: `~/.claude-control/media/prototypes/<slug>-<ISO>/`), with a standalone `hit-test.mjs` for the `elementFromPoint` proof since `run.mjs`'s step vocabulary has no generic "evaluate JS" action.
- Hit a stray orphaned `node` process squatting on port 5199 (the `churn-spike` harness's dev-server port) during final re-verification, likely a leftover from an earlier session's harness run that never exited. Diagnosed via `lsof -i :5199`, killed (`kill -9`), re-ran clean.
- **Budget**: complexity-budget was `{ files: 6, loc-delta: 500 }`. Actual cumulative phase diff (`202367a..HEAD`, i.e. all of B1+B2+B3 against the umbrella base): **6 files** (on budget), **563 insertions / 55 deletions** — net +508, ~8 lines over the 500 loc-delta budget. Minor, mechanical overage (test-file growth: `AppFrameLayer.vitest.ts` alone carries 246 of the 563 insertions across all three tasks) — flagged per policy, not gating.

**Verification (final, full phase)**: `cd web && npx vitest run` → 725 passed (46 files), up from a 707 baseline (+18 net: 6 new B3 tests plus prior B1/B2 additions). `npx tsc -b --pretty false` → clean. `npm run build` → green (one pre-existing, unrelated chunk-size warning on `dist/assets/index-*.js`). `churn-spike` harness re-run → "stable iframe loads: 1, unstable iframe loads: 1" (Phase A never-reload seam intact, unaffected by Phase B).

**Evidence paths**: `~/.claude-control/media/prototypes/studio-phase-b/` (stable-named copy, 8 PNGs + video + `frames-scan2/`) and `~/.claude-control/media/prototypes/cockpit-studio-phase-b-2026-07-10T05-15-35/` (fresh post-fix timestamped run, identical contents).

### CP3-B — done — sha `b907fc1`
Four CP3 audit follow-ups on top of B1–B3, none touching Finding 5 (cross-fade/scroll-fade opacity — ruled self-healing, out of scope, untouched):
- **FIX 1 [HIGH, BLOCKING]** — studio pane-clip blindness: `computePaneClip`'s ancestor lookup (`AppFrameLayer.tsx:1023` in `tick()`, `:1194` in `syncPositions()`) hardcoded `.closest('.thread-viewport')`, which never matches inside a studio panel — a device preset taller than `.studio-body` (iPad 1024 / Desktop 800, the common case on a laptop screen) scrolls the pane, and the hoisted iframe fell through to `viewportRect()` fully unclipped over the studio's own head/toolbar (close button + device bar). Both call sites widened to `.closest('.thread-viewport, .studio-body')`. New mounted regression test (`AppFrameLayer.vitest.ts`, "Studio Phase B CP3 audit, FIX 1") builds a real `.studio-body` ancestor + a scrolled studio placeholder and asserts a non-trivial `inset(60px 0px 440px 0px)` clip, not the pre-fix unclipped case. `elementFromPoint` hit-test evidence was attempted but jsdom implements no such API at all (not even a stub) — recorded as its own test asserting the API's absence, consistent with B1's own note that this class of proof needs a real-Chromium harness; the clip-math test is FIX 1's real, DOM-observable proof here.
- **FIX 2 [HIGH]** — chrome renders over the device preview: the reload/pin/fullscreen corner trio (`AppFrameLayer.tsx`, render function, all three slot-state branches) rendered unconditionally for every context, including studio — floating over the previewed app inside the device box, and making fullscreen a self-referential no-op. Gated all three behind `const isStudioHost = slot.context === 'studio'; {!isStudioHost && (...)}` (`AppFrameLayer.tsx:1449`). New mounted test asserts a studio host renders none of the three (`[aria-label="Reload app"/"Open in panel"/"Open in studio"]` all null) while a transcript host for a different url still renders all three.
- **FIX 3 [MEDIUM]** — device-width gating ignored `.studio-body` chrome width: `useMinWidth(DEVICE_MODES[i].width)` enabled a mode the instant the window matched the RAW device width, but `.studio-body`'s 24px padding (both sides) + `.studio-frame`'s 1px border (both sides) — 50px total — meant a window exactly at a preset's width couldn't actually fit the device box without a boundary-band horizontal scrollbar. Added `STUDIO_BODY_CHROME_WIDTH = 50` (`StudioModal.tsx:28`) and gated all three `useMinWidth` calls on `DEVICE_MODES[i].width + STUDIO_BODY_CHROME_WIDTH`. Updated the two Phase A gating tests that hardcoded the old 390px boundary (now Mobile's real threshold is 440px) and added two new regression tests proving the boundary-band bug is closed: Mobile disabled at the raw 390px width, enabled at the chrome-aware 440px threshold.
- **FIX 4 [LOW]** — rapid app swap skipped the exit animation: `StudioModal`'s `onOpen` called `setOpenUrl(url)` unconditionally, so opening app B while app A's studio was still open force-unmounted A via `<StudioPanel key={openUrl}>`'s key change, bypassing `useModalTransition`'s exit tween (a jump-cut). Fixed with an ignore-until-closed guard: `setOpenUrl((prev) => (prev && prev !== url ? prev : url))` (`StudioModal.tsx:236`) — the functional-update form is required (not incidental), since the listener's effect has a `[]` deps array and a plain `openUrl` closure reference would always read the stale initial-render value. New test opens app A, opens app B (ignored, dialog still shows A), closes, then opens app B (now succeeds).

**Verification**: `cd web && npx vitest run` → 731 passed (46 files), up from the 725 baseline (+6: 3 in `AppFrameLayer.vitest.ts` for FIX 1/FIX 2, 3 in `StudioModal.vitest.ts` for FIX 3's new boundary tests + FIX 4). `npx tsc -b --pretty false` → clean. `npm run build` → green (same pre-existing chunk-size warning on `dist/assets/index-*.js` noted in B3's log, unrelated). `churn-spike` harness re-run (FIX 1 touches the ancestor-selector input to `computePaneClip`, i.e. positioning math) → `stable iframe loads: 1, unstable iframe loads: 1`, unchanged from B3 — the never-reload seam is intact.

**Evidence path**: `~/.claude-control/media/prototypes/cockpit-churn-spike-2026-07-10T05-52-35/` (post-CP3-B churn-spike re-run, 5 PNGs + video).

## Audit item coverage
| Task | Rubric |
|---|---|
| B1 | T1 (arbitration), P1 |

## Task list

### B1 — 'studio' context tier
> **Goal**: placeholders may declare data-embed-app-context='studio'; pickHost prefers studio > panel > transcript while studio is open; studio hosts elevate above the studio overlay (z 310 via the generalized elevate mechanism from the scroll PR).
> **Files**: web/src/components/AppFrameLayer.tsx, web/src/components/EmbeddedApp.tsx (context prop union), web/src/components/AppFrameLayer.vitest.ts
> **Acceptance**: with transcript+panel+studio placeholders for one url, studio hosts; closing studio returns hosting to panel-then-transcript with ZERO iframe reloads (mounted load-count assertions); chip semantics on non-hosts remain coherent ('open in studio'? keep existing chip text — non-host chip text stays as-is this phase).
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: scroll-sync PR merged (external); none in-phase
> **Reversibility**: load-bearing

### B2 — Device modes = placeholder resize
> **Goal**: StudioModal's body hosts the app placeholder at 390×844 / 768×1024 / 1280×800 (letterboxed, centered); switching modes resizes the placeholder only.
> **Files**: web/src/components/StudioModal.tsx, web/src/styles.css
> **Acceptance**: zero iframe reloads across mode switches (load-count); iframe media queries respond (verify with an artifact that renders its own innerWidth); gated modes unreachable at small screens.
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: B1
> **Reversibility**: clean-revert

### B3 — Enter/exit transitions + evidence
> **Goal**: polished open/close (no layout shift, correct clip/z at every step) with harness captures proving the seam.
> **Files**: web/scratch harness (gitignored), web/src/styles.css touch-ups
> **Acceptance**: harness video: transcript embed → studio (state intact) → device switches (state intact) → close → panel/transcript hosting resumes (state intact); PNGs read + confirmed.
> **Verification**: harness run + cd web && npx vitest run
> **Depends on**: B2
> **Reversibility**: clean-revert
> **E2E test**: harness capture (state-intact across the full journey)

## Review sign-off checklist
- [ ] Zero reloads across enter/switch/exit (evidence)
- [ ] Scroll-PR behaviors (fade/sync) still green post-merge
- [ ] PR targets umbrella branch
