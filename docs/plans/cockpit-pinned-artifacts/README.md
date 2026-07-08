# cockpit-pinned-artifacts — tracker index

Plan: `~/.claude/plans/cockpit-pinned-artifacts.md` (pass 2, tier feature, autonomous: true, confidence 97)
Design: [`docs/design/cockpit-pinned-artifacts.md`](../../design/cockpit-pinned-artifacts.md)
Umbrella branch: `feat/cockpit-pinned-artifacts-integration` (phase PRs target it; umbrella PR is the single review surface into main)

> ⚠️ Repo flow: PR-first. Local main is disposable (deploy hard-resets to origin/main). All work happens in phase worktrees off the umbrella branch. These tracker files are intentionally untracked in the main checkout (they survive `git reset --hard`); the committed copies ride the umbrella branch.

| Phase | Tracker | Goal |
|---|---|---|
| A | [phase-a-tasks.md](./phase-a-tasks.md) | Transcript re-renders stop remounting embedded iframes (state survives churn) |
| B | [phase-b-tasks.md](./phase-b-tasks.md) | Reload affordance + optional crash beacon, both views |
| C | [phase-c-tasks.md](./phase-c-tasks.md) | Panel `'app'` kind: pinning, always-mounted bodies, LRU exemption |
| D | [phase-d-tasks.md](./phase-d-tasks.md) | Live reload on rebuild + filesystem versioning + producer updates |

## Out of scope
Popout/detach windows + signed media URLs · remote app sources · versioning UI for code/skill kinds · multi-client pin sync · general windowing system.
