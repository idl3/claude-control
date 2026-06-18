import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listProcesses, killProcess } from '../lib/resources.js';

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
