# CodeWhale as a first-class Claude Control harness

Status: accepted design; Phase 0 terminal and Phase 1 native transcript integration implemented in the current worktree
Upstream reviewed: [Hmbown/CodeWhale at `d9704959`](https://github.com/Hmbown/CodeWhale/tree/d970495929f3624728cd6d8755696a151fb7f991) (`0.9.6`)
Claude Control reviewed: `baf3856112dfd98096be1d0df1c5d9bf339ff736`

## Decision

CodeWhale can be integrated at two useful levels:

1. **Terminal mode (small, immediate):** launch the `codewhale` TUI in a tmux
   pane and expose it through Claude Control's existing `/pty` bridge. This is a
   real interactive integration, but it intentionally does not populate Claude
   Control's transcript UI.
2. **Native thread mode (recommended first-class substrate):** connect to
   `codewhale app-server --http` and use its documented HTTP/SSE Runtime API for
   session/thread discovery, transcript snapshots, live events, turns,
   interrupts, approvals, and user-input requests.

Do not make the native integration depend on screen scraping or direct parsing
of CodeWhale's internal session files. CodeWhale explicitly names
`app-server` as the canonical integration contract and advises integrations to
use it rather than scrape terminal output
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L1-L21)).

The important Claude Control change is not a CodeWhale parser. It is a small
generalization of the existing substrate seams: session discovery, transcript
streaming, and session control should each have an adapter. CodeWhale is the
second non-file substrate after Olam, which makes those interfaces worth
formalizing now.

## What CodeWhale exposes

### Canonical Runtime API

Run the canonical service on loopback:

```sh
CODEWHALE_RUNTIME_TOKEN='…' codewhale app-server --http --host 127.0.0.1 --port 7878
```

The documented surface is sufficient for Claude Control's normal thread UI:

| Need | CodeWhale contract |
|---|---|
| Compatibility/health | `GET /health`, `GET /v1/runtime/info` |
| Saved sessions | `GET /v1/sessions`, `/summary`, `/{id}` |
| Convert recording to live thread | `POST /v1/sessions/{id}/resume-thread` |
| Live thread list/detail | `GET /v1/threads/summary`, `GET /v1/threads/{id}` |
| Create a thread | `POST /v1/threads` |
| Transcript replay/live tail | `GET /v1/threads/{id}/events?since_seq=<u64>` (SSE) |
| Start/steer/stop | `POST .../turns`, `POST .../steer`, `POST .../interrupt` |
| Resolve an approval | `POST /v1/approvals/{approval_id}` |
| Answer requested input | `POST /v1/user-input/{thread_id}/{input_id}` |

The endpoint list and request shapes are part of CodeWhale's documented
contract
([sessions and threads](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L402-L535),
[approvals, input, and events](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L537-L588)).
`GET /v1/runtime/info` returns both the exact CodeWhale version and embedded
commit so Claude Control can capability-gate or fail closed instead of assuming
a compatible binary
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L66-L71)).

The authoritative thread snapshot is `ThreadDetail`:

```text
thread
turns[]
items[]
latest_seq
pending_approvals[]
pending_user_inputs[]
pending_dynamic_tool_calls[]
```

That shape is implemented in CodeWhale's runtime model
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/crates/tui/src/runtime_threads.rs#L1597-L1617)).
CodeWhale's own web client first loads this snapshot, hydrates its pending
attention state, and only then subscribes from `latest_seq`. Claude Control
should copy that ordering so a reload cannot strand an approval or input request
whose event is already behind the cursor
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L366-L378)).

SSE events have a stable envelope containing `schema_version`, global `seq`,
per-thread `previous_seq`, `thread_id`, optional turn/item IDs, event name,
timestamp, and payload. Global sequence gaps are normal because other threads
can interleave; continuity must be checked with `previous_seq`, not
`seq === cursor + 1`
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L798-L847)).

### Saved TUI transcripts

CodeWhale's normal TUI saves sessions under `~/.codewhale/sessions/<id>.json`.
The `SavedSession` contains metadata, a compatibility `messages` projection,
and, in newer sessions, an append-only canonical `journal` plus `leaf_id`
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/crates/tui/src/session_manager.rs#L495-L527)).

This is useful for history/import, but poor as the primary live substrate:

