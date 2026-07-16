# Design — cockpit-protocol-split-native-heads

> Scaffolded by /100x:commit-plan from plan Risk candidates ([known]+[assumed] rows).
> TODO: fill prose. The /100x:design terminal-panel pass (task A1) lands its output HERE.

## Threat model
| # | Threat | Mitigation |
|---|---|---|
| T1 | Richer tailnet-exposed API widens attack surface | layered tailnet+bearer; zero new unauth surfaces; ttyd ?token= deletion is net reduction; scoped tokens deferred (Decision 14) |
| T2 | Control-mode desync (%output, %pause, version drift) | pre-B spike gate; compat layer; periodic full reconcile; TMUX_MODE=poll escape hatch |
| T3 | PTY bridge = keystroke injection into live panes | same flat bearer gate as replies; audit-log line per attach (Decision 15) |
| T4 | Tauri auto-update = code-execution trust boundary | signature verification; key in secret manager; TLS pinned origin; rotation runbook pre-D |
| T5 | Client caches hold transcripts unencrypted multi-device | FileVault as stated at-rest boundary; purge on revoke/logout; delete tombstones; bounds (Decision 12) |
| T6 | xterm.js renders raw PTY output (escape sequences) | pin patched version; OSC-52/clipboard disabled by default; CVE tracking |

## Performance findings
| # | Concern | Target | Measured by |
|---|---|---|---|
| P1 | Keystroke echo | p95 <40ms direct path; DERP tripwire (>20% relayed AND p95>80ms at B-close → predictive echo promoted) | latency harness, path-type logged per run |
| P2 | Transcript open / reconnect / zod parse | warm <300ms; reconnect <1s zero-refetch; zod <2ms p95 per batch on WKWebView-class | SPA perf marks; Playwright throttle E2E |
| P3 | Control-mode output flooding | no missed lifecycle events at ≥1MB/s pane output | pre-B spike flood test; per-pane throttle |

## Simplicity findings
| # | Temptation | What we do instead |
|---|---|---|
| S1 | Ceremony (service split / schema toolchain) | one Node process; zod ceiling until falsifier-1 fires |
| S2 | Cache-sync CRDT | append-only seq replay |
| S3 | Tauri plugin sprawl | hotkeys+notifications+auto-update only; rest adoption-gated |

## PM-lens rows
| # | Class | Row |
|---|---|---|
| B1 | business | invisible protocol work stalls momentum → Phase A visible win + A-spike front-loaded |
| C1 | customer | web parity regression → checklist gate per phase |
| C2 | customer | native onboarding friction → operator-only first |
| F1 | feasibility | L overall; C largest; spike-gated control-mode; handshake for cutover |

