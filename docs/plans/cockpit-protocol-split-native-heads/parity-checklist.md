# Phase-C Protocol Cutover — Control Action Parity Gate

**Header:** This checklist enumerates every web control action the SPA can perform today (source: main branch @ 2026-07-16). After protocol cutover, EVERY action here must still work on the protocol-only build. Missing an action now = a control silently lost later. **SOURCE OF TRUTH: current main branch behavior**.

| # | Control Action | UI Location (Component) | Server Surface (Endpoint or WS Frame) | How to Verify Parity |
|---|---|---|---|---|
| 1 | Reply to a session (compose & send text) | Composer in Thread | `reply` WS message → tmux sendText / print submit / Codex RPC | Send a text message; verify it lands in the session transcript |
| 2 | Answer an AskUserQuestion | AskInline component | `answer` WS message → navigate picker via parsed prompt + keystroke sequence | Open a picker (permission/menu); select option; verify answer flows back |
| 3 | Approve/deny a permission | AskInline component (permission picker) | `answer` WS message (parsed as permission option) | Trigger a permission prompt; approve/deny; verify Claude receives decision |
| 4 | Create a new session | NewSessionForm/NewSessionDraft | POST /api/session/new | Form submit → verify new window appears in rail within 4-6s |
| 5 | Rename a session | Session header rename inline | POST /api/session/rename | Click rename; type new name; verify rail updates + Claude receives /rename |
| 6 | Rename a tmux SESSION (grouped header) | SessionRail group-collapse header | POST /api/tmux/rename-session | Click tmux session header rename; verify rail updates instantly |
| 7 | Kill/close a session | SessionRail delete/close action | (implicit via tmux kill-window or session removal) | Click close; verify session vanishes from rail (not verified via explicit endpoint) |
| 8 | Attach raw terminal (ttyd) | TerminalPane / TerminalButton | GET /term/<encoded-id>/ (window.open to URL with ?token=) | Click terminal button; verify ttyd UI loads in iframe/window |
| 9 | Send terminal input (keystroke) | TerminalPane or raw ttyd | (direct via ttyd WS, bypasses cockpit) | Type in raw terminal; verify input reaches tmux pane |
| 10 | Send pane text (non-terminal) | Thread composer or debug | `pane-text` WS message → tmux sendText | Send via composer; verify text reaches pane |
| 11 | Send pane keystroke | (internal/debug, no exposed UI) | `pane-key` WS message → tmux sendRawKeysSequenced | (Internal: sent by answer/promptkey logic) |
| 12 | Upload an attachment | Composer file picker | POST /api/upload → file stored, absolute path returned | Drag/select file in composer; verify path injected into prompt |
| 13 | Serve uploaded media (preview/lightbox) | Transcript inline images | GET /api/uploads/<basename> or GET /api/file?path=... | Click image in transcript; verify preview/lightbox loads |
| 14 | Serve transcript inline media (embedded-image/video) | Transcript blocks | GET /api/media/<relative-path> | Agent embeds media; verify GET returns correct MIME + content |
| 15 | Edit config (transcriptFontSize, launchCommand, etc.) | ConfigModal / Settings | POST /api/config with partial body → get back merged config | Save setting; verify persisted + applied (e.g. font size changes live) |
| 16 | Manage pins (set/clear/re-match) | Pin picker modal or re-match action | POST /api/pins with {id, transcriptPath} or {all: true} → updated pins map | Pin a transcript; verify binding persists; "Re-match all" clears pins |
| 17 | Browse/list skills | CommandPalette or inline slash menu | GET /api/skills (optionally with ?id=<sessionId> for project scope) | Invoke skill browser; verify skill list populates |
| 18 | Fetch skill detail (for display/invocation) | CommandPalette skill panel | GET /api/skill?name=<name>&id=<sessionId> → frontMatter + body | Click skill; verify description/body renders |
| 19 | Invoke skill (dispatch into composer) | CommandPalette → inject text | (via `reply` after fetching skill text — no separate invoke endpoint) | Select skill; verify inserted into composer as prefix/template |
| 20 | Subscribe to push notifications | PWA settings / browser prompt | POST /api/push/subscribe with PushSubscriptionJSON | Grant permission; verify subscription stored + future push received |
| 21 | Unsubscribe from push notifications | PWA settings | POST /api/push/unsubscribe with {endpoint} | Unsubscribe; verify subscription removed |
| 22 | Transcript search (in-session) | TranscriptSearch (⌘/) | (client-side array search; no server endpoint) | Open search (⌘/); type query; verify results filter transcript |
| 23 | Restart the service | ConfigModal / Settings | POST /api/restart (if service is supervised) | Click restart; verify server restarts + reconnect prompt |
| 24 | Update the service | UpdateBanner or ConfigModal | POST /api/update → spawns self-update.sh detached | Click "update now"; verify server pulls/rebuilds/restarts |
| 25 | Request shell capture | TerminalPane shell text input | `shell-capture` WS message → shell.shellCapture → stdout text | (Internal: sends shell-capture WS to get output) |
| 26 | Send shell text | TerminalPane input | `shell-text` WS message → shell input dispatcher | (Internal: types into shell via sendText) |
| 27 | Send shell keystroke | (internal/debug) | `shell-key` WS message → shell keystroke | (Internal: send raw keys to shell) |
| 28 | Capture pane content | RawEventPanel or debug | `capture` WS message → tmux capturePane → raw terminal text | (Internal: scrapes live pane screen) |
| 29 | List processes by CPU | ResourceHud / process monitor | GET /api/ps → array of top N processes | Open process monitor; verify list populates |
| 30 | Kill a process (SIGTERM/SIGKILL) | ResourceHud process row click | POST /api/kill with {pid, signal} | Click kill; verify process terminates |
| 31 | Get version info | UpdateBanner or Settings | GET /api/version → {current, latest, behind, updateAvailable} | Settings page shows version; update banner shows availability |
| 32 | List recent transcripts (for pin picker) | Pin picker modal | GET /api/transcripts → array of TranscriptInfo | Open pin picker; verify transcript list loads |
| 33 | List spawn-agent availability | NewSessionForm agent picker | GET /api/spawn-agents → {agents: [...]} with availability | New session form shows which agents are available/unavailable |
| 34 | List tmux sessions (for new-session host picker) | NewSessionForm tmux-session dropdown | GET /api/tmux/sessions → array of TmuxSessionSummary | New session form host picker shows existing sessions |
| 35 | List agents (for skill browser or collab) | CommandPalette / agents panel | GET /api/agents (optionally with ?id=<sessionId> for project scope) | Agents browser populates; agents available for selection |
| 36 | Request sub-agent transcript load | SubAgentPanel / strip pill click | `subagent-load` WS message → load entry from SubAgentsWatcher | Click agent pill; verify inline transcript loads |
| 37 | Get config | App.tsx on mount + ConfigModal | GET /api/config → {launchCommand, transcriptFontSize, etc.} | Settings modal populates; font size loads from server default |
| 38 | Optimize a prompt (enhance text) | Composer ✨ button | POST /api/optimize with {text, intent} → {optimized, rationale, changes, backend} | Click enhance; verify optimized text + rationale displayed |
| 39 | Transcribe audio (voice-to-text) | VoiceRecorder / audio input | POST /api/transcribe?ext=... with Blob → {ok, text} | Record audio message; verify transcribed text appears |
| 40 | Get PWA VAPID key | usePushNotifications hook | GET /api/push/vapid → {publicKey} | (Internal: fetches key for push subscription) |
| 41 | Upload custom PWA icon | ConfigModal icon uploader | POST /api/icon with raw PNG bytes → {ok, custom: true} | Upload PNG; verify home-screen icon changes |
| 42 | Delete custom PWA icon (reset to default) | ConfigModal icon reset | DELETE /api/icon → {ok, custom: false} | Click reset icon; verify reverts to bundled logo |
| 43 | Serve PWA icon (manifest/home-screen) | (Browser manifest / OS) | GET /api/icon?size=192\|512 (token-free) | (Fetched by OS/browser; not user-driven) |
| 44 | Get health/resource snapshot | App startup or periodic | GET /api/health → {ok, snapshot: {rss, processes, ...}} | (Broadcast automatically to all clients; subscribes to resource events) |
| 45 | Collaboration: list rooms | CollabPanel | GET /api/collab/list → {rooms: [...]} | (MCP-driven; lists open collab rooms) |
| 46 | Collaboration: open room | CollabPanel open button | POST /api/collab/open with {paneId, topic} → {roomId, code} | (MCP-driven; opens a new collab room) |
| 47 | Collaboration: join room | CollabPanel join input | POST /api/collab/join with {paneId, roomId, code} → joined | (MCP-driven; joins existing room) |
| 48 | Collaboration: leave room | CollabPanel leave button | POST /api/collab/leave with {roomId} → left | (MCP-driven; leaves room) |
| 49 | Collaboration: send message | CollabPanel send | POST /api/collab/send with {roomId, paneId, text} → {seq, nudged} | (MCP-driven; sends collab message + nudges idle peers) |
| 50 | Collaboration: read messages | CollabPanel read (long-poll) | GET /api/collab/read?roomId=...&since=...&wait=1 → {messages} | (MCP-driven; polls/waits for new messages) |
| 51 | Collaboration: view members | CollabPanel members view | GET /api/collab/members?roomId=... → {members} | (MCP-driven; shows room members) |
| 52 | Collaboration: view history | CollabPanel history tab | GET /api/collab/history?roomId=... → history | (MCP-driven; shows past messages) |
| 53 | Remote session: mint terminal token (olam) | TerminalPane for remote session | GET /api/olam/terminal-token?id=olam:... → {uiUrl, replayUiUrl} | (Remote session; mints HMAC URLs for terminal access) |
| 54 | Remote session: check liveness (olam) | App.tsx session select + pre-send | GET /api/olam/liveness?id=olam:... → {state: 'live'\|'dormant'\|'unknown'} | (Remote session; on-demand probe before send) |
| 55 | Remote session: steer (olam, hard/soft) | Composer send (remote) | `reply` WS message (with hardSteer flag) → dispatchLiveSteer to org client | (Remote session; routes to cloud dispatch not local tmux) |
| 56 | Remote session: resume dormant session (olam, Phase C) | Composer send (dormant remote) | `reply` WS message → dispatchResume to org client | (Remote session; resumes + sends atomically; Phase C, task C5) |
| 57 | Respond to prompt (promptkey navigation) | AskInline when picker is open | `promptkey` WS message → send key to navigate picker | (Keystroke navigation fallback; internal to answer flow) |
| 58 | Respond to prompt (promptselect via label) | AskInline option click | `promptselect` WS message → map label to keystroke via buildAnswerProgram | (Label-to-keystroke mapping; fallback navigation) |
| 59 | Subscribe to a session's transcript | SessionRail session select | `subscribe` WS message {type: 'subscribe', id} → server pushes `messages` + events | Click session; verify transcript loads + new messages stream |
| 60 | Unsubscribe from a session's transcript | SessionRail session deselect or close | `unsubscribe` WS message {type: 'unsubscribe', id} | Switch sessions; verify old session's subscription closes |
| 61 | Save a Studio screenshot (media capture) | StudioModal screenshot button (D3) | POST /api/media-apps/<name>/captures with {dataUrl} → {path} | (D3: Studio captures screenshots; saves to media root) |
| 62 | List media app versions (D3 multi-version support) | ArtifactPanel media app version picker | GET /api/media-apps/<name>/versions → {versions, latest} | (D3: lists available versions of a media micro-app) |
| 63 | Report client error | ErrorBoundary or console errors | POST /api/client-error with error details | (Background: error logged on server; not user-driven) |

**Total Actions: 63**

**Actions discovered beyond minimum list:**
- Sub-agent/agent loading and viewing (36)
- Collaboration suite (45-52)
- Remote session control (53-56)
- Prompt navigation fallbacks (57-58)
- Studio/media app support (61-62)
- Client error reporting (63)
- Prompt/keystroke navigation (promptkey, promptselect, 57-58)
- Media app capture/versions (61-62)
- Health/resource monitoring (44)
- Process monitor (29-30)
- Config retrieval on mount (37)
- Prompt optimization (38)
- Audio transcription (39)
- PWA icon management (41-43)

