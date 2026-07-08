---
feature: cockpit-pinned-artifacts
phase: c
tier: feature
autonomous: true
complexity-budget: { files: 6, loc-delta: 450 }
adopted-patterns: [ArtifactPanel/ArtifactContext tab seam, reserved-box discipline]
umbrella-branch: feat/cockpit-pinned-artifacts-integration
---

# Phase C — Panel view + pinning

> **Scope**: `'app'` artifact kind; pin-to-panel from transcript embeds; always-mounted, mount-ordered app iframes; LRU pin-exemption.
> **Design**: docs/design/cockpit-pinned-artifacts.md
> **Branch**: feat/cockpit-pinned-artifacts-phase-c

## Status
| state | tasks |
|---|---|
| todo | (none — phase C complete) |
| done | C1, C2, C3, C4 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08 -->

<!-- CP0 log -->
### C1 — done (sha acf5fee)
- `kind:'app'` (appUrl, appHeight) + `pinned: boolean` added to `Artifact`; `capUnpinnedOverflow()` splits the LRU_CAP=8 slice so the cap counts unpinned entries only — pinned artifacts are never evicted regardless of count or open order.
- `appArtifactId(url)` (djb2-hash based) added alongside the existing `codeArtifactId` for stable, url-derived ids (feeds C3's idempotent re-pin).
- New `ArtifactContext.vitest.ts`: 14 tests — pre-existing open/re-open/close behavior (3, unchanged/regression-guard), pinned defaults + pin()/unpin() semantics (6), LRU pin-exemption (5: single pinned survives 12 opens, multiple pinned survive, unpin re-exposes to eviction, close removes regardless of pin state).
- Verification: `npx vitest run` + `npx tsc -b --pretty false` green at commit time.
- Complexity: 2 files, ArtifactContext.tsx delta well under the phase's 450 loc-delta budget.
- Deviations: none. Neither HALT condition triggered.

### C2 — done (sha 8fed2a1)
- `AppFrameLayer.tsx` generalized from one-placeholder-per-url to N-placeholder-per-url: `SlotEl` gained `context`/`explicitlyHidden`; `pickHost(entries)` picks one deterministic host per tick (panel-context wins, else first-in-document-order); non-host "shadow" placeholders for a url that IS hosted in the panel get their live rect tracked (`shadowsRef`) and rendered as an "active in panel ↗" chip that calls `setActive(appArtifactId(url))` — gated so a same-url transcript-only duplicate (host picked via the doc-order fallback, no panel involved at all) never shows a misleading chip.
- `EmbeddedApp.tsx` gained `context` ('panel'|'transcript') and `hidden` props, riding as `data-embed-app-context`/`data-embed-app-hidden`; `hidden` applies `visibility:hidden`+`pointerEvents:none` (never `display:none`, which would zero the rect and trip the existing FIX-2 zero-rect eviction) — folded into the same `paneHidden` treatment as a scrolled-out-of-pane placeholder, so tab switches hide-not-evict.
- `ArtifactPanel.tsx` gained the always-mounted app stack: `selectLiveAppIds(mruAppIds, wokenIds, cap=6)` (pure, exported) caps simultaneously-fetched iframes at 6 (MRU-first + any explicitly-woken id), `ArtifactAppStack` renders EVERY open app artifact's slot simultaneously (visibility toggled per-slot via `data-active`), with a "suspended — tap to wake" button standing in for anything past the cap — waking is the only path that promotes a suspended app to live, deliberately NOT triggered by tab-switch/activation. Wired into both the desktop and mobile `.artifact-panel-body` blocks; existing `SkillLegend`/`ArtifactBody` rendering gated on `kind !== 'app'`.
- `styles.css`: `.artifact-panel-body{position:relative}` (containing block) + `.artifact-app-stack`/`.artifact-app-slot`/`.artifact-app-suspended`/`.embed-app-panel-chip`.
- Regression fix: `AppFrameLayer` now calls `useArtifactPanel()` (for the chip's `setActive`) — every pre-existing test mounting it needed an `<ArtifactPanelProvider>` ancestor added (`AppFrameLayer.vitest.ts` 1 mount, `embeds.vitest.ts` 9 mounts).
- Self-caught bug (pre-test, no user report): initial shadow-chip tracking populated the chip for two transcript-only duplicate placeholders (no panel involvement at all) — fixed by gating shadow tracking on `host.context === 'panel'`; regression-guarded by a dedicated test.
- Self-caught bug (post-write, jsdom quirk): `ArtifactPanel.vitest.ts`'s first draft omitted the `getBoundingClientRect` stub every other AppFrameLayer-mounting suite requires (jsdom has no layout — every real rect is 0x0x0x0, which FIX-2 treats as "not present"); all 3 mounted tests silently never fetched until the stub was added, matching `embeds.vitest.ts`'s existing pattern.
- Tests: 14 new — `ArtifactPanel.vitest.ts` (9: `selectLiveAppIds` pure-function cap/wake/no-orphan-crash behavior ×3, desktop mounted zero-reload-across-tab-switch/reorder/pin-unpin, desktop mounted live-cap+suspend+wake, desktop non-app-kind-unaffected, mobile-sheet app-stack+ArtifactBody-suppression) + `embeds.vitest.ts` C2 suite (4: panel-hosts-over-transcript-duplicate, chip-click-focuses-tab, explicitly-hidden-hides-never-evicts, transcript-duplicate-fallback-no-misleading-chip).
- Verification: full suite 594/594 green (567 baseline + 14 C1 + 13 C2), `npx tsc -b --pretty false` clean, `npm run build` green (pre-existing >500kB chunk-size warning unrelated, not touched).
- Deviations: churn-spike harness re-run deferred to the phase-end VERIFY pass (C2 changes are a strict generalization of AppFrameLayer's single-placeholder path, confirmed via the full green AppFrameLayer.vitest.ts/embeds.vitest.ts suites — no code path AppFrameLayer's core geometry/eviction logic actually changed for the pre-Phase-C single-placeholder case). Neither HALT condition triggered.

### C3 — done (sha 45cf02b)
- `AppPinButton` (EmbeddedApp.tsx, sibling to `AppReloadButton`) rendered by `AppFrameLayer` next to the reload button in all three chrome states (healthy iframe corner, failed strip, crashed strip). Symmetric top-left placement via a new `cornerLeft` field on `clampChromeInsets`' return type (mirrors the existing `cornerTop`/`cornerRight` clamp the reload button already used on the opposite corner) — no per-branch special-casing needed since the existing `.embed-app-reload-btn`/`.embed-app-crashed` CSS positioning model already floats corner chrome absolutely over all three branches uniformly.
- Click always calls `open({..., pinned: true})` — deliberately not a toggle. Re-clicking an already-pinned app's button re-opens/re-focuses it (idempotent via `openReducer`'s existing move-to-front-and-activate path); it never unpins. This follows the exact semantics already specified in `ArtifactContext.tsx`'s pre-existing `OpenArtifactInput` doc comment (a forward reference to C3 authored during C1) rather than inventing new toggle behavior. Unpinning is exposed only from the panel side (tab close), which is existing C1/C2 machinery, not new C3 surface.
- Title is the url's basename (new `basename()` helper in AppFrameLayer.tsx).
- `.embed-app-pin-btn`/`-labeled`/`-active` CSS added to styles.css, positioned `left:6px` (opposite corner from `.embed-app-reload-btn`'s `right:6px`) so the two controls never overlap in any chrome state.
- New mounted test in `embeds.vitest.ts` (`describe('C3: pin-to-panel affordance (mounted)')`) drives the real pin button + real `ArtifactPanel` UI end-to-end (not `useArtifactPanel().open()` called directly): pinning from a transcript embed creates+focuses a panel tab with zero extra fetches; pinning again focuses without duplicating the tab; closing the tab from the panel hands the iframe back to the transcript placeholder with no reload (proves host arbitration is symmetric in the panel-removed direction, not just the panel-added direction C2's tests already covered).
- Fixed the 2 pre-existing `clampChromeInsets` tests broken by the `cornerLeft` field addition. One of them ("leaves the corner offset at its CSS default when only bottom/left are clipped") needed more than a mechanical field bump: with `cornerLeft` in play, a `left` clip now legitimately pushes `cornerLeft` inward exactly like a `right` clip already pushed `cornerRight` — so the test's own title and asserted value were wrong for the new field, not just incomplete. Retitled and corrected rather than patched.
- Verification: full suite 595/595 green (594 prior + 1 new C3 mounted test), `npx tsc -b --pretty false` clean, `npm run build` green (same pre-existing >500kB chunk-size warning, unrelated).
- Deviations: the tracker's anticipated file list for C3 named `MessageParts.tsx or MarkdownText.tsx (wiring)`, but the pin button lives entirely in `AppFrameLayer.tsx`'s hoisted chrome layer instead — the same placement `AppReloadButton` already uses, and for the same reason (AppFrameLayer's portal is the only place with both a stable per-url slot and `useArtifactPanel()`'s `open`/`artifacts`; wiring through the transcript-render path would require passing panel context down through markdown rendering for no benefit). No transcript-rendering files needed touching. Neither HALT condition triggered.

### C4 — done (sha 1a55fab)
- New `web/scratch/pin-to-panel-harness/` mounts the real `ArtifactPanelProvider`+`ArtifactPanel`+`AppFrameLayer` trio (no mocks) around two independently pinnable counter micro-apps — the same built `counter.html` (see `../counter-app/build.mjs`) served under two url paths (`apps/counter.html`/`apps/counter2.html`) via a small Vite media middleware, since each gets its own iframe + its own React root + its own count state from 0. Cheapest way to get a genuine second, independently-stateful pinnable artifact for a real tab-switch capture without a second build target.
- Captured at desktop (1360x900, `capture-desktop.json`) and narrow (390x844, `capture-narrow.json`), driven by `~/.claude/skills/prototype-component/scripts/run.mjs`. Desktop: 7 stills + 1 video walking pin → panel tab + "active in panel ↗" chip on the transcript embed → pin a second app (both transcript embeds show the chip simultaneously) → click `+1` three times inside the panel's live sandboxed iframe (via Playwright's `frameLocator`) → switch tabs away and back → count still 3 (proves the C2 `visibility:hidden` mechanism — no reload) → close/unpin → transcript embed resumes hosting with count still 3, tab list shrinks to one. Narrow: 2 stills (initial transcript, pinned → mobile bottom-sheet peek with tab strip + drag handle) proving the responsive layout holds with no shift; skipped a full narrow interaction replay (the fixed-position sheet can legitimately occlude the second pin button below the peek fold — replaying the full desktop script here would need real drag-to-expand simulation, which is out of scope for a visual pass whose acceptance is just "no layout shift").
- All 9 PNGs + the video read back and visually verified before landing (not embedded unverified) — every claimed state (chip appearance, live increment, count survival across tab switch, unpin round-trip, narrow sheet peek) is directly confirmed in the pixels, not assumed.
- Playwright wasn't a project dependency (no E2E infra existed yet in this repo) — added via `npm install --no-save playwright@1.59.1` in the (symlinked, gitignored) `web/node_modules`. Deliberately `--no-save`: this is capture tooling for the harness, not a shipped dependency, so `package.json`/lockfile are untouched.
- Deferred seam-regression re-run (flagged across C2 and C3, still outstanding going into C4) executed as part of this task's VERIFY pass: `web/scratch/churn-spike/` — Phase A's hoist-survival regression guard — had gone stale and now crashed on mount (`AppFrameLayer` calls `useArtifactPanel()` since C2, but sat outside both `Panel` variants' own nested `ArtifactPanelProvider`s). Fixed by hoisting one shared provider around both panels + `AppFrameLayer` (per-panel context isolation doesn't matter for this harness's actual assertions — hoist/fetch-count survival, not pin state). Separately, its `capture.json` used `locator.screenshot()` on the counters region, which waits for two visually-stable consecutive frames — a wait that can never resolve while `AppFrameLayer`'s rAF tracking loop keeps repositioning the hoisted iframe every frame (expected, continuous, by-design behavior of the live clip-tracking system, not a bug). Switched those states to `fullPage` screenshots, which carry no such wait. Re-run confirms the fix from Phase A still holds after C1–C3: `stable iframe loads: 1`, `unstable iframe loads: 1`, `live hoist count: 2` after the full 24-step churn run; hide/re-show the stable pane past the eviction grace period costs exactly one extra load (2) and hoist count returns to 2 — matching FIX 2's documented contract exactly, no leak.
- Verification: full suite 595/595 green (unchanged from C3 — C4 touched no `src/` files), `npx tsc -b --pretty false` clean (the new harness `.tsx`/`.mts` files under `web/scratch/` don't affect the build graph, same as the pre-existing scratch dirs), `npm run build` green (same pre-existing >500kB chunk-size warning, unrelated).
- Deviations: (1) the tracker's file list for C4 named only `web/src/styles.css, capture harness spec` — no styles.css changes were needed (C1-C3's chrome/CSS already matched the cockpit aesthetic; C4 found nothing to adjust visually). (2) the churn-spike harness fix (2 files) was not in C4's anticipated scope but was required to actually execute the phase's own explicitly-deferred VERIFY-pass regression check — a mechanical unblock (missing provider wrap + a screenshot-mechanics swap), not a design change, so folded into this commit rather than opening a new task. Neither HALT condition triggered at any point across the full phase.

<!-- CP0 log: CP3-C: verdict (b); 2 HIGH + 1 MEDIUM fixed in a93a19f —
     panel-context hosts are now exempt from AppFrameLayer's zero-rect
     eviction check (AppFrameLayer.tsx: the mobile back-nav
     `.detail{display:none}` collapse used to zero-rect a pinned app's panel
     placeholder same as any transcript embed, and the eviction loop
     unconditionally evicted on zero-rect — silently destroying every
     pinned app's live iframe on every back navigation; a panel zero-rect
     now routes through the existing hide-not-evict path unchanged,
     transcript embeds keep the Phase-A evict-on-view-exit behavior).
     `wasLive` tracking (ArtifactPanel.tsx's new `everLiveIds` set)
     distinguishes "suspended — tap to reload" (state was discarded on cap
     demotion) from "tap to open" (never loaded) on the suspended-app
     button. MEDIUM: C2 chip copy "active in panel ↗" → "open in panel ↗"
     (state-agnostic — a hidden/inactive panel tab is still the host per
     `pickHost`'s unconditional context rule, so "active" was a lie).
     LOW: dead `pin()`/`unpin()` exports removed from ArtifactContext (zero
     production call sites — pinning is `open({pinned:true})`, unpinning is
     `close()`); `setPinnedReducer` removed alongside (its only caller,
     and would otherwise trip `noUnusedLocals`). ArtifactContext.vitest.ts's
     2 dead-reducer tests deleted, plus a 3rd LRU re-eligibility test
     deleted outright: it depended on `setPinnedReducer`'s in-place,
     non-reordering unpin flip, and isn't safely rewritable via `open()`
     (`openReducer`'s re-open path always moves the artifact to MRU-front,
     which would invert that test's eviction-order assertion) — accepted as
     a YAGNI consequence, revisit if Phase D needs unpin-without-close.
     LOW: added the missing hidden-panel-host arbitration test (a hidden/
     inactive panel tab still out-arbitrates a visible transcript
     placeholder — chip shows, click still focuses the tab). New coverage:
     embeds.vitest.ts +2 (panel-survives-back-nav-collapse both-sides test;
     hidden-panel-host-still-arbitrates test), ArtifactPanel.vitest.ts +1
     (demoted-from-live app shows "tap to reload" and wakes with exactly
     one re-fetch — this test's first draft caught a real timing gotcha:
     AppFrameLayer's own hoisted slot for a demoted app stays mounted,
     hidden, until GRACE_MS elapses, even after ArtifactAppStack unmounts
     the app's placeholder — the `queryByTitle(...).toBeNull()` assertion
     had to move to after the grace-period wait, not before). Net test
     count unchanged (595 → 595: -3 dead ArtifactContext tests, +1
     ArtifactPanel test, +2 embeds tests). Design-doc seam line added
     (Principles & Seams: "pinned panel apps survive mobile back-nav
     (hide-not-evict, cap-bounded); transcript embeds keep the documented
     evict-on-view-exit exception"). Files: AppFrameLayer.tsx,
     ArtifactContext.tsx, ArtifactPanel.tsx, ArtifactContext.vitest.ts,
     ArtifactPanel.vitest.ts, embeds.vitest.ts, this tracker, design doc.
     595/595 vitest, tsc clean, build green. Bookkeeping note: a commit
     cannot embed its own resulting sha (the sha is a hash of the tree/
     message/parent, so writing it into the tree changes the tree, which
     changes the sha — confirmed the hard way this round: an initial
     commit-then-amend attempt landed a stale sha, since amending the tree
     to inject the sha necessarily produces a *different* sha). This log
     line therefore lands in a separate doc-only commit after a93a19f, not
     folded into it — matching this file's own established CP3-B precedent
     (b41f7fd fix commit + fe0cc8f doc-only tracker-sync commit above). -->

## Audit item coverage
| Task | Rubric |
|---|---|
| C2 | T1, P1 |
| C1 | S2 |

## Task list

### C1 — `'app'` kind + pin semantics in ArtifactContext
> **Goal**: context supports `kind:'app'` artifacts with `pinned` flag; LRU slice skips pinned (cap governs unpinned only).
> **Files**: web/src/components/ArtifactContext.tsx, web/src/components/ArtifactContext.vitest.ts (new)
> **Acceptance**: opening 9+ artifacts never evicts a pinned app; unpinned still LRU at 8; reducer unit tests cover open/re-open/pin/unpin/close.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: load-bearing

### C2 — Mount-ordered app frame container in ArtifactPanel
> **Goal**: app bodies render in a persistent container ordered by mount (NOT tab/reducer order); tab switching toggles visibility only; non-app kinds keep active-only rendering (ArtifactPanel.tsx:232).
> **Files**: web/src/components/ArtifactPanel.tsx, web/src/styles.css
> **Acceptance**: with 3 pinned apps, switching tabs + re-opening artifacts (reducer move-to-front) produces ZERO iframe reloads (stateful-app evidence); mounted-app cap 6 with placeholder beyond; MULTI-PLACEHOLDER ARBITRATION (CP3-A MEDIUM follow-up): slots stay url-keyed single-instance — a deterministic priority rule picks the hosting placeholder (panel > transcript, else first visible) and non-hosting placeholders render a quiet 'open in panel' chip instead of a silent empty box.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false && npm run build
> **Depends on**: C1
> **Reversibility**: load-bearing

### C3 — Pin affordance on transcript embeds
> **Goal**: "pin to panel" control on `<embedded-app>` frames opens/activates the panel tab for that app url.
> **Files**: web/src/components/EmbeddedApp.tsx, web/src/components/MessageParts.tsx or MarkdownText.tsx (wiring), web/src/styles.css
> **Acceptance**: pinning from transcript creates/focuses the app tab; pinning twice focuses (no duplicate); transcript embed stays functional independently.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: C2
> **Reversibility**: clean-revert

### C4 — Visual pass + mobile behavior
> **Goal**: panel app view matches cockpit aesthetic; mobile follows existing ArtifactPanel responsive rules; captures embedded for review.
> **Files**: web/src/styles.css, capture harness spec
> **Acceptance**: captures show pinned tabs (desktop + narrow viewport), reload strip, and tab-switch state survival; no layout shift.
> **Verification**: prototype-harness run + npm run build
> **Depends on**: C3
> **Reversibility**: clean-revert
> **E2E test**: harness video: pin → switch tabs → state intact → unpin

## Dependencies between tasks
C1 → C2 → C3 → C4 (linear; C4 may start styles alongside C3).

## Review sign-off checklist
- [ ] Zero iframe reloads across tab switch + reducer reorder (evidence)
- [ ] Pinned never evicted; unpinned LRU intact
- [ ] PR targets umbrella branch
