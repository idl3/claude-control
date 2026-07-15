import { minimatch } from 'minimatch';
import type { Db } from '../store/db.js';
import type { Clock } from '../store/clock.js';
import { systemClock } from '../store/clock.js';
import { generateId } from '../store/ids.js';
import { DEFAULT_TTL_SEC } from './agents.js';
import type { Boundary, BoundaryConflict, Failure } from './types.js';

interface BoundaryRow {
  id: string;
  stream_id: string | null;
  owner_agent_id: string;
  patterns: string;
  note: string | null;
  created_at: number;
  expires_at: number;
  released_at: number | null;
}

function mapBoundaryRow(row: BoundaryRow): Boundary {
  return {
    id: row.id,
    streamId: row.stream_id,
    ownerAgentId: row.owner_agent_id,
    patterns: JSON.parse(row.patterns) as string[],
    note: row.note,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    releasedAt: row.released_at,
  };
}

/**
 * Directional match: `path` is a concrete file about to be edited; `pattern`
 * is a declared lease pattern (file, dir prefix, or glob). Matches if the
 * pattern equals the path, is a directory prefix of the path (`foo/` or
 * `foo/**`), or `minimatch(path, pattern)` is true.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === path) return true;
  let dirBase: string | null = null;
  if (pattern.endsWith('/**')) {
    dirBase = pattern.slice(0, -3);
  } else if (pattern.endsWith('/')) {
    dirBase = pattern.slice(0, -1);
  }
  if (dirBase !== null && (path === dirBase || path.startsWith(`${dirBase}/`))) {
    return true;
  }
  return minimatch(path, pattern);
}

export interface DeclareBoundaryParams {
  agentId: string;
  paths: string[];
  ttlSec?: number;
  stream?: string | null;
  note?: string | null;
}

/** Advertise ownership of path/glob patterns for `ttlSec` seconds (default 1800). */
export function declareBoundary(
  db: Db,
  params: DeclareBoundaryParams,
  now: Clock = systemClock,
): { ok: true; boundaryId: string; expiresAt: number } {
  const id = generateId();
  const ts = now();
  const ttlSec = params.ttlSec && params.ttlSec > 0 ? params.ttlSec : DEFAULT_TTL_SEC;
  const expiresAt = ts + ttlSec * 1000;
  db.prepare(
    `INSERT INTO boundaries (id, stream_id, owner_agent_id, patterns, note, created_at, expires_at, released_at)
     VALUES (@id, @streamId, @ownerAgentId, @patterns, @note, @ts, @expiresAt, NULL)`,
  ).run({
    id,
    streamId: params.stream ?? null,
    ownerAgentId: params.agentId,
    patterns: JSON.stringify(params.paths),
    note: params.note ?? null,
    ts,
    expiresAt,
  });
  return { ok: true, boundaryId: id, expiresAt };
}

export interface CheckBoundaryParams {
  paths: string[];
  agentId?: string | null;
  stream?: string | null;
}

/**
 * For each concrete `path`, list conflicting active leases held by other
 * agents. A lease is active iff `released_at IS NULL AND expires_at > now`
 * (lazy expiry, enforced here in the WHERE clause).
 */
export function checkBoundary(db: Db, params: CheckBoundaryParams, now: Clock = systemClock): { ok: true; conflicts: BoundaryConflict[] } {
  const ts = now();
  const rows = db
    .prepare(
      `SELECT * FROM boundaries
        WHERE released_at IS NULL AND expires_at > @ts
          AND (@streamId IS NULL OR stream_id=@streamId)
          AND (@agentId IS NULL OR owner_agent_id != @agentId)`,
    )
    .all({ ts, streamId: params.stream ?? null, agentId: params.agentId ?? null }) as unknown as BoundaryRow[];

  const conflicts: BoundaryConflict[] = [];
  for (const row of rows) {
    const boundary = mapBoundaryRow(row);
    for (const path of params.paths) {
      if (boundary.patterns.some((pattern) => matchesPattern(path, pattern))) {
        conflicts.push({
          path,
          boundaryId: boundary.id,
          owner: boundary.ownerAgentId,
          expiresAt: boundary.expiresAt,
          patterns: boundary.patterns,
        });
      }
    }
  }
  return { ok: true, conflicts };
}

export interface ReleaseBoundaryParams {
  agentId: string;
  boundaryId: string;
}

/** Owner-only. Sets `released_at`. */
export function releaseBoundary(db: Db, params: ReleaseBoundaryParams, now: Clock = systemClock): { ok: true } | Failure {
  const existing = db.prepare(`SELECT * FROM boundaries WHERE id=@id`).get({ id: params.boundaryId }) as unknown as
    | BoundaryRow
    | undefined;
  if (!existing) {
    return { ok: false, reason: 'not_found', message: `boundary ${params.boundaryId} not found` };
  }
  if (existing.owner_agent_id !== params.agentId) {
    return { ok: false, reason: 'forbidden', message: `boundary ${params.boundaryId} is not owned by ${params.agentId}` };
  }
  if (existing.released_at !== null) {
    return { ok: false, reason: 'conflict', message: `boundary ${params.boundaryId} already released` };
  }
  const ts = now();
  db.prepare(`UPDATE boundaries SET released_at=@ts WHERE id=@id AND owner_agent_id=@agentId AND released_at IS NULL`).run({
    ts,
    id: params.boundaryId,
    agentId: params.agentId,
  });
  return { ok: true };
}

export function getBoundary(db: Db, boundaryId: string): Boundary | null {
  const row = db.prepare(`SELECT * FROM boundaries WHERE id=@id`).get({ id: boundaryId }) as unknown as BoundaryRow | undefined;
  return row ? mapBoundaryRow(row) : null;
}

export { mapBoundaryRow };
export type { BoundaryRow };
