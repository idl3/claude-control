import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { openDb } from '../src/store/db.js';
import * as agentsCore from '../src/core/agents.js';
import * as tasksCore from '../src/core/tasks.js';
import type { Task, Failure } from '../src/core/types.js';

const WORKER_PATH = fileURLToPath(new URL('./helpers/claim-worker.ts', import.meta.url));

interface WorkerMessage {
  agentId: string;
  result: ({ ok: true; task: Task } | Failure);
}

function runClaimInWorker(dbPath: string, taskId: string, agentId: string): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(WORKER_PATH, {
      // Only the tsx loader is needed for the worker to import .ts sources;
      // `process.execArgv` under `node --test` carries internal V8/test-runner
      // flags that aren't valid Worker execArgv, so it is not reused wholesale.
      execArgv: ['--import', 'tsx'],
      workerData: { dbPath, taskId, agentId },
    });
    worker.once('message', (msg: WorkerMessage) => {
      resolve(msg);
      void worker.terminate();
    });
    worker.once('error', (err) => {
      reject(err);
      void worker.terminate();
    });
  });
}

function freshDbPath(prefix: string): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dbPath: join(dir, 'collab.db') };
}

test('atomic claim: exactly one winner under N real concurrent connections', async () => {
  const { dir, dbPath } = freshDbPath('collab-claim-');
  try {
    const db = openDb(dbPath);
    const N = 20;
    const agentIds: string[] = [];
    for (let i = 0; i < N; i++) {
      const reg = agentsCore.register(db, { harness: 'test', agentId: `racer-${i}` });
      agentIds.push(reg.agentId);
    }
    const created = tasksCore.createTask(db, { agentId: agentIds[0]!, title: 'race task' });
    const taskId = created.taskId;
    db.close();

    // Fire N *separate* connections (one per worker thread) at the SAME task,
    // genuinely concurrently — not sequential same-thread calls.
    const results = await Promise.all(agentIds.map((agentId) => runClaimInWorker(dbPath, taskId, agentId)));

    const wins = results.filter((r) => r.result.ok === true);
    const conflicts = results.filter((r) => r.result.ok === false);

    assert.equal(wins.length, 1, `expected exactly one winner, got ${wins.length}`);
    assert.equal(conflicts.length, N - 1, `expected ${N - 1} conflicts, got ${conflicts.length}`);
    for (const c of conflicts) {
      assert.equal((c.result as Failure).reason, 'conflict');
    }

    // The task is now owned by the sole winner.
    const verifyDb = openDb(dbPath);
    const finalTask = tasksCore.getTask(verifyDb, taskId);
    assert.ok(finalTask);
    assert.equal(finalTask!.status, 'claimed');
    assert.equal(finalTask!.ownerAgentId, wins[0]!.agentId);

    // A claimed task cannot be re-claimed (even by a brand-new agent).
    const reReg = agentsCore.register(verifyDb, { harness: 'test', agentId: 'late-comer' });
    const reClaim = tasksCore.claimTask(verifyDb, { agentId: reReg.agentId, taskId });
    assert.equal(reClaim.ok, false);
    assert.equal((reClaim as Failure).reason, 'conflict');
    verifyDb.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claimTask: single-connection double-claim also conflicts', () => {
  const { dir, dbPath } = freshDbPath('collab-claim-single-');
  try {
    const db = openDb(dbPath);
    agentsCore.register(db, { harness: 'test', agentId: 'a1' });
    agentsCore.register(db, { harness: 'test', agentId: 'a2' });
    const { taskId } = tasksCore.createTask(db, { agentId: 'a1', title: 'solo task' });

    const first = tasksCore.claimTask(db, { agentId: 'a1', taskId });
    assert.equal(first.ok, true);

    const second = tasksCore.claimTask(db, { agentId: 'a2', taskId });
    assert.equal(second.ok, false);
    assert.equal((second as Failure).reason, 'conflict');
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
