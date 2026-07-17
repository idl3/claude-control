# claude-control

A tiny, local web UI to **watch and drive your Claude Code sessions from a
browser or phone**. It discovers the Claude sessions you already run inside
**tmux**, streams each session's transcript live, lets you reply, answer
`AskUserQuestion` prompts, attach screenshots/files, and capture the pane — all
over `127.0.0.1` (or your Tailscale tailnet), behind an optional token you enter
in-app (never in the URL).

No daemon to babysit, no database: it reads Claude Code's transcript files and
talks to tmux. Bind is localhost-only by default.

---

## Install (npm)

**Clean machine?** One command installs the prerequisites (Node + tmux), the
published package, a generated auth token, and a launchd service on port 4317:

```bash
# from a checkout of this repo:
./scripts/install.sh
# …or pipe it straight from GitHub:
curl -fsSL https://raw.githubusercontent.com/idl3/claude-control/main/scripts/install.sh | bash
```

The installer is idempotent (re-run it to update). It prefers an existing
Homebrew for Node, falls back to **nvm** (no `sudo`, works headless over SSH) on
a bare machine, generates `~/.claude-control/token`, and prints the token + URL
at the end. Flags: `--no-service`, `--foreground` (nohup instead of launchd),
`--tokenless`. Pin a version with
`CC_PACKAGE_SPEC=@idl3/claude-control@1.12.1 ./scripts/install.sh`.

Prefer to install by hand? The manual steps:

```bash
npm install -g @idl3/claude-control     # or run once: npx @idl3/claude-control
```

> **`claude-control: command not found`?** Use `-g` — a plain/local `npm install`
> only drops the binary in `./node_modules/.bin/` (not on `PATH`). If it's still
> missing after `-g`, your npm global bin dir isn't on `PATH`: run `npm prefix -g`
> and add `<that>/bin` to your shell `PATH`, or just use `npx @idl3/claude-control`.

**Prerequisites:** Node ≥20 and **tmux** on your `PATH` (`brew install tmux` · `sudo apt install tmux`). Optional: **ttyd** for the in-browser raw terminal (`brew install ttyd` · `sudo apt install ttyd`) — set `CLAUDE_CONTROL_TTYD` to override its path. The web UI ships prebuilt — no build step on install.

**Optional local AI (no API key):**

