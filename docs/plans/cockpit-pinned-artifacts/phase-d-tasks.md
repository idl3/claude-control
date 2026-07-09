---
feature: cockpit-pinned-artifacts
phase: d
tier: feature
autonomous: true
complexity-budget: { files: 7, loc-delta: 400 }
adopted-patterns: [WS frame protocol broadcast(), TranscriptTailer fs.watch shape, mediaUrl.ts validation]
umbrella-branch: feat/cockpit-pinned-artifacts-integration
---

# Phase D — Live reload + versions

> **Scope**: rebuilds hot-reload tracking-latest tabs ≤2s; filesystem versioning + version picker; producer skill emits versions.
> **Design**: docs/design/cockpit-pinned-artifacts.md
> **Branch**: feat/cockpit-pinned-artifacts-phase-d

## Status
| state | tasks |
|---|---|
| todo | (none — phase D complete) |
| done | D1, D2, D3, D4, D5 |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08 CP3-D: verdict (a) — no gating findings; MEDIUM latest-pointer API validation + LOW O(changed) poll sweep landed post-audit (see next commit); server tests 926/926.
-->

<!-- CP0 log -->
### D1 — done (sha 4f10001)
- `lib/media-watch.js` (new, 180 lines): rename-tolerant `fs.watch` wrapper matching `TranscriptTailer`'s existing shape — debounces bursts of filesystem events into a single `{type:'media-app-changed', path, mtime}` frame, and re-arms the watcher on ENOENT/rename (atomic-write via `tmp`+`rename` briefly removes+recreates the watched path; a naive `fs.watch` handle would silently go dead at that point).
- `server.js` (+15 lines): wires the watcher's callback into the existing `broadcast()` WS fan-out.
- `test/media-watch.test.js` (new, 146 lines): proves debounce timing (one frame per burst, 300–800ms window) and rename-survival (watcher keeps emitting after the watched dir is removed and recreated) against real tmp-dir writes.
- Verification: `node --test test/media-watch.test.js && npm test` green at commit time.
- Deviations: none. Neither HALT condition triggered.

### D2 — done (sha 1ec0cd1)
- Landed the frame-consuming half in `AppFrameLayer.tsx` (+94/-… lines) rather than `EmbeddedApp.tsx`/`useCockpit.ts` alone as the tracker's file list predicted — `AppFrameLayer` was the existing seam that already owns the live iframe hoisting/mount lifecycle, so track-latest re-fetch-on-frame logic joined it there instead of duplicating mount-tracking state in a second file. `EmbeddedApp.tsx`/`useCockpit.ts`/`web/src/lib/types.ts` still each got the smaller plumbing changes the tracker anticipated (frame prop threading, `trackLatest` typing). `web/src/lib/mediaUrl.ts` gained +24 lines of shared URL-parsing helpers reused by D3/D4.
- mtime-compare guard prevents a redundant reload when a frame arrives for an app whose srcdoc is already current (covers both same-mtime replays and out-of-order frame delivery).
- Deviation (logged loud, self-caught): the new tests were added to the **existing** `AppFrameLayer.vitest.ts` (+160 lines) rather than a new file, since `AppFrameLayer.vitest.ts` already owned this component's test surface — creating a second test file for the same component would have split coverage for no benefit.
- Positive deviation (discovered in D4, logged here for the record): this task built `EmbeddedApp.tsx`'s `trackLatest` prop fully ahead of schedule, which is why D4 below needed zero further changes to that file.
- Verification: `cd web && npx vitest run && npx tsc -b --pretty false` green at commit time.

