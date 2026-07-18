// Mirrors claude-cockpit's backend contract (server.js / CONTRACT.md).
// These are read-only on the client; never mutate in place.

export interface Session {
  id: string;
  sessionId?: string;
  name?: string;
  title?: string;
  tmuxName?: string;
  target?: string;
  paneId?: string;                  // stable tmux %N (survives renumber / grouped mirrors)
  sessionName?: string;
  windowIndex?: number;
  paneIndex?: number;
  windowId?: string;
  active?: boolean;
  cwd?: string;
  transcriptPath?: string;
  pinned?: boolean;
  lastActivity?: number;
  /** Millisecond timestamp of the last transcript record — the numeric counterpart
   *  to the ISO-string lastActivity. Used by claudeWorking for the 15 s recency
   *  check; lastActivity (string) is kept for backwards compat. */
  lastActivityMs?: number;
  pending?: boolean;
  pendingQuestion?: string | null;
  cmd?: string;
  isClaude?: boolean;
  /** 'claude' = a Claude Code pane (transcript Thread); 'claudex' = the claude
   *  binary pointed at the olam auth-worker (renders/behaves like 'claude' —
   *  it's a rail-FILTER-bucket distinction, codex-flavored per design
   *  decision 7, not a pane-treatment one); 'codex' = an OpenAI Codex pane;
   *  'terminal' = a plain shell pane (live terminal); 'remote' = an olam
   *  remote sandbox session. */
  kind?: 'claude' | 'claudex' | 'codex' | 'terminal' | 'remote';
  /** Per-session control transport. */
  transport?: 'tmux' | 'rpc' | 'print' | 'olam' | null;
  // --- remote (olam) rows only — additive; absent on local sessions ---------
  /** Org slug the remote session belongs to (atlas | grain | pleri | ...). */
  org?: string;
  /** Runner pool the session runs on (linear | sandbox | agentrun), probe-confirmed. */
  pool?: string | null;
  /** Runner phase (running | done | ...); null when list-only. */
  phase?: string | null;
  /** ADR-062 identity: session_id === Linear AgentSession id. */
  linearRef?: string | null;
  /** One-line session summary from the olam session store. */
  summary?: string;
  /** Linear issue identifier when the session is Linear-delegated (live list field). */
  linearIssueId?: string | null;
  /** olam plan status (planned/approved/...); null for ad-hoc chats. */
  planStatus?: string | null;
  /** Agent turn currently in flight. */
  inFlight?: boolean;
  /** Session halted (budget/limits). */
  halted?: boolean;
  /** Row is last-known data from an unreachable org (render greyed). */
  stale?: boolean;
  /** Per-org probe state the row was fetched under. */
  orgHealth?: { status: 'green' | 'amber' | 'red' | 'unknown'; reason: string | null };
  /** Owning operator's email (org scope=all list). */
  ownerEmail?: string | null;
  /** True when owned by a different operator — view-only (steering disabled). */
  readOnly?: boolean;
  /** Local structured transport endpoint, when the server exposes one. */
  endpoint?: string | null;
  /** true if this terminal pane is a composer >_ sister shell (auto-created). */
  ccShell?: boolean;
  model?: string | null;
  ctxPct?: number | null;
  /** Reasoning-effort tier reported by the harness (Claude statusLine `.effort.level`;
   *  Codex has no dedicated field — its effort stays embedded in `model` and is
   *  parsed client-side via `parseEffort`). */
  effort?: string | null;
  /** true while Claude is actively generating in this pane (TUI "esc to interrupt") */
  thinking?: boolean;
  /** true while Claude is compacting the conversation (TUI "Compacting conversation…") */
  compacting?: boolean;
  /** true when the agent hit an API error and stalled (rate limit / overload / 5xx) */
  errored?: boolean;
  /** true when a pane hit macOS "Operation not permitted" — the launchd service
   *  lacks Full Disk Access (TCC). Surfaced as a one-time fix-it banner. */
  permIssue?: boolean;
  /** true when this session has a sub-agent actively running (server-side dir probe;
   *  works for ALL sessions, unlike runningSubagentCountById which is subscription-scoped) */
  subAgentActive?: boolean;
  /** Codex-only: primary rate-limit used_percent (0–100). null for Claude sessions. */
  usagePct?: number | null;
  /** Codex-only: primary rate-limit window in minutes (e.g. 300 = 5h, 10080 = 7d). */
  usageWindowMin?: number | null;
  /** Remote (olam) rows only: PRs opened by this session's agent run, normalized
   *  from the runner status `prs` field (lib/olam-prs.js normalizePrs). */
  prs?: Array<{ url: string; number: number | null }>;
  /** Remote (olam) rows only: PR count (falls back to prs.length when the
   *  runner status omits it). */
  prCount?: number;
  /** Remote (olam) rows only: derived from canonical Gateway-written status
   *  (halted / terminal plan/PR/Linear status / phase:'done') — see
   *  lib/olam-archive.js deriveArchived. Sessions with archived:true render
   *  under the rail's collapsed "Archived" section instead of the active list. */
  archived?: boolean;
}

