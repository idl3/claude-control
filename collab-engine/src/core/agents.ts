import type { Db } from '../store/db.js';
import type { Clock } from '../store/clock.js';
import { systemClock } from '../store/clock.js';
import { generateId, assertSafeId } from '../store/ids.js';
import type { Agent, AgentDirectoryEntry, Failure } from './types.js';

/** Default staleness window: an agent with no heartbeat in this long reads as `stale`. */
export const STALE_MS = 90_000;

/** Default boundary lease TTL, seconds. Also used as the row shape backing heartbeat renewal. */
export const DEFAULT_TTL_SEC = 1800;

interface AgentRow {
  id: string;
  harness: string;
  role: string | null;
  worktree: string | null;
  branch: string | null;
  cwd: string | null;
  capabilities: string | null;
  stream_id: string | null;
  status: string;
  inbox_cursor: number;
  registered_at: number;
  last_heartbeat: number;
}

function mapAgentRow(row: AgentRow): Agent {
  return {
    id: row.id,
    harness: row.harness,
    role: row.role,
    worktree: row.worktree,
    branch: row.branch,
    cwd: row.cwd,
    capabilities: row.capabilities ? (JSON.parse(row.capabilities) as string[]) : [],
    streamId: row.stream_id,
    status: row.status as Agent['status'],
    inboxCursor: row.inbox_cursor,
    registeredAt: row.registered_at,
    lastHeartbeat: row.last_heartbeat,
  };
}

export interface RegisterParams {
  harness: string;
  role?: string | null;
  worktree?: string | null;
  branch?: string | null;
  cwd?: string | null;
  capabilities?: string[];
  stream?: string | null;
  agentId?: string;
}

/** Create or refresh an agent row. `agent_id` optional (generated if absent). */
export function register(db: Db, params: RegisterParams, now: Clock = systemClock): { ok: true; agentId: string } {
  const id = params.agentId ? assertSafeId('agent_id', params.agentId) : generateId();
  const ts = now();
  const capabilitiesJson = JSON.stringify(params.capabilities ?? []);
  const stmt = db.prepare(`
    INSERT INTO agents (id, harness, role, worktree, branch, cwd, capabilities, stream_id, status, inbox_cursor, registered_at, last_heartbeat)
    VALUES (@id, @harness, @role, @worktree, @branch, @cwd, @capabilities, @streamId, 'active', 0, @ts, @ts)
    ON CONFLICT(id) DO UPDATE SET
      harness=excluded.harness,
      role=excluded.role,
      worktree=excluded.worktree,
      branch=excluded.branch,
      cwd=excluded.cwd,
      capabilities=excluded.capabilities,
      stream_id=excluded.stream_id,
      status='active',
      last_heartbeat=excluded.last_heartbeat
  `);
  stmt.run({
    id,
    harness: params.harness,
    role: params.role ?? null,
    worktree: params.worktree ?? null,
    branch: params.branch ?? null,
    cwd: params.cwd ?? null,
    capabilities: capabilitiesJson,
    streamId: params.stream ?? null,
    ts,
  });
  return { ok: true, agentId: id };
}

export interface HeartbeatParams {
  agentId: string;
  renewLeases?: boolean;
}

export type HeartbeatResult = { ok: true; now: number; staleAfterMs: number } | Failure;

/** Touch `last_heartbeat`; optionally renew the agent's still-active boundary leases. */
export function heartbeat(db: Db, params: HeartbeatParams, now: Clock = systemClock): HeartbeatResult {
  const ts = now();
  const stmt = db.prepare(`UPDATE agents SET last_heartbeat=@ts WHERE id=@id AND status='active'`);
  const res = stmt.run({ ts, id: params.agentId });
  if (Number(res.changes) === 0) {
    return { ok: false, reason: 'not_found', message: `agent ${params.agentId} not found or not active` };
  }
  if (params.renewLeases) {
    // Renew each active lease by its own original duration, anchored to now.
    db.prepare(
      `UPDATE boundaries
          SET expires_at = @ts + (expires_at - created_at)
        WHERE owner_agent_id=@id AND released_at IS NULL AND expires_at > @ts`,
    ).run({ ts, id: params.agentId });
  }
  return { ok: true, now: ts, staleAfterMs: STALE_MS };
}

export interface DirectoryParams {
  stream?: string | null;
  includeStale?: boolean;
}

/** List agents, computing `live` from the heartbeat window. Excludes `gone` unless `includeStale`. */
export function directory(db: Db, params: DirectoryParams, now: Clock = systemClock): { ok: true; agents: AgentDirectoryEntry[] } {
  const ts = now();
  const rows = db
    .prepare(
      `SELECT * FROM agents
        WHERE (@streamId IS NULL OR stream_id=@streamId)
          AND (status != 'gone' OR @includeStale = 1)
        ORDER BY registered_at ASC`,
    )
    .all({
      streamId: params.stream ?? null,
      includeStale: params.includeStale ? 1 : 0,
    }) as unknown as AgentRow[];
  const agents = rows.map((row) => {
    const agent = mapAgentRow(row);
    const live = agent.status === 'active' && ts - agent.lastHeartbeat <= STALE_MS;
    return { ...agent, live };
  });
  return { ok: true, agents };
}

export interface DeregisterParams {
  agentId: string;
}

/** Mark `gone` and release the agent's active leases. */
export function deregister(db: Db, params: DeregisterParams, now: Clock = systemClock): { ok: true } | Failure {
  const ts = now();
  const res = db.prepare(`UPDATE agents SET status='gone' WHERE id=@id AND status='active'`).run({ id: params.agentId });
  if (Number(res.changes) === 0) {
    return { ok: false, reason: 'not_found', message: `agent ${params.agentId} not found or already gone` };
  }
  db.prepare(`UPDATE boundaries SET released_at=@ts WHERE owner_agent_id=@id AND released_at IS NULL`).run({
    ts,
    id: params.agentId,
  });
  return { ok: true };
}

export function getAgent(db: Db, agentId: string): Agent | null {
  const row = db.prepare(`SELECT * FROM agents WHERE id=@id`).get({ id: agentId }) as unknown as AgentRow | undefined;
  return row ? mapAgentRow(row) : null;
}