### D3 — done (sha 1447094)
- `lib/media-apps.js` (new, 90 lines): `isValidAppName` (`^[a-z0-9-]+$`), `isoStamp` (strips ms, replaces `:`→`-`, keeps trailing `Z`), `listVersions(root, name)` — scans `apps/<name>/`, ignores non-matching files/subdirs, returns `null` for an unknown/flat-only app or an invalid name (never throws on a traversal attempt), returns `{name, versions: [], latest: null}` for a real-but-empty app dir. Doc comment explicitly flags that D5 (outside this repo) must duplicate this exact algorithm — see D5 below.
- `server.js` (+36 lines): `GET /api/media-apps/<name>/versions` route, bearer-gated, uniform-response (no existence leak — unknown app name returns 200 + empty listing, not 404/403).
- `web/src/lib/appVersion.ts` (new, 58 lines): client-side mirror — `appNameFromUrl`, `flatAppUrl`, `versionedAppUrl`, `sortVersionsDesc`.
- Tests: `test/media-apps.test.js` (183 lines, server+lib) + `web/src/lib/appVersion.vitest.ts` (76 lines, client parse/sort) — traversal, invalid-name, unknown-app, and atomic-pointer-update cases all covered.
- Verification: `node --test && cd web && npx vitest run` green at commit time.
- Deviations: none. Neither HALT condition triggered.

### D4 — done (sha 6b49d02e75aacfd9b2821801db936e1756ab83f9)
- `ArtifactPanel.tsx` (+174 lines): version-picker `<select>` on each app tab, sourced from D3's listing endpoint; `loadAppTabVersion`/`saveAppTabVersion` persist per-tab pin-vs-track-latest mode to `localStorage`; `effectiveAppUrl` resolves the tab's actual iframe src (versioned url when pinned, flat/track-latest url otherwise).
- `web/src/styles.css` (+22 lines): `.app-version-picker` rules matching the existing tab-chrome aesthetic.
- Deviation (logged loud, confirmed via `git diff --stat` before committing): **zero** changes needed to `EmbeddedApp.tsx`, contrary to the tracker's predicted file list — D2 had already built the `trackLatest` prop this task needed. Net files touched: `ArtifactPanel.tsx`, `ArtifactPanel.vitest.ts`, `styles.css` (3, not the 3+`EmbeddedApp.tsx` implied by the tracker).
- Deviation: the picker deliberately does not eagerly probe the D3 listing endpoint on tab activation — gated on the `<select>`'s `onFocus` instead, to avoid breaking 3 pre-existing exact-fetch-count `authFetchMock` assertions in `ArtifactPanel.vitest.ts`.
- Self-caught bug (test-harness only, not production code): this Node/vitest/jsdom combination runs with Node's own experimental `localStorage` global (tied to an unconfigured `--localstorage-file`) shadowing jsdom's proper `Storage` implementation — the shadowing global is a non-functional empty-object stub missing `getItem`/`setItem`/`clear`. No prior test in this repo ever exercised bare `localStorage` (confirmed via grep), so nothing had caught this before. Fixed with a self-contained `FakeLocalStorage` class + `vi.stubGlobal`/`vi.unstubAllGlobals()` scoped entirely to `ArtifactPanel.vitest.ts` — zero changes to `vite.config.ts`, zero changes to `ArtifactPanel.tsx`'s own production code, which keeps using bare `localStorage` exactly matching `App.tsx`'s established `loadDrafts`/`saveDrafts` convention (correct/idiomatic in a real browser; the bug was purely a test-harness artifact of this Node version).
- Tests: `ArtifactPanel.vitest.ts` grew to 21 tests (10 pre-existing C2 + 4 pure `loadAppTabVersion`/`saveAppTabVersion` + 5 pure `effectiveAppUrl` + 2 mounted picker tests), all passing.
- Verification: `cd web && npx vitest run && npm run build` green at commit time.