export type Role = 'user' | 'assistant' | 'system';

export type Block =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | {
      kind: 'tool_use';
      id: string;
      name: string;
      input?: unknown;
      inputSummary?: string;
    }
  | { kind: 'tool_result'; forId: string; text: string; isError?: boolean }
  // A pasted/typed image attachment. The server deliberately omits the base64
  // payload (see lib/transcript.js parseRecord) — this is a presence marker
  // only, used by pendingSend.ts's echoMatches to reconcile image-only sends
  // (no accompanying text block at all).
  | { kind: 'image' };

export interface Msg {
  uuid: string;
  role: Role;
  ts?: number;
  blocks: Block[];
  rawType?: string;
  // True when derived from a Claude Code `queued_command` attachment (a message
  // typed while the agent was busy). Rendered as a user bubble, but dropped by
  // convert if the same text later lands as a real type=user message.
  queued?: boolean;
}

/**
 * One question's answer on the wire. Either the chosen option labels (the option
 * path, unchanged + backward-compatible) OR a free-text/chat directive telling the
 * server to type the literal `text` into the picker's "Type something" /
 * "Chat about this" row instead of selecting an option.
 */
export type AnswerSelection =
  | string[]
  | { kind: 'text' | 'chat'; text: string };

export interface PendingOption {
  label: string;
  description?: string;
  /** Multi-line text (ASCII diagram, code, arch mockup) shown as monospace in the preview pane. */
  preview?: string;
}

export interface PendingQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: PendingOption[];
}

export interface Pending {
  toolUseId: string;
  ts?: number;
  questions: PendingQuestion[];
}

/** Parsed YAML front-matter from an agent definition `.md` file. */
export interface AgentDef {
  name?: string;
  description?: string;
  tools?: string;
  model?: string;
  [k: string]: string | undefined;
}

/** Lightweight summary of a nested sub-agent (one level deep, no messages). */
export interface NestedSubAgent {
  agentId: string;
  agentType: string | null;
  model: string | null;
}

// A sub-agent (Task/Agent) running under a session, with its own transcript.
export interface SubAgent {
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  status: 'running' | 'done';
  messages: Msg[];
  /** False for historical summaries until their bounded transcript is requested. */
  messagesLoaded?: boolean;
  createdAt?: number | null;
  /** Model string extracted from the agent's own transcript records. */
  model?: string | null;
  /** Parsed front-matter from the agent definition file, or null if not found. */
  def?: AgentDef | null;
  /** Nested sub-agents spawned by this agent (one level, best-effort). */
  nested?: NestedSubAgent[];
}

// A live TUI selection prompt (permission / trust / numbered menu) detected from
// the pane — NOT from the transcript (these never appear there).
export interface PanePromptOption {
  key: string;
  label: string;
  selected?: boolean;
  /** Wrapped sub-text the TUI renders under the label (scraped from the pane). */
  description?: string;
  /** True when this checkbox option is already checked in the TUI. */
  checked?: boolean;
}
export interface PanePrompt {
  question: string;
  /** True when the prompt is a multi-select checkbox picker (vs. single-select radio). */
  multiSelect?: boolean;
  options: PanePromptOption[];
}

