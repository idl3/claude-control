# claude-control

A tiny, local web UI to **watch and drive your Claude Code sessions from a
browser or phone**. It discovers the Claude sessions you already run inside
**tmux**, streams each session's transcript live, lets you reply, answer
`AskUserQuestion` prompts, attach screenshots/files, and capture the pane — all
over `127.0.0.1` (or your Tailscale tailnet), guarded by a token.

No daemon to babysit, no database: it reads Claude Code's transcript files and
talks to tmux. Bind is localhost-only by default.

---

## Quick start

```bash
git clone https://github.com/idl3/claude-control.git
cd claude-control
npm install
npm run build        # builds the web UI (web/dist)
npm start            # prints a URL with a token
```

Open the printed URL (e.g. `http://127.0.0.1:4317/?token=…`). Any Claude Code
session running in tmux shows up in the left rail.

> **Already have tmux running with Claude sessions?** You're done — just run
> `npm start` and they appear automatically.

---

## The tmux setup (the one requirement)

claude-control manages sessions **through tmux**: it lists tmux windows, finds
the ones running Claude Code, and sends your replies as keystrokes to the right
pane. So your Claude sessions need to live in tmux.

### A) You already use tmux

Nothing to do. claude-control reads your **default tmux server** (the same one
`tmux ls` shows). Start it and your sessions appear. To point at a non-default
tmux binary, set `CLAUDE_CONTROL_TMUX=/path/to/tmux`.

### B) You don't use tmux yet

Install it and run Claude *inside* a tmux session so claude-control can see it:

```bash
# macOS: brew install tmux   ·   Debian/Ubuntu: sudo apt install tmux

tmux new -s work       # start (or attach) a tmux session
claude                 # run Claude Code inside it — now it's discoverable
```

That's it. Open more windows (`Ctrl-b c`) and run more Claude sessions; each
becomes a row in claude-control. (Tip: detach with `Ctrl-b d` — the sessions
keep running and stay visible in claude-control.)

A session is recognized when its pane is running Claude Code **or** has a
matching transcript under `~/.claude/projects/`.

---

## Updating

claude-control checks npm for a newer `claude-control` and shows an **update
banner** when one exists. Click **Update now** — the server pulls the latest
source, rebuilds, and restarts itself in place; the page reconnects
automatically. (Equivalent manual update: `git pull && npm install && npm run
build`, then restart.)

Versioning follows npm semver; this is **v0.1.0**.

---

## Configuration

All optional. Prefer `CLAUDE_CONTROL_*`; legacy `COCKPIT_*` names still work.

| Env | Default | Purpose |
|---|---|---|
| `CLAUDE_CONTROL_PORT` | `4317` | HTTP/WS port |
| `CLAUDE_CONTROL_HOST` | `127.0.0.1` | Bind address |
| `CLAUDE_CONTROL_TOKEN` | _(none)_ | Require `?token=` on every request (recommended if exposed beyond localhost) |
| `CLAUDE_CONTROL_PROJECTS` | `~/.claude/projects` | Where Claude Code transcripts live |
| `CLAUDE_CONTROL_UPLOADS` | `~/.claude-control/uploads` | Where attachments are stored (TTL-swept) |
| `CLAUDE_CONTROL_TMUX` | _(auto)_ | tmux binary override |
| `CLAUDE_CONTROL_MAX_UPLOAD_MB` | `25` | Per-file upload cap |

---

## Security

- Binds `127.0.0.1` by default; cross-origin WebSocket upgrades are rejected.
- Set `CLAUDE_CONTROL_TOKEN` before exposing it (e.g. via `tailscale serve`) —
  **this UI can type into your live sessions.**
- Uploads are written `0600` under the uploads dir and swept after a TTL.

---

## How it works

- **Discovery** — polls `tmux list-windows` every few seconds and matches each
  window to the newest transcript for its cwd (`lib/sessions.js`).
- **Transcript** — tails each subscribed session's `*.jsonl` (bounded reads)
  and streams appends over WebSocket (`lib/transcript.js`).
- **Input** — replies and answers are sent with `tmux send-keys` to the exact
  pane (`lib/tmux.js`); attachments upload to the uploads dir and their path is
  appended to the message for Claude to read.

## Development

```bash
npm run dev             # server with --watch
cd web && npm run dev   # Vite dev server for the UI
npm test                # node:test unit tests
```

## License

MIT
