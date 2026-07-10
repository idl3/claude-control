---
feature: cockpit-prototype-studio
phase: e
tier: feature
autonomous: true
complexity-budget: { files: 6, loc-delta: 400 }
adopted-patterns: [appBridge protocol, harness capture conventions]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase E — Inspector, console stub, E2E + docs

> **Scope**: read-only DOM inspection, console coming-soon slot, full-journey evidence, artifact-contract docs. Last phase — umbrella goes ready-for-review after this.
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-e

## Status
| state | tasks |
|---|---|
| todo | — |
| done | E1, E2, E3, CP3-E |

**Budget note (applies to E1+E2 combined, carried forward from before this entry existed)**: `complexity-budget: { files: 6, loc-delta: 400 }` — actual E1+E2 span (`b98b7a7..aedd15a`) touched **9 files, +1114/-12 loc**. Over on both axes (1.5x files, ~2.75x loc). Breakdown: 5 source files (`StudioInspector.tsx` new, `StudioModal.tsx`, `appBridge.ts`, `ccBridgeRuntime.tsx`, `styles.css`) + 4 test files (`StudioInspector.vitest.ts`, `StudioModal.vitest.ts`, `appBridge.vitest.ts`, `ccBridgeRuntime.vitest.ts`). The overrun is the test files: the global testing mandate (80%+ coverage, regression tests for every new surface) isn't optional against a per-phase loc budget — S1's read-only-inspector acceptance criteria (spoofed-source rejection, truncation boundary cases, full-context round-trip) need real coverage, not a token test. Not treated as scope creep; flagged here because the budget line exists and was in fact exceeded.

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

### E1 — Inspector tab — DONE (`7c9717c`)
- `cc-dom-outline-request`/`cc-dom-outline-result` wired into the bridge protocol (bridge template outside git: `~/.claude/skills/prototype-component/scripts/cc-bridge-template.tsx`, `web/src/lib/appBridge.ts`, `web/src/lib/ccBridgeRuntime.tsx`). Producer-side `serializeCcDomOutline` walks the DOM into a plain tree with a single shared-counter budget (depth ≤12, total nodes ≤2000, whole-tree not per-branch); consumer-side `isCcDomOutlineResultShape` independently re-enforces the SAME two ceilings when validating an inbound result — defense-in-depth against a buggy/hostile producer build, not just trust-boundary source-identity (mirrors the existing `event.source === trackedWindow` reference-equality model, never `event.origin`, same as every other cc-bridge message type).
- New `web/src/components/StudioInspector.tsx`: collapsible read-only tree (native `<details>/<summary>`, zero interactive/mutation affordances by design — S1), Refresh button, truncated-notice banner. `StudioModal.tsx` gains a `StudioSidePanel` tab strip (Props / Inspector / Console) wrapping the pre-existing `StudioPropsPanel` — both panels stay mounted at all times, tab switch toggles the native `hidden` attribute rather than unmounting (extends the pre-existing "`.studio-frame` must never unmount" discipline one level down), so a pending prop edit or an already-fetched outline survives a tab switch.
- **Regression found + fixed during verification**: because both side-panel tabs stay permanently mounted, `StudioInspector`'s bridge-ready listener originally fired its auto-outline-request the instant the bridge announced ready — even while the Inspector tab was hidden — sharing the same postMessage channel `StudioPropsPanel`'s props-set debounce/queue logic depends on, and breaking two pre-existing C3 tests that spy on call count/timing. Fixed by gating the auto-request effect on a new `active` prop (`tab === 'inspector'`), re-arming on tab-activation; the always-visible Refresh button remains the general-purpose recovery path regardless of activation timing.
- Tests: outline round-trip (mock the tree), depth/node truncation (both producer-side `serializeCcDomOutline` truncation and consumer-side oversize-tree rejection, including an exact-ceiling boundary case that must NOT be rejected), spoofed-source rejection (unit + component level), read-only proof (clicking a disclosure `<summary>` never posts a message), full-context round-trip mounted with a real `AppFrameLayer` + hosted iframe.

