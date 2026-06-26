# Tests

Two suites, both run in CI (`.github/workflows/ci.yml`) on every PR and push to `main`:

| Suite | Run locally | Runner |
|-------|-------------|--------|
| Backend (`test/*.test.js`) | `npm test` (= `node --test`) | Node built-in test runner |
| Web (`web/src/**/*.vitest.ts`) | `cd web && npm test` (= `vitest run`) | Vitest |

The web build (`cd web && npm run build`) runs `tsc -b` first, so type errors fail CI too.

**Hermetic by design** — no `tmux`, `ttyd`, `ffmpeg`, or `whisper` on the runner. Anything that would shell out is injected/stubbed (a `_run`/`spawn` seam, or a captured fixture). Verify a single file with `node --test test/<file>.test.js`.

## Backend suites by area

- **Session detection / registry** — `sessions-*`, `pane-registry`, `match`, `scrape-gate`, `poller-guards`, `create-session*`.
- **Transcript** — `transcript`, `transcript-parser`, `push-pending` (cross-session AskUserQuestion flag), `subagents`.
- **TUI question detection + answering** — see invariants below: `prompt`, `prompt-parse`, `picker-parse`, `answer`, `reply-guard`, `reply-picker-guard`.
- **Codex** — `codex`, `codex-prompt`, `codex-rpc`, `sessions-codex-appserver`, `create-session-codex`.
- **tmux / terminal** — `tmux-capture`, `tmux-sendtext` (paste→poll-Pasting→Enter), `terminal` (ttyd dedup), `shell`, `shell-keys`.
- **Transport / protocol** — `ws-serialize`, `ws-heartbeat`, `server`, `server-hardening`, `auth`, `claude-print`, `claude-cli`.
- **Misc** — `config`, `json-file`, `pins`, `models`, `mlx`, `optimize*`, `transcribe`, `uploads`, `resources`, `skills`, `tui`, `fixes`.

## Question-detection invariants (load-bearing — guard against regression)

The cockpit surfaces an open TUI question by **scraping the pane**, because the
question is frequently in NO transcript it can read (a sub-agent's question, or
AskUserQuestion written only on answer). The detector (`lib/prompt.js`
`detectPanePicker`) and the answer planner (`lib/answer.js`) must hold these,
all covered by `test/prompt.test.js` + `test/picker-parse.test.js` with live captures in `test/fixtures-*.txt`:

1. **Footer-anchored, deterministic.** A picker is open IFF its footer
   (`Enter to select · ↑/↓ to navigate · Esc to cancel`, or a permission
   `Esc to cancel/reject/keep`) appears in the **bottom region** of the pane.
   The working footer (`esc to interrupt`) never counts.
2. **A bare `❯` is NOT a signal** — it's also the composer input prompt.
   Fixture `fixtures-fp-prose-input.txt` (numbered prose + input `❯`) → `null`.
3. **Real pickers still detect** — `fixtures-live-031.txt` (narrow, no-space-after-dot
   options, footer wrapped over 3 lines) → detected with reconstructed options.
4. **Width-robust option reconstruction** — narrow panes hard-wrap options
   mid-word; continuation lines rejoin into the option label.
5. **Title vs description split** — an option's description (indented past the
   title column) goes to `option.description`, NOT clobbered into the label.
   `fixtures-live-1979-descriptions.txt`: option 1 label = `Continue to Phase B`,
   description = `Refactor the cloud runner's buildSkillLaydown…`.
6. **Answering is width-independent** — single-select answers by option NUMBER
   (`promptkey`); multi-select matches the title. A free-text reply into an open
   picker is refused by the synchronous send-guard (`reply-picker-guard`) so a
   normal message can never accidentally answer a question.

## Adding a test

Drop a `test/<name>.test.js` (backend) or `web/src/**/<name>.vitest.ts` (web) —
both runners auto-discover by glob, so CI picks it up with no config change.
Prefer a committed `test/fixtures-*.txt` for any real-pane capture so the case is
reproducible and self-documenting.
