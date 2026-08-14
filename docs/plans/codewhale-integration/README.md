# CodeWhale integration — execution tracker

CodeWhale becomes a first-class harness in two independently shippable forms:
an embedded tmux terminal now, followed by a native transcript/controller
adapter over CodeWhale's HTTP/SSE Runtime API.

- Design: [codewhale-integration.md](../../design/codewhale-integration.md)
- Upstream contract pinned for implementation: CodeWhale `0.9.6`, commit
  `d970495929f3624728cd6d8755696a151fb7f991`
- Local binary observed during investigation: CodeWhale `0.9.5`, commit
  `853cb707bbcf` (useful for terminal E2E only; native contract tests must run
  against the pinned or newer compatible Runtime)

| Phase | Status | Goal | Exit gate |
|---|---|---|---|
| 0 | Implemented; browser E2E passed, native-shell build pending | First-class CodeWhale identity with tmux terminal presentation | Launch, reconnect, resize, mouse, and keyboard pass in desktop shell |
| 1 | Implemented; local Runtime and browser E2E passed | Read-only Runtime client, capability probe, session/thread discovery, snapshots | Real `runtime/info`, summaries, detail, and reconnect test against a compatible Runtime |
| 2 | Partial | Mutable transcript stream and shared attention state | Upsert/reset, cursor-gap recovery, and approval UI pass; user input remains |
| 3 | Partial | Native turn/steer/interrupt controls | Start-turn, interrupt, and approval decisions are routed; steer and user input remain |
| 4 | Optional | Managed Runtime lifecycle and saved-session import | Token/process security review plus bounded-history benchmark |

## Phase 0 delivered surface

- `codewhale` availability appears in `/api/spawn-agents`.
- Settings persist an operator-owned launch command and optional binary path.
- New Session offers CodeWhale without a fake model selector.
- Spawned panes are tagged `@cc_agent=codewhale` and discovered by tag or
  process fallback.
- Sessions report `kind:'codewhale'`, `presentation:'terminal'`, and
  `transport:'tmux'`; the existing PTY bridge and `TerminalPane` own the I/O.
- The rail keeps a CodeWhale identity/icon while terminal filters and rendering
  follow presentation rather than harness identity.
- Protocol version 3 records the new kind and presentation field.

### Phase 0 validation recorded 2026-08-12

- All 1,446 backend tests and all 1,761 frontend tests passed; the production
  Vite build succeeded.
- A local Browser E2E found four real running CodeWhale processes, rendered
  their whale rail identity, selected one into `TerminalPane`, and verified the
  real tmux target stayed selected across a registry refresh.
- The isolated Otoro checkout at `127.0.0.1:4318` reported CodeWhale available
  from `/api/spawn-agents`, discovered all four panes through `/api/sessions`,
  and rendered an enabled CodeWhale picker plus a live xterm view. This check
  also caught and fixed a missing `readCloudBearer` server import that had made
  the availability endpoint return 500 before the UI could consume it.
- Follow-up device testing caught the PTY stuck on `Connecting…`, a blank
  first paint, and Otoro's global tmux window-name hook overwriting the pane.
  The dev server now runs persistently on an isolated tmux socket; every PTY
  viewer receives an immediate pane seed, app-owned mirror sessions shadow
  global select-window hooks, and CodeWhale uses the non-resizing agent-pane
  mirror. Browser E2E shows the live CodeWhale TUI at its real pane geometry.
- The same E2E verified the New Session CodeWhale option is enabled, removes the
  model picker, and labels itself as terminal passthrough.
- Underwater fish were observed moving across the rendered viewport; the
  implementation stays one-shot, reduced-motion aware, and idle between events.
- Native Tauri compilation was attempted but stopped when the checkout volume
  ran out of free space. The newly created `target/` and untracked generated
  `Cargo.lock` were removed; native launch/keyboard/resize remains the Phase 0
  exit gate.

## Phase 1 tasks — read-only Runtime contract probe

1. Add server-only Runtime configuration: base URL, token source, compatibility
   policy, request timeout, and reconnect budget. Never expose the token through
   `/api/config` or the browser.
