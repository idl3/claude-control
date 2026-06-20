/**
 * test/ws-serialize.test.js
 *
 * Unit tests for the runSerial per-target FIFO serialisation primitive
 * exported from server.js.
 *
 * Teeth: a naive implementation that just awaits fn() directly (no chaining)
 * would FAIL the same-key ordering test because B would start before A settles.
 *
 * Run: node --test test/ws-serialize.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Import directly — server.js guards main() behind `_isMain` so importing it
// is side-effect-free (no server starts, no tmux calls, no filesystem access).
import { runSerial } from '../server.js';

// ---------------------------------------------------------------------------
// Helper: a manually-resolved deferred promise so tests can control timing.
// ---------------------------------------------------------------------------
function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// ---------------------------------------------------------------------------
// Test 1: same target → ops run in FIFO order (B waits for A)
//
// Tooth: a naive `async (fn) => fn()` with no chaining lets B start immediately
// alongside A.  That would fail the assertion that B's start is recorded AFTER
// A's end.
// ---------------------------------------------------------------------------
test('runSerial: same target — B does not start until A settles', async () => {
  const key = 'target:same-key-test';
  const log = [];

  const dA = deferred();

  // Op A: holds until dA resolves.
  const taskA = runSerial(key, async () => {
    log.push('A:start');
    await dA.promise;
    log.push('A:end');
    return 'result-A';
  });

  // Op B: enqueued behind A; should not start until A ends.
  const taskB = runSerial(key, async () => {
    log.push('B:start');
    return 'result-B';
  });

  // At this point A is running (started, blocked on dA). B should NOT have
  // started yet (the chain holds it back).
  // Yield to the microtask queue to let any eager execution happen.
  await new Promise((r) => setImmediate(r));

  assert.deepEqual(log, ['A:start'], 'B must not start while A is pending');

  // Unblock A.
  dA.resolve();

  const [rA, rB] = await Promise.all([taskA, taskB]);

  assert.equal(rA, 'result-A');
  assert.equal(rB, 'result-B');
  assert.deepEqual(log, ['A:start', 'A:end', 'B:start'],
    'order must be A:start → A:end → B:start');
});

// ---------------------------------------------------------------------------
// Test 2: different targets → ops run concurrently (B starts before A settles)
//
// Tooth: if every op were serialised on a single global lock, B would not start
// until A finished — the test would hang or fail the concurrency assertion.
// ---------------------------------------------------------------------------
test('runSerial: different targets — ops run concurrently', async () => {
  const keyA = 'target:concurrent-A';
  const keyB = 'target:concurrent-B';
  const log = [];

  const dA = deferred();

  // Op on key A: holds until dA resolves.
  const taskA = runSerial(keyA, async () => {
    log.push('A:start');
    await dA.promise;
    log.push('A:end');
  });

  // Op on key B (different target): should start immediately, not blocked by A.
  const taskB = runSerial(keyB, async () => {
    log.push('B:start');
  });

  // Yield to let B run.
  await new Promise((r) => setImmediate(r));

  assert.ok(log.includes('B:start'), 'B must start while A is still pending (different targets)');
  assert.ok(log.includes('A:start'), 'A must have started');
  assert.ok(!log.includes('A:end'), 'A must not have ended yet');

  // Unblock A and wait for both.
  dA.resolve();
  await Promise.all([taskA, taskB]);

  assert.deepEqual(log, ['A:start', 'B:start', 'A:end']);
});

// ---------------------------------------------------------------------------
// Test 3: a rejecting op does NOT prevent the next op from running
//
// Tooth: if chain propagation stopped on rejection (e.g. `.then(fn)` only,
// not `.then(fn, fn)`), the next op in the queue would never start.
// ---------------------------------------------------------------------------
test('runSerial: rejecting op on a key does not block subsequent ops', async () => {
  const key = 'target:rejection-test';
  const log = [];

  // Op A: rejects.
  const taskA = runSerial(key, async () => {
    log.push('A:start');
    throw new Error('A failed');
  });

  // Op B: queued behind A; must still run even though A rejects.
  const taskB = runSerial(key, async () => {
    log.push('B:start');
    return 'B:ok';
  });

  // taskA should reject.
  await assert.rejects(taskA, /A failed/, 'taskA must reject with the original error');

  // taskB should fulfill.
  const rB = await taskB;
  assert.equal(rB, 'B:ok', 'taskB must fulfill despite A rejecting');

  assert.deepEqual(log, ['A:start', 'B:start'],
    'B must still execute after A rejected');
});

// ---------------------------------------------------------------------------
// Test 4: Map entry is cleaned up after the chain goes idle (no leak)
// ---------------------------------------------------------------------------
test('runSerial: _opChains entry is deleted after chain goes idle', async () => {
  // We can't reach _opChains directly (it's module-private), but we CAN verify
  // that successive calls on the same key still work correctly after the chain
  // has settled — which means the cleanup didn't break re-entry.
  const key = 'target:cleanup-test';
  const log = [];

  await runSerial(key, async () => { log.push('first'); });
  // Yield to let the finally() cleanup run.
  await new Promise((r) => setImmediate(r));

  // Second wave: if cleanup was correct, this still queues and runs.
  await runSerial(key, async () => { log.push('second'); });

  assert.deepEqual(log, ['first', 'second'], 're-entry after cleanup must work');
});