export interface PowerStatus {
  hasBattery: boolean;
  percent?: number | null;
  charging?: boolean;
  low?: boolean;
}

export interface ResourceSnapshot {
  self?: { cpuPct?: number; rssMB?: number; heapMB?: number };
  system?: {
    loadavg?: number[];
    cpuCount?: number;
    totalMB?: number;
    freeMB?: number;
    memUsedPct?: number;
  };
  /** Battery/power status (darwin only); null/absent when unavailable. */
  power?: PowerStatus | null;
  overLimit?: boolean;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  cpu: number;
  mem: number;
  rssMB: number;
  command: string;
}

export interface RawEvent {
  ts: number;
  source: string;
  kind: string;
  summary: string;
  detail?: unknown;
}

// Server -> client WebSocket frames.
export type ServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'messages'; id: string; messages: Msg[]; pending: Pending | null }
  | { type: 'append'; id: string; messages: Msg[] }
  | { type: 'olam-degraded'; id: string; degraded: boolean; reason: string | null }
  // Remote (olam) session only: the Electric chunks shape's initial snapshot
  // has drained to its live cursor — the transcript is no longer ambiguous
  // between "still loading" and "genuinely empty". See useCockpit's
  // remote-only messagesLoaded gate.
  | { type: 'olam-transcript-ready'; id: string }
  | { type: 'pending'; id: string; pending: Pending | null }
  | { type: 'resources'; snapshot: ResourceSnapshot; warning?: string }
  | { type: 'capture'; id: string; text: string }
  | { type: 'prompt'; id: string; prompt: PanePrompt | null }
  | { type: 'subagents'; id: string; subagents: SubAgent[] }
  | { type: 'subagent'; id: string; subagent: SubAgent }
  | { type: 'raw-events'; id: string; events: RawEvent[] }
  | { type: 'raw-event'; id: string; event: RawEvent }
  // Composer terminal mode (>_): live capture of the dedicated shell pane.
  | { type: 'shell-output'; text: string; id?: string }
  // Pane-scrape picker signal: any numbered TUI picker (AskUserQuestion /
  // permission / trust / plan / custom menu) appearing or disappearing on
  // the Claude pane's visible screen.  open:true = picker is ON SCREEN right now.
  | { type: 'picker'; id: string; open: boolean }
  | { type: 'ack'; op: string; ok: boolean; error?: string; transport?: string; reqId?: string }
  // D2: pushed whenever lib/media-watch.js's MediaAppWatcher observes a
  // settled write under the media apps/ dir (a rebuilt/versioned micro-app).
  // `path` is media-root-relative ("apps/<name>.html" or
  // "apps/<name>/<version>.html"); `mtime` is the file's mtimeMs. Consumed by
  // AppFrameLayer via the 'cockpit:media-app-changed' CustomEvent (see
  // useCockpit.ts) to hot-reload track-latest panel app tabs.
  | { type: 'media-app-changed'; path: string; mtime: number };

// Client -> server WebSocket frames.
export type ClientMessage =
  | { type: 'subscribe'; id: string }
  | { type: 'unsubscribe'; id: string }
  | { type: 'reply'; id: string; text: string; reqId?: string; attachments?: number; viaAnswer?: boolean; hardSteer?: boolean }
  | { type: 'answer'; id: string; toolUseId: string; selections: AnswerSelection[] }
  | { type: 'subagent-load'; id: string; agentId: string }
  | { type: 'capture'; id: string; lines?: number; escapes?: boolean }
  | { type: 'promptkey'; id: string; key: string }
  | { type: 'promptselect'; id: string; labels: string[] }
  // Interactive terminal panes: forward keystrokes to a pane by id.
  | { type: 'pane-text'; id: string; text: string }
  | { type: 'pane-key'; id: string; key: string }
  // Composer terminal mode: per-session sister shell (id = the Claude session).
  | { type: 'shell-input'; id: string; line: string }
  | { type: 'shell-text'; id: string; text: string }
  | { type: 'shell-key'; id: string; key: string }
  | { type: 'shell-capture'; id: string; lines?: number };