### E2 — Console slot — DONE (`aedd15a`)
- Decided **against** live console forwarding this phase. Wrapping `console.log/warn/error`, posting `cc-console-entry{level, args-as-strings}` per call, and rendering a capped (≤500) ring buffer with level badges and clear-on-reload in Studio is meaningfully more than the ~1hr trivial-work bar: safe arg serialization (circular refs, DOM nodes, `Error` objects), a wrapped-console lifecycle that restores cleanly on unmount/re-open without leaking the previous artifact's wrapper, and its own render-side test suite — closer in scope to D1's capture feature (a full request/response bridge extension) than a one-effect addition.
- Shipped instead: `CC_CONSOLE_ENTRY_TYPE` reserved as a concrete exported constant (`ccBridgeRuntime.tsx`, mirrored in the outside-git bridge template) with no handler wired, plus the disabled "coming soon" Console tab (button + `.studio-side-tab-disabled` CSS + `title` tooltip) — the UI slot for a future E-follow-up implementer to fill in without renegotiating the tab-strip shape.
- **Deviation**: the disabled Console tab's UI (button + CSS + tab-strip wiring) shipped bundled into the E1 commit rather than isolated to this one, because `StudioSidePanel` is a single atomic 3-tab-strip component — splitting its JSX across two commits would require a synthetic 2-tab intermediate state with no functional or audit value (nobody ships/reviews a 2-tab strip that immediately becomes 3-tab in the very next commit). This E2 commit carries the genuinely E2-scoped remainder: the `CC_CONSOLE_ENTRY_TYPE` protocol reservation and its doc comment.

