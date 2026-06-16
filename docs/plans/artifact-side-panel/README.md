# Plan — Rich-content artifact side panel

Source plan: `~/.claude/plans/artifact-side-panel.md` (pass 2, confidence 95, autonomous).
Design: TBD. Delivery: commit-to-main + `launchctl` deploy (no PR ceremony for this local tool; `umbrella-branch: SKIPPED`).

Open any tool result or fenced code block into a tabbed panel beside the chat
(50:50 split ≥760px; draggable bottom sheet <760px) without disturbing the
transcript. Locked UI: tap header NAME → panel, caret → inline peek; tab strip
of recents; any tool result + code blocks; mobile bottom sheet. Seam = artifacts
**snapshot content at open** (tool→toolCallId, code→content-hash).

## Phases

| Phase | Goal | Tracker |
|---|---|---|
| A | Desktop split MVP: context + panel + 50:50 layout + open-from-tool/code | [phase-a-tasks.md](./phase-a-tasks.md) |
| B | Tabs (LRU 8) + mobile bottom sheet + tap/caret trigger split + a11y | [phase-b-tasks.md](./phase-b-tasks.md) |

## Out of scope
Resizable split divider (fixed 50:50); virtualized huge outputs (cap render);
deep-linkable artifacts; diff-aware Edit/Write rendering.
