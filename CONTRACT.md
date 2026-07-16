# claude-cockpit — module contract (authoritative)

All files are **ESM** (`"type":"module"`). Node ≥20. Only runtime dependency: `ws`.
Everything else uses Node built-ins. Bind to **127.0.0.1 only**. Never pass user
strings through a shell — always `execFile`/`spawn` with an args array.

Environment knobs (read in `server.js`, with defaults):
- `COCKPIT_PORT` (default `4317`)
- `COCKPIT_HOST` (default `127.0.0.1` — do not default to 0.0.0.0)
- `COCKPIT_PROJECTS` (default `~/.claude/projects`)
- `COCKPIT_TMUX` (default: auto-resolved tmux binary)
- `COCKPIT_RSS_LIMIT_MB` (default `350`) — self-RSS soft cap
- `COCKPIT_TOKEN` (optional) — if set, `/api/*` requires `Authorization: Bearer <token>` and the WS upgrade must offer the token as a `Sec-WebSocket-Protocol` subprotocol (alongside the `claude-control` label). The token is never accepted in a `?token=` URL query — URLs leak via history/logs/referrer. (`CLAUDE_CONTROL_TOKEN` is the current name; `COCKPIT_TOKEN` remains a legacy alias.)

## Resource doctrine (the whole point — "don't go overboard")
- **Never read a transcript fully.** Files reach 200 MB+. Initial load reads only a
  bounded **tail** (≤1 MB) to recover the last `maxBuffer` records, then watches and
  reads **only new bytes** from a tracked offset.
- Per-session in-memory message buffer is capped (`maxBuffer`, default 500); drop oldest.
- Only **subscribed** sessions are tailed. Unsubscribe closes the watcher.
- `capture-pane` only on demand (never in a tight loop).
- Debounce filesystem events (≥150 ms).
- ResourceMonitor samples on an interval (default 3 s), broadcasts, and emits
  `overlimit` when self RSS exceeds the cap so the server can trim buffers.

---

## lib/tmux.js
```js
export async function resolveTmuxBin(): Promise<string>   // honor COCKPIT_TMUX, else probe
                                                          // /opt/homebrew/bin/tmux, /usr/local/bin/tmux,
                                                          // /usr/bin/tmux, then `command -v tmux`
export function isValidTarget(target: string): boolean    // ^[A-Za-z0-9_.-]+:\d+(\.\d+)?$
export async function listWindows(): Promise<Window[]>
export async function sendText(target: string, text: string): Promise<void>
        // send-keys -t <target> -l <text>   (literal, no key interpretation)
        // then a SECOND call: send-keys -t <target> Enter
export async function sendRawKeys(target: string, keys: string[]): Promise<void>
        // send-keys -t <target> <key1> <key2> ...   (key NAMES like Down/Space/Enter, NO -l)
export async function capturePane(target: string, lines = 40): Promise<string>
        // capture-pane -t <target> -p -e -S -<lines>   (-e keeps ANSI; server may strip)
```
`Window = { sessionName, windowIndex:number, windowName, target /* "sess:idx" */,
            active:boolean, panePid:number, cwd:string, cmd:string }`
- Use `tmux list-windows -a -F '<fmt>'` with `#{session_name}`, `#{window_index}`,
  `#{window_name}`, `#{window_active}`, `#{pane_pid}`, `#{pane_current_path}`,
  `#{pane_current_command}`. Pick a delimiter unlikely to appear (e.g. `\x1f`).
