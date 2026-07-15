import type { Db } from '../store/db.js';
import type { Clock } from '../store/clock.js';
import { systemClock } from '../store/clock.js';
import { generateId } from '../store/ids.js';
import type { Stream, StreamStatus } from './types.js';

interface StreamRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  created_by: string | null;
  created_at: number;
}

function mapStreamRow(row: StreamRow): Stream {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    status: row.status as StreamStatus,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

export interface CreateStreamParams {
  agentId: string;
  name: string;
  description?: string | null;
}

/** Create a workstream grouping. */
export function createStream(db: Db, params: CreateStreamParams, now: Clock = systemClock): { ok: true; streamId: string } {
  const id = generateId();
  const ts = now();
  db.prepare(
    `INSERT INTO streams (id, name, description, status, created_by, created_at)
     VALUES (@id, @name, @description, 'active', @createdBy, @ts)`,
  ).run({ id, name: params.name, description: params.description ?? null, createdBy: params.agentId, ts });
  return { ok: true, streamId: id };
}

export interface ListStreamsParams {
  status?: StreamStatus | null;
}

/** List streams, optionally filtered by status. */
export function listStreams(db: Db, params: ListStreamsParams): { ok: true; streams: Stream[] } {
  const rows = db
    .prepare(`SELECT * FROM streams WHERE (@status IS NULL OR status=@status) ORDER BY created_at ASC`)
    .all({ status: params.status ?? null }) as unknown as StreamRow[];
  return { ok: true, streams: rows.map(mapStreamRow) };
}

export function getStream(db: Db, streamId: string): Stream | null {
  const row = db.prepare(`SELECT * FROM streams WHERE id=@id`).get({ id: streamId }) as unknown as StreamRow | undefined;
  return row ? mapStreamRow(row) : null;
}
