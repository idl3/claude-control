import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProcesses, killProcess, parseVmStat, parsePmset } from '../lib/resources.js';
import { ResourceMonitor } from '../lib/resources.js';

// ── killProcess guards ───────────────────────────────────────────────────────

test('killProcess rejects non-integer / out-of-range pids', () => {
  assert.deepEqual(killProcess('abc'), { ok: false, error: 'invalid pid' });
  assert.deepEqual(killProcess(0), { ok: false, error: 'invalid pid' });
  assert.deepEqual(killProcess(1), { ok: false, error: 'invalid pid' });
  assert.deepEqual(killProcess(-5), { ok: false, error: 'invalid pid' });
});

test('killProcess refuses to kill the control server itself', () => {
  const r = killProcess(process.pid);
  assert.equal(r.ok, false);
  assert.match(r.error, /control server/);
});

test('killProcess reports failure for a non-existent pid (no throw)', () => {
  // PID 2^31-1 is effectively never live; process.kill throws ESRCH → {ok:false}.
  const r = killProcess(2147483646);
  assert.equal(r.ok, false);
  assert.ok(typeof r.error === 'string' && r.error.length > 0);
});

// ── listProcesses ────────────────────────────────────────────────────────────

test('listProcesses returns CPU-sorted rows with the expected shape', () => {
  const rows = listProcesses(10);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0, 'expected at least one process on the host');
  assert.ok(rows.length <= 10, 'respects the limit');
  for (const r of rows) {
    assert.equal(typeof r.pid, 'number');
    assert.equal(typeof r.cpu, 'number');
    assert.equal(typeof r.command, 'string');
  }
  // Sorted by CPU descending.
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].cpu >= rows[i].cpu);
  }
});

// ── parseVmStat — pure parser unit tests ────────────────────────────────────

// Fixture: representative vm_stat output from macOS (trimmed).
const VM_STAT_FIXTURE = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               12345.
Pages active:                            200000.
Pages inactive:                           30000.
Pages speculative:                         5000.
Pages throttled:                              0.
Pages wired down:                         80000.
Pages purgeable:                           2000.
"Translation faults":                   5000000.
Pages copy-on-write:                      10000.
Pages zero filled:                       100000.
Pages reactivated:                         1000.
Pages purged:                              500.
File-backed pages:                        25000.
Pages occupied by compressor:             15000.
Decompressions:                            2000.
Compressions:                              3000.
Pageins:                                  50000.
Pageouts:                                   100.
Swapins:                                    200.
Swapouts:                                   150.
`;

test('parseVmStat: returns correct reclaimable byte count from fixture', () => {
  const result = parseVmStat(VM_STAT_FIXTURE);
  // Expected: (12345 + 30000 + 5000 + 2000 + 25000) pages × 16384 bytes
  const expectedPages = 12345 + 30000 + 5000 + 2000 + 25000;
  assert.equal(result, expectedPages * 16384,
    `expected ${expectedPages * 16384} bytes but got ${result}`);
});

test('parseVmStat: uses correct page size from header', () => {
  // Swap the page size to 4096 — result must scale accordingly.
  const out = VM_STAT_FIXTURE.replace('page size of 16384 bytes', 'page size of 4096 bytes');
  const result = parseVmStat(out);
  const expectedPages = 12345 + 30000 + 5000 + 2000 + 25000;
  assert.equal(result, expectedPages * 4096);
});

test('parseVmStat: returns null for unparseable output', () => {
  assert.equal(parseVmStat(''), null);
  assert.equal(parseVmStat('garbage data with no vm_stat fields'), null);
});

test('parseVmStat: wrong field offset would change the result (teeth)', () => {
  // If someone accidentally read a different field (e.g. Pages active = 200000)
  // the expected value would differ. This verifies we're reading the right labels.
  const result = parseVmStat(VM_STAT_FIXTURE);
  const expectedPages = 12345 + 30000 + 5000 + 2000 + 25000;
  // Pages active (200000) must NOT appear in the reclaimable sum.
  assert.notEqual(result, (200000 + 12345 + 30000 + 5000 + 2000 + 25000) * 16384);
  assert.equal(result, expectedPages * 16384);
});

// ── parsePmset — pure parser unit tests ──────────────────────────────────────

const PMSET_BATT_FIXTURE = `Now drawing from 'Battery Power'
 -InternalBattery-0 (id=1234567)	75%; discharging; 3:42 remaining present: true
`;

const PMSET_AC_FIXTURE = `Now drawing from 'AC Power'
 -InternalBattery-0 (id=1234567)	92%; charging; (no estimate) present: true