### E3 — Full-journey E2E + contract docs — DONE (`6901031`)
- Harness: `web/scratch/studio-phase-e-harness/run.py` (gitignored — `web/scratch/` is repo-excluded, same as the Phase D evidence harness and the counter/composer dogfood app sources it depends on; only the harness's OUTPUT — the evidence PNGs/video and the contract docs — is a tracked deliverable). System Python Playwright (`playwright.sync_api`, already installed, chromium cached) drives a hermetic `server.js` instance on port 4419 with its own token + tmp media/projects/uploads/present/pins roots (`CLAUDE_CONTROL_*` env vars) — the operator's real port-4317 server is never imported, started, or touched.
- Journey: open (`cockpit:studio-open` CustomEvent) -> device-mode switch (iPad/Mobile/Desktop) -> props edit (`label` field) -> crash (counter's own in-iframe "crash it" button — its `CounterBoundary` class component, not a synthetic bad-prop payload: neither of Counter's real props triggers a render-time throw from a bad raw-JSON override) -> recover (`cockpit:app-reload` CustomEvent — Studio's own crashed-strip renders no reload button this phase, see the design doc's new degrade-rules table; the harness stands in for that missing affordance) -> screenshot (D1's capture tool) -> annotate (one pen stroke) -> save -> Inspector tab. Second pass at a real 390px viewport asserts device-mode gating. All 12 evidence artifacts (11 desktop-pass stills + 1 narrow-pass still, plus video for both passes) written to `~/.claude-control/media/prototypes/studio-phase-e/` and individually read+visually confirmed correct.
- **Root cause found + fixed**: the harness's first several runs failed at the screenshot step with a client-side `capture timed out` (Studio's own 10s internal timeout — zero response ever arrived), reproducible even with no crash/reload involved at all (isolated no-reload control case). Root cause: the checked-in dogfood artifacts (`~/.claude-control/media/apps/counter.html`/`composer.html` — the ones the original phase dispatch assumed were "pre-built, no rebuild needed") were stale from Phase C, entirely missing D1's `cc-capture-request`/`cc-capture-result` and this phase's own `cc-dom-outline-request`/`cc-dom-outline-result` (confirmed by grepping the deployed `.html` for `cc-*` string literals — minification can't rename these — plus an mtime comparison against their `.tsx` sources). Fixed by rebuilding both via their existing `build.mjs` scripts (esbuild already in `web/node_modules`, invoking the pre-existing outside-git `~/.claude/skills/prototype-component/scripts/run.mjs` — zero new npm installs, Halt-N honored). Documented in the harness's own module docstring for the next person who hits this.
- **Corrected assumption, found by reading `StudioModal.tsx` directly**: `DEVICE_MODES` gating via `useMinWidth(preset.width + STUDIO_BODY_CHROME_WIDTH(50))` applies to **every** device-mode button, including the smallest preset (Mobile, own threshold 440px) — not just the larger ones. An earlier harness draft asserted "Mobile stays enabled at 390px" and failed; corrected to assert all three disabled at a real 390px viewport, matching verified source behavior. The same gate also meant a naive 1280px desktop-pass viewport was too narrow to select Studio's *own* "Desktop 1280" button (needs >=1330px) — bumped the desktop pass to 1400px so all three device-mode screenshots actually get taken.
- **Two findings folded into the design doc's new degrade-rules table** (not treated as bugs to fix this phase — out of E3's scope, which is evidence + docs): (1) a full iframe reload (crash recovery) discards all previously-applied `cc-props-set` overrides — the artifact remounts via a genuinely new `<iframe>` DOM element with only its own manifest defaults, and Studio's Props panel doesn't auto-resend the last-typed value to the fresh iframe (verified live: `desktop-05-recovered.png` shows the label reverted to default while the input still showed the pre-crash edit); (2) Studio's crashed-strip renders no reload button (`isStudioHost` gate in `AppFrameLayer.tsx`), a pre-existing gap this phase doesn't fix.
- Non-blocking clarification: the harness's hermetic server briefly showed live-host tmux window state in its sidebar during development (SessionRegistry reconciles tmux panes host-wide, alongside file-based project transcripts which ARE correctly isolated via `CLAUDE_CONTROL_PROJECTS`) — inherent to `lib/sessions.js`, orthogonal to the Studio journey under test (which only ever touches the isolated media root), and absent on the final clean run ("no tmux panes"). Not a hermeticity bug in the harness's own env-var construction.
- Contract docs: new "Artifact contract" section in `docs/design/cockpit-prototype-studio.md` — manifest schema v1 (fields + per-field degrade), full bidirectional message catalog (all 8 types, both directions, correlation/no-correlation reasoning), validation rules (source-identity-not-origin, exact-shape, dual-sided outline-budget enforcement, capture-size ceilings client+server), and a degrade-rules table covering manifest-absence, oversize/throwing outline walks, capture failure/timeout/oversize, crash+no-reload-button, reload-discards-overrides, and the device-mode chrome-inset gating above.
- Verification: harness run green (`{"ok": true}`, 12/12 evidence artifacts) + full suites below.

### CP3-E — done — sha `d9ea5cf`
CP3 audit follow-up on top of E1-E3, priority-ordered:
- **FIX 1 [P2, priority]** — the crashed strip's `isStudioHost` gate (Studio Phase B CP3, FIX 2) suppressed the reload/pin/fullscreen corner trio unconditionally for `context==='studio'`, including the crashed render branch — a studio-hosted component that crashes with the studio as its only host had no recovery path short of closing and reopening the whole modal. Fixed by rendering `AppReloadButton` unconditionally in the CRASHED branch only (`AppFrameLayer.tsx`, render function) — dispatches the same `cockpit:app-reload` CustomEvent the transcript/panel reload button already uses, remounting the shared url-keyed iframe fresh (`crashed:false`, `pickHost`'s existing studio>panel>transcript priority re-hosts it in the studio). Pin + fullscreen stay suppressed for studio in every branch (still redundant/self-referential there regardless of crash state); the healthy and failed branches are byte-for-byte unchanged from Phase B CP3. New mounted regression tests in `web/src/lib/embeds.vitest.ts` ("Studio Phase E CP3 audit, FIX 1"): a crashed studio host renders Reload (not Pin/Fullscreen) and recovers via a real click through to a freshly-fetched srcdoc; a healthy studio host still renders none of the three, confirming the fix is scoped to the crashed branch alone.
- **FIX 2 [LOW]** — added the missing cycle/DAG regression test for `isCcDomOutlineResultShape` (`web/src/lib/appBridge.vitest.ts`): a hand-built self-referencing outline node (`n.children.push(n)`) is rejected, locking in the analytically-proven bound that `isPlainOutlineNodeShape`'s depth check (first line of the recursive walk, evaluated before `.every(...)` re-enters children) terminates within `CC_DOM_OUTLINE_MAX_DEPTH`+1 (13) stack frames regardless of a hostile/buggy producer's tree shape — no infinite recursion, no stack blow.
- **FIX 3 [LOW]** — corrected the design doc's degrade-rules table ("Artifact throws during render (crash)" row, `docs/design/cockpit-prototype-studio.md`): it previously read as if recovering a studio crash needed a manual `cockpit:app-reload` dispatch; updated to document FIX 1's shipped in-studio Reload button as the primary recovery path, plus the close+reopen fallback's real timing nuance (`GRACE_MS`=250ms — a reopen past that window evicts-and-remounts fresh; a reopen within it reuses the still-tracked, still-crashed slot).
- The prop-resync-on-reload finding (a full iframe reload discards all `cc-props-set` overrides, `degrade rules` table's "Full iframe reload" row) is intentionally untouched — a narrower, already-documented P2/P3 fast-follow, out of scope for this pass. `bridgeReady`/flush logic likewise untouched.

**Verification**: `cd web && npx vitest run` → 878 passed (52 files), up from the 875 baseline (+3: 2 in `embeds.vitest.ts` for FIX 1, 1 in `appBridge.vitest.ts` for FIX 2). `npx tsc -b --pretty false` → clean. `npm run build` → green (same pre-existing chunk-size warning on `dist/assets/index-*.js` noted throughout this phase's log, unrelated). Server suite (`npm test` at repo root) → 945 passed (17 suites), unchanged (no server-side files touched).

## Audit item coverage
| Task | Rubric |
|---|---|
| E1 | S1 |
| E3 | full-journey evidence + contract docs |
| CP3-E | FIX 1 P2 (priority), FIX 2/FIX 3 LOW |

## Task list

### E1 — Inspector tab
> **Goal**: cc-dom-outline-request → depth-limited serialized outline (tag/id/class/text-preview/child-count, depth ≤12, nodes ≤2000) → collapsible tree in the studio with refresh; read-only.
> **Files**: bridge template, web/src/lib/appBridge.ts, web/src/components/StudioInspector.tsx (new), styles.css, tests
> **Acceptance**: counter + composer outlines render; oversized DOMs truncate with a notice; zero interaction affordances (read-only v1).
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: none
> **Reversibility**: clean-revert

### E2 — Console slot
> **Goal**: Console tab ships as disabled "coming soon" with the cc-console-entry protocol reserved; IMPLEMENT live forwarding only if it is genuinely trivial (bridge wraps console.* → capped ring buffer → studio list) — judgment call, justify either way in the tracker log.
> **Files**: StudioModal.tsx, bridge template (reservation), tests if implemented
> **Acceptance**: tab present + honest state; if implemented: entries stream with level badges, capped at 500, cleared on reload.
> **Verification**: cd web && npx vitest run
> **Depends on**: none
> **Reversibility**: clean-revert

### E3 — Full-journey E2E + contract docs
> **Goal**: harness captures of the complete studio journey (desktop + 390px): open → device switch → props edit → invalid prop → crash+reload → screenshot → annotate → save → inspector; docs/design contract section documents manifest schema v1 + bridge protocol + degrade rules.
> **Files**: web/scratch harness, docs/design/cockpit-prototype-studio.md, README updates
> **Acceptance**: PNGs/video read + confirmed; docs let a third party build a conforming artifact.
> **Verification**: harness run + full suites (web + server) green
> **Depends on**: E1
> **Reversibility**: clean-revert
> **E2E test**: the journey harness itself

## Review sign-off checklist
- [x] Full journey evidence on both form factors
- [x] Contract docs complete (schema + protocol + degrade)
- [ ] Umbrella ready-for-review flipped after merge — orchestrator opens the PR; not this dispatch's step
