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
| todo | D1, D2, D3, D4, D5 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08 -->

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
- [ ] Success signal 2 (≤2s hot reload) harness-proven
- [ ] Debounce + atomic-write races covered by tests
- [ ] PR targets umbrella branch
