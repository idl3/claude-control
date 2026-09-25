---
feature: artifacts-system
phase: b
tier: feature
autonomous: true
complexity-budget: { files: 5, loc-delta: 350 }
adopted-patterns: [manifest schema v1, appVersion.ts fetchAppManifest, ArtifactContext kind model]
---

# Phase B — artifactKind manifest field + studio kind-gating + rename

> **Scope**: wire the `artifactKind` manifest field into the SPA (studio hides Props/Inspector for non-`prototype` kinds via the existing manifest null-degrade) and align user-facing "component(s)" copy to "artifact(s)". HOLD until the in-flight studio PRs (desktop-toolbar, editable-annotations) land + deploy — this phase edits StudioModal + SPA copy and would conflict.
> **Design**: docs/design/artifacts-system.md
> **Branch**: feat/artifacts-system-phase-b (standalone → PR to main)

## Status
| state | tasks |
|---|---|
| todo | (none) |
| done | B1, B2, B3 |

<!-- landed in PR #225 (branch feat/artifacts-bc-v2), rebased onto #224. 1128/1128 vitest, tsc clean, build ok. -->


<!-- CP0 log: emitted 2026-07-13. Feature. Standalone branch (not stacked). DEPENDS on Phase A (artifactKind produced) + the in-flight studio PRs landing first (StudioModal collision). -->

## Task list

### B1 — Read + validate artifactKind manifest field
> **Goal**: extend the client manifest fetch/validate (`appVersion.ts` fetchAppManifest / the manifest shape) to surface `artifactKind` (default `prototype` when absent, for back-compat with existing prototype apps).
> **Files**: web/src/lib/appVersion.ts, web/src/lib/appVersion.vitest.ts
> **Acceptance**: fetchAppManifest returns `artifactKind`; absent → defaults to `prototype`; malformed → null-degrades (unchanged).
> **Verification**: cd web && npx vitest run appVersion
> **Depends on**: none (Phase A produces the field, but the reader defaults gracefully)
> **Reversibility**: clean-revert

### B2 — Studio kind-gating
> **Goal**: StudioModal shows the Props (+ Inspector) tab ONLY when `artifactKind === 'prototype'`; presentation kinds keep the stage + device modes + zoom/pan + Screenshot, no Props tab.
> **Files**: web/src/components/StudioModal.tsx, web/src/components/StudioModal.vitest.ts
> **Acceptance**: opening a `markdown|html|react` artifact in the studio shows no Props tab; a `prototype` artifact is unchanged.
> **Verification**: cd web && npx vitest run StudioModal && npm run build
> **Depends on**: B1
> **Reversibility**: clean-revert

### B3 — Rename "component(s)" → "artifact(s)" (UI copy + CLAUDE.md)
> **Goal**: align user-facing "component" strings in the cockpit SPA (studio/embed labels, Open/fullscreen affordances) to "artifact", leveraging the existing ArtifactContext naming; reframe prototype-component's user-facing description as "the studio-prototype artifactKind" WITHOUT renaming the deployed skill.
> **Files**: web/src/components/**, ~/.claude/CLAUDE.md, ~/.claude/skills/prototype-component/SKILL.md
> **Acceptance**: no user-facing "component" copy remains where "artifact" is meant; `/prototype-component` still invokes unchanged; CLAUDE.md pointer says "artifacts".
> **Verification**: cd web && npx vitest run && npm run build; grep audit for stray "component" user-copy
> **Depends on**: none
> **Reversibility**: clean-revert

## Review sign-off checklist
- [x] Existing prototype apps (no artifactKind) still show Props (default → prototype) — back-compat (normalizeArtifactKind + `!manifest` keeps the panel for loading/null)
- [x] Held until studio PRs merged+deployed (no StudioModal conflict) — built on current main's restructured StudioModal
