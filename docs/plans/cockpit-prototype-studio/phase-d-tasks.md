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
| todo | D1, D2, D3 |
| done | — |

<!-- CP0 log: emitted by /100x:commit-plan 2026-07-10; B6 elided: Dependencies (linear) -->

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
- [ ] Endpoint abuse matrix tested (size/name/auth)
- [ ] Saved capture embeddable in a transcript
- [ ] PR targets umbrella branch
