---
feature: artifact-side-panel
phase: a
tier: feature
autonomous: true
complexity-budget:
  files: 6
  loc-delta: 450
adopted-patterns:
  - react-context (ThinkingContext precedent)
  - lib/highlight.ts (highlightCode / resolveLanguage)
umbrella-branch: SKIPPED
---

# Phase A — Desktop split MVP

> **Scope**: Artifact context + panel component + desktop 50:50 split + open-from-tool/code, single active artifact.
> **Design**: TBD (~/.claude/plans/artifact-side-panel.md)
> **Branch**: main (commit-to-main workflow)

## Status

| State | Tasks |
|---|---|
| todo | A1, A2, A3, A4 |
| done | — |

<!-- CP0 log: emitted by 100x:commit-plan; tier feature; umbrella SKIPPED (local commit-to-main tool) -->

## Task list

### A1 — Artifact panel context
> **Goal**: A React context owns `{ artifacts[], activeId }` + `open(artifact)` / `setActive(id)` / `close(id)`; exposed via `useArtifactPanel()`; provider wraps the detail pane in App.
> **Files**: web/src/components/ArtifactContext.tsx (new), web/src/App.tsx
> **Acceptance**: A child component can call `useArtifactPanel().open(...)` and the provider state updates; mirrors the existing `ThinkingContext` shape.
> **Verification**: cd web && npx tsc --noEmit -p tsconfig.json
> **Depends on**: none
> **Reversibility**: clean-revert

### A2 — ArtifactPanel component
> **Goal**: Panel renders the active artifact — header (title + close) + body highlighted via `lib/highlight.ts` (plain-text fallback while loading / over ~256 KB).
> **Files**: web/src/components/ArtifactPanel.tsx (new)
> **Acceptance**: Given an artifact `{title, language, content}`, renders highlighted content; close button calls `close()`.
> **Verification**: cd web && npx tsc --noEmit -p tsconfig.json
> **Depends on**: A1
> **Reversibility**: clean-revert

### A3 — Detail split layout
> **Goal**: Detail content area becomes `.detail-split` flex row — `thread-root` and `ArtifactPanel` each `flex:1` (50:50) when open, chat 100% when closed; `Esc` + close collapse; focus returns to chat region.
> **Files**: web/src/App.tsx, web/src/styles.css
> **Acceptance**: With an artifact open on ≥760px, chat and panel each take ~50%; closing restores full-width chat; no horizontal-overflow regression.
> **Verification**: cd web && npm run build
> **Depends on**: A1, A2
> **Reversibility**: clean-revert

### A4 — Open-from-tool/code wiring (snapshot model)
> **Goal**: `ToolPart` (tap name) and the code `CodeHeader` call `open()` with a snapshot artifact — tool→`toolCallId` id, code→content-hash id, language via `resolveLanguage` (fence / file extension).
> **Files**: web/src/components/MessageParts.tsx, web/src/components/MarkdownText.tsx
> **Acceptance**: Tapping a Read result name or a code-block opens it in the panel; reopening the same artifact does not duplicate (same id).
> **Verification**: cd web && npm run build
> **Depends on**: A1, A2, A3
> **Reversibility**: clean-revert

## Dependencies between tasks
A1 → A2 → A3 → A4 (linear).
