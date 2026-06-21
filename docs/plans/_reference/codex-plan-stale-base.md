# Codex CLI Agent Parity — Deep Plan

**Date:** 2026-06-21
**Repo:** `/Users/ernie/Projects/claude-control-wt/phone-suite` (branch `feat/phone-suite`)
**Status:** Phase 0a gate PASSED (2026-06-21). Phase 0 (adapter seam) IMPLEMENTED — behavior-preserving, suite green. Phases 1+ pending.
**Confidence:** 89/100 (autonomous threshold 85 NOW MET — clears the bar, proceeds without checkpoint). Was 80 pre-gate. The single unknown that held it below threshold — whether the Codex approval-prompt TUI surface is stable and anchorable enough to build first-class answering against — is RETIRED by the Phase 0a spike (gate PASSED on Codex CLI `v0.131.0-alpha.4`, evidence in `test/fixtures/codex/`). All three approval modals proved to share ONE structurally-uniform numbered-select surface; reasoning-encryption and the full rollout JSONL type/payload taxonomy were confirmed against live data. The day-one full-parity directive is therefore feasible as specified, not a bet on an unstable surface. Residual −11 is ordinary execution risk across P1–P6 (Codex discovery cost, spawn-validation hardening, FE), each independently revertable per §9 — no remaining load-bearing unknown.

**Decisions folded in (Ernest, 2026-06-21):**
1. **Codex answering = FULL PARITY, day one.** No reply-only MVP. Codex must match Claude's AskUserQuestion. This makes the approval-prompt shape a **gating prerequisite spike (Phase 0a)**, and makes the Codex approval-prompt parser + answer-key builder first-class deliverables. See §11 #1.
2. **Normalization = SERVER-SIDE** (locked). Codex JSONL → shared `Block` union in the Node adapter. `web/src/lib/convert.ts` is untouched. See §11 #2.
3. **Spawn UX = FULL PICKER** (not minimal). Session + cwd + agent-type picker before spawn, symmetric for Claude/Codex. See §11 #3 and expanded Phase 3 / Phase 5.

---

## 0. Objective

Bring OpenAI Codex CLI to feature parity with Claude Code inside `claude-control`:
discovery, live transcript streaming, reply input, prompt answering, attachments,
pane capture — **plus** a net-new capability the user explicitly asked for:
*spawning* a Codex (and, for symmetry, a Claude) session into a tmux pane from
the UI.

The central design decision is the **agent-adapter seam**: extract the Claude-specific
logic now scattered across `lib/sessions.js`, `lib/transcript.js`, `lib/answer.js`,
`lib/tui.js` behind a single `AgentAdapter` interface, then add a `CodexAdapter`
alongside. ONE seam, not a duplicated module tree, not a speculative plugin framework.

---

## 1. Codex runtime reality (verified — do not re-derive)

