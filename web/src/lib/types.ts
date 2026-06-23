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
  /** 'claude' = a Claude Code pane (transcript Thread); 'codex' = an OpenAI Codex pane; 'terminal' = a plain shell pane (live terminal). */
  kind?: 'claude' | 'codex' | 'terminal';
  /** Per-session control transport. */
  transport?: 'tmux' | 'rpc' | 'print' | null;
  /** Local structured transport endpoint, when the server exposes one. */
  endpoint?: string | null;
  /** true if this terminal pane is a composer >_ sister shell (auto-created). */
  ccShell?: boolean;
  model?: string | null;
  ctxPct?: number | null;
  /** true while Claude is actively generating in this pane (TUI "esc to interrupt") */
  thinking?: boolean;
  /** true while Claude is compacting the conversation (TUI "Compacting conversation…") */
  compacting?: boolean;
  /** Codex-only: primary rate-limit used_percent (0–100). null for Claude sessions. */
  usagePct?: number | null;
  /** Codex-only: primary rate-limit window in minutes (e.g. 300 = 5h, 10080 = 7d). */
  usageWindowMin?: number | null;
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
  | { kind: 'tool_result'; forId: string; text: string; isError?: boolean };

export interface Msg {
  uuid: string;
  role: Role;
  ts?: number;
  blocks: Block[];
  rawType?: string;
}

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

// Server -> client WebSocket frames.
export type ServerMessage =
  | { type: 'sessions'; sessions: Session[] }
  | { type: 'messages'; id: string; messages: Msg[]; pending: Pending | null }
  | { type: 'append'; id: string; messages: Msg[] }
  | { type: 'pending'; id: string; pending: Pending | null }
  | { type: 'resources'; snapshot: ResourceSnapshot; warning?: string }
  | { type: 'capture'; id: string; text: string }
  | { type: 'prompt'; id: string; prompt: PanePrompt | null }
  | { type: 'subagents'; id: string; subagents: SubAgent[] }
  | { type: 'subagent'; id: string; subagent: SubAgent }
  // Composer terminal mode (>_): live capture of the dedicated shell pane.
  | { type: 'shell-output'; text: string; id?: string }
  | { type: 'ack'; op: string; ok: boolean; error?: string; transport?: string };

// Client -> server WebSocket frames.
export type ClientMessage =
  | { type: 'subscribe'; id: string }
  | { type: 'unsubscribe'; id: string }
  | { type: 'reply'; id: string; text: string }
  | { type: 'answer'; id: string; toolUseId: string; selections: string[][] }
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
