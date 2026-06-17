---
title: claude-control — Architecture & Evolution
project: claude-control
version: 0.1.21
span: 2026-06-14 → 2026-06-17
---

# claude-control — Architecture & Evolution

A product-evolution narrative: how `@idl3/claude-control` grew from a
read-only transcript viewer into a full phone-friendly cockpit for driving
Claude Code tmux sessions — 124 commits across four days, v0.1.0 → v0.1.21.

## The premise

Claude Code runs in your terminal, inside tmux. You leave the desk and lose it.
claude-control is a tiny **local** web UI that discovers those sessions, streams
each transcript live, and lets you reply, answer `AskUserQuestion`, attach
files, and capture the pane — from a browser or phone over `127.0.0.1` or your
Tailscale tailnet. No daemon, no database: it reads Claude Code's transcript
files and talks to tmux.

## Architecture at a glance

The spine never changed, only thickened. A single Node process (`server.js`)
serves an HTTP+WebSocket API and a prebuilt React/Vite SPA. It reads Claude
Code's JSONL transcripts on disk and drives panes via `tmux send-keys`. State
lives in files, not a DB.

- **server.js** — HTTP + WS, route table, static SPA, token gate.
- **lib/** — the engine: `tmux` (pane I/O), `sessions` (pane↔transcript match),
  `transcript`/`tui` (parse live panes), `answer` (AskUserQuestion keystrokes),
  `push` (VAPID), `optimize`/`claude-cli` (no-key LLM), `transcribe` (STT).
- **web/** — React SPA on `@assistant-ui/react`: `Composer`, `Thread`,
  `MessageParts`, `SubAgentPanel`, `ArtifactPanel`, hooks (`useCockpit`).
- **Auth** — optional bearer token via header + WS subprotocol; never in the URL.

## v0.1.0 — Foundation

**Decision:** read-only first. Watch tmux, tail transcripts, render them. No
write path until the read path is trustworthy.

The first cut discovered Claude sessions in tmux, matched each to its JSONL
transcript by working directory, streamed updates over a WebSocket, and rendered
them in an assistant-ui thread. One process, localhost-only, no build step on
install.

## Iteration 1 — Reach & resilience

**Theme:** make it usable from the couch and survive restarts.

- **Phone push notifications** (Web Push + VAPID) so a session needing input
  pings your phone.
- **Durable launchd service** — auto-start on login, restart on crash.
- **Raw-terminal escape hatch** — a token-gated `ttyd` reverse proxy for when
  the structured view isn't enough.
- **Robustness pass** — frontend tests, syntax highlighting, a render cap to
  bound huge transcripts, and a security review.
- **Reply + answer** — Cmd/Ctrl+Enter to send; a working indicator after you
  answer an `AskUserQuestion`.

## Iteration 2 — Correct session identity

**The P0 fix.** Two Claude panes in the same directory were matching the *same*
transcript — a reply could echo under the wrong session. Directory-keyed
matching was the bug.

**Decision:** identity is the exact `session:window.pane`, not the directory.

- Pane-scoped session identity (enumerate panes, not windows).
- Layered 1:1 pane↔transcript matching (title → process-start-time → recency).
- **URL routing** — deep-linkable `/<session>/<window>/<pane>`.
- **Queued messages** — a FIFO of in-flight sends, each reconciled against its
  real echo instead of clearing on any activity.
- First cut of the **sub-agent panel** + an **image lightbox**.

## Iteration 3 — Reliability & trust

**Theme:** earn the write path's trust; never silently misfire.

- **Token login gate** — header/subprotocol auth, tokens never in the URL;
  optional tokenless mode for pure-localhost use.
- **Manual transcript pins** — an escape hatch for sessions the matcher can't
  resolve.
- **Live TUI prompt handling** — read prompts straight from the pane capture
  when the transcript lags.
- **Composer draft persistence** per session (survives switch + reload),
  double-send guard, and an in-app version + update-available hint.

## Iteration 4 — A real chat surface

**Theme:** stop looking like a log tail; start looking like Claude.ai.

- **Claude.ai-style composer card**, 800px reading column, hover copy action bar.
- **Per-session thinking signal** parsed from the TUI capture — a live thinking
  flash, rolling "last updated", and a shimmer while Claude works.
- **Chain-of-thought grouping** — reasoning + tool calls fold into one
  collapsible turn-level group (`GroupedParts`).
- **Skill invocations collapse** to a chip with an expand modal.
- **Rich-content artifact side panel** (tabbed; 50:50 desktop / bottom-sheet mobile).
- **Proper agent chip** (name + model) with agent-definition front-matter and
  nested sub-agents.
- **Customizable PWA icon**, defaulting to the Claude Control robot logo.

## Iteration 5 — Intelligence in the composer

**Decision:** add LLM smarts with **no API key** — reuse the `claude` CLI the
operator already has (`claude -p --model haiku`, lean flags ≈ free).

- **Capture-driven verified answerer** — for `AskUserQuestion`, arrow-walk to the
  option, space-select, then submit, verified against the live capture, with a
  static fallback.
- **Prompt enhancer** — ✨ rewrites your draft via the no-key Haiku backend;
  diff-review then Accept/Edit/Discard, never auto-send. State bound per session.
- **Skill browser + inline autocomplete** — `/<query>` dropdown populated from
  the session's *live* installed skills, with an active-skill chip.
- **Pull-to-refresh** on mobile to hard-reload new bundles.

## Iteration 6 — Voice input

**Theme:** speak your prompt — everywhere, including the iPad.

The first cut used the browser **Web Speech API**; it silently failed on
iOS/Safari. **Decision:** record in the browser, transcribe on the server.

- A recording dialog with a live waveform and Cancel / Pause / Stop (no stuck mic).
- **Local speech-to-text** — `MediaRecorder` → `POST /api/transcribe` →
  `ffmpeg` → `whisper.cpp` (`ggml-base.en`). Cross-browser, private, no API key.

## Setup

- **Install:** `npm install -g @idl3/claude-control` (ships prebuilt — no build).
- **Prereqs:** Node ≥20, `tmux` on PATH. Optional `ttyd` (raw terminal),
  `ffmpeg` + `whisper-cpp` (voice).
- **Run:** `claude-control` prints the URL. `install-service` adds launchd
  auto-start. Token via `CLAUDE_CONTROL_TOKEN` or `~/.claude-control/token`.
- **Reach it:** `127.0.0.1` locally, or your Tailscale tailnet (HTTPS for voice).

## Usage

- Open the URL, enter the token if prompted; pick a session from the rail.
- Watch the live transcript; reply with Cmd/Ctrl+Enter; answer `AskUserQuestion`
  prompts inline; attach screenshots; pop the raw terminal when needed.
- Speak via the mic; enhance a draft with ✨; invoke skills with `/`; watch
  sub-agents in the side panel; deep-link a pane by URL.

## Design decisions that held

- **No database** — files (transcripts + tmux) are the source of truth.
- **Localhost-first, token optional** — secrets never in the URL.
- **No API key** — LLM features reuse the operator's `claude` CLI; STT is local.
- **Identity = exact pane** — the fix that made every later feature reliable.
- **Disposable UI, durable engine** — the React layer changes weekly; `lib/` is stable.

## What's next

- npm publish cadence (currently v0.1.21).
- Server-side STT model options + accuracy tuning.
- Broader artifact rendering and richer sub-agent tracing.