### D5 — done (no commit — target files live outside any git repository)
- **Load-bearing deviation, logged loud**: `~/.claude/skills/prototype-component/scripts/run.mjs` and `SKILL.md` are a global, machine-local skill outside this repo. `git status` inside that directory returns `fatal: not a git repository (or any of the parent directories)` — there is no git history to commit these changes into. The umbrella plan's assumption of a per-task commit SHA does not apply to D5; this tracker entry (and the accompanying phase-end docs-sync commit in this repo) is the only durable record of the D5 change.
- **Tracker-vs-reality deviation, logged loud**: the tracker's acceptance criterion implies `run.mjs` currently writes "loose files" that need migrating. The actual pre-existing code had zero logic writing `apps/<name>.html`-style artifacts at all — it only ever produced `~/.claude-control/media/prototypes/<slug>-<stamp>/*.png`/`*.webm` capture output. Treated this as a genuinely new capability, not a migration of pre-existing logic, while staying inside the tracker's explicit 2-file scope.
- `run.mjs` additions: `isValidAppName`/`isoStamp` (byte-identical reimplementation of `lib/media-apps.js`'s algorithm — its own doc comment mandates this duplication since D5 can't `import` across the repo boundary), `atomicWrite`/`writeVersionedApp` (same `<path>.tmp`+`renameSync` pattern as `lib/collab.js`/`lib/json-file.js`), a standalone `--write-app <name> --html <file> [--label <label>]` CLI mode, and a `buildEmbeddableHtml(dir)` helper (vite's JS `build()` API, resolved from the target app's own devDependencies — same dynamic-resolution pattern the file already used for Playwright — with `cssCodeSplit:false` + a high `assetsInlineLimit`, then regex-inlines the single JS/CSS chunk; throws loudly instead of shipping a broken embed if vite code-splits the output) wired into `capture.json`'s new optional `embedApp` field. No new npm dependency added (HALT constraint respected) — reused vite, already a devDependency of any target micro-app.
- `SKILL.md`: new §5 documenting both entry points, plus a Gotchas note on the single-chunk-only inliner's ceiling and upgrade path (`vite-plugin-singlefile`, only if a genuinely code-splitting micro-app needs it).
- E2E proof, this session:
  - `--write-app` smoke-tested against a throwaway app name first (invalid-name rejection, missing-`--html` rejection, then a real write + a second labeled write proving `latest` moves) — all cleaned up after.
  - `embedApp` capture.json path smoke-tested against a minimal synthetic vite app in a gitignored `web/scratch/` fixture (also cleaned up after) — required one fix mid-session: `appRequire.resolve('vite')` resolves vite's CJS entry, so `import()` wraps it CJS-interop style and the real `build` function lives at `viteMod.default.build`, not `viteMod.build`. Fixed with the same `??` fallback pattern the file already used for the Playwright import.
  - **Real migration**: `~/.claude-control/media/apps/counter.html` (146294 bytes, pre-existing loose file) migrated via `--write-app counter --html ~/.claude-control/media/apps/counter.html --label migrated`, producing `apps/counter/2026-07-08T16-06-29Z-migrated.html` + `latest` pointer + refreshed flat compat alias.
  - **Real second version**: re-ran `web/scratch/counter-app/build.mjs` (unmodified — out of D5's scope) to rebuild `counter.html`, then fed the fresh output through `--write-app counter --html ... --label rebuild-proof`, producing a second version and moving `latest` — proving the acceptance criterion "a harness run produces a new version + updated pointer" against real content, not synthetic fixtures.
  - `ls -t ~/.claude-control/media/apps/counter/` → `latest`, `2026-07-08T16-06-30Z-rebuild-proof.html`, `2026-07-08T16-06-29Z-migrated.html` (tracker's own stated verification command).
  - Full-stack proof: booted this worktree's `server.js` on port 4321, curled `GET /api/media-apps/counter/versions` with the bearer token → both versions returned, newest-first, `latest:true` correctly marking `rebuild-proof`; unauthenticated request → 401. Server stopped after.
- Verification: `node --check run.mjs` clean throughout; no repo files touched (confirmed via `git status` showing zero changes from D5).

## Audit item coverage
| Task | Rubric |
|---|---|
| D1 | T3, P2 |
| D2 | T3 |
| D3 | S1, T4 |

## Task list

### D1 — Server media-apps watcher → WS frame
> **Goal**: fs.watch (rename-tolerant, TranscriptTailer shape) on media apps dir emits debounced `{type:'media-app-changed', path, mtime}` via broadcast().
> **Files**: server.js, lib/media-watch.js (new), test/media-watch.test.js (new)
> **Acceptance**: touch/rename-atomic-write under apps/ → exactly one frame within 300–800ms (node --test proves debounce + rename tolerance); watcher survives dir recreation.
> **Verification**: node --test test/media-watch.test.js && npm test
> **Depends on**: none
> **Reversibility**: clean-revert
> **E2E test**: test/media-watch.test.js (real tmp-dir writes)

### D2 — Client: tracking-latest tabs re-fetch on frame
> **Goal**: pinned tabs in track-latest mode re-fetch srcdoc when a frame for their app arrives; mtime compare prevents redundant/racing reloads.
> **Files**: web/src/components/EmbeddedApp.tsx, web/src/hooks/useCockpit.ts (frame plumb), web/src/lib/appVersion.vitest.ts
> **Acceptance**: rebuild on disk → tab reflects new build ≤2s (success signal 2, harness-proven); pinned-to-version tabs do NOT reload.
> **Verification**: cd web && npx vitest run && npx tsc -b --pretty false
> **Depends on**: D1
> **Reversibility**: clean-revert

### D3 — Version convention + listing endpoint
> **Goal**: `apps/<name>/<ISO-stamp>[-label].html` + `latest` pointer file; `/api/media-apps/<name>/versions` lists from the filesystem; all paths through mediaUrl-equivalent validation.
> **Files**: lib/media.js or lib/media-apps.js (new), server.js (route), web/src/lib/appVersion.ts (new, parse/sort), tests both sides
> **Acceptance**: listing returns sorted versions + latest; traversal/scheme attacks rejected (tests); pointer update is atomic (temp+rename).
> **Verification**: node --test && cd web && npx vitest run
> **Depends on**: none
> **Reversibility**: clean-revert

### D4 — Version picker UI: pin-version vs track-latest per tab
> **Goal**: app tab header exposes version dropdown (from D3 endpoint); switching versions re-fetches; mode persists per tab (localStorage).
> **Files**: web/src/components/ArtifactPanel.tsx, web/src/components/EmbeddedApp.tsx, web/src/styles.css
> **Acceptance**: pin v1 → rebuild latest → v1 tab untouched, latest tab reloads; picker matches cockpit aesthetic.
> **Verification**: cd web && npx vitest run && npm run build
> **Depends on**: D2, D3
> **Reversibility**: clean-revert

### D5 — Producer side: prototype-component skill writes versions
> **Goal**: the skill flow (scripts/run.mjs + SKILL.md) writes `apps/<name>/<stamp>.html` + updates `latest` instead of loose files.
> **Files**: ~/.claude/skills/prototype-component/scripts/run.mjs, ~/.claude/skills/prototype-component/SKILL.md
> **Acceptance**: a harness run produces a new version + updated pointer; existing loose apps/counter.html migrated to the convention.
> **Verification**: harness run + ls -t ~/.claude-control/media/apps/counter/
> **Depends on**: D3
> **Reversibility**: clean-revert
> **E2E test**: harness run producing a version visible in the D4 picker

## Dependencies between tasks
D1 → D2; D3 → D4 (needs D2 too); D3 → D5. D1 and D3 can run in parallel.

## Review sign-off checklist
- [x] Success signal 2 (≤2s hot reload) harness-proven (D2, `AppFrameLayer.vitest.ts` mtime-compare tests)
- [x] Debounce + atomic-write races covered by tests (D1 `test/media-watch.test.js`; D3 `test/media-apps.test.js`; D5's producer-side atomic write proven live via the counter migration, see D5 log above)
- [ ] PR targets umbrella branch (not yet opened — see phase-end VERIFY note below)

## Phase-end VERIFY (this session)
- `npm test` (repo root): **925/925** pass.
- `cd web && npx vitest run`: **628/628** pass across 43 files.
- `cd web && npx tsc -b --pretty false`: clean.
- `cd web && npm run build`: green (pre-existing >500kB `index` chunk-size warning, unrelated to this phase, not touched).
- Churn-spike seam guard (`web/scratch/churn-spike/`, the Phase A hoist-survival regression harness Phase C had to repair): re-run clean after all of D1–D5 — `stable iframe loads: 1`, `unstable iframe loads: 1`, `live hoist count: 2`, matching the FIX-2 contract exactly (screenshots read back and visually confirmed, not embedded unverified).
- D5's producer-side changes touch zero files in this repository (confirmed via `git status` in this worktree showing no changes attributable to D5) — outside the scope of any of the above checks by construction.

<!-- Codex review: 3H/3M/2L fixed in 6c04dc2, 6c8dcd7 -->
