---
feature: cockpit-prototype-studio
phase: d
tier: feature
autonomous: true
complexity-budget: { files: 7, loc-delta: 600 }
adopted-patterns: [lib/media-apps.js endpoint discipline, reserved-box/skeleton CSS]
umbrella-branch: feat/cockpit-prototype-studio-integration
---

# Phase D — Screenshot, annotate, captures endpoint

> **Scope**: in-sandbox capture via the bridge, studio annotation overlay, authed persistence into the media root.
> **Design**: docs/design/cockpit-prototype-studio.md
> **Branch**: feat/cockpit-prototype-studio-phase-d

## Status
| state | tasks |
|---|---|
| todo | — |
| done | D1, D2, D3 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

### D1 — Bridge capture — DONE
- `cc-capture-request`/`cc-capture-result` wired into the cc-bridge protocol (bridge template outside git: `~/.claude/skills/prototype-component/scripts/cc-bridge-template.tsx`, `web/src/lib/appBridge.ts`, `web/src/lib/ccBridgeRuntime.tsx`) via `html-to-image`'s `toPng` — the only pre-approved new dependency (confirmed via `web/package.json`/`package-lock.json` diff, static top-level import, no code-splitting).
- Studio `Screenshot` button (`StudioModal.tsx`) drives `idle → capturing → review|error` with a 10s timeout and a `requestId` correlation key so a stale/spoofed result is dropped, not misapplied.
- Bundle growth measured (git-stash bracket, pre- vs post-D1/D2 `dist/assets/index-*.js`): **+13.3KB raw / +5.0KB gzip** — well within the ≤80KB budget.
- Tests: capture round-trip, timeout path, spoofed-source rejection, stale-requestId rejection (`StudioModal.vitest.ts`, `appBridge.vitest.ts`, `ccBridgeRuntime.vitest.ts`).

### D2 — Annotate overlay — DONE
- `web/src/components/StudioAnnotate.tsx` (new): canvas overlay, pen/arrow/text tools, color picker, undo, composites onto the captured PNG via a single exported canvas (`exportPng()` on a forwarded ref).
- Pointer events (not mouse-only) — touch and mouse both draw identically (`StudioAnnotate.vitest.ts`).
- Geometry/compositing helpers (`toCanvasPoint`, `computeArrowHeadPoints`, `undoStrokes`, `drawStroke`) unit-tested independent of the mounted component.

### D3 — Captures endpoint + save flow — DONE
- `POST /api/media-apps/<name>/captures` (`server.js` route + new `lib/media-captures.js`): bearer-gated, `NAME_RE`-validated, ≤8MB decoded-PNG cap (413 both via `readJsonBody`'s raw-body ceiling and `isOversizeCapture`'s decoded-bytes ceiling), path-traversal-safe, atomic temp+rename write under `captures/<name>/<ts>.png`.
- `test/media-captures.test.js` (new, 11 tests): pure helpers + route-level 401/400/413/200, plus a same-`resolveMediaPath()` fetchability proof (not just a UI success state).
- Studio save flow renders a copyable `<embedded-image url="captures/...">` tag on success.