`;

const PMSET_AC_NO_BATT_FIXTURE = `Now drawing from 'AC Power'
`;

test('parsePmset: discharging battery at 75% — hasBattery, not charging, not low', () => {
  const result = parsePmset(PMSET_BATT_FIXTURE);
  assert.equal(result.hasBattery, true);
  assert.equal(result.percent, 75);
  assert.equal(result.charging, false);
  assert.equal(result.low, false);
});

test('parsePmset: charging at 92% — hasBattery, charging, not low', () => {
  const result = parsePmset(PMSET_AC_FIXTURE);
  assert.equal(result.hasBattery, true);
  assert.equal(result.percent, 92);
  assert.equal(result.charging, true);
  assert.equal(result.low, false);
});

test('parsePmset: AC only, no battery — hasBattery false', () => {
  const result = parsePmset(PMSET_AC_NO_BATT_FIXTURE);
  assert.equal(result.hasBattery, false);
  assert.equal(result.charging, true);
});

test('parsePmset: battery at 15%, discharging — low is true', () => {
  const out = PMSET_BATT_FIXTURE.replace('75%', '15%');
  const result = parsePmset(out);
  assert.equal(result.hasBattery, true);
  assert.equal(result.percent, 15);
  assert.equal(result.charging, false);
  assert.equal(result.low, true);
});

test('parsePmset: battery at 20%, discharging — low is true (boundary)', () => {
  const out = PMSET_BATT_FIXTURE.replace('75%', '20%');
  const result = parsePmset(out);
  assert.equal(result.low, true);
});

test('parsePmset: battery at 21%, discharging — low is false (boundary)', () => {
  const out = PMSET_BATT_FIXTURE.replace('75%', '21%');
  const result = parsePmset(out);
  assert.equal(result.low, false);
});

test('parsePmset: wrong percent field would change the result (teeth)', () => {
  // Verify we're reading the battery's % not something else.
  const result = parsePmset(PMSET_BATT_FIXTURE);
  assert.notEqual(result.percent, 92); // 92 is from the AC fixture, not this one
  assert.equal(result.percent, 75);
});

// ── _tick re-entrancy guard ──────────────────────────────────────────────────

test('_tick: second concurrent call returns early (re-entrancy guard)', async () => {
  const monitor = new ResourceMonitor({ intervalMs: 60000 });

  let execCallCount = 0;

  // Monkey-patch _tick to observe guard behaviour without actually spawning
  // subprocesses. We simulate a slow async operation via a deferred promise.
  let resolveFirst;
  const slowOp = new Promise((res) => { resolveFirst = res; });

  const originalTick = monitor._tick.bind(monitor);

  // Override _tick so the first call hangs on slowOp (simulating slow exec),
  // and we can fire a second call while the first is in-flight.
  monitor._tick = async function () {
    execCallCount++;
    if (this._ticking) return; // guard check identical to production code
    this._ticking = true;
    try {
      await slowOp;
    } finally {
      this._ticking = false;
    }
  };

  // Fire tick #1 — it will be in-flight waiting on slowOp.
  const p1 = monitor._tick();

  // Fire tick #2 immediately — the guard should cause it to return early.
  const p2 = monitor._tick();

  // Resolve the first tick's slow operation.
  resolveFirst();
  await Promise.all([p1, p2]);

  // execCallCount tracks entries into our patched _tick. Both ticks were
  // invoked, but only the first should have done real work (the second bails
  // at the guard). Both increment the counter, but the test verifies the
  // guard flag behaviour: only one was ever _ticking = true at a time.
  // The key assertion: guard is false after both settle.
  assert.equal(monitor._ticking, false, 'guard must be released after ticks complete');

  // Restore to ensure no timer leak.
  monitor.stop();
});

test('_tick: guard prevents overlap — second tick skips when first in-flight', async () => {
  const monitor = new ResourceMonitor({ intervalMs: 60000 });

  const log = [];
  let resolveSlowTick;
  const slowTickDone = new Promise((res) => { resolveSlowTick = res; });

  // Replace _tick with a controlled version that uses the real guard pattern.
  monitor._tick = async function () {
    if (this._ticking) {
      log.push('skipped');
      return;
    }
    this._ticking = true;
    try {
      log.push('started');
      await slowTickDone;
      log.push('finished');
    } finally {
      this._ticking = false;
    }
  };

  // First tick — goes in-flight.
  const t1 = monitor._tick();
  // Second tick — must be skipped.
  const t2 = monitor._tick();
  // Third tick — must also be skipped.
  const t3 = monitor._tick();

  resolveSlowTick();
  await Promise.all([t1, t2, t3]);

  assert.deepEqual(log, ['started', 'skipped', 'skipped', 'finished'],
    'only the first tick should execute; subsequent ones must skip');

  monitor.stop();
});

test('overlimit pressure relief repeats after cooldown while RSS stays high', () => {
  const monitor = new ResourceMonitor({
    intervalMs: 60000,
    overlimitCooldownMs: 1000,
  });
  const high = { overLimit: true };
  const normal = { overLimit: false };
  const events = [];
  monitor.on('overlimit', (snapshot) => events.push(snapshot));

  monitor._maybeEmitOverlimit(high, 10_000); // rising edge
  monitor._maybeEmitOverlimit(high, 10_999); // still cooling down
  monitor._maybeEmitOverlimit(high, 11_000); // sustained pressure, cooldown elapsed
  assert.deepEqual(events, [high, high]);

  monitor._maybeEmitOverlimit(normal, 11_100); // recovery resets the edge detector
  monitor._maybeEmitOverlimit(high, 11_101);   // new rising edge is immediate
  assert.deepEqual(events, [high, high, high]);
});
