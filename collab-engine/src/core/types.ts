/** Shared TS types for the collab-engine core. Harness-agnostic: no MCP/CLI imports. */

export type AgentStatus = 'active' | 'gone';
export type TaskStatus = 'open' | 'claimed' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export type StreamStatus = 'active' | 'closed';
export type MessageKind = 'msg' | 'handoff' | 'system';

export interface Stream {
  id: string;
  name: string;
  description: string | null;
  status: StreamStatus;
  createdBy: string | null;
  createdAt: number;
}

export interface Agent {
  id: string;
  harness: string;
  role: string | null;
  worktree: string | null;
  branch: string | null;
  cwd: string | null;
  capabilities: string[];
  streamId: string | null;
  status: AgentStatus;
  inboxCursor: number;
  registeredAt: number;
  lastHeartbeat: number;
}

export interface AgentDirectoryEntry extends Agent {
  live: boolean;
}

export interface Message {
  id: number;
  streamId: string | null;
  fromAgent: string | null;
  toAgent: string | null;
  kind: MessageKind;
  body: string;
  createdAt: number;
}

export interface Task {
  id: string;
  streamId: string | null;
  title: string;
  body: string | null;
  status: TaskStatus;
  ownerAgentId: string | null;
  priority: number;
  version: number;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  claimedAt: number | null;
  completedAt: number | null;
}

export interface Boundary {
  id: string;
  streamId: string | null;
  ownerAgentId: string;
  patterns: string[];
  note: string | null;
  createdAt: number;
  expiresAt: number;
  releasedAt: number | null;
}

export interface BoundaryConflict {
  path: string;
  boundaryId: string;
  owner: string;
  expiresAt: number;
  patterns: string[];
}

/** Uniform failure shape returned by guarded mutations (claim/update/complete/release/handoff). */
export interface Failure {
  ok: false;
  reason: 'conflict' | 'stale' | 'not_found' | 'forbidden' | 'invalid';
  message?: string;
}

export type Result<T> = ({ ok: true } & T) | Failure;
