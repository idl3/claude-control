// lib/agents/adapter.js — the AgentAdapter seam.
//
// claude-control drives more than one kind of agent CLI (today: Claude Code;
// next: OpenAI Codex). The pieces that differ per-agent — how a transcript line
// parses, where transcripts live, how a pane process is recognised, how a
// pending prompt is detected and answered, how the TUI status reads — are
// gathered behind a single `AgentAdapter`. The shared mechanics
// (`TranscriptTailer` watch/offset machinery, `SessionRegistry` reconciliation,
// tmux send/capture, server WS plumbing) stay agent-neutral and consume an
// adapter rather than hardcoding Claude.
//
// This file is the CONTRACT only — JSDoc typedefs, no behaviour. Concrete
// implementations live alongside (`claude.js`, later `codex.js`) and the ordered
// registry is `index.js`.
//
// SCOPE NOTE (Phase 0): only the members the current runtime actually exercises
// are part of the live contract today —
//   matchesProcess, buildTranscriptIndex, parseRecord, trackPending,
//   detectTranscriptPending, buildAnswerProgram, parseTuiStatus, prettyModel.
// The members marked "(deferred)" below are sketched so the Codex implementation
// has a known shape to slot into, but are NOT yet called by any shared code and
// NOT yet implemented by ClaudeAdapter. They are introduced by their owning
// phase (spawn → P3, deriveStatusFromTranscript / detectPendingFromCapture → P1/P2).

/**
 * A normalized message produced by an adapter's `parseRecord`. Identical shape
 * across agents — this is what the shared `TranscriptTailer` buffers and what
 * the frontend converter consumes.
 *
 * @typedef {Object} NormalizedMessage
 * @property {string|null} uuid
 * @property {'user'|'assistant'} role
 * @property {string|null} ts            ISO timestamp or null
 * @property {Array<Object>} blocks      text | thinking | tool_use | tool_result blocks
 * @property {string} rawType            the source record's raw type
 */

/**
 * A transcript discovered during a registry refresh, keyed into the index by cwd
 * (and, for Claude, also by encoded project dir).
 *
 * @typedef {Object} DiscoveredTranscript
 * @property {string|null} cwd
 * @property {string|null} sessionId
 * @property {string|null} lastActivity      ISO ts or null
 * @property {string|null} model             raw model id
 * @property {string|null} customTitle
 * @property {string|null} aiTitle
 * @property {string} transcriptPath
 * @property {number} mtime
 * @property {boolean} transcriptPending
 * @property {string|null} pendingToolUseId
 * @property {string|null} pendingQuestion
 */

/**
 * The cwd-indexed result of a discovery scan. `byDir` is optional and used only
 * by agents (Claude) that encode the launch cwd into the transcript directory
 * name; agents without dir-encoding (Codex) populate `byCwd` only.
 *
 * @typedef {Object} TranscriptIndex
 * @property {Map<string, DiscoveredTranscript>} byCwd
 * @property {Map<string, DiscoveredTranscript>} [byDir]
 */

/**
 * Roots an adapter may scan during discovery. Each adapter reads only the roots
 * it understands (Claude: projectsRoot; Codex: codexSessionsRoot).
 *
 * @typedef {Object} DiscoveryRoots
 * @property {string} projectsRoot
 * @property {string} [codexSessionsRoot]
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {'claude'|'codex'} id
 *
 * // ---- discovery ----
 * // Does this tmux pane process belong to THIS agent?
 * // (claude: process title is a version like "2.1.162"; codex: === 'codex')
 * @property {(cmd: string) => boolean} matchesProcess
 *
 * // Build a cwd-indexed map of recent transcripts. The adapter owns WHERE to
 * // look and HOW to bound reads (resource doctrine: never whole-file).
 * // claude: projectsRoot immediate-subdir walk + tail-read of newest *.jsonl.
 * // codex (later): ~/.codex/sessions recent date dirs + head-read of session_meta.
 * @property {(roots: DiscoveryRoots) => Promise<TranscriptIndex>} buildTranscriptIndex
 *
 * // ---- transcript tailing (injected into TranscriptTailer) ----
 * // One JSONL line -> NormalizedMessage | null (null = not a message record).
 * @property {(line: string) => (NormalizedMessage|null)} parseRecord
 *
 * // Update a pending-map (Map<id, pending>) in place from a freshly parsed msg.
 * // claude: open AskUserQuestion tool_use ids added, matching tool_result ids
 * // removed. The pending entries are what `TranscriptTailer` surfaces.
 * @property {(msg: NormalizedMessage, pendingMap: Map<string, object>) => void} trackPending
 *
 * // ---- discovery-time pending (tail-scan, no live tailer) ----
 * // Decide, from a set of tail lines, whether a prompt is still open. Used to
 * // push-notify ANY session, not just a subscribed one.
 * @property {(lines: string[]) => {transcriptPending: boolean, pendingToolUseId: string|null, pendingQuestion: string|null}} detectTranscriptPending
 *
 * // ---- answering ----
 * // Build the keystroke program that answers the current pending prompt.
 * // claude: number-key tabbed picker (lib/answer.js); codex (later): y/n/letter
 * // or arrow+Enter for approval modals.
 * @property {(pending: object, selections: string[][]) => string[]} buildAnswerProgram
 *
 * // ---- status ----
 * // Parse model + ctx% from a capture-pane dump.
 * // claude: ctx:% + model-name regex; codex (later): returns nulls (no ctx line).
 * @property {(capture: string) => {ctxPct: number|null, model: string|null}} parseTuiStatus
 * // Prettify a raw transcript model id into a short display label.
 * @property {(modelId: string|null) => (string|null)} prettyModel
 *
 * // ---- spawn (P3) ----
 * // Build the spawn argv (no shell; args array).
 * // claude: {bin:'claude', args:[]}; codex: {bin:'codex', args:['-C', cwd]}.
 * // The bin default may be overridden by the server's configured codexBin.
 * @property {(opts?:{cwd?:string, bin?:string}) => {bin:string, args:string[]}} buildSpawnCommand
 *
 * // ---- deferred (introduced by later phases; NOT part of the P0 live contract) ----
 * // (P1/P2) Derive ctx%/model from the transcript when the TUI has no status line.
 * // @property {(t: DiscoveredTranscript|null) => {ctxPct:number|null, model:string|null}} [deriveStatusFromTranscript]
 * // (P2) Detect a pending approval from a capture-pane dump (Codex: approvals are TUI-only).
 * // @property {(capture: string) => {transcriptPending:boolean, pendingKind:string|null, options:object[]}} [detectPendingFromCapture]
 */

export {};
