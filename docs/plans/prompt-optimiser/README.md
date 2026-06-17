# Plan — Prompt optimiser ("pre-prompt" / composer enhance)

Source: `~/.claude/plans/prompt-optimiser.md` (pass 2, confidence 96, autonomous).
Delivery: commit-to-main + `launchctl` deploy (no PR ceremony; `umbrella-branch: SKIPPED`).

Composer "enhance" step: an ✨ icon right of Send → background prompt enhancement
→ suggestion modal (diff + rationale) → Accept replaces the composer text (never
auto-sends). Backend = host `claude -p --model haiku` (NO API key; uses host
Claude auth), with a deterministic rules fallback. Pure injected core
`optimizePrompt(input,{complete,intent})` so it ports to the Cloud Plan SPA.
Measured caveat: cold `claude -p` ~6s/$0.26 (full-harness) — Phase A tries lean
flags (tools/MCP off) to cut it.

## Phases
| Phase | Goal | Tracker |
|---|---|---|
| A | Pure core + claude -p backend + `/api/optimize` + tests (no UI) | [phase-a-tasks.md](./phase-a-tasks.md) |
| B | Composer enhance icon → suggestion modal → Accept-replaces | [phase-b-tasks.md](./phase-b-tasks.md) |

## Out of scope
Cloud Plan SPA integration; direct-API-key tier (deferred unless lean claude -p
fails); intent auto-detection; template library; streaming.
