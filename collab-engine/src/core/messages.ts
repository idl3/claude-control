import type { Db } from '../store/db.js';
import type { Clock } from '../store/clock.js';
import { systemClock } from '../store/clock.js';
import type { Message, MessageKind } from './types.js';

interface MessageRow {
  id: number;
  stream_id: string | null;
  from_agent: string | null;
  to_agent: string | null;
  kind: string;
  body: string;
  created_at: number;
}

function mapMessageRow(row: MessageRow): Message {
  return {
    id: row.id,
    streamId: row.stream_id,
    fromAgent: row.from_agent,
    toAgent: row.to_agent,
    kind: row.kind as MessageKind,
    body: row.body,
    createdAt: row.created_at,
  };
}

export interface SendParams {
  agentId: string; // from
  body: string;
  to?: string | null; // null/omitted => broadcast
  stream?: string | null;
  kind?: MessageKind;
}

/** Durable insert. `to` omitted/null broadcasts to every agent. */
export function send(db: Db, params: SendParams, now: Clock = systemClock): { ok: true; messageId: number } {
  const ts = now();
  const res = db
    .prepare(
      `INSERT INTO messages (stream_id, from_agent, to_agent, kind, body, created_at)
       VALUES (@streamId, @fromAgent, @toAgent, @kind, @body, @ts)`,
    )
    .run({
      streamId: params.stream ?? null,
      fromAgent: params.agentId,
      toAgent: params.to ?? null,
      kind: params.kind ?? 'msg',
      body: params.body,
      ts,
    });
  return { ok: true, messageId: Number(res.lastInsertRowid) };
}

export interface PollParams {
  agentId: string;
  ackThrough?: number;
  limit?: number;
}

/**
 * If `ackThrough` given, advance the agent's `inbox_cursor` to it first. Then
 * return messages where `id > inbox_cursor` AND (`to_agent = me` OR `to_agent IS NULL`),
 * ordered by id. At-least-once: unacked messages redeliver on every poll.
 */
export function poll(db: Db, params: PollParams): { ok: true; messages: Message[]; cursor: number } {
  if (typeof params.ackThrough === 'number') {
    db.prepare(`UPDATE agents SET inbox_cursor = @ackThrough WHERE id=@id AND inbox_cursor < @ackThrough`).run({
      ackThrough: params.ackThrough,
      id: params.agentId,
    });
  }
  const agentRow = db.prepare(`SELECT inbox_cursor FROM agents WHERE id=@id`).get({ id: params.agentId }) as
    | { inbox_cursor: number }
    | undefined;
  const cursor = agentRow?.inbox_cursor ?? 0;
  const limit = params.limit && params.limit > 0 ? params.limit : 100;
  const rows = db
    .prepare(
      `SELECT * FROM messages
        WHERE id > @cursor AND (to_agent = @id OR to_agent IS NULL)
        ORDER BY id ASC
        LIMIT @limit`,
    )
    .all({ cursor, id: params.agentId, limit }) as unknown as MessageRow[];
  return { ok: true, messages: rows.map(mapMessageRow), cursor };
}