- the containing document is atomically rewritten as a whole with
  temp-file + fsync + rename
  ([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/crates/tui/src/session_manager.rs#L771-L785));
- while the TUI is open, its in-memory copy is authoritative and the next
  autosave replaces the document
  ([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/crates/tui/src/session_manager.rs#L177-L188));
- CodeWhale itself describes saved sessions as recordings, with live state
  available only after resuming into a Runtime thread
  ([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L449-L462)).

Watching those files would require reopening and parsing a whole JSON document
after every rename. That conflicts with Claude Control's bounded, incremental
transcript doctrine in [CONTRACT.md](../../CONTRACT.md). Direct file reads should
therefore be an explicitly bounded history/import fallback, not live mode.

If deterministic pane-to-recording correlation becomes necessary, a CodeWhale
`session_start` observer hook can write a small external registry. CodeWhale
documents a stable `DEEPSEEK_SESSION_ID` for the TUI session
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/HOOKS.md#L212-L260));
when CodeWhale is launched in tmux, `TMUX_PANE` should also be inherited. The
pane/session pairing is an inference to validate in an end-to-end test, and the
hook is only a binding signal, not a transcript stream.

### Terminal passthrough

Claude Control already has the required transport. Its generic PTY bridge
attaches to tracked tmux targets ([`lib/pty-bridge.js`](../../lib/pty-bridge.js))
and `/pty` resolves a selected pane in [`server.js`](../../server.js#L2224).
The frontend's [`TerminalPane`](../../web/src/components/TerminalPane.tsx) is a
full interactive xterm client. There is no need for CodeWhale-specific terminal
emulation.

CodeWhale's Runtime web client deliberately omits PTY/terminal functionality
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L380-L383)).
Consequently, terminal mode and native Runtime thread mode are two distinct
execution surfaces. A saved TUI recording can be explicitly resumed into a
Runtime thread, but Claude Control should not claim that the API thread is a
live mirror of the existing TUI pane.

## Claude Control seams that need work

### Current coupling

The code has the beginnings of an adapter contract, but harness identity is
still spread through conditionals:

- [`SessionRegistry`](../../lib/sessions.js#L905) performs local discovery,
  harness classification, transcript matching, and Olam row injection in one
  class.
- [`ensureSubscription`](../../server.js#L2485) special-cases Olam, then creates
  a file `TranscriptTailer` and selects a Claude or Codex parser.
- `OlamTranscriptSource` already mimics the tailer's `start`, `stop`, snapshot,
  pending, trim, and `append` behavior
  ([`lib/olam-transcript.js`](../../lib/olam-transcript.js#L255)). This is the
  clearest existing substrate seam.
- The client chooses terminal versus transcript presentation solely with
  `selectedSession.kind === 'terminal'`
  ([`App.tsx`](../../web/src/App.tsx#L3052)).
- The client `Session.kind` union and rail filters are closed lists
  ([`types.ts`](../../web/src/lib/types.ts),
  [`SessionRail.tsx`](../../web/src/components/SessionRail.tsx#L35)).
- The protocol schema explicitly documents extension by adding harness and
  transport enum values, but its actual enum is behind the runtime shapes (it
  omits `claudex` and `claudemi` already)
  ([`lib/protocol/session.js`](../../lib/protocol/session.js#L46)). Any real
  CodeWhale shape change must reconcile this drift, update the fingerprint, and
  bump the protocol version.

### Recommended deep interfaces

Keep one concept per interface instead of adding CodeWhale branches throughout
`SessionRegistry` and `server.js`:

```text
SessionSource
  start(onChange) / stop() / list() / health()

TranscriptSource
  start() / stop() / snapshot() / getPending() / trim()
  emits change({ op: append | upsert | reset, ... }) / ready / error

SessionController
  capabilities()
  send(prompt) / steer(prompt) / interrupt() / answer(request, response)
```

Implementations would be:

- `TmuxSessionSource` for the current local registry discovery;
- `OlamSessionSource` for the current `setRemoteSessions` flow;
- `CodeWhaleRuntimeSessionSource` for Runtime thread/session summaries;
- `FileTranscriptSource` wrapping today's Claude/Codex `TranscriptTailer`;
- `OlamTranscriptSource` (existing);
- `CodeWhaleRuntimeTranscriptSource` for snapshot + SSE replay;
- controller adapters for tmux keys, Codex RPC/print, Olam, and CodeWhale HTTP.

This puts CodeWhale's network protocol and cursor rules behind one adapter. The
rest of the application consumes normalized session, transcript-change, and
control-capability contracts.

### Separate harness from presentation

`kind` currently means both "which harness is this?" and "which UI should render
it?" A CodeWhale TUI is harness-identical to a CodeWhale Runtime thread but needs
the terminal presentation. Model those dimensions separately:

```ts
type Harness = 'claude' | 'codex' | 'codewhale' | 'olam' | 'shell';
type Presentation = 'thread' | 'terminal';
type Transport = 'tmux' | 'rpc' | 'print' | 'olam' | 'codewhale-http-sse';
```

For a low-risk migration, keep `kind` during rollout and add `harness`,
`presentation`, and capability fields additively. Switch render/control
decisions to capabilities/presentation before eventually shrinking or removing
the overloaded `kind` semantics.

## Transcript normalization

CodeWhale's live record is a mutable `TurnItemRecord`, not an append-only chat
line. It includes a stable item ID, kind, lifecycle status, summary, optional
detail/metadata/artifacts, and start/end times
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/crates/tui/src/runtime_threads.rs#L671-L705)).

Use the CodeWhale item ID to derive a stable Claude Control message UUID:

| CodeWhale item | Claude Control projection |
|---|---|
| `user_message` | user text message |
| `agent_message` | assistant text message |
| `agent_reasoning` | assistant thinking block |
| `tool_call` | tool-use receipt and eventual result/status |
| `command_execution` | command tool receipt/result |
| `file_change` | file-change receipt/artifact links |
| `context_compaction` | assistant/system status receipt |
| `status` / `error` | assistant/system status or error receipt |

The hard part is live mutation. CodeWhale emits `item.delta` for an existing
`item_id`; deltas are materialized into the item projection before the event is
([source](https://github.com/Hmbown/CodeWhale/blob/d970495929f3624728cd6d8755696a151fb7f991/docs/RUNTIME_API.md#L841-L856)).
Claude Control's server currently broadcasts only `{type: 'append', messages}`
from transcript sources ([`server.js`](../../server.js#L2506)), and the frontend
therefore has no replace-by-UUID operation.

The native integration needs an additive transcript change frame such as:

```ts
type TranscriptChange =
  | { op: 'append'; messages: NormalizedMessage[] }
  | { op: 'upsert'; messages: NormalizedMessage[] }
  | { op: 'reset'; messages: NormalizedMessage[]; cursor?: string };
```

Existing Claude/Codex/Olam producers keep emitting append. CodeWhale sends an
upsert for item start/delta/completion and reset after a cursor discontinuity.
The client reducer replaces a message with the same UUID in place. Emitting
every delta as an appended message would create duplicate bubbles and should not
be accepted as a first-class implementation. A completion-only read-only MVP
can temporarily avoid upserts, but it would not provide streaming output.

Pending approvals and user inputs should not be inferred from transcript text.
Hydrate the snapshot's authoritative pending arrays, translate them into Claude
Control's existing pending-question/attention model, and update them from SSE
settlement events. Keep dynamic tool calls unsupported until Claude Control has
a deliberate client-tool execution policy.

### Correct subscription sequence

For every selected CodeWhale Runtime thread:

1. Fetch `GET /v1/threads/{id}`.
2. Normalize `items` as the transcript snapshot.
3. Hydrate all pending attention state.
4. Record `latest_seq` as the accepted per-thread cursor.
5. Open SSE with `since_seq=latest_seq`.
6. Drop duplicates; require each event's `previous_seq` to equal the accepted
   cursor, then advance to `seq`.
7. On a discontinuity, close the stream and repeat from step 1.

This closes the snapshot/subscribe race and matches CodeWhale's own client.

## Implementation plan

### Phase 0 — terminal floor

Implementation status: complete in the current worktree; pending final E2E
validation in the desktop shell.

- Add CodeWhale binary/availability detection to `/api/spawn-agents`.
- Add CodeWhale to the new-session picker and rail filter/icon/label.
- Launch `codewhale` in a tmux pane with `@cc_agent codewhale` (or the eventual
  additive `harness` metadata).
- Classify the pane without requiring a transcript path.
- Return `presentation: 'terminal'`, so the existing `TerminalPane` and `/pty`
  bridge handle interaction.
- Do not show an empty transcript or imply that terminal capture is a parsed
  conversation.

This phase is independently shippable and provides the requested passthrough.

### Phase 1 — read-only Runtime adapter

- Add server-only configuration for an externally managed Runtime base URL and
  token.
- Implement `CodeWhaleRuntimeClient` with health, runtime-info, summaries,
  thread detail, and SSE methods.
- Gate on exact version/commit plus advertised capabilities rather than only a
  successful TCP connection.
- Add `CodeWhaleRuntimeSessionSource` and
  `CodeWhaleRuntimeTranscriptSource` behind the generic seams.
- Render historical/completed items in the regular transcript UI.
- List saved sessions separately as recordings; offer explicit "Resume into
  thread" rather than representing them as live.

Starting with an externally launched `app-server` proves the contract without
introducing process-lifecycle and secret-management work into the first adapter.

### Phase 2 — live first-class thread mode

- Add append/upsert/reset transcript operations to the backend WebSocket and
  frontend reducer.
- Implement snapshot-then-SSE, duplicate suppression, cursor continuity, and
  full resnapshot on a gap.
- Connect start turn, steer, and interrupt to the CodeWhale HTTP controller.
- Adapt pending approvals and user input to Claude Control's shared attention UI
  and answer routes.
- Add loading, disconnected, incompatible, interrupted, and failed states.

### Phase 3 — optional managed Runtime

- Add an owned-process mode that launches
  `codewhale app-server --http --host 127.0.0.1`.
- Generate a strong ephemeral token and pass it by environment, not in argv or a
  URL; retain it only server-side.
- Add startup health/capability checks, bounded restart backoff, and clean
  shutdown.
- Never silently adopt an unknown server on the configured port. Either connect
  with explicit URL/token configuration or own the child process and its token.
- Make new-session creation capable of creating a native CodeWhale Runtime
  thread.

HTTP/SSE is preferable to CodeWhale's stdio control transport for Claude Control
because it exposes the complete session/thread/event/pending surface. Stdio can
remain an alternative for an embedded single-process future.

### Phase 4 — optional saved-session import

- Add a bounded, on-demand importer for a selected SavedSession JSON file.
- Prefer the canonical journal/leaf projection where present; support legacy
  `messages` for compatibility.
- Never continuously full-parse every saved session or use filesystem polling as
  the primary live transcript source.
- If needed, add the `session_start` hook registry only to correlate tmux panes
  with saved recordings.

## Acceptance gates

### Terminal mode

- Launch CodeWhale from Claude Control and classify it as CodeWhale.
- Type, resize, scroll, use mouse input, disconnect, and reconnect through `/pty`.
- Closing the UI does not unexpectedly kill the tmux-hosted CodeWhale session.
- Terminal mode always renders `TerminalPane`, never a blank transcript.

### Native Runtime mode

- Reject a Runtime that lacks required thread, turn, replay, approval, or input
  capabilities; surface the returned version/commit in diagnostics.
- A snapshot plus concurrent SSE event loses no content and produces no
  duplicates.
- Replaying the same event is idempotent; `item.delta` updates one bubble.
- A deliberately broken `previous_seq` forces a fresh snapshot.
- Pending approvals and input requests survive a Claude Control reload even when
  their request events precede `latest_seq`.
- Turn start, steer, interrupt, approve/deny, and input answers exercise actual
  CodeWhale endpoints and converge back through snapshot/SSE state.
- Runtime tokens never reach the browser, query strings, logs, or process argv;
  network binding stays loopback by default.
- Large histories remain bounded in memory and do not trigger full rescans of
  every SavedSession file.
- Session/protocol schema changes update the fingerprint snapshot and protocol
  version.

## Risks and explicit non-goals

- **Upstream drift:** this design is pinned to CodeWhale `0.9.6` at commit
  `d9704959`. Capability and commit reporting must be checked at runtime.
- **Two persistence models:** TUI SavedSessions and Runtime threads are related
  by explicit resume, not assumed to be the same live object.
- **No terminal inside Runtime mode:** CodeWhale does not currently publish that
  contract. Keep the agent-terminal UI absent/disabled for native Runtime
  threads unless upstream adds one.
- **No iframe embedding as the primary integration:** `codewhale web` uses a
  one-time bootstrap-to-cookie flow and provides a separate UI. The API adapter
  is the stable integration boundary; terminal passthrough is the simpler escape
  hatch.
- **No external writes to an active TUI SavedSession:** the TUI owns its
  in-memory state and rewrites the document.

## Recommended first slice

Ship Phase 0 and the Phase 1 client/contract probe together:

1. CodeWhale appears as a first-class launch/filter/icon choice and works
   immediately through the current terminal bridge.
2. A hidden or developer-gated Runtime client proves `runtime/info`, thread
   summaries, detail normalization, and SSE cursor recovery against CodeWhale
   `0.9.6`.
3. Only after that contract test passes, add the transcript upsert frame and
   expose native thread mode to users.

That sequence gives Claude Control a useful CodeWhale integration early without
locking the application into transcript-file scraping or contaminating the
current code with another set of harness-specific branches.
