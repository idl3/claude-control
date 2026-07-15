import type { Db } from '../store/db.js';
import type { Clock } from '../store/clock.js';
import { systemClock } from '../store/clock.js';
import { generateId } from '../store/ids.js';
import type { Failure, Task, TaskStatus } from './types.js';

interface TaskRow {
  id: string;
  stream_id: string | null;
  title: string;
  body: string | null;
  status: string;
  owner_agent_id: string | null;
  priority: number;
  version: number;
  created_by: string | null;
  created_at: number;
  updated_at: number;
  claimed_at: number | null;
  completed_at: number | null;
}

function mapTaskRow(row: TaskRow): Task {
  return {
    id: row.id,
    streamId: row.stream_id,
    title: row.title,
    body: row.body,
    status: row.status as TaskStatus,
    ownerAgentId: row.owner_agent_id,
    priority: row.priority,
    version: row.version,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}

export interface CreateTaskParams {
  agentId: string;
  title: string;
  body?: string | null;
  stream?: string | null;
  priority?: number;
}

/** Insert an `open` task. */
export function createTask(db: Db, params: CreateTaskParams, now: Clock = systemClock): { ok: true; taskId: string } {
  const id = generateId();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks (id, stream_id, title, body, status, owner_agent_id, priority, version, created_by, created_at, updated_at)
     VALUES (@id, @streamId, @title, @body, 'open', NULL, @priority, 0, @createdBy, @ts, @ts)`,
  ).run({
    id,
    streamId: params.stream ?? null,
    title: params.title,
    body: params.body ?? null,
    priority: params.priority ?? 0,
    createdBy: params.agentId,
    ts,
  });
  return { ok: true, taskId: id };
}

export interface ListTasksParams {
  stream?: string | null;
  status?: TaskStatus | null;
  owner?: string | null;
  mine?: boolean;
  agentId?: string | null;
}

/** Filtered list, ordered `priority DESC, created_at ASC`. */
export function listTasks(db: Db, params: ListTasksParams): { ok: true; tasks: Task[] } {
  const ownerFilter = params.mine ? params.agentId ?? null : params.owner ?? null;
  const rows = db
    .prepare(
      `SELECT * FROM tasks
        WHERE (@streamId IS NULL OR stream_id=@streamId)
          AND (@status IS NULL OR status=@status)
          AND (@owner IS NULL OR owner_agent_id=@owner)
        ORDER BY priority DESC, created_at ASC`,
    )
    .all({
      streamId: params.stream ?? null,
      status: params.status ?? null,
      owner: ownerFilter,
    }) as unknown as TaskRow[];
  return { ok: true, tasks: rows.map(mapTaskRow) };
}

export interface ClaimTaskParams {
  agentId: string;
  taskId: string;
}

export type ClaimTaskResult = { ok: true; task: Task } | Failure;

/**
 * Atomic conditional claim: a single `UPDATE ... WHERE status='open'`. No
 * read-then-write window — two racing claims can never both see changes===1.
 */
export function claimTask(db: Db, params: ClaimTaskParams, now: Clock = systemClock): ClaimTaskResult {
  const ts = now();
  const res = db
    .prepare(
      `UPDATE tasks
          SET status='claimed', owner_agent_id=@agentId, claimed_at=@ts, updated_at=@ts, version=version+1
        WHERE id=@taskId AND status='open'`,
    )
    .run({ agentId: params.agentId, taskId: params.taskId, ts });
  if (Number(res.changes) !== 1) {
    return { ok: false, reason: 'conflict', message: `task ${params.taskId} is not open` };
  }
  const row = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as TaskRow;
  return { ok: true, task: mapTaskRow(row) };
}

export interface UpdateTaskParams {
  agentId: string;
  taskId: string;
  status?: TaskStatus;
  body?: string | null;
  expectedVersion?: number;
}

export type UpdateTaskResult = { ok: true; task: Task } | Failure;

/**
 * Owner-guarded status/body change. When `expectedVersion` is present, the
 * update is additionally guarded on `version=@expectedVersion` (optimistic
 * concurrency); `changes===0` means someone else moved the task first.
 */
export function updateTask(db: Db, params: UpdateTaskParams, now: Clock = systemClock): UpdateTaskResult {
  const existing = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as TaskRow | undefined;
  if (!existing) {
    return { ok: false, reason: 'not_found', message: `task ${params.taskId} not found` };
  }
  if (existing.owner_agent_id !== params.agentId) {
    return { ok: false, reason: 'forbidden', message: `task ${params.taskId} is not owned by ${params.agentId}` };
  }
  const ts = now();
  const nextStatus = params.status ?? (existing.status as TaskStatus);
  const nextBody = params.body !== undefined ? params.body : existing.body;
  const hasExpectedVersion = typeof params.expectedVersion === 'number';
  const res = db
    .prepare(
      `UPDATE tasks
          SET status=@status, body=@body, version=version+1, updated_at=@ts
        WHERE id=@taskId AND owner_agent_id=@agentId
          AND (@expectedVersion IS NULL OR version=@expectedVersion)`,
    )
    .run({
      status: nextStatus,
      body: nextBody,
      ts,
      taskId: params.taskId,
      agentId: params.agentId,
      expectedVersion: hasExpectedVersion ? params.expectedVersion! : null,
    });
  if (Number(res.changes) === 0) {
    return { ok: false, reason: 'stale', message: `task ${params.taskId} version changed; re-read and retry` };
  }
  const row = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as TaskRow;
  return { ok: true, task: mapTaskRow(row) };
}

export interface CompleteTaskParams {
  agentId: string;
  taskId: string;
}

export type CompleteTaskResult = { ok: true; task: Task } | Failure;

/** Owner-only. Sets `status='done'`, `completed_at`. */
export function completeTask(db: Db, params: CompleteTaskParams, now: Clock = systemClock): CompleteTaskResult {
  const ts = now();
  const res = db
    .prepare(
      `UPDATE tasks
          SET status='done', completed_at=@ts, updated_at=@ts, version=version+1
        WHERE id=@taskId AND owner_agent_id=@agentId`,
    )
    .run({ taskId: params.taskId, agentId: params.agentId, ts });
  if (Number(res.changes) === 0) {
    const existing = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as TaskRow | undefined;
    if (!existing) {
      return { ok: false, reason: 'not_found', message: `task ${params.taskId} not found` };
    }
    return { ok: false, reason: 'forbidden', message: `task ${params.taskId} is not owned by ${params.agentId}` };
  }
  const row = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: params.taskId }) as unknown as TaskRow;
  return { ok: true, task: mapTaskRow(row) };
}

export function getTask(db: Db, taskId: string): Task | null {
  const row = db.prepare(`SELECT * FROM tasks WHERE id=@id`).get({ id: taskId }) as unknown as TaskRow | undefined;
  return row ? mapTaskRow(row) : null;
}

export { mapTaskRow };
export type { TaskRow };
