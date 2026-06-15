// Mirrors claude-cockpit's backend contract (server.js / CONTRACT.md).
// These are read-only on the client; never mutate in place.

export interface Session {
  id: string;
  sessionId?: string;
  name?: string;
  title?: string;
  tmuxName?: string;
  target?: string;
  sessionName?: string;
  windowIndex?: number;
  paneIndex?: number;
  windowId?: string;
  active?: boolean;
  cwd?: string;
  transcriptPath?: string;
  pinned?: boolean;
  lastActivity?: number;
  pending?: boolean;
  pendingQuestion?: string | null;
  cmd?: string;
  isClaude?: boolean;
  model?: string | null;
  ctxPct?: number | null;
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

// A sub-agent (Task/Agent) running under a session, with its own transcript.
export interface SubAgent {
  agentId: string;
  toolUseId: string | null;
  agentType: string | null;
  description: string | null;
  status: 'running' | 'done';
  messages: Msg[];
  createdAt?: number | null;
}

// A live TUI selection prompt (permission / trust / numbered menu) detected from
// the pane — NOT from the transcript (these never appear there).
export interface PanePromptOption {
  key: string;
  label: string;
  selected?: boolean;
}
export interface PanePrompt {
  question: string;
  options: PanePromptOption[];
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
  overLimit?: boolean;
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
  | { type: 'ack'; op: string; ok: boolean; error?: string };

// Client -> server WebSocket frames.
export type ClientMessage =
  | { type: 'subscribe'; id: string }
  | { type: 'unsubscribe'; id: string }
  | { type: 'reply'; id: string; text: string }
  | { type: 'answer'; id: string; toolUseId: string; selections: string[][] }
  | { type: 'capture'; id: string; lines?: number }
  | { type: 'promptkey'; id: string; key: string };