- `isValidTarget` MUST be called before any send/capture. Reject otherwise (throw).
- If no tmux server is running, `listWindows` resolves to `[]` (don't throw).

## lib/transcript.js
```js
export function parseRecord(line: string): NormalizedMessage | null
export class TranscriptTailer extends EventEmitter {
  constructor(filePath: string, { maxBuffer = 500, debounceMs = 150 } = {})
  async start(): Promise<void>   // bounded tail load -> set offset=size -> watch
  stop(): void                   // remove watchers/timers
  getMessages(): NormalizedMessage[]
  getPending(): Pending | null
  // events:
  //   'append'  (msgs: NormalizedMessage[])   new records since last read
  //   'pending' (p: Pending | null)           open-question state changed
  //   'error'   (err)
}
```
`NormalizedMessage = { uuid, role:'user'|'assistant'|'system', ts:string|null,
                       blocks: Block[], rawType:string }`
`Block` is one of:
- `{ kind:'text', text }`
- `{ kind:'thinking', text }`
- `{ kind:'tool_use', id, name, inputSummary /* short string */, input /* object */ }`
- `{ kind:'tool_result', forId, text /* flattened */, isError:boolean }`
`Pending = { toolUseId, ts, questions: Question[] }`
`Question = { question, header, multiSelect:boolean, options:[{label, description}] }`

Parsing rules (verified against real transcripts):
- Each line is a JSON object with a top-level `type`. Only `type:"user"` and
  `type:"assistant"` become messages; everything else → `parseRecord` returns `null`.
- The payload is in `record.message`. `record.message.content` is **either a string**
  (user prompt) → one `{kind:'text'}` block, **or an array of blocks**.
- Map block `type`: `text`→text, `thinking`→thinking, `tool_use`→tool_use,
  `tool_result`→tool_result (`tool_use_id`→`forId`; `content` may be string or array
  of `{type:'text',text}` → flatten to text; `is_error`→isError).
- `ts` = record.timestamp; `uuid` = record.uuid.
- **Pending detection:** an AskUserQuestion is a `tool_use` block with
  `name === 'AskUserQuestion'`, `input.questions`. It is *pending* until a
  `tool_result` with `forId === that id` appears anywhere later in the stream.
  Maintain a map of open question ids while tailing; `getPending()` returns the most
  recent still-open one (or null). Emit `'pending'` when it changes.
- Bounded tail load: stat size; read the last `min(size, 1MB)` bytes; discard the
  first partial line; parse the rest; keep the last `maxBuffer` messages. Set the read
  offset to the file size. Then watch (`fs.watch` on the file, debounced) and on change
  read `[offset, newSize)` only, carrying a leftover partial-line buffer across reads.
  Handle truncation/rotation (newSize < offset) by resetting offset to 0.

## lib/sessions.js
```js
export class SessionRegistry extends EventEmitter {
  constructor({ projectsRoot, tmux /* the lib/tmux module */, debounceMs = 1000 } = {})
  async refresh(): Promise<Session[]>   // rescan tmux + project dirs
  start(): void   // periodic refresh (e.g. every 4s) + initial refresh
  stop(): void
  getSessions(): Session[]
  setPending(id: string, pending: boolean): void   // server pushes live pending state;
        // updates the matching session's `pending` and emits 'change' if it flipped
  // events: 'change' (sessions: Session[])  emitted when the set/levels change
}
```
`Session = { id, sessionId, name, target, sessionName, windowIndex, active:boolean,
             cwd, transcriptPath, lastActivity:string|null, pending:boolean, cmd }`
Linking algorithm:
1. `tmux.listWindows()`.
2. For each project dir under `projectsRoot`, find the newest `*.jsonl` (by mtime).
   Read its **tail** (≤64 KB) and parse the last record that carries a `cwd` →
   `{ cwd, sessionId, lastActivity, transcriptPath, mtime }`. (Reuse a tiny tail-read
   helper; do NOT read whole files.)
3. Index those by `cwd` (keep newest per cwd).
4. For each tmux window, match by exact `cwd`. `id = target` (stable per window).
   A matched window with a transcript = a live session. `name = windowName || target`.
   Windows whose `cmd` doesn't look like claude (optional filter) may still be shown.
5. `pending` is filled by the server from the active tailer; registry may default false.
Emit `'change'` only when the serialized session list actually differs (avoid spam).

## lib/resources.js
```js
export class ResourceMonitor extends EventEmitter {
  constructor({ intervalMs = 3000, rssLimitMB = 350 } = {})
  start(): void
  stop(): void
  snapshot(): Snapshot
  // events: 'sample' (Snapshot), 'overlimit' (Snapshot)
}
```
`Snapshot = { ts:number,
              self:{ cpuPct:number, rssMB:number, heapMB:number },
              system:{ loadavg:[number,number,number], cpuCount:number,
                       totalMB:number, freeMB:number, memUsedPct:number },
              overLimit:boolean }`
- `cpuPct` = process CPU% over the interval via `process.cpuUsage()` deltas / wall time
  / `cpuCount` (clamp 0..100*cpuCount or normalize to single-core %, document which).
- `overLimit` when `self.rssMB > rssLimitMB`; emit `'overlimit'` on the rising edge.

## server.js (I own this — listed for reference)
HTTP: serves `public/` (static, path-traversal-safe) and `GET /api/sessions`.
WS (`ws`): bound to the same server.
Client→server messages:
- `{ type:'subscribe', id }`         start tailing that session; reply with `messages`
- `{ type:'unsubscribe', id }`
- `{ type:'reply', id, text }`        sendText into the session's tmux target
- `{ type:'answer', id, toolUseId, selections: string[][] }`
        selections[i] = chosen option labels for questions[i]; build picker keys
        (lib/answer.js) and sendRawKeys, then sendText fallback is NOT auto-used.
- `{ type:'capture', id }`            return a one-shot capture-pane snapshot
Server→client messages:
- `{ type:'sessions', sessions }`
- `{ type:'messages', id, messages, pending }`   full buffer on (re)subscribe
- `{ type:'append', id, messages }`
- `{ type:'pending', id, pending }`
- `{ type:'resources', snapshot }`
- `{ type:'capture', id, text }`
- `{ type:'ack', op, ok, error? }`

## lib/answer.js (I own this)
`export function buildAnswerKeys(question, selectedLabels): string[]`
Single-select: `['Down'*index, 'Enter']`. Multi-select: navigate Down to each chosen
index and press `Space`, then `Enter`. (Picker-navigation assumption — documented in
README as the one load-bearing assumption, with the free-text `reply` as fallback.)

## public/ (frontend — vanilla, no build)
`index.html`, `styles.css`, `app.js`. Connects to `ws://<host>:<port>`, authenticating
via the `Sec-WebSocket-Protocol` subprotocol (`['claude-control', <token>]`) when a
token is configured, and sends `Authorization: Bearer <token>` on HTTP requests (e.g.
`/api/upload`) — matching lib/auth.js's `checkWsToken`/`checkToken` contract, never
`?token=` in the URL. A legacy `?token=` on first load is lifted into `localStorage`
and stripped from the visible URL via `history.replaceState`, then read from storage
thereafter. Renders: left session rail (active dot, pending badge, cwd), a chat
transcript pane (text/thinking/tool blocks visually distinct, thinking collapsible), a
reply composer (Enter to send → `reply`), and an **AskUserQuestion modal** that appears
when `pending` is set: shows each question + options as buttons (multi-select toggles),
and a Send Answer button → `answer`. A fixed resource HUD (self CPU%/RSS, system load,
mem%) that turns warning-colored when `overLimit`. Aesthetic: dark terminal-cockpit,
CSS custom properties, compositor-friendly transitions only. Accessible (keyboard,
focus states, aria on the modal). No external network calls/CDNs.