| Fact | Implication for the plan |
|------|--------------------------|
| `codex` (no subcommand) = interactive TUI; `codex [PROMPT]` seeds a prompt; `-C/--cd <DIR>` sets cwd; `-m/--model`; `-c key=val` TOML override. | Spawn command builder: `codex -C <cwd> [-m <model>]`, args array only. |
| Transcript path: `~/.codex/sessions/YYYY/MM/DD/rollout-<ISO>-<uuid>.jsonl`. Date-sharded, **not** cwd-encoded dirs. | Claude's `byDir(encodeCwd)` walk does NOT apply. Codex discovery = recursive bounded scan of recent date dirs (today + yesterday), index by cwd. |
| `session_meta` is the **first** JSONL line: `{ id, timestamp, cwd, originator, cli_version, source, model_provider }`. cwd appears ONCE, not per-record. | cwd via a small **head**-read (first line), NOT a tail-read. `lastActivity` from file mtime or last record timestamp. |
| JSONL schema fundamentally different. Top-level `{ timestamp, type, payload }`; `type ∈ {session_meta, event_msg, response_item, turn_context}`; payload has its own `.type`. | Need a Codex-specific `parseRecord`. Mapping in §5. |
| `event_msg/user_message {message}` and `event_msg/agent_message {message,phase}` are CLEAN text. | Primary normalized text source. |
| `response_item/reasoning {summary[], encrypted_content}` — reasoning is **encrypted**; only `summary[]` (often empty) is plaintext. | Cannot render thinking like Claude. Emit a `thinking` block from `summary` text, else a `"reasoning (hidden)"` placeholder. |
| `response_item/function_call {name, arguments(JSON str), call_id}` + `function_call_output {call_id, output}`; `custom_tool_call {name, input, call_id}` (e.g. `apply_patch`) + `custom_tool_call_output`. | Map to `tool_use` / `tool_result` blocks keyed by `call_id`. |
| `turn_context {cwd, model, approval_policy, sandbox_policy, personality}`. | Map `turn_context.model` → session model. |
| `event_msg/token_count {rate_limits, used_percent}`. Codex has **no** `ctx:%` TUI string. | Derive a ctx-like indicator from `token_count.used_percent` (transcript-driven), not from `parseTuiStatus`. |
| Live `codex` pane: `pane_current_command === 'codex'` (not a version number). | `isClaudeCmd` won't match. Need `isCodexCmd(cmd) === 'codex'`. |
| **Prompt-answering is the GATING dependency.** Codex has NO `AskUserQuestion` tabbed picker. Its blocking interactions are **approval prompts** (`approval_policy: on-request`) for command exec / patch apply — yes/no/always + free text. The live approval prompt is **TUI-only** — it is NOT in the rollout JSONL. | Day-one full parity is now REQUIRED (Ernest). The exact rendered shape + selecting keystrokes are captured by the **Phase 0a gating spike** via live `capture-pane`, producing a fixture/spec the adapter targets. Free-text reply (`send-keys -l` + Enter) is no longer the deliverable — it is only a degraded fallback if the spike proves the shape unstable (kill-criteria, §11 #1). |
| The `codex-cli-runtime` skill is about `codex-companion.mjs task` for the codex-rescue **subagent** (non-interactive forwarding). | NOT relevant to interactive driving. Do not conflate. |

---

## 2. Verified codebase seams (confirmed by reading the files)

- **`lib/transcript.js`**: `parseRecord(line)` is a module-level function imported and
  called directly inside `TranscriptTailer._initialLoad` and `_readIncremental`.
  `_trackPending(msg)` **hardcodes** `block.name === 'AskUserQuestion'`. ⇒ TranscriptTailer
  must accept an injected `{ parseRecord, trackPending }` from the adapter. **Highest-churn file #1.**
- **`lib/sessions.js`**: `_buildTranscriptIndex()` hardcodes the `projectsRoot` immediate-subdir
  walk + tail-read; the final `refresh()` filter is `isClaudeCmd(s.cmd) || s.transcriptPath`;
  builds the session object with `isClaude: true` hardcoded; `_pollCtx` calls `parseTuiStatus`.
  ⇒ `SessionRegistry` must iterate a list of adapters for discovery and tag `agentType`.
  **Highest-churn file #2.**
- **`server.js`**: NO session-spawn logic exists. The only `spawn()` (line 185) is the
  self-update script. ⇒ "spawn a Codex session" is **net-new**; there is also no Claude
  spawn path today. WS client msgs: `subscribe/unsubscribe/reply/answer/capture`; server
  msgs: `sessions/messages/append/pending/resources/capture/ack`. `reply` and `capture`
  are already agent-agnostic (`tmux.sendText` / `tmux.capturePane`). `answer` calls
  `buildAnswerProgram` directly — must route through the adapter.
- **`lib/tmux.js`**: `sendText` (send-keys -l literal + Enter), `sendRawKeysSequenced`
  (130ms delay), `capturePane`, `listWindows` (incl `pane_current_command`), `isValidTarget`
  (`^[A-Za-z0-9_.-]+:\d+(\.\d+)?$`). All reusable as-is. Spawn needs new `newWindow`/`newSession` helpers.
- **`web/src/lib/convert.ts`**: agent-AGNOSTIC. Consumes the normalized `Block` union
  (`text|thinking|tool_use|tool_result`) only. **If normalization stays server-side, convert.ts
  needs ZERO changes.** This is the decisive argument for server-side normalization (§11 blocker #2).
- **`web/src/lib/types.ts`**: `Session` has no `agentType`; the normalized `Block`/`Msg`/`Pending`
  shapes are identical to the server's. Adding `agentType` + a badge is the only required FE change.

**STALE-DOC DRIFT (flag + fix):** `CONTRACT.md` describes the old vanilla `public/` UI. `server.js`
(lines 26–29) prefers `web/dist` (the React/Vite app under `web/src`) and only falls back to `public/`.
The served UI is `web/dist`. CONTRACT must be rewritten to document `web/src` as authoritative and
note `public/` as the fallback. Tracked as a task in Phase 6.

---

## 3. The AgentAdapter seam (RECOMMENDED — justification in §9)

New file **`lib/agents/adapter.js`** defining the interface; **`lib/agents/claude.js`**
(extracted from current code, behavior-preserving); **`lib/agents/codex.js`** (new);
**`lib/agents/index.js`** exporting an ordered `ADAPTERS` array.

### 3.1 Interface sketch (JSDoc — this is an ESM/JS repo, no TS in `lib/`)

```js
/**
 * @typedef {Object} DiscoveredTranscript
 * @property {string} cwd
 * @property {string|null} sessionId
 * @property {string|null} lastActivity     ISO ts or null
 * @property {string|null} model            raw model id
 * @property {string|null} customTitle
 * @property {string|null} aiTitle
 * @property {string} transcriptPath
 * @property {number} mtime
 * @property {boolean} transcriptPending
 * @property {string|null} pendingToolUseId
 * @property {string|null} pendingQuestion
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {'claude'|'codex'} id
 *
 * // ---- discovery ----
 * // Is this tmux pane process THIS agent? (claude: version regex; codex: === 'codex')
 * @property {(cmd: string) => boolean} matchesProcess
 * // Build a cwd-indexed map of recent transcripts. Adapter owns WHERE to look
 * // (claude: projectsRoot subdir walk + tail-read; codex: ~/.codex/sessions recent
 * // date dirs + head-read of session_meta) and HOW to bound reads (resource doctrine).
 * @property {(roots: {projectsRoot:string, codexSessionsRoot:string}) =>
 *            Promise<{ byCwd: Map<string,DiscoveredTranscript>, byDir?: Map<string,DiscoveredTranscript> }>}
 *            buildTranscriptIndex
 * // Reconcile a tmux window against the index → matched transcript or null.
 * @property {(win, index) => DiscoveredTranscript|null} matchWindow
 *
 * // ---- transcript tailing (injected into TranscriptTailer) ----
 * // line → NormalizedMessage|null
 * @property {(line: string) => (import('../transcript.js').NormalizedMessage|null)} parseRecord
 * // Update a pending-map from a parsed msg (claude: AskUserQuestion ids;
 * // codex: approval-prompt detection — may be a no-op if approvals come only via capture-pane).
 * @property {(msg, pendingMap: Map) => void} trackPending
 *
 * // ---- discovery-time pending (tail/head scan, no live tailer) ----
 * @property {(lines: string[]) => {transcriptPending:boolean, pendingToolUseId:string|null, pendingQuestion:string|null}}
 *            detectTranscriptPending
 *
 * // ---- input ----
 * // Build the spawn argv (NO shell; args array). claude: ['claude'] / codex: ['codex','-C',cwd,...]
 * @property {(opts:{cwd:string, model?:string}) => {bin:string, args:string[]}} buildSpawnCommand
 * // Build the keystroke program to answer a pending prompt.
 * // claude: number-key picker (buildAnswerProgram); codex: y/n or arrow+Enter for approvals.
 * @property {(pending, selections) => string[]} buildAnswerProgram
 *
 * // ---- status ----
 * // Parse model + ctx% from a capture-pane dump (claude: ctx:% regex; codex: returns nulls,
 * // ctx derived from token_count instead — see deriveStatusFromTranscript).
 * @property {(capture:string) => {ctxPct:number|null, model:string|null}} parseTuiStatus
 * // Optional: derive ctx%/model from the transcript when the TUI has no status line.
 * @property {(transcript:DiscoveredTranscript|null) => {ctxPct:number|null, model:string|null}} [deriveStatusFromTranscript]
 */
```

### 3.2 What MOVES behind the interface vs STAYS shared

| Moves (per-adapter) | Stays shared (mechanics) |
|---------------------|--------------------------|
| `parseRecord` | `readTail` / `readRange` byte-bounded helpers (transcript.js) |
| `_buildTranscriptIndex` body | `TranscriptTailer` watch/offset/debounce/trim machinery |
| `isClaudeCmd` → `matchesProcess` | `tmux.sendText` / `sendRawKeysSequenced` / `capturePane` / `listWindows` / `isValidTarget` |
| `detectTranscriptPending` | `SessionRegistry` reconciliation loop, dedup, `_maybeEmit`, `setPending` |
| `_trackPending` | server WS plumbing (`subscribe`/`append`/`pending`/`capture`), push edge-detect |
| `buildAnswerProgram` | uploads, resources, version, static serving |
| `parseTuiStatus` / `prettyModel` | the normalized `Block`/`Msg` model + `convert.ts` |
| spawn command builder (new) | new shared `tmux.newWindow`/`newSession` (mechanics) |

---

## 4. Phased plan

Tiers: **trooper** (mechanical, well-specified), **specialist** (domain judgement —
parser/discovery), **officer** (architecture/seam/risk).

**GATING ORDER (changed by decision #1):** Phase 0a is the top execution risk and the
gate for the whole feature. It must run **before** P4 and **before** heavy P2/P3 build
investment — there is no point hardening a parser/answer path against a prompt shape we
have not captured, and no point building the full spawn picker if the feature is killed
at the gate. Sequence: **P0 → P0a (gate) → P1/P2 → P3 → P4 → P5/P6.** P1 (discovery) and
the metadata half of P2 (parseRecord for non-approval records) may proceed in parallel
with P0a since they do not depend on the approval shape; the approval-specific tasks
(2.3, 4.x) are downstream of P0a.

### Phase 0 — Adapter scaffold + Claude extraction (behavior-preserving) — ✅ IMPLEMENTED (2026-06-21)

**Outcome:** seam landed, behavior preserved, suite GREEN (35 pass / 0 fail, unchanged from baseline).
Files added: `lib/agents/adapter.js` (interface), `lib/agents/index.js` (registry: `ADAPTERS`,
`adapterFor`, `adapterById`, `DEFAULT_ADAPTER`), `lib/agents/claude.js` (`ClaudeAdapter`),
`lib/pending.js` (canonical `detectTranscriptPending`), `lib/transcript-index.js` (shared tail-read +
`buildClaudeTranscriptIndex`). Files changed: `lib/transcript.js` (inject `parseRecord`/`trackPending`,
default to local impls — no agents import, avoids cycle), `lib/sessions.js` (iterate `ADAPTERS` for
discovery, `adapterFor` filter, `agentType` tag, re-export `detectTranscriptPending` for test-import
back-compat). `server.js` untouched. Circular-import (`sessions → index → claude → sessions`) broken by
the two neutral shared modules. **Deviations from the §3.1 sketch:** (1) only the 8 methods the runtime
calls are live (`matchesProcess`, `buildTranscriptIndex`, `parseRecord`, `trackPending`,
`detectTranscriptPending`, `buildAnswerProgram`, `parseTuiStatus`, `prettyModel`); `buildSpawnCommand` /
`matchWindow` / `deriveStatusFromTranscript` are JSDoc-only placeholders deferred to their owning phases
(anti-speculation). (2) `matchWindow` NOT extracted — the `refresh()` byDir/byCwd reconciliation stays
inline (Claude-specific dir-encoding logic); Codex will populate `byCwd` only and the inline merge already
handles it. (3) `_pollCtx` still calls `tui.js` directly rather than routing through the adapter — pure
churn-minimisation; the adapter exposes `parseTuiStatus` for when Codex needs `deriveStatusFromTranscript`.

---

Goal (historical): introduce the seam with ZERO behavior change. All existing tests stay green.

| Task | File | Tier | Size |
|------|------|------|------|
| 0.1 Define `AgentAdapter` JSDoc typedef + `NormalizedMessage` export | `lib/agents/adapter.js` (new) | officer | S |
| 0.2 Extract Claude logic into `ClaudeAdapter` (re-export existing `parseRecord`, `detectTranscriptPending`, `isClaudeCmd`→`matchesProcess`, `buildAnswerProgram`, `parseTuiStatus`; new `buildTranscriptIndex` wrapping the projectsRoot walk; `buildSpawnCommand`→`{bin:'claude',args:[]}`) | `lib/agents/claude.js` (new) | specialist | M |
| 0.3 `ADAPTERS` registry (ordered: claude, codex) + `adapterFor(cmd)` + `adapterById(id)` | `lib/agents/index.js` (new) | officer | S |
| 0.4 Inject `{parseRecord, trackPending}` into `TranscriptTailer` ctor (default to Claude adapter for back-compat); replace hardcoded `parseRecord` calls + `_trackPending` AskUserQuestion logic with injected fns | `lib/transcript.js` | officer | M |
| 0.5 `SessionRegistry` iterates `ADAPTERS` for discovery: merge per-adapter `buildTranscriptIndex`, tag each session `agentType` + keep `isClaude` (derived `agentType==='claude'`) for back-compat; filter `adapter.matchesProcess(cmd) || transcriptPath` | `lib/sessions.js` | officer | L |

**Verify P0:** all existing node:test (`transcript.test.js`, `answer.test.js`, `push-pending.test.js`,
`tui.test.js`, `fixes.test.js`, `uploads.test.js`) pass unchanged; all `web/src/lib/*.vitest.ts` pass.
This phase is a pure refactor — green tests are the proof.

### Phase 0a — Codex approval-prompt CAPTURE SPIKE (GATING) — ✅ RESOLVED: GATE PASSED (2026-06-21)

**Gate outcome:** PASSED on Codex CLI `v0.131.0-alpha.4`. Captured evidence committed under
**`test/fixtures/codex/`**: `APPROVAL-SHAPES.md` (the modal-structure + JSONL-taxonomy writeup),
`approval-prompts.spec.json` (the parser/answer contract), `sample-rollout.jsonl` (scrubbed live
rollout sample), and `pane-*.txt` (raw `capture-pane` dumps of each blocking prompt). The
load-bearing feasibility risk (could full-parity Codex answering be built at all) is **retired**.

**Authoritative findings folded in:**
- **All three approval modals share ONE structure** (directory-trust at session start, `exec_command`,
  `apply_patch`): heading question line → optional body (command echoed after `$ ` / a mini-diff) →
  contiguous `N. label (key)` option lines with `›` (U+203A) marking the highlighted default → footer
  (`Press enter to confirm or esc to cancel`; the trust modal uses `Press enter to continue` and has no
  per-option `(key)` shortcut). A parser anchoring on (heading) + (contiguous `^\s*[›\s]\s*\d+\.\s+…(?:\s+\(\w+\))?$`
  option lines) + (footer hint) handles every variant. Option 2's label is dynamic (echoes the command
  prefix / "these files") — anchor on the `N. … (key)` STRUCTURE, never on option text.
- **Answerable three ways:** number key, the parenthetical `(y/p/a/esc)` shortcut char, or arrows+Enter
  (Enter confirms the highlighted option; Esc cancels ≈ the "No" option).
- **Approval gates are TUI-ONLY** — absent from rollout JSONL. JSONL carries the *proposed* action and its
  *post-approval result* only: `function_call` (name `exec_command`, `arguments` = JSON string `{cmd, workdir, …}`,
  `call_id`) + `function_call_output` (matched by `call_id`); `apply_patch` is a `custom_tool_call` +
  `custom_tool_call_output` / `patch_apply_end`. Reasoning items are **encrypted** (`encrypted_content` set,
  `summary: []`, `content: null` → render a placeholder, never raw bytes). **Therefore: pending-approval
  detection = `capture-pane` (Phase 2.3 `detectPendingFromCapture`); resolved history = JSONL.** This is
  exactly the seam the plan drew.

**Gate decision (0a.4):** PROCEED to full-parity build. Tasks 2.3 (`detectPendingFromCapture`) and 4.3
(`CodexAdapter.buildAnswerProgram`) target `approval-prompts.spec.json`; no kill-criterion triggered.

---

Goal (historical, for context): de-risk the day-one full-parity requirement (decision #1) by capturing the EXACT
rendered shape of every blocking Codex approval prompt and the precise keystrokes that
select each option, BEFORE building the parser/answer path. The output is a committed
fixture/spec file that the Codex pending-detection + answer-key builder target. **The
feature is gated on this spike succeeding** — kill-criteria below.

| Task | File | Tier | Size |
|------|------|------|------|
| 0a.1 Spawn a real `codex` session in tmux with `approval_policy: on-request` (and matching `sandbox_policy`). Drive it (manually or scripted via `send-keys`) to trigger each representative blocking prompt: **(a) command-exec approval, (b) file-write / `apply_patch` approval, (c) any multi-option prompt** (e.g. yes / no / always / edit). | (live tmux; no repo file) | officer | M |
| 0a.2 `capture-pane -p` each prompt at the moment it blocks. Record: exact rendered layout (lines, framing, option labels, highlighted/selected default), whether selection is **y/n/letter keypress** vs **arrow + Enter**, and the precise keystroke sequence that commits each option. Cross-check against ≥2 Codex `cli_version`s if available to gauge stability. | (capture logs) | specialist | M |
| 0a.3 Author a **fixture/spec** of captured prompt shapes: for each prompt kind, the matching signature (regex/anchors a parser keys on), the option set, and the keystroke program per option. This is the contract the adapter implements against. | `test/fixtures/codex/approval-prompts.spec.json` (new) + `test/fixtures/codex/capture-*.txt` (new) | specialist | M |
| 0a.4 GATE DECISION (officer): is the shape **stable and parseable**? If yes → proceed to full-parity build (2.3, 4.2, 4.3 target this spec). If the shape is unstable across versions / ANSI-noisy / ambiguous to anchor on → trigger kill-criteria (§11 #1): escalate to Ernest with the captures, do NOT silently downgrade. | (decision record in plan/PR) | officer | S |

**Verify P0a:** the spec file exists and contains, for each of the three prompt kinds, a
non-empty match signature + option set + per-option keystroke program, each traceable to a
committed `capture-*.txt`. The gate decision (proceed / kill) is recorded explicitly. No
parser code is written in this phase — this phase produces the *target* the parser is built
against.

### Phase 1 — Codex discovery — specialist

| Task | File | Tier | Size |
|------|------|------|------|
| 1.1 `CodexAdapter.matchesProcess(cmd) === 'codex'` | `lib/agents/codex.js` (new) | trooper | S |
| 1.2 `buildTranscriptIndex`: recursive bounded scan of `~/.codex/sessions/<YYYY>/<MM>/<DD>` for **today + yesterday only**; per rollout, **head-read** first line (`session_meta`) for cwd/sessionId/cli_version; `lastActivity` from file mtime; index `byCwd`. NEVER read whole files. | `lib/agents/codex.js` | specialist | L |
| 1.3 `matchWindow`: reconcile by exact cwd (Codex has no dir-encoding); fall back to descendant-cwd consistency reusing `isCwdConsistent`. | `lib/agents/codex.js` | specialist | M |
| 1.4 New config: `CLAUDE_CONTROL_CODEX_SESSIONS` (default `~/.codex/sessions`), pass `codexSessionsRoot` through `SessionRegistry` ctor + `server.js` CONFIG | `server.js`, `lib/sessions.js` | trooper | S |

**Verify P1:** new `test/codex-discovery.test.js` — fixture date-dir tree under `test/fixtures/codex/`,
assert cwd index built from `session_meta` head-read, assert only today/yesterday scanned, assert no
full-file read (spy on read size ≤ a small head cap). Manual: run a real `codex` in tmux, confirm it
appears in `/api/sessions` with `agentType:'codex'`.

### Phase 2 — Codex transcript parsing → normalized model — specialist

| Task | File | Tier | Size |
|------|------|------|------|
| 2.1 `CodexAdapter.parseRecord(line)`: top-level `{type,payload}` dispatch. `event_msg/user_message`→user text block; `event_msg/agent_message`→assistant text block; `response_item/reasoning`→`thinking` block (`summary[]` join, else `"reasoning (hidden)"`); `function_call`/`custom_tool_call`→`tool_use` (name+parsed args, keyed `call_id`); `*_output`→`tool_result` (forId=`call_id`); `session_meta`/`turn_context`/`token_count`/`task_*`→null (metadata, not messages). | `lib/agents/codex.js` | specialist | L |
| 2.2 `deriveStatusFromTranscript`: model from latest `turn_context.model`; ctx% from latest `token_count.used_percent`. | `lib/agents/codex.js` | specialist | M |
| 2.3 **Codex pending-detection (first-class, gated on P0a spec).** Because the approval prompt is TUI-only and absent from JSONL, pending-detection is **capture-pane-driven**: a `detectPendingFromCapture(capture)` that matches the approval signatures from `approval-prompts.spec.json` and returns `{transcriptPending, pendingKind, options[]}`. The transcript-scan `detectTranscriptPending` becomes a weak secondary hint (an open `function_call`/`custom_tool_call` with no matching `*_output` suggests a likely block) used to decide WHEN to capture, not to render the prompt. This is parity with how Claude surfaces a pending — same `Pending` shape out. | `lib/agents/codex.js` | specialist | L |
| 2.4 Commit a small **real** rollout sample (scrub any cwd/paths to a placeholder) | `test/fixtures/codex/rollout-sample.jsonl` (new) | trooper | S |

**Verify P2:** `test/codex-transcript.test.js` — feed the fixture rollout through `parseRecord`, assert
user/assistant/thinking/tool_use/tool_result blocks match expected normalized output; assert metadata
records return null; assert encrypted reasoning yields a placeholder not raw bytes.

### Phase 3 — Spawning: FULL PICKER (net-new, symmetric Claude+Codex) — officer

Decision #3: ship the full picker, not the minimal current-session new-window. The picker
selects **(1) target tmux session, (2) working directory (cwd), (3) agent type
(claude | codex)** before spawning. Server endpoints + a frontend picker component (Phase 5)
+ validation are all in scope. Spawning stays symmetric across agents — one adapter-driven
code path.

**Server side:**

| Task | File | Tier | Size |
|------|------|------|------|
| 3.1 `tmux.newWindow({sessionName, cwd, bin, args, windowName})` + `tmux.newSession({sessionName, cwd, bin, args})` — `execFile`/`spawn` args array ONLY, no shell interpolation; return the new `target` (`session:window`). Window/session names validated against the existing `isValidTarget` charset. | `lib/tmux.js` | officer | M |
| 3.2 **Picker-feed endpoint(s)** the frontend reads to populate the picker: **(a)** `GET /api/tmux/sessions` (or WS `{type:'listTmux'}`) → existing tmux session names + their attached cwd hints, so the user can target an existing session; **(b)** `GET /api/agents` → the registered adapter ids (`['claude','codex']`) + which binaries actually resolve on this host (so unresolvable agents are disabled in the picker). Reuse `tmux.listWindows`; binary resolution via `which`-style check against `CLAUDE_CONTROL_CODEX` / `claude`. | `server.js` | officer | M |
| 3.3 **Spawn WS msg** `{type:'spawn', agent:'claude'|'codex', target:{mode:'newWindow', sessionName} | {mode:'newSession', sessionName}, cwd, model?, windowName?}`. Validate (server-authoritative — never trust the picker): `agent` ∈ adapter ids AND its binary resolves; `cwd` realpath’d, absolute, no `..`, must exist and be a directory; `sessionName`/`windowName` match `isValidTarget` charset; `newWindow` requires an existing session, `newSession` requires the name be free; `model` charset-restricted. Resolve adapter, `buildSpawnCommand({cwd,model})`, call `tmux.newWindow`/`newSession`, force `registry.refresh()`, ack with the new target. | `server.js` | officer | L |
| 3.4 Server ack `{type:'ack', op:'spawn', ok, target?, error?}`; on success the new session surfaces through the normal discovery/refresh path and is immediately subscribable. | `server.js` | officer | S |

**Validation contract (server-authoritative, non-negotiable):**
- **cwd:** `fs.realpathSync` + `statSync().isDirectory()`; reject relative, `..`, symlink-escape, nonexistent.
- **binary resolvable:** the selected agent’s bin (`CLAUDE_CONTROL_CODEX` / fixed `claude`) must resolve to an executable; otherwise reject with a clear error (and the picker should have disabled it — defense in depth, both sides validate).
- **session/window naming:** `isValidTarget` charset only; `newWindow` requires the target session to exist; `newSession` requires the chosen name not already exist.
- **no shell:** `execFile`/`spawn` with an args array only; never a shell string; `model` charset-restricted.
- Bind stays 127.0.0.1; token gate already covers WS + the new picker-feed endpoints.

**Verify P3:** `test/spawn-command.test.js` — `buildSpawnCommand` for both adapters yields expected
`{bin,args}`; validation rejects `..`, relative, nonexistent, non-dir, shell-meta cwd; rejects unknown
agent; rejects unresolvable binary; rejects bad session/window names; `newSession` rejects a name that
already exists; `newWindow` rejects a missing session. `test/picker-feed.test.js` — list-tmux + list-agents
endpoints return the expected shape and correctly flag unresolvable agents. Manual: from the UI picker,
spawn a Codex session into a new window of an existing session AND into a brand-new session; confirm both
appear in the rail with `agentType:'codex'` and are subscribable; repeat for Claude.

### Phase 4 — Input / answers / attachments — specialist

| Task | File | Tier | Size |
|------|------|------|------|
| 4.1 `reply` already works for Codex (`tmux.sendText`). Confirm with a test that the WS `reply` path is agent-agnostic (no Claude assumption). | `test/fixes.test.js` (extend) | trooper | S |
| 4.2 Route `answer` through `adapterById(session.agentType).buildAnswerProgram`. Claude path unchanged. Codex path is **first-class, full parity**: server pairs the live pending (from 2.3 capture detection) with the user’s selection and emits the keystroke program. No reply-only branch in the happy path — reply-only exists only as the §11 #1 kill-fallback if the P0a gate failed. | `server.js` | officer | M |
| 4.3 **`CodexAdapter.buildAnswerProgram` (first-class, parity with Claude’s `lib/answer.js`).** Given a pending (kind + option set from the P0a spec) and a selection, emit the exact keystroke program — `y`/`n`/letter keypress OR arrow+Enter, per the captured shape — via `sendRawKeysSequenced` (NOT number keys). Mirrors `buildAnswerProgram`’s role for Claude: deterministic, table-driven from `approval-prompts.spec.json`, unit-testable without a live session. | `lib/agents/codex.js` | specialist | L |
| 4.4 Attachments: upload dir + path injection already works unchanged (Codex reads the injected path from a reply). No code change; add a doc note + a test asserting the upload→reply path is agent-neutral. | `test/uploads.test.js` (extend) | trooper | S |

**Verify P4:** `test/codex-answer.test.js` drives `buildAnswerProgram` against the `approval-prompts.spec.json`
fixture from P0a: for each prompt kind, each option maps to the exact captured keystroke program; an
unknown/option-out-of-set selection is rejected. `detectPendingFromCapture` is tested against the committed
`capture-*.txt` fixtures (matches → correct `{pendingKind, options}`; non-prompt captures → no pending).
Manual: drive a real approval prompt end-to-end (capture → pending in UI → user selects → keystroke sent →
Codex proceeds) for all three prompt kinds. Reply-path agnosticism (4.1) and upload neutrality (4.4) as before.

### Phase 5 — Frontend (badge + agentType) — trooper

| Task | File | Tier | Size |
|------|------|------|------|
| 5.1 Add `agentType?: 'claude'|'codex'` to `Session`; add the picker-feed response types (tmux sessions, agents+resolvable flag); add `{type:'spawn', agent, target, cwd, model?, windowName?}` to `ClientMessage`; add `op:'spawn'` ack handling. | `web/src/lib/types.ts` | trooper | S |
| 5.2 Agent badge/icon in SessionRail (Claude vs Codex). **Codex approval UI = full parity** with Claude’s pending flow: render the captured option set (yes / no / always / …) as selectable actions wired to the `answer` path (§4.2), not a hardcoded yes/no. Reuses the existing pending/answer plumbing; differs only in option source (P0a spec) and that it’s a confirm-style set rather than AskUserQuestion tabs. Reply composer remains available, not the primary answer mechanism. | `web/src/components/*`, `web/src/App.tsx` | specialist | M |
| 5.3 **Spawn picker component (FULL — decision #3).** A `SpawnPicker` with three controls: **(1) target tmux session** (existing session dropdown from `GET /api/tmux/sessions`, plus a "new session" option with a name field), **(2) working directory** (text/path input, optionally seeded from a selected session’s cwd; client-side presence check is advisory only — server is authoritative), **(3) agent type** (claude | codex; agents whose binary does not resolve per `GET /api/agents` are disabled with a tooltip). On submit, send the `spawn` WS msg and surface the ack (success → the new session appears in the rail; error → inline message). **Where it hangs:** a "+" / "New agent" affordance at the top of the SessionRail (the rail is the session-management surface), opening the picker as a popover/modal. Symmetric for both agents. | `web/src/components/SpawnPicker.tsx` (new), `web/src/components/SessionRail.tsx`, `web/src/App.tsx` | specialist | L |

**No `convert.ts` change (decision #2 — locked).** Normalization is **server-side**: the Codex
adapter emits the shared `Block` union (`text|thinking|tool_use|tool_result`) and `convert.ts`
already consumes that union agnostically (confirmed by reading the file). The converter is not
touched in any phase of this plan.

**Verify P5:** `web/src/lib/*.vitest.ts` — badge renders per `agentType`; a Codex session with
tool_use/thinking blocks renders through the **unchanged** converter; the Codex approval UI renders
the captured option set and dispatches the correct `answer`; `SpawnPicker` disables unresolvable
agents, requires a valid session/cwd selection, and emits a well-formed `spawn` msg.

### Phase 6 — Config, docs, drift fix — trooper

| Task | File | Tier | Size |
|------|------|------|------|
| 6.1 Document `CLAUDE_CONTROL_CODEX` (binary override) + `CLAUDE_CONTROL_CODEX_SESSIONS`. | `README.md` | trooper | S |
| 6.2 **Fix the stale-doc drift:** rewrite `CONTRACT.md` to document `web/dist`/`web/src` as the served UI, `public/` as fallback; document the picker-feed endpoints (`/api/tmux/sessions`, `/api/agents`), the full `spawn` WS msg shape (`agent`, `target.mode`, `cwd`, `model?`, `windowName?`) + its `op:'spawn'` ack, the `agentType` field, the Codex approval-prompt/answer contract, and multi-agent discovery. | `CONTRACT.md` | specialist | M |
| 6.3 Multi-agent discovery doc (how adapters are registered + how to add a third). | `docs/` | trooper | S |

**Verify P6:** docs reviewed; `verify-change` gate run on the full diff.

---

## 5. Codex JSONL → NormalizedMessage mapping (reference for Phase 2)

| Codex record | Normalized output |
|--------------|-------------------|
| `event_msg/user_message {message}` | `{role:'user', blocks:[{kind:'text',text:message}]}` |
| `event_msg/agent_message {message}` | `{role:'assistant', blocks:[{kind:'text',text:message}]}` |
| `response_item/message {role,content:[{type,text}]}` | role passthrough; `input_text`/`output_text`→`text` block (secondary; prefer event_msg) |
| `response_item/reasoning {summary[],encrypted_content}` | `{kind:'thinking', text: summary.join('') || '⋯ reasoning (hidden)'}` |
| `response_item/function_call {name,arguments,call_id}` | `{kind:'tool_use', id:call_id, name, input:JSON.parse(arguments), inputSummary}` |
| `response_item/function_call_output {call_id,output}` | `{kind:'tool_result', forId:call_id, text:output}` |
| `response_item/custom_tool_call {name,input,call_id}` (e.g. apply_patch) | `{kind:'tool_use', id:call_id, name, input}` |
| `response_item/custom_tool_call_output {call_id,output}` | `{kind:'tool_result', forId:call_id, text:output}` |
| `event_msg/patch_apply_end {changes,unified_diff}` | fold into the matching `apply_patch` tool_result (or its own tool_result) |
| `turn_context {model,...}` | session model (not a message → parseRecord returns null) |
| `event_msg/token_count {used_percent,rate_limits}` | ctx% indicator (not a message → null) |
| `session_meta`, `task_started`, `task_complete`, `web_search_*`, `mcp_tool_call_end` | null (or fold tool variants into tool_use/result as above) |

---

## 6. Resource doctrine (honored throughout)

- Claude discovery: tail-read (≤64KB) — cwd is repeated, lives at file end.
- **Codex discovery: head-read of the FIRST line only** — `session_meta.cwd` lives at the
  start. A small head cap (e.g. ≤8KB) suffices; never tail, never whole-file.
- Codex date-dir scan bounded to **today + yesterday** (configurable), never the full tree.
- Only SUBSCRIBED sessions get a live `TranscriptTailer` (≤1MB initial tail, offset-incremental, fs.watch debounced) — unchanged.
- `capture-pane` stays off the hot path (12s ctx poll); for Codex, prefer transcript-derived
  status over capture-pane parsing since Codex has no ctx:% line.

---

## 7. Tradeoffs — adapter vs scattered branching

**Adapter (RECOMMENDED).**
- Pros: single seam; `TranscriptTailer`/`SessionRegistry`/server plumbing stay agent-neutral;
  adding a third agent = one new file; testable in isolation (parser/discovery/spawn each unit-tested);
  honors the ponytail principle (extract the seam that already exists implicitly, no more).
- Cons: P0 refactor touches the two highest-churn files; must be behavior-preserving (mitigated by
  green existing tests as the gate).

**Scattered `if (agentType==='codex')` branching.**
- Pros: no upfront refactor.
- Cons: branch points multiply across `parseRecord`, `_trackPending`, `_buildTranscriptIndex`,
  `refresh` filter, `answer` handler, `_pollCtx`; every new field re-touches all of them; the
  hardcoded `AskUserQuestion`/`parseRecord` coupling in `TranscriptTailer` becomes permanent.
  Rejected.

**Anti-over-engineering guard:** exactly TWO adapters (claude extracted + codex). No plugin loader,
no dynamic registration, no config-driven adapter discovery. The `ADAPTERS` array is a literal.

---

## 8. Verification plan (consolidated)

| Phase | node:test | vitest | manual |
|-------|-----------|--------|--------|
| 0 | all existing pass unchanged | all existing pass | — |
| **0a (GATE)** | — | — | **live codex in tmux → capture all 3 approval-prompt kinds → commit `approval-prompts.spec.json` + `capture-*.txt`; record proceed/kill gate decision** |
| 1 | `codex-discovery.test.js` | — | real codex in tmux → `/api/sessions` shows `agentType:'codex'` |
| 2 | `codex-transcript.test.js` (fixture); `detectPendingFromCapture` vs `capture-*.txt` | — | live rollout renders in UI |
| 3 | `spawn-command.test.js`, `picker-feed.test.js` | — | picker spawns Codex AND Claude into both a new window of an existing session and a brand-new session |
| 4 | `codex-answer.test.js` (vs P0a spec), extended `fixes`/`uploads` | — | end-to-end live approval answer for all 3 prompt kinds |
| 5 | — | badge + **unchanged**-converter + approval-UI + `SpawnPicker` vitest | both agents render in rail; picker disables unresolvable agents |
| 6 | — | — | `verify-change` on full diff |

Coverage target: ≥80% on new `lib/agents/*` files.

---

## 9. Rollback / kill-criteria

- **P0a gate fails — approval-prompt shape unstable/unparseable** (ANSI-noisy, ambiguous to
  anchor, or differs materially across `cli_version`s): this is the load-bearing kill-criterion.
  Decision #1 mandates full parity, so reply-only is NOT a silent acceptable downgrade — it is a
  **scope change requiring Ernest's sign-off**. The Phase 0a gate (0a.4) surfaces the captures and
  escalates. Options at the gate: (a) pin a minimum supported `codex` version and proceed against
  its captured shape; (b) accept reply-only as a documented, explicitly-approved fallback; (c)
  defer Codex answering entirely (ship discovery + streaming + reply + spawn) until the shape
  stabilizes. **Do not proceed past P0a without recording which option Ernest chose.**
- **P0 not behavior-preserving** (any existing test goes red and can't be made green without
  changing test intent) → revert P0, fall back to scattered branching for Codex-only paths. **Kill the adapter, keep the feature.**
- **Codex discovery cost too high** (date-dir scan adds noticeable latency to the 4s refresh) →
  cache the head-read index by file mtime; if still bad, gate Codex discovery behind a config flag.
- **Spawn security/validation review fails** → spawn is now in-scope (decision #3), but the picker
  + WS `spawn` path remains independently revertable: ship discovery + streaming + reply + answer
  WITHOUT the spawn picker if validation hardening slips. The picker is the last phase to land, so
  this degrades cleanly.

Each phase is independently revertable. The one HARD gate is P0a: full-parity answering is the only
piece whose feasibility is not yet proven, and it is sequenced first so a kill there costs the least.

---

## 10. Stale-doc drift (explicit flag)

`CONTRACT.md` documents the retired vanilla `public/` UI. The real served UI is `web/dist`
(built from `web/src`, the React/Vite app), per `server.js` lines 26–29. Phase 6.2 rewrites
CONTRACT to make `web/src` authoritative and `public/` the documented fallback, and to add the
`spawn` message, `agentType` field, and multi-agent discovery.

---

## 11. Load-bearing blockers — DECIDED (Ernest, 2026-06-21)

All three are resolved. The first was the plan's **top execution risk** (sequenced as the Phase 0a
gate); that gate has now **PASSED** (2026-06-21, Codex CLI `v0.131.0-alpha.4` — evidence in
`test/fixtures/codex/`), retiring the only load-bearing unknown and lifting confidence to 89/100.

1. **Codex answering — DECIDED: FULL PARITY, day one (no reply-only MVP). GATE PASSED — risk retired.**
   The Phase 0a spike captured all three approval modals (directory-trust, `exec_command`, `apply_patch`)
   and confirmed they share ONE stable, anchorable numbered-select structure (heading → optional body →
   `N. label (key)` options with `›` highlight → footer), answerable by number key / `(key)` shortcut /
   arrows+Enter. Approvals are TUI-only (absent from JSONL) exactly as predicted; reasoning is encrypted;
   the rollout type/payload taxonomy is confirmed. Captured evidence: `test/fixtures/codex/APPROVAL-SHAPES.md`,
   `approval-prompts.spec.json`, `sample-rollout.jsonl`, `pane-*.txt`. **No kill-criterion triggered; option
   (a)/(b)/(c) escalation not needed.** The build proceeds against the captured spec (2.3, 4.3). Original
   risk note retained below for provenance.
   Codex answering must match Claude's AskUserQuestion from day one. The consequence flagged in the
   prior draft stands: the approval-prompt TUI shape is TUI-only, absent from rollout JSONL,
   confirmable only via live `capture-pane`. Because we now block on it, that verification is a
   **gating prerequisite spike (Phase 0a)**, not a Phase 4 follow-up. Phase 0a captures every
   representative approval prompt (command-exec, file-write/patch, multi-option), records the exact
   rendered layout + the precise selecting keystrokes, and emits `approval-prompts.spec.json` — the
   contract the Codex pending-detection (2.3) + answer-key builder (4.3) target as **first-class
   deliverables**, peers of Claude's `lib/answer.js` path.
   **Kill-criteria if the prompt shape proves unstable across Codex versions** (ANSI-noisy /
   ambiguous to anchor / materially version-divergent): the Phase 0a gate (0a.4) escalates to
   Ernest with the captures. Full parity is mandated, so reply-only is NOT a silent fallback — it
   requires explicit sign-off. Options at the gate: (a) pin a minimum supported `codex` version;
   (b) explicitly-approved reply-only fallback; (c) defer answering, ship the rest. The plan does
   not proceed past P0a without a recorded decision. This is the single unknown holding confidence
   below the autonomous threshold.

2. **Normalization — DECIDED: SERVER-SIDE (locked).** Codex JSONL → shared `Block` union in the Node
   adapter; `web/src/lib/convert.ts` stays untouched. `convert.ts` already consumes the `Block` union
   agnostically (confirmed by reading it), so there are ZERO converter changes anywhere in this plan
   (re-confirmed in Phase 5). One normalization path, server-owned.

3. **Spawn UX — DECIDED: FULL PICKER (not minimal).** A picker selects target tmux session, working
   directory, and agent type (claude | codex) before spawning, symmetric for both agents. Server
   endpoints (`/api/tmux/sessions`, `/api/agents`), the `SpawnPicker` frontend component (hung off a
   "New agent" affordance at the top of the SessionRail), and server-authoritative validation (cwd
   existence/realpath, binary resolvable, session/window naming) are specified in expanded Phase 3
   (server) and Phase 5.3 (frontend). Spawning is one adapter-driven path: `buildSpawnCommand`
   returns `{bin,args}` per agent, so Claude and Codex spawn are symmetric by construction.

---

## 12. Executive summary

See the standalone 15-line summary returned to the operator.
