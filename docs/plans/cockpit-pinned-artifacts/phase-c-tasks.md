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
| todo | C1, C2, C3, C4 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-08 -->

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
> **Acceptance**: with 3 pinned apps, switching tabs + re-opening artifacts (reducer move-to-front) produces ZERO iframe reloads (stateful-app evidence); mounted-app cap 6 with placeholder beyond; MULTI-PLACEHOLDER ARBITRATION (CP3-A MEDIUM follow-up): slots stay url-keyed single-instance — a deterministic priority rule picks the hosting placeholder (panel > transcript, else first visible) and non-hosting placeholders render a quiet 'active in panel' chip instead of a silent empty box.
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