### Deviations / findings (all three tasks)
1. **P0 bug found + fixed post-code-complete, pre-commit**: the Studio's pre-existing studio-context hoisted live-app iframe (`AppFrameLayer.tsx`'s `STUDIO_HOIST_Z_INDEX = 310`, unconditional for any `context==='studio'` host, added for a legitimate, different reason — keeping the live app interactive above `.studio-overlay` z-index:300 during normal Studio use) sat on top of `.studio-capture-overlay` (z-index:1) and intercepted every pointer event meant for the D2 annotation canvas and the D3 Save/Cancel buttons. `.studio-capture-overlay`'s doc comment incorrectly assumed it inherited `.studio-panel`'s stacking context; `.studio-panel` has no explicit `z-index`, so no such context exists. **Root-caused via live-browser (Playwright) evidence-gathering only** — jsdom performs no real layout/stacking-context/hit-testing, so none of D1/D2/D3's unit/component tests could ever have caught it; the bug was invisible to a fully-green 815/815 jsdom suite. Fixed with the minimal, additive change: `StudioCapture` (`StudioModal.tsx`) toggles `document.body.classList.toggle('studio-capture-reviewing', ...)` while `stage.kind` is `review`/`saving`/`saved` (mirrors the existing `is-ipad`/`is-external-display` body-class idiom in `App.tsx`), paired with `body.studio-capture-reviewing .embed-app-hoist { z-index: 0 !important; pointer-events: none !important; }` in `styles.css` — scoped strictly behind the new body class, so `AppFrameLayer.tsx`'s unconditional normal-use behavior is untouched. Added a jsdom-level regression test (`StudioModal.vitest.ts`) asserting the class toggles on and clears on unmount; the CSS/hit-testing half of the fix is proven only by the live Playwright probe (not jsdom-assertable). Re-verified end-to-end post-fix: live probe now completes Screenshot → real annotation stroke → Save → embed-tag → independent bearer-authed fetch of the saved PNG, all in a real browser. Incremental bundle cost of the fix itself: +0.23KB raw / +0.04KB gzip (837.55→837.78 kB raw, 255.96→256.00 kB gzip) — folded into D1's total, still within budget.
2. `churn-spike` regression harness (`web/scratch/churn-spike/`, shared hoist-survival seam guard from the `cockpit-pinned-artifacts` feature) could not be re-run: its runner requires the Node `playwright` package, which is not installed anywhere in this worktree (only a Python `playwright` CLI is available on this machine). Installing it would violate the single-pre-approved-dependency constraint (`html-to-image` only). Not blocking: the new CSS rule is a compound selector requiring `body.studio-capture-reviewing`, which nothing in the churn-spike harness (or any non-Studio-capture-review code path) ever sets, so it cannot affect the harness's hoist-survival contract even in principle; the same `.embed-app-hoist`/hoisted-iframe mechanics were independently exercised live (Python Playwright) as part of this turn's own probe.
3. Complexity budget declared in the frontmatter (`{files: 7, loc-delta: 600}`) is exceeded: 15 files touched total across D1+D2+D3 (11 modified + 4 new) — `server.js`, `web/package.json`, `web/package-lock.json` (the `html-to-image` dependency add), `web/src/components/StudioModal.tsx`, `web/src/components/StudioModal.vitest.ts`, `web/src/lib/api.ts`, `web/src/lib/appBridge.ts`, `web/src/lib/appBridge.vitest.ts`, `web/src/lib/ccBridgeRuntime.tsx`, `web/src/lib/ccBridgeRuntime.vitest.ts`, `web/src/styles.css`, plus new `lib/media-captures.js`, `test/media-captures.test.js`, `web/src/components/StudioAnnotate.tsx`, `web/src/components/StudioAnnotate.vitest.ts`. The budget appears sized for a single task, not three (D1+D2+D3 bundled under one frontmatter budget); every touched file maps directly to an item in a task's own `**Files**` line — no incidental/scope-creep files. `bridge template (skill dir)` (`~/.claude/skills/prototype-component/scripts/cc-bridge-template.tsx`) also changed for D1 but lives outside this git repo, so it doesn't appear in `git status`.
4. Server suite drifted from the documented baseline of 940 pass/1 skip to **941 pass/0 skip** (same 941 total) — not caused by this session's changes (no server test files touched besides the new `test/media-captures.test.js`, already counted); flagged for visibility, not treated as a regression.

**Final verification**: `cd web && npx vitest run` → 816/816 (up from 815, +1 regression test for the z-index fix). `npm test` (root) → 941/941, 0 fail, 0 skip. `npx tsc -b` → clean. `npm run build` → clean (837.78 kB raw / 256.00 kB gzip, one pre-existing unrelated >500kB chunk-size warning). Live E2E probe (Python Playwright against an isolated, hermetic server instance — port 4417, throwaway token, hermetic media/data roots, the operator's real port-4317 server never touched) → full round-trip green: `FETCH_STATUS: 200 BYTES: 40585 PNG_SIG_OK: True`.

## Audit item coverage
| Task | Rubric |
|---|---|
| D1 | P2 |
| D3 | T2 |

## Task list

### D1 — Bridge capture
> **Goal**: cc-capture-request → html-to-image inside the sandbox (statically bundled in the bridge) → cc-capture-result{dataUrl}; studio Screenshot button shows progress, 10s timeout → error chip.
> **Files**: bridge template (skill dir), web/src/lib/appBridge.ts, StudioModal.tsx (screenshot btn), tests
> **Acceptance**: capture of the counter dogfood returns a decodable PNG dataURL at the device-mode dimensions; timeout path renders the chip; bundle growth ≤80KB.
> **Verification**: cd web && npx vitest run + live probe capture decoded
> **Depends on**: none (bridge from C)
> **Reversibility**: clean-revert

### D2 — Annotate overlay
> **Goal**: annotate mode over the captured image: pen, arrow, text, color picker, undo; composite export to a single PNG.
> **Files**: web/src/components/StudioAnnotate.tsx (new), StudioModal.tsx, styles.css, vitest for the pure geometry/composite helpers
> **Acceptance**: annotations rasterize onto the export at capture resolution; undo works; touch + mouse both draw (pointer events).
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: D1
> **Reversibility**: clean-revert

### D3 — Captures endpoint + save flow
> **Goal**: POST /api/media-apps/<name>/captures (bearer, NAME_RE, ≤8MB, atomic temp+rename) → media root captures/<name>/<ts>.png; studio save shows the embeddable <embedded-image> tag with copy.
> **Files**: lib/media-apps.js or lib/media-captures.js (new), server.js route, test/media-captures.test.js (new), StudioModal.tsx
> **Acceptance**: saved file appears under the media root + is served back via /api/media; oversize → 413; bad name → 400; unauthenticated → 401 (all tested); tag renders in a transcript (manual/live check).
> **Verification**: npm test && curl matrix + live save
> **Depends on**: D1
> **Reversibility**: clean-revert
> **E2E test**: live probe — screenshot → annotate → save → fetch saved PNG

## Review sign-off checklist
- [x] Endpoint abuse matrix tested (size/name/auth)
- [x] Saved capture embeddable in a transcript
- [ ] PR targets umbrella branch
