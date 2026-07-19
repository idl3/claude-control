# pleri.ask — implementation trackers (M1)

Harness-agnostic interactive question protocol shared by claude-control + the Olam SPA, replacing native AskUserQuestion's keystroke-puppeteering with a structured answer channel.

- **Plan:** `~/.claude/plans/ask-protocol.md` (pass 2, confidence 96, epic)
- **Design:** [docs/design/ask-protocol.md](../../design/ask-protocol.md) (@ `origin/docs/ask-protocol`)
- **Tier:** epic · **This tracker = M1 only** (claude-control turn-end); M2 (MCP mid-turn) / M3 (SPA) / M4 (full migration) + Phase G (wireframe DSL fast-follow) are separate later commit-plan passes, per the per-milestone split (OQ19).
- **Branch:** `feat/ask-protocol-m1` · **Reversibility:** clean-revert (additive + feature-flagged; native path stays).

## M1 phases (Phases A–C of the plan)

| Phase | Tracker | Delivers |
|---|---|---|
| A | [phase-a-tasks.md](./phase-a-tasks.md) | `pleri-ask` core lib (DSL + enum schema + parse/serialize + native-adapter + efficiency bench) **+ the early 3-transport round-trip gate** |
| B | [phase-b-tasks.md](./phase-b-tasks.md) | Shared renderer (AskInline → DSL): multi-question + markdown/code previews (scheme-filtered), all states |
| C | [phase-c-tasks.md](./phase-c-tasks.md) | Content-block envelope + strict provenance + answer channel (send-guard + qid dedupe) — deletes puppeteering for pleri:ask |

**Sequencing:** A first (its round-trip gate must pass before B/C). B + C then land the visible protocol. Native AskUserQuestion stays fully functional throughout (dual-support).

## Out of scope (M1)
MCP mid-turn envelope (M2) · Olam SPA (M3) · full `/100x` migration (M4) · wireframe preview DSL (Phase G fast-follow) · mermaid (optional, only if pinned-secure + available) · hook-initiated asks (keep native side-channel).

## Verify against
Efficiency budget (≥30% smaller ask than native; ≤~40B answer) · the 3-transport round-trip gate (tmux/print/codex-rpc) · strict-provenance detection (no picker from prose/fenced/quoted `<pleri:ask>`).
