# cockpit-prototype-studio — tracker index

Plan: `~/.claude/plans/cockpit-prototype-studio.md` (pass 2, feature, autonomous, confidence 99)
Design: [`docs/design/cockpit-prototype-studio.md`](../../design/cockpit-prototype-studio.md)
Umbrella: `feat/cockpit-prototype-studio-integration` (phase PRs merge-commit into it; umbrella squashes to main)

> PR-first repo: local main is disposable. Phase worktrees branch off the umbrella tip.
> SEQUENCING: Phase B touches AppFrameLayer and MUST wait for the in-flight scroll-sync PR (feat/app-hoist-scroll-sync) to merge.

| Phase | Tracker | Goal |
|---|---|---|
| A | [phase-a-tasks.md](./phase-a-tasks.md) | Open rename, styles dedupe, hotkey suppression, StudioModal shell |
| B | [phase-b-tasks.md](./phase-b-tasks.md) | Studio hosting tier + device modes (post-scroll-PR) |
| C | [phase-c-tasks.md](./phase-c-tasks.md) | Manifest + cc-bridge + props editor (the seam) |
| D | [phase-d-tasks.md](./phase-d-tasks.md) | Screenshot, annotate, captures endpoint |
| E | [phase-e-tasks.md](./phase-e-tasks.md) | Inspector, console stub, E2E + contract docs |

## Out of scope
Prop presets/two-way manifest editing · multi-root/non-React artifacts · live console (slot only) · server-side capture · popouts.
