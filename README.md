# claude-control

A tiny, local web UI to **watch and drive your Claude Code and Codex CLI
sessions from a browser or phone**. It discovers the agent sessions you already
run inside **tmux**, streams each session's transcript live, lets you reply,
answer approval prompts (Claude `AskUserQuestion` + Codex TUI modals), attach
screenshots/files, and capture the pane — all over `127.0.0.1` (or your
Tailscale tailnet), guarded by a token.

No daemon to babysit, no database: it reads agent transcript files and talks to
tmux. Bind is localhost-only by default.

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

claude-control compares your checkout against its git upstream (`origin`) and
shows an **update banner** when new commits are available. Click **Update now**
— the server pulls, reinstalls, rebuilds the web bundle, and restarts itself in
place; the page reconnects automatically. (Equivalent manual update: `git pull
&& npm install && npm run build`, then restart.)

Version numbers follow npm semver (bump `package.json` per release); this is
**v0.1.0**.

---

## Configuration

All optional. Prefer `CLAUDE_CONTROL_*`; legacy `COCKPIT_*` names still work
(the server tries `CLAUDE_CONTROL_<X>` first, then `COCKPIT_<X>`).

| Env | Default | Purpose |
|---|---|---|
| `CLAUDE_CONTROL_PORT` | `4317` | HTTP/WS port |
| `CLAUDE_CONTROL_HOST` | `127.0.0.1` | Bind address |
| `CLAUDE_CONTROL_TOKEN` | _(none)_ | Require `?token=` on every request (recommended if exposed beyond localhost) |
| `CLAUDE_CONTROL_PROJECTS` | `~/.claude/projects` | Where Claude Code transcripts live |
| `CLAUDE_CONTROL_CODEX` | `codex` | Codex binary name or absolute path; used to spawn Codex sessions and to check binary availability for `/api/agents` |
| `CLAUDE_CONTROL_CODEX_SESSIONS` | `~/.codex/sessions` | Codex rollout sessions root; today's and yesterday's date dirs are scanned for transcript discovery |
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
  window to the newest transcript for its cwd. Claude Code sessions are matched
  by process title (version string) and transcript from `~/.claude/projects/`;
  Codex sessions are matched by process name and rollout JSONL from
  `~/.codex/sessions/<YYYY>/<MM>/<DD>/` (`lib/sessions.js`, `lib/agents/`).
- **Transcript** — tails each subscribed session's JSONL (bounded reads) and
  streams appends over WebSocket. Claude and Codex use different record schemas,
  parsed by their respective adapters (`lib/transcript.js`, `lib/agents/`).
- **Spawn** — the spawn picker lets you choose a tmux target (new window in an
  existing session, or a new named session), a working directory, and an agent
  type (`claude` or `codex`). The server validates the binary, realpaths the
  cwd, and launches the agent via `tmux new-window` or `tmux new-session`.
- **Approvals** — Claude `AskUserQuestion` prompts are detected in the JSONL
  transcript and surfaced as a modal; Codex approval modals ("Would you like to
  run the following command?", etc.) are detected via `capture-pane` (TUI-only,
  not written to the rollout JSONL). Both are surfaced through the same `pending`
  WebSocket frame and answered through the same `answer` message; the server
  routes each answer through the correct adapter's keystroke builder.
- **Input** — replies and keystrokes are sent with `tmux send-keys` to the
  exact pane (`lib/tmux.js`); attachments upload to the uploads dir and their
  path is appended to the message.

## Development

```bash
npm run dev             # server with --watch
cd web && npm run dev   # Vite dev server for the UI
npm test                # node:test unit tests
```

## License

MIT
