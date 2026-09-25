---
feature: artifacts-system
phase: c
tier: feature
autonomous: true
complexity-budget: { files: 5, loc-delta: 400 }
adopted-patterns: [embeds.ts TAG_RE, media-apps versions endpoint, transcript tailing]
---

# Phase C — Per-session artifact gallery (transcript-derived)

> **Scope**: show the artifacts a session has registered — derived from the session's transcript `<embedded-app>` tags (reuse `embeds.ts:36` TAG_RE), listed in a cockpit gallery, each openable per kind (inline / studio for prototype / viewer for presentation). No new persistence (S1). HOLD until Phase B + the studio PRs land.
> **Design**: docs/design/artifacts-system.md
> **Branch**: feat/artifacts-system-phase-c (standalone → PR to main)

## Status
| state | tasks |
|---|---|
| todo | (none) |
| done | C1, C2, C3 |

<!-- landed in PR #225 (branch feat/artifacts-bc-v2), rebased onto #224. Gallery mounts at App.tsx next to <ArtifactPanel/>; transcript-derived (S1). Hermetic E2E on :4417, live :4317 held 200. -->


<!-- CP0 log: emitted 2026-07-13. Feature. Standalone branch. DEPENDS on B (artifactKind gating) + the multi-root transcript discovery PR #215 (gallery parses transcripts regardless of config-dir root). -->

## Task list

### C1 — Derive a session's artifacts from its transcript
> **Goal**: a pure helper (+ endpoint or client derivation) that scans a session's transcript for `<embedded-app url=…>` tags (reuse `embeds.ts` TAG_RE + parseAppEmbedAttrs), resolving each to its media-app name + latest version + `artifactKind` (via the versions endpoint / manifest); bounded scan, no new full-file reads (P2).
> **Files**: web/src/lib/sessionArtifacts.ts (+ vitest), server.js (optional /api/sessions/<id>/artifacts) OR client-side from the tailed transcript
> **Acceptance**: given a transcript containing N embedded-app tags, returns N deduped artifacts with name/kind/version; zero tags → empty.
> **Verification**: cd web && npx vitest run sessionArtifacts
> **Depends on**: none
> **Reversibility**: clean-revert

### C2 — Gallery UI
> **Goal**: a cockpit panel/section that lists the current session's artifacts (name · artifactKind · latest version · optional thumbnail), each opening per kind — inline embed / studio (prototype) / light viewer (presentation). Shown only when the session has ≥1 artifact.
> **Files**: web/src/components/ArtifactGallery.tsx (+ vitest), web/src/styles.css
> **Acceptance**: a session with ≥1 embedded artifact shows the gallery; clicking an item opens it correctly per kind; a session with none shows nothing.
> **Verification**: cd web && npx vitest run ArtifactGallery && npm run build
> **Depends on**: C1
> **Reversibility**: clean-revert

### C3 — E2E gallery
> **Goal**: end-to-end: seed a session that embeds a markdown + a react artifact; the gallery lists both with correct kinds; opening each renders it.
> **Files**: web/scratch/artifact-gallery-e2e (playwright), screenshots to media root
> **Acceptance**: Playwright shows the gallery with 2 artifacts, correct kind labels, open-per-kind works.
> **Verification**: hermetic Playwright (CLAUDE_CONTROL_NO_REAP=1 + spare port), screenshots read back
> **Depends on**: C1, C2
> **Reversibility**: clean-revert

## Review sign-off checklist
- [x] Gallery works across config-dir roots — derives from `cockpit.messages` (the already-tailed transcript), root-agnostic by construction
- [x] No new persistence layer (transcript-derived) — S1 (gallery holds only transient useState; nothing written)