## Principles & Seams
Seam: protocol SHAPE (mux'd WS + seq cursors + binary PTY framing + host-scoped IDs); schema language swappable (zod → protobuf on falsifier-1). Unwind: ~15 files in lib/protocol + adapters.

## Terminal panel design (A1)

> /100x:design output for A5 (in-app xterm.js terminal panel). Replaces the ttyd
> iframe (`lib/terminal.js` spawning a per-target `ttyd`, proxied at `/term/<id>`)
> with `@xterm/xterm` + `@xterm/addon-webgl` rendering into an in-document canvas,
> fed by the binary PTY WebSocket bridge from A4 (`lib/pty-bridge.js`). Covers the
> four decision areas below with rules concrete enough to implement without
> further design input. Audit refs: T3 (PTY = keystroke injection — same bearer
> gate), T6 (raw PTY output renders escape sequences — OSC-52 decision below), P1
> (keystroke echo latency — unaffected by this doc; harness lives in A2).

### Surfaces in scope

Two existing terminal UIs converge on one xterm.js host:

- **`TerminalPanel.tsx`** — the full-viewport `role="dialog" aria-modal` overlay
  opened by ⌘/Ctrl+J for *any* session. `term-overlay` / `term-head` / `term-scroll`
  chrome is kept; `<iframe class="term-frame" src={terminalUrl}>` is replaced by an
  xterm.js canvas.
- **`TerminalPane.tsx` + `TerminalView.tsx`** — the dedicated main-view renderer for
  `kind:'terminal'` sessions. Today this polls `shell-capture` every 800ms and
  relays keystrokes via a diffed `<textarea>` (`useTerminalRelay` /
  `web/src/lib/terminalKeys.ts`) because there is no real PTY underneath. A5 gives
  it one: the poll loop is replaced by the same live byte stream as the overlay.

**Decision**: one shared component, `web/src/components/XtermHost.tsx` (new), owns
the `Terminal` instance and the `pty-client.ts` socket. `TerminalPanel.tsx` and
`TerminalPane.tsx` become thin hosts (overlay chrome vs. inline chrome) wrapping it,
so focus/hotkey/reconnect logic lives in one place instead of drifting between two
copies. `TerminalView.tsx`'s on-screen `KEY_BAR` / sticky-Ctrl/Opt affordance is
**kept** (phones have no hardware Ctrl key) but rewired to write raw bytes to
`pty-client.ts` instead of tmux `sendKey` ops.

The "↗ New tab" link in `TerminalPanel.tsx` is **removed**: it opened
`terminalUrl(sessionId)`, ttyd's own HTTP page (`/term/<id>?token=…`). The xterm.js
panel has no separate HTTP surface to open — it is an in-app WS client. This is a
direct, load-bearing consequence of the migration, stated here so A5 doesn't have to
re-decide it.

### 1. Focus handoff

**Reuse the existing modal-focus convention** (`web/src/lib/anim.ts`'s
`useModalTransition`), already used by `CommandPalette`, `ConfigModal`, `PinModal`,
`StudioModal`, `ProcessPanel`, `SkillBrowser`, `OptimizeReview`, and
`AppFrameLayer` — not the bespoke `initialFocusTarget`/`shouldCloseOnKey` pair in
`terminalFocus.ts`, which was a workaround for the iframe's cross-document focus
boundary that xterm.js (same-document) no longer has.

- **DOM shape**: `TerminalPanel.tsx`'s `rootRef` (from `useModalTransition`) goes on
  `.term-overlay`; its header/term-scroll/nav trio is wrapped in one child
  (`.term-panel`) so `useModalTransition`'s `:scope > *` panel lookup finds a single
  focus-trap boundary, matching `ConfigModal`/`CommandPalette`'s backdrop→panel
  shape.
- **Initial focus target**: the xterm canvas must be the FIRST focusable descendant
  in DOM order (`useModalTransition` focuses `getFocusable(panel)[0]`) — reorder
  JSX so `.term-canvas` (tabIndex 0) renders before `.term-head`'s buttons, using
  CSS `order` to keep the header visually on top. This satisfies the regression this
  file's current `terminalFocus.ts` guards today ("close button must never be the
  initial focus target") for free, via the same mechanism every other modal uses.
- **Tab order**: canvas (0) → on-screen `ACTION_KEYS` buttons (tabIndex 0 only while
  `visible`, existing convention) → close button. `useModalTransition`'s existing
  Tab/Shift+Tab trap wraps last→first automatically — no new trap code.
- **Click-to-focus**: clicking anywhere inside `.term-canvas` focuses xterm's
  internal helper textarea natively (`Terminal.open()` wires this — zero custom
  code). Clicking the header/chrome (`.term-head`, outside the canvas) blurs xterm
  and moves focus to the clicked chrome element, **without closing the panel** —
  this is the concrete reading of "click-outside to blur": there is no backdrop
  behind a full-viewport overlay, so "outside" means outside the canvas, inside the
  same panel.
- **Escape — split by current focus target, not a single global rule**:
  - Canvas focused (`document.activeElement === xterm's textarea`) → Escape is
    **never** intercepted by the panel; it passes straight to the PTY (vim insert
    mode, tmux copy-mode exit, shell line-cancel all need it). `requestClose()` is
    NOT called.
  - Any other focus target inside the panel (header, close button, on-screen keys)
    → Escape calls `requestClose()` (standard modal convention, matches
    `CommandPalette`'s `e.key === 'Escape'` handler).
  - This is a deliberate change from today: the ttyd iframe's parent-window Escape
    listener was effectively dead code while the iframe held focus (keyboard events
    don't cross the iframe document boundary), so Escape always reached ttyd in
    practice. xterm.js removes that accidental iframe boundary, so the split rule
    above is what makes Escape do the right thing in the new same-document world.
- **Focus after the Ask card closes**: `AskInline.tsx` already returns focus to
  `.composer-input` on submit/close (`textareaRef.current?.focus()`). No new
  handling needed — the terminal overlay and the Ask card are mutually exclusive UI
  regions (Ask card lives in the composer/transcript area, which is occluded while
  `.term-overlay` covers the viewport). If the terminal panel is open, the Ask
  card's own focus-restore target isn't visible/interactive anyway; if the panel is
  closed, existing behavior is untouched.
- **Visual focus indicator**: xterm.js natively switches the terminal cursor from a
  solid block to a hollow outline when its container loses focus (default
  behavior, no config needed) — that's the terminal-content-level indicator.
  Additionally, `.term-canvas` gets a `:focus-within` border/ring (reusing the
  app's existing accent-color token) so the chrome-level focus state is visible
  too, matching the "hover/focus/active states that feel designed" bar in the
  design-quality rubric.
- **Inline pane (`TerminalPane.tsx`) focus**: same click-to-focus via xterm's
  native textarea. The soft-keyboard concern that motivated `useTerminalRelay`'s
  diffed `<textarea>` (iOS autocorrect / predictive text) is xterm.js's own
  well-established problem to solve via its internal hidden textarea (this pattern
  ships in every browser-based xterm.js deployment, e.g. cloud IDEs) — **primary
  path: xterm's native textarea, zero custom relay code**. Contingency (exercised
  only if mobile typing regresses in testing, not a default): keep
  `useTerminalRelay`'s diff-relay as an alternate input source that writes bytes to
  `pty-client.ts` instead of tmux `sendKey`/`sendText` ops.

### 2. Hotkey passthrough table

**Routing rule**: while the terminal (canvas OR inline pane) has focus, a keydown
is owned by the app **only if `event.metaKey` is true**. A plain `ctrlKey`-only
combo (no `metaKey`) is never intercepted by the app and always reaches the PTY —
this single rule is what a real terminal app does (Terminal.app/iTerm2 reserve Cmd
for chrome; Ctrl is shell territory) and it resolves every Ctrl-combo collision
below without hand-auditing tmux/readline/vim bindings one at a time. Implemented
as one guard line added to each of App.tsx's global keydown handlers (mirroring
the existing `if (composerTerminalRef.current) return;` bail already used by the
Escape-to-cancel handler): a new helper in `terminalFocus.ts`,
`getTerminalPanelFocused()` / `setTerminalPanelFocused(bool)` (module-level
boolean + getter/setter, same shape as `lib/hotkeySuppression.ts`'s
`getHotkeySuppressed`/`setHotkeySuppressed`), set by `XtermHost`'s focus/blur
handlers. Each handler gains: `if (getTerminalPanelFocused() && !e.metaKey) return;`
— for bubble-phase handlers this stops the app's action from *also* firing
alongside the PTY's own handling; for capture-phase handlers it stops
`preventDefault`/`stopPropagation` from running, letting the event continue its
natural path down to xterm's target element.

| Key / combo | Destination | Notes |
|---|---|---|
| Ctrl+C, Ctrl+D | PTY | interrupt / EOF |
| Ctrl+A, Ctrl+E | PTY | readline home/end |
| Ctrl+B, Ctrl+F | PTY | readline back/forward char; Ctrl+B is ALSO the tmux prefix — see collision #1 |
| Ctrl+K, Ctrl+U, Ctrl+W | PTY | readline kill-to-end / kill-line-backward / delete-word |
| Ctrl+L | PTY | clear/redraw |
| Ctrl+R | PTY | reverse-search |
| Ctrl+Z | PTY | suspend |
| Ctrl+J | PTY | raw LF (some shells treat as Enter) — see collision #4 |
| Arrows, Home/End, PgUp/PgDn | PTY | xterm forwards as VT sequences |
| tmux prefix sequences (Ctrl+B, then a command key) | PTY | resolved by tmux itself once Ctrl+B reaches it |
| Mouse events (click/drag/wheel) while the attached program has a DECSET mouse-tracking mode enabled | PTY | xterm.js tracks the mode from the PTY's own output stream — see §3 |
| All printable characters | PTY | no modifier involved, never touched |
| **Cmd/Ctrl+K** | App | command palette (`setPaletteOpen`) — Ctrl-only variant now excluded per routing rule |
| **Cmd/Ctrl+N** | App | new session draft |
| **Cmd/Ctrl+B** | App | toggle rail — Ctrl-only variant now excluded (was colliding with tmux prefix) |
| **Cmd/Ctrl+J** | App | close terminal panel — Ctrl-only variant now excluded (was colliding with raw LF) |
| **Cmd/Ctrl+U** | App | sub-agents panel — Ctrl-only variant now excluded (was colliding with readline kill-line-backward) |
| **Cmd/Ctrl+1-9** | App | switch session — **explicit exception to the meta-only rule**, wins even on plain Ctrl (see collision #6) |
| **Cmd/Ctrl+Enter** | App | focus composer — meta-only rule applies; low-risk no-op while terminal focused since composer isn't visible in overlay mode |
| **Cmd/Ctrl+.** | App | scroll transcript to latest |
| **Cmd/Ctrl+/** | App/Terminal | routes to a NEW terminal-scoped search (see §3) while the terminal panel is open, instead of `TranscriptSearch` |
| Escape | PTY or App | split by focus target — see §1 |

**Collisions found and their resolution** (this is the "resolve every collision
explicitly" deliverable):

1. **tmux prefix `Ctrl+B` vs. app's `Cmd/Ctrl+B` "toggle rail"** — today's
   `useEffect` at `App.tsx` (detail-head shortcuts) checks `e.metaKey || e.ctrlKey`
   with no terminal-focus guard; a bare Ctrl+B typed to send the tmux prefix would
   currently ALSO toggle the rail. Resolved by the meta-only routing rule.
2. **readline kill-line `Ctrl+K` vs. app's `Cmd/Ctrl+K` "command palette"** — same
   class of bug, same resolution.
3. **readline kill-line-backward `Ctrl+U` vs. app's `Cmd/Ctrl+U` "sub-agents
   panel"** — same resolution.
4. **raw LF `Ctrl+J` vs. app's `Cmd/Ctrl+J` "toggle terminal"** — some shells treat
   Ctrl+J as a newline in canonical mode; a bare Ctrl+J typed at a shell prompt
   would currently ALSO close the panel it was typed into. Resolved by the
   meta-only routing rule: **Cmd+J only** closes the panel; Ctrl+J (no Cmd) is
   never intercepted.
5. **Escape: "close overlay" (modal convention) vs. "cancel" (vim/shell/tmux
   copy-mode convention)** — resolved by the focus-target split in §1, not by the
   meta-only rule (Escape has no modifier to key off of).
6. **`Cmd/Ctrl+1-9` session switch — deliberate exception**: kept as app-owned even
   on a bare Ctrl press, because (a) it is the primary cross-session navigation
   affordance and losing it while inside any terminal would be a worse regression
   than the collision it risks, and (b) no common shell/tmux/vim default binds bare
   Ctrl+1..9. The existing iframe-specific workaround in this handler ("blur a
   stuck ttyd iframe first") is dead code once xterm.js removes the iframe boundary
   and can be deleted.
7. **Accepted tradeoff**: on a Ctrl-only keyboard with no usable Meta key (some
   Windows/Linux desktop browsers), the app's escape hatches (palette, close,
   rail) are unreachable by keyboard while the terminal has focus. The on-screen
   close button (`term-close`) remains the fallback. This is a documented,
   accepted cost of the meta-only rule, not a gap — real terminal apps make the
   same tradeoff (Terminal.app has no Ctrl-driven chrome shortcuts at all).

### 3. Scrollback / copy-mode

- **Two independent scrollback buffers, by design**: xterm.js keeps its own local
  scrollback (`scrollback` option, e.g. 10000 lines) fed purely by the raw byte
  stream it has received — this is separate from tmux's own internal
  history/copy-mode buffer inside the attached pane. No synchronization between
  the two is attempted; this mirrors how a real terminal (Terminal.app, iTerm2)
  relates to tmux today.
- **Mouse-wheel target is dynamic, not statically decided**: xterm.js tracks the
  DECSET mouse-tracking mode (1000/1002/1003/1006, etc.) that the attached program
  signals via its own output escape sequences. When tmux has `set -g mouse on`,
  wheel/click events are encoded as SGR mouse sequences and sent to the PTY, and
  tmux drives its own copy-mode scroll (this is xterm.js's default, out-of-the-box
  behavior — zero custom code). When no mouse mode is signaled, wheel events scroll
  xterm's own local scrollback natively. This is the correct behavior and requires
  no app-level branching.
- **Snap-to-bottom on input**: xterm.js's default behavior returns the view to the
  live bottom when new PTY data arrives or the user types while scrolled up — kept
  as-is (matches every real terminal emulator). No custom "jump to latest" control
  is required to satisfy the acceptance bar, though `Cmd+.` (already app-owned per
  the routing rule, currently a no-op while the terminal is focused since the
  transcript isn't visible) MAY additionally scroll the xterm view to bottom as a
  cheap follow-on — not required for A5.
- **Text selection + copy**: click-drag inside the canvas uses xterm.js's native
  DOM selection; the OS clipboard receives the copy via the browser's normal
  Cmd+C / native "Copy" — a **user-initiated read/select path**, unaffected by the
  OSC-52 decision below.
- **OSC-52 clipboard writes — disabled by default, per T6, with zero code**:
  xterm.js does not implement OSC 52 unless a handler is explicitly registered
  (via `@xterm/addon-clipboard` or a manual `parser.registerOscHandler(52, ...)`).
  **Decision: do not register one.** "Disabled by default" is therefore the
  library's default — a decision to withhold code, not a config flag — and any
  future addition of OSC-52 write support requires a follow-up security review
  (the threat: untrusted pane output, e.g. `cat`-ing an attacker-controlled file,
  can carry an OSC-52 escape sequence that silently overwrites the user's OS
  clipboard with no user action). Paste (Cmd+V → PTY) is unaffected — reading the
  OS clipboard on explicit user paste is xterm.js's native, always-on behavior and
  is not part of the OSC-52 threat surface (bracketed-paste mode, DECSET 2004, is
  honored natively when the attached program requests it).
- **Search**: `@xterm/addon-search` (official xterm addon) provides
  `findNext`/`findPrevious` over xterm's local scrollback only (not tmux's
  history). Wired to the **same `Cmd/Ctrl+/` binding** the app already uses for
  `TranscriptSearch`, with one new branch in that handler: `if
  (getTerminalPanelFocused()) { toggleTerminalSearch(); return; }` before the
  existing `setSearchOpen` call. New component `web/src/components/TerminalSearch.tsx`
  mirrors `TranscriptSearch.tsx`'s UI pattern (same CSS family), backed by the
  search addon instead of the transcript's own text index.

### 4. Disconnect / reconnect visual states

`web/src/lib/pty-client.ts` (new, A5) mirrors `web/src/lib/ws.ts`'s `CockpitSocket`
exactly — same `ConnState` shape, same backoff constants, same auth-close
convention — extended with two terminal-specific failure modes the main socket
never needs.

- **`ConnState` extended to 5 values**: `'connecting' | 'connected' |
  'reconnecting' | 'auth-expired' | 'session-ended'` (the main socket's 3-value
  `ConnState` in `lib/ws.ts` is untouched; this is a local type in `pty-client.ts`).
- **Backoff**: reuse `RECONNECT_BASE_MS = 1000`, `RECONNECT_MAX_MS = 30_000`,
  doubling — identical constants to `CockpitSocket`, for consistency across the
  app's two WS clients.
- **Close-code table**:

| WS close code | Meaning | Client behavior |
|---|---|---|
| 1008 (`WS_AUTH_CLOSE`, reused from `lib/ws.ts`) | bearer token rejected on an established socket | no reconnect; call the SAME `handleUnauthorized()` from `lib/api.ts` that `CockpitSocket` already calls — full-app login-gate takeover, zero new UI |
| `4000` (new, private-use range per RFC 6455 §7.4.2), reason `"dead-target"` | A4's PTY bridge attached to a tmux target that no longer exists | no reconnect (matches A4's "dead-target … no auto-retry" acceptance criterion exactly); `session-ended` state |
| anything else (1006, 1001, 1005, …) | transient network blip, server restart, tailnet hiccup | schedule reconnect per backoff; `reconnecting` state |

- **Three visually distinct states** (must never be confused with each other):
  1. **Transient / reconnecting** — freeze the last rendered xterm frame exactly
     as-is (the natural consequence of no new writes arriving; no code needed to
     "freeze"). Overlay a small, non-blocking pill/banner at the top of
     `.term-canvas` reading "Reconnecting…" with the same `conn-dot conn-<state>`
     CSS convention `ResourceHud.tsx` already uses for the main socket (extend
     with a `conn-reconnecting` modifier) — NOT a full-screen blocking spinner.
     **Keystrokes typed during the gap are queued, not dropped**: `pty-client.ts`
     buffers bytes typed while `readyState !== OPEN` in a FIFO queue bounded to
     4096 bytes (drops oldest on overflow, so a stuck key repeat can't grow it
     unbounded), and flushes the queue in order on the socket's `open` event —
     the same place `CockpitSocket` re-sends its `subscribe` message today.
  2. **Permanent / auth-expired** (close 1008) — no "Reconnecting…" pill. Reuses
     the app-wide login-gate takeover `handleUnauthorized()` already produces for
     the main socket; no bespoke in-panel message is needed for A5 (a
     terminal-scoped message is a fast-follow, not required here). Zero reconnect
     attempts, matching `CockpitSocket`'s exact existing behavior on
     `WS_AUTH_CLOSE`.
  3. **Session ended / dead target** (close `4000`) — distinct from both of the
     above: write a short, styled error directly INTO the xterm buffer via
     `term.write()` — a **typed error frame**, per A4's own task language,
     literally typed as text into the terminal's own scrollback rather than a
     React overlay:
     ```
     \r\n\x1b[31m[session ended — this tmux target no longer exists]\x1b[0m\r\n
     ```
     No auto-retry (matches A4's acceptance criterion). The panel's close button
     or `Cmd+J` is the only dismissal; re-opening (re-selecting the session, or
     `Cmd+J` again) issues a fresh attach attempt — retry is an explicit user
     action, never automatic, for this state.
  - These three states are mutually exclusive, driven by the single `ConnState`
    value above — the banner/pill (state 1) and the auth takeover (state 2) never
    render while a `session-ended` typed frame (state 3) is showing, and vice
    versa.

### Cross-refs

Threat model: T3 (bearer-gated attach, audit-log line — A4's job, unaffected by
this doc), T6 (OSC-52 disabled by default, resolved above with zero code).
Performance: P1's keystroke-echo harness (A2) measures the direct path this doc's
focus/hotkey rules don't touch. Files this design constrains: `web/src/components/XtermHost.tsx`
(new), `web/src/components/TerminalPanel.tsx`, `web/src/components/TerminalPane.tsx`,
`web/src/components/TerminalSearch.tsx` (new), `web/src/components/terminalFocus.ts`,
`web/src/lib/pty-client.ts` (new), `web/src/lib/ws.ts` (constants reused, not
modified), `web/src/App.tsx` (per-handler meta-only guard, ⌘1-9 dead-code removal).

> **Orchestrator note (A1 review, 2026-07-16):** `@xterm/addon-search` is NOT in web/package.json today — it's a NEW dependency, alongside `@xterm/xterm` + `@xterm/addon-webgl` which A5 adds. Terminal search (the `Cmd/Ctrl+/` → `TerminalSearch.tsx` branch) is a **P2 nice-to-have** — defer it out of A5 if it expands the core panel scope; the four load-bearing areas (focus, hotkey passthrough, scrollback/copy-mode, disconnect/reconnect) are the A5 acceptance bar. Everything else the A1 design cites (`useModalTransition`, `hotkeySuppression.ts`, `terminalFocus.ts`, `ResourceHud` conn-dot CSS) is verified present on main.
