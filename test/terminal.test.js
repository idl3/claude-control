// test/terminal.test.js — ttyd lifecycle dedup.
//
// Regression for the async cache-stampede: concurrent first-hit requests on a
// cold open (iframe HTML GET + WS upgrade + asset GETs) must DEDUPE onto a
// single ttyd spawn. Before the fix the map entry was set only after
// `await findFreePort()`, so each racer spawned its own ttyd; losers leaked
// (untracked → never reaped) and the clobbered request 502'd.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import { ensureTerminal, reap, liveCount } from '../lib/terminal.js';

// A fake ttyd process: EventEmitter with a stderr stream + kill(). It never
// emits 'exit'/'error', so readiness is driven entirely by the injected
// waitForPort below.
function makeFakeProc() {
  const proc = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.kill = () => {};
  return proc;
}

test('ensureTerminal: concurrent cold hits spawn exactly ONE ttyd (no stampede)', async () => {
  const id = 'concurrent:1';
  let spawnCount = 0;
  const deps = {
    spawn: () => { spawnCount += 1; return makeFakeProc(); },
    findFreePort: async () => 40000 + spawnCount,
    // Resolve on the next tick so all concurrent callers are in-flight together.
    waitForPort: async (port) => { await Promise.resolve(); return port; },
  };

  try {
    // Fire 5 concurrent requests for the SAME id (the cold-open burst).
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ensureTerminal(id, '0:1.1', deps)),
    );
    assert.equal(spawnCount, 1, 'only one ttyd spawned for 5 concurrent hits');
    assert.equal(liveCount(), 1, 'exactly one tracked terminal');
    // All callers got the SAME port (shared the one spawn).
    const ports = new Set(results.map((r) => r.port));
    assert.equal(ports.size, 1, 'all callers resolved to the same port');
  } finally {
    reap(id);
  }
  assert.equal(liveCount(), 0, 'reaped after test');
});

test('ensureTerminal: a later request reuses the live terminal (no respawn)', async () => {
  const id = 'reuse:1';
  let spawnCount = 0;
  const deps = {
    spawn: () => { spawnCount += 1; return makeFakeProc(); },
    findFreePort: async () => 41000,
    waitForPort: async (port) => port,
  };
  try {
    await ensureTerminal(id, '0:1.1', deps);
    await ensureTerminal(id, '0:1.1', deps); // second hit, terminal already live
    assert.equal(spawnCount, 1, 'no respawn for an already-live terminal');
    assert.equal(liveCount(), 1);
  } finally {
    reap(id);
  }
});

test('ensureTerminal: invalid target throws before any spawn', async () => {
  let spawnCount = 0;
  const deps = { spawn: () => { spawnCount += 1; return makeFakeProc(); }, findFreePort: async () => 1, waitForPort: async (p) => p };
  await assert.rejects(() => ensureTerminal('bad', 'not a target!!', deps), /invalid tmux target/);
  assert.equal(spawnCount, 0, 'no ttyd spawned for an invalid target');
});