2. Implement a fetch-injected `CodeWhaleRuntimeClient` for `/health`,
   `/v1/runtime/info`, thread/session summaries, thread detail, and SSE events.
3. Fail closed on missing required Runtime capabilities. Report version and
   commit in diagnostics, not secrets.
4. Normalize a `ThreadDetail` snapshot into stable Claude Control messages keyed
   by CodeWhale item ID. Phase 1 may render completed items only; it must not
   append every delta as a new bubble.
5. Introduce `CodeWhaleRuntimeSessionSource` and a read-only transcript source
   without adding Runtime branches to the tmux registry.
6. Contract-test against a real loopback Runtime at the pinned revision. Gate
   Phase 2 on evidence that snapshot hydration followed by `since_seq` SSE loses
   no event.

### Native Runtime validation recorded 2026-08-13

- Claude Control connected server-side to a real loopback CodeWhale `0.9.5`
  Runtime, capability-gated it with `/v1/runtime/info`, and discovered a resumed
  thread through `/v1/threads/summary` without exposing the Runtime token to the
  browser.
- A real two-message thread (`Reply with exactly OK.` / `OK`) rendered through
  Claude Control's existing native transcript components. Browser assertions
  confirmed there was no xterm surface or terminal wrapper in this view.
- Runtime transcript events use stable item UUIDs and the additive
  `upsert`/`reset` frames. Tests cover chunked SSE parsing, replay-safe upserts,
  and a `previous_seq` discontinuity forcing a fresh snapshot.
- The Runtime row is labelled `Runtime` and omits tmux-only rename, terminate,
  drag, and agent-terminal actions. `Cmd+J` is intentionally inert when a
  Runtime thread has no real linked tmux target; the Runtime API does not expose
  a PTY.
- A separately detected CodeWhale tmux pane remains the terminal fallback.
  Browser E2E verified both the embedded TUI and the `Cmd+J` full-screen mirror
  stay connected. The overlay reuses the pane's existing FIFO bridge so two
  viewers cannot replace each other's `pipe-pane` registration.
- Runtime `pending_approvals` now hydrate into Claude Control's existing inline
  question surface. Allow-once, remember-for-thread, and deny decisions route to
  `POST /v1/approvals/{id}`; free-text replies are refused while an approval is
  open, so typing "Approved" can no longer masquerade as a permission decision.
- The UI labels native HTTP/SSE rows as `Runtime` and tmux passthrough rows as
  `Terminal`. Runtime is not Claude print mode and has no PTY contract, so its
  invalid scratch/agent terminal actions are hidden or disabled; terminal rows
  continue to render the live CodeWhale TUI independently.
- Runtime lifecycle `status` items are normalized at the transcript adapter:
  transport chatter (`Continuing`, queued-completion resumes, and per-step
  progress) is omitted, while sub-agent completion payloads are linked back to
  their originating `agent` tool call as `tool_result` blocks. The native
  transcript therefore renders compact/grouped tool receipts with expandable
  agent output instead of raw lifecycle paragraphs.

## Phase 2 tasks — mutable transcript and attention seam

1. Extend transcript changes from append-only to `append | upsert | reset`.
2. Add reducer tests proving item deltas replace one UUID in place and replay is
   idempotent.
3. Enforce per-thread `previous_seq` continuity; resnapshot on a gap.
4. Hydrate pending approvals and user inputs from the snapshot before opening
   SSE, then reconcile settlement events.
5. Map approvals and user input onto shared attention UI without inferring them
   from transcript text.

## Phase 3 tasks — control path

1. Add a controller capability contract for turn, steer, interrupt, approval,
   and user input.
2. Route CodeWhale thread controls over server-side HTTP; keep Runtime tokens
   server-only.
3. Disable unsupported controls explicitly and surface disconnected,
   incompatible, interrupted, and failed states.

## Stop/go decisions

- If Runtime version/capability negotiation is not reliable, keep terminal mode
  as the supported integration and do not expose a partial native mode.
- If stable item IDs or delta materialization differ from the pinned contract,
  revise normalization before changing the shared transcript reducer.
- Managed process lifecycle is not required for native transcript support; only
  take it on after externally managed Runtime mode is proven.
