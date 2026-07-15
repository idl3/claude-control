import type { Db } from '../store/db.js';
import { withTransaction } from '../store/db.js';
import type { Clock } from '../store/clock.js';
import { systemClock } from '../store/clock.js';
import { mapTaskRow, type TaskRow } from './tasks.js';
import { mapBoundaryRow, type BoundaryRow } from './boundaries.js';
import type { Boundary, Failure, Task } from './types.js';

export interface HandoffParams {
  agentId: string; // from
  toAgent: string;
  taskId?: string | null;
  boundaryId?: string | null;
  note?: string | null;
}

export type HandoffResult = { ok: true; messageId: number; task?: Task; boundary?: Boundary } | Failure;

/** Sentinel thrown to unwind `withTransaction` on a guard failure (triggers rollback). */
class HandoffAbort extends Error {
  constructor(public readonly failure: Failure) {
    super(failure.message ?? failure.reason);
  }
}

/**
 * In one transaction: reassign the task (guarded on current owner) and/or the
 * boundary (guarded on current owner), then insert a `kind='handoff'` message
 * to `toAgent`. At least one of `taskId`/`boundaryId` is required.
 */
export function handoff(db: Db, params: HandoffParams, now: Clock = systemClock): HandoffResult {
  if (!params.taskId && !params.boundaryId) {
    return { ok: false, reason: 'invalid', message: 'at least one of task_id/boundary_id is required' };
  }
  const ts = now();

  try {
    return withTransaction(db, (): { ok: true; messageId: number; task?: Task; boundary?: Boundary } => {
      let task: Task | undefined;
      let boundary: Boundary | undefined;

      if (params.taskId) {
        const existing = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as
          | TaskRow
          | undefined;
        if (!existing) {
          throw new HandoffAbort({ ok: false, reason: 'not_found', message: `task ${params.taskId} not found` });
        }
        if (existing.owner_agent_id !== params.agentId) {
          throw new HandoffAbort({
            ok: false,
            reason: 'forbidden',
            message: `task ${params.taskId} is not owned by ${params.agentId}`,
          });
        }
        db.prepare(
          `UPDATE tasks SET owner_agent_id=@to, updated_at=@ts, version=version+1
            WHERE id=@id AND owner_agent_id=@from`,
        ).run({ to: params.toAgent, ts, id: params.taskId, from: params.agentId });
        const row = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as TaskRow;
        task = mapTaskRow(row);
      }

      if (params.boundaryId) {
        const existing = db.prepare(`SELECT * FROM boundaries WHERE id=@id`).get({ id: params.boundaryId }) as unknown as
          | BoundaryRow
          | undefined;
        if (!existing) {
          throw new HandoffAbort({ ok: false, reason: 'not_found', message: `boundary ${params.boundaryId} not found` });
        }
        if (existing.owner_agent_id !== params.agentId) {
          throw new HandoffAbort({
            ok: false,
            reason: 'forbidden',
            message: `boundary ${params.boundaryId} is not owned by ${params.agentId}`,
          });
        }
        db.prepare(`UPDATE boundaries SET owner_agent_id=@to WHERE id=@id AND owner_agent_id=@from`).run({
          to: params.toAgent,
          id: params.boundaryId,
          from: params.agentId,
        });
        const row = db.prepare(`SELECT * FROM boundaries WHERE id=@id`).get({ id: params.boundaryId }) as unknown as BoundaryRow;
        boundary = mapBoundaryRow(row);
      }

      const body = JSON.stringify({
        taskId: params.taskId ?? null,
        boundaryId: params.boundaryId ?? null,
        note: params.note ?? null,
      });
      const res = db
        .prepare(
          `INSERT INTO messages (stream_id, from_agent, to_agent, kind, body, created_at)
           VALUES (NULL, @from, @to, 'handoff', @body, @ts)`,
        )
        .run({ from: params.agentId, to: params.toAgent, body, ts });

      return { ok: true, messageId: Number(res.lastInsertRowid), task, boundary };
    });
  } catch (err) {
    if (err instanceof HandoffAbort) {
      return err.failure;
    }
    throw err;
  }
}
