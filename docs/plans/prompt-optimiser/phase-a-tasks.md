---
feature: prompt-optimiser
phase: a
tier: feature
autonomous: true
complexity-budget:
  files: 5
  loc-delta: 450
adopted-patterns:
  - child_process spawn (self-update precedent) + absolute binary path
  - lib/config.js persistence
umbrella-branch: SKIPPED
---

# Phase A — Core + claude -p backend + endpoint (no UI)

> **Scope**: Pure optimiser core, claude -p backend (no key) w/ lean-flag measurement, rules fallback, token-gated `/api/optimize`, tests.
> **Design**: ~/.claude/plans/prompt-optimiser.md
> **Branch**: main (commit-to-main workflow)

## Status
| State | Tasks |
|---|---|
| todo | A1, A2, A3, A4, A5 |
| done | — |

<!-- CP0 log: emitted by 100x:commit-plan; tier feature; umbrella SKIPPED -->

## Task list

### A1 — Pure optimiser core
> **Goal**: `lib/optimize.js` exports `optimizePrompt(input,{complete,intent}) → {optimized,rationale[],changes[],mode}` — `complete` set → critique-then-rewrite LLM pass (model returns JSON; tolerant parse; on malformed → fall back to rules); else `rulesOptimize(input)` (deterministic structure + missing-element checklist). Draft passed as delimited DATA. `intent` plumbed, unused.
> **Files**: lib/optimize.js (new)
> **Acceptance**: `optimizePrompt` with a mock `complete` returns parsed fields (mode:'llm'); malformed completion falls back to rules; no `complete` → mode:'rules'.
> **Verification**: node --test test/optimize.test.js
> **Depends on**: none
> **Reversibility**: clean-revert

### A2 — claude -p backend (no key) + lean-flag measurement
> **Goal**: `lib/claude-cli.js` `complete(prompt,{model})` spawns the CLI with `--output-format json`, parses `.result`; non-zero/`is_error`/parse-fail throws (→ rules fallback). Resolve the ABSOLUTE binary at boot (`which claude` / config `claudeBin` / common paths incl `~/.local/bin/claude`) — no launchd alias/PATH. MEASURE latency+cost with vs without lean flags (`--strict-mcp-config` empty / disallow tools) and record findings in the task report.
> **Files**: lib/claude-cli.js (new)
> **Acceptance**: given a fixture JSON envelope `{type:'result',is_error:false,result:"X"}`, parse helper returns "X"; binary-resolver finds the abs path; a live lean-vs-default measurement is recorded.
> **Verification**: node --test test/claude-cli.test.js
> **Depends on**: none
> **Reversibility**: clean-revert
> **E2E test**: live `claude -p` lean-flags benchmark (record ms + cost; skip-and-note if claude unauth)

### A3 — Config: model + claude-bin (no key)
> **Goal**: `lib/config.js` adds `optimizeModel` (default `claude-haiku-4-5`) + optional `claudeBin`. NO API-key field.
> **Files**: lib/config.js
> **Acceptance**: readConfig returns the new fields with defaults; writeConfig persists them.
> **Verification**: node --test
> **Depends on**: none
> **Reversibility**: clean-revert

### A4 — POST /api/optimize (token-gated)
> **Goal**: server.js route → `{text,intent?}` → cap input (~8k chars; 400 on oversize) → `optimizePrompt(text,{complete: claudeCliComplete, intent})` → JSON `{optimized,rationale,changes,mode}`. Token-gated (`checkToken`). Never log the draft/result beyond a short prefix.
> **Files**: server.js
> **Acceptance**: `curl` with token returns optimized JSON; without token → 401; oversize → 400.
> **Verification**: cd /Users/ernie/Projects/claude-cockpit && node --check server.js
> **Depends on**: A1, A2, A3
> **Reversibility**: clean-revert

### A5 — Tests
> **Goal**: node --test coverage: rulesOptimize shape; optimizePrompt mock-complete (llm + malformed→fallback + no-complete→rules); claude-cli `.result` parse + binary resolver.
> **Files**: test/optimize.test.js (new), test/claude-cli.test.js (new)
> **Acceptance**: all new tests pass; full suite stays green.
> **Verification**: node --test
> **Depends on**: A1, A2
> **Reversibility**: clean-revert

## Dependencies between tasks
A1, A2, A3 parallel → A4 (needs all three) ; A5 covers A1/A2.