- **Voice → text** — run `claude-control setup` once: it installs `ffmpeg` + `whisper.cpp` (Homebrew) and downloads a ggml model to `~/.claude-control/models/`. The mic in the composer then records audio and transcribes it locally (no API key). *(Manual equivalent: `brew install ffmpeg whisper-cpp` and drop a model at `~/.claude-control/models/ggml-base.en.bin`.)*

  > **Microphone on a phone or tablet**: browsers only allow mic access on a [secure context](https://developer.mozilla.org/en-US/docs/Web/Security/Secure_Contexts) (HTTPS or `localhost`). A plain `http://192.168.x.x:4317` URL leaves `navigator.mediaDevices` undefined on iOS/Android — the permission won't stick and re-prompts every reload. `localhost` on the Mac itself is exempt. Easiest fix: `tailscale serve --bg 4317` then open the `https://<host>.ts.net` URL. Or run with your own cert: `TLS_CERT=cert.pem TLS_KEY=key.pem claude-control`.
- **Prompt enhancer (✨)** — defaults to a **local MLX model** on Apple Silicon. One-time setup:
  ```bash
  python3 -m venv ~/.claude-control/mlx-venv
  ~/.claude-control/mlx-venv/bin/pip install mlx-lm
  ```
  claude-control lazily starts `mlx_lm.server` on first use, keeps it warm, and shuts it down when idle. The model (default `mlx-community/Llama-3.2-3B-Instruct-4bit`, ~1.8 GB) auto-downloads on first run. Pick the backend + model in **Settings** (`mlx` → deterministic rules fallback). Without the venv (or on non-Apple hardware) the enhancer uses the rules optimiser. Env overrides: `CLAUDE_CONTROL_MLX_PYTHON`, `CLAUDE_CONTROL_MLX_PORT`; set `CLAUDE_CONTROL_MLX_PREWARM=1` to trade the default lean startup for a warm model immediately after launch.

```bash
claude-control                    # start the server (prints the URL)
claude-control --help             # config + subcommands
claude-control install-service    # macOS: launchd auto-start on login + restart on crash
claude-control uninstall-service
```

Open the printed URL. If a token is configured (env `CLAUDE_CONTROL_TOKEN`, or a
token in `~/.claude-control/token`), the app **prompts for it on first load** and
stores it in your browser — the token is never placed in the URL. With no token
set, it runs open on `127.0.0.1` / your tailnet.

---

## Quick start (from source)

```bash
git clone https://github.com/idl3/claude-control.git
cd claude-control
npm install
npm run build        # builds the web UI (web/dist)
npm start            # prints the URL
```

Open the printed URL (e.g. `http://127.0.0.1:4317/`). If a token is configured,
the app prompts for it on first load and remembers it in your browser — it's
never put in the URL. Any Claude Code session running in tmux shows up in the
left rail.

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

## macOS Full Disk Access

If panes show **`Operation not permitted`** when reading `~/Documents`,
`~/Desktop`, or `~/Downloads` — even though the same commands work in your normal
terminal — it's macOS privacy protection (**TCC**), not a bug. claude-control runs
as a **launchd** service, and the tmux server it starts inherits that context,
which has **no Full Disk Access**. Your terminal app (iTerm/Terminal) already has
the grant, which is why it works there.

**Fix — grant Full Disk Access to the `node` that runs the service:**

1. Find the node path the service uses:
   ```bash
   grep -A2 ProgramArguments ~/Library/LaunchAgents/com.*claude-control*.plist
   ```
   (e.g. `~/.nvm/versions/node/vXX/bin/node`, or `which node` → `/opt/homebrew/bin/node`)
2. **System Settings → Privacy & Security → Full Disk Access → `+`**. In the file
   picker press **⌘⇧G**, paste that node path (the `~/.nvm` dir is hidden, so the
   typed path is the only way in), add it, and **toggle it on**.
3. Restart the service so node relaunches with the grant:
   ```bash
   launchctl kickstart -k gui/$(id -u)/com.<your-service-name>
   ```
4. Kill the stale (permission-less) tmux server so new panes start under the
   granted node — this ends the claude-control tmux sessions; the service recreates
   them:
   ```bash
   tmux kill-server
   ```

Verify in a fresh pane: `ls ~/Documents` should work (no `Operation not permitted`).
Grant it to **your own** node path, not someone else's.

---

## Updating & restarting

How you update depends on **how you installed** — pick your row. Check your
current version any time with `claude-control --version`.

> **`npm install` does NOT pull the git repo.** The npm package ships the app
> *prebuilt* (the `web/dist` bundle is included), so there's no source tree to
> `git pull` and nothing to build. Update by reinstalling the package.

### Installed globally (`npm install -g`)

```bash
npm install -g @idl3/claude-control@latest   # fetch the new version
# then restart the server (see "Restarting" below)
```

The in-app **update banner / “Update now”** button is for **source checkouts
only** (it runs `git pull`); on an npm install it has no repo to update, so use
the command above instead.

### Run via `npx` (no install)

```bash
npx @idl3/claude-control@latest               # always fetches the latest
```

`npx` re-resolves the package each run, so you're already on the newest version
every time you start it — just restart the process.

### From source (git checkout)

```bash
git pull && npm install && npm run build       # then restart
```

…or click **Update now** in the app: the server pulls from `origin`, reinstalls,
rebuilds `web/dist`, and restarts itself in place; the page reconnects
automatically.

### Restarting the server

- **Foreground** (you ran `claude-control` / `npm start` in a terminal): press
  `Ctrl-C`, then run it again. The web UI reconnects on its own.
- **launchd service** (you ran `claude-control install-service`):
  ```bash
  launchctl kickstart -k gui/$(id -u)/com.ernest.claude-control
  ```
  or `claude-control uninstall-service && claude-control install-service`.

Restarting is safe — sessions live in tmux, so nothing is lost; each browser
re-prompts for the token once (if one is set).

Version numbers follow npm semver (`claude-control --version`).

---

## Configuration

All optional. Prefer `CLAUDE_CONTROL_*`; legacy `COCKPIT_*` names still work.

| Env | Default | Purpose |
|---|---|---|
| `CLAUDE_CONTROL_PORT` | `4317` | HTTP/WS port |
| `CLAUDE_CONTROL_HOST` | `127.0.0.1` | Bind address |
| `CLAUDE_CONTROL_TOKEN` | _(none)_ | Access token. Also read from `~/.claude-control/token`. Sent as `Authorization: Bearer` (HTTP) / WS subprotocol — never in the URL. Unset **and** no file ⇒ tokenless. |
| `CLAUDE_CONTROL_PROJECTS` | `~/.claude/projects` | Where Claude Code transcripts live |
| `CLAUDE_CONTROL_UPLOADS` | `~/.claude-control/uploads` | Where attachments are stored (TTL-swept) |
| `CLAUDE_CONTROL_TMUX` | _(auto)_ | tmux binary override |
| `CLAUDE_CONTROL_MAX_UPLOAD_MB` | `25` | Per-file upload cap |

---

## Security

- Binds `127.0.0.1` by default; cross-origin WebSocket upgrades are rejected.
- **Token auth** — strongly recommended before exposing it (e.g. via
  `tailscale serve`): *this UI can type into your live sessions.* The token is
  resolved in order from `CLAUDE_CONTROL_TOKEN`, else the file
  `~/.claude-control/token` (mode `0600`). With neither set it runs **tokenless**
  (open to anything that can reach the port — the `127.0.0.1` bind, tailnet ACL,
  and cross-origin check are the only guards).
  - The web app **prompts for the token on first load** and stores it in
    `localStorage`. It's sent as an `Authorization: Bearer` header (and a WS
    subprotocol) — **never placed in the URL** (URLs leak via history, server
    logs, and referrer headers). A `401` returns you to the prompt.
  - **Set or rotate**: write the token to `~/.claude-control/token`, then
    restart — `launchctl kickstart -k gui/$(id -u)/com.ernest.claude-control`
    (launchd service), or just re-run `npm start` / `claude-control`. Each
    browser re-prompts once. `bin/install-service.sh` reads the same file.
- Uploads are written `0600` under the uploads dir and swept after a TTL.

---

## Inline media in transcripts (for control-session agents)

Agent responses can embed screenshots and screen recordings directly in the
chat transcript with self-closing blocks:

```
<embedded-image url="shot.png" size="lg" />
<embedded-video url="runs/demo.webm" size="full" />
```

- `url` — either a path **relative to the media root**
  (`~/.claude-control/media/`, override with `CLAUDE_CONTROL_MEDIA`), served
  by the token-gated `/api/media/` route, or a full `http(s)` URL passed
  through as-is. `file://` and every other scheme are rejected.
- `size` — `sm` (240px) · `md` (420px, default) · `lg` (640px) · `full`
  (bubble width). Missing/unknown sizes fall back to `md`.

**Convention for control-session agents:** for SPA/UI changes (or any visual
result), always capture screenshots and a short video into the media root and
emit the embed blocks in your response, so the operator sees the change inline
in the transcript without navigating to files.

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
