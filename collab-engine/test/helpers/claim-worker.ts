/**
 * Worker-thread entry point for claim.test.ts. Opens its OWN `DatabaseSync`
 * connection to the shared db file (genuinely separate from every other
 * worker's connection) and fires exactly one `claimTask` through the real
 * `core/tasks.ts` function — proving atomicity across real concurrent
 * writers, not just sequential same-thread calls.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { openDb } from '../../src/store/db.js';
import { claimTask } from '../../src/core/tasks.js';

interface WorkerInput {
  dbPath: string;
  taskId: string;
  agentId: string;
}

const { dbPath, taskId, agentId } = workerData as WorkerInput;

const db = openDb(dbPath);
const result = claimTask(db, { agentId, taskId });
db.close();

parentPort!.postMessage({ agentId, result });
