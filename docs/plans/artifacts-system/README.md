# artifacts-system — tracker index

Plan: `~/.claude/plans/artifacts-system.md` (pass 2, feature, autonomous, confidence 93)
Design: [`docs/design/artifacts-system.md`](../../design/artifacts-system.md)

> Repo flow: PR-first, local main disposable. Phase A lives OUTSIDE the repo (global skill `~/.claude/skills/create-artifact/` + the shared `prototype-component` producer) — no repo branch needed. Phases B/C are standalone repo branches → PR to `main` (NOT stacked). These tracker files are intentionally untracked in the main checkout.

| Phase | Tracker | Goal |
|---|---|---|
| A | [phase-a-tasks.md](./phase-a-tasks.md) | `/create-artifact` skill: markdown / html / react-dataviz lanes → publish → `<embedded-app>` (no cc-bridge) |
| B | [phase-b-tasks.md](./phase-b-tasks.md) | `artifactKind` manifest field + studio kind-gating + "component"→"artifact" rename |
| C | [phase-c-tasks.md](./phase-c-tasks.md) | Per-session artifact gallery (transcript-derived) |

Sequencing: A is isolated (build now). B/C touch the SPA/server — hold until the in-flight studio PRs land + deploy to avoid rename/UI conflicts.

## Out of scope
Persistent cross-session artifact registry/sharing · deep `/100x:present` integration (hook noted) · artifact GC beyond existing media sweep · bespoke studio "present mode" · in-place artifact editing.
