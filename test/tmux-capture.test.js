// Unit tests for capturePane argument construction.
//
// These are hermetic — they drive the real capturePane with a stub runner that
// records argv without shelling out to tmux. They pass with NO tmux installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { capturePane } from '../lib/tmux.js';

/**
 * Build a stub runner that records every args array passed to it.
 * Returns `{ _run, calls }`.
 */
function makeStub() {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  return { _run, calls };
}

// ── capturePane arg construction ─────────────────────────────────────────────

test('capturePane default: includes -p, -S; no -e, no -J', async () => {
  const { _run, calls } = makeStub();
  await capturePane('0:1.1', 40, false, false, { _run });
  assert.equal(calls.length, 1);
  const argv = calls[0];
  assert.ok(argv.includes('-p'), 'must include -p (print to stdout)');
  assert.ok(argv.some(a => a.startsWith('-')), 'must have flags');
  assert.ok(!argv.includes('-e'), 'escapes=false must NOT include -e');
  assert.ok(!argv.includes('-J'), 'join=false must NOT include -J');
});

test('capturePane with escapes=true includes -e but not -J', async () => {
  const { _run, calls } = makeStub();
  await capturePane('0:1.1', 40, true, false, { _run });
  const argv = calls[0];
  assert.ok(argv.includes('-e'), 'escapes=true must include -e');
  assert.ok(!argv.includes('-J'), 'join=false must NOT include -J');
});

test('capturePane with join=true includes -J but not -e when escapes=false', async () => {
  const { _run, calls } = makeStub();
  await capturePane('0:1.1', 40, false, true, { _run });
  const argv = calls[0];
  assert.ok(!argv.includes('-e'), 'escapes=false must NOT include -e');
  assert.ok(argv.includes('-J'), 'join=true must include -J');
});

test('capturePane with escapes=true and join=true includes both -e and -J', async () => {
  const { _run, calls } = makeStub();
  await capturePane('0:1.1', 200, true, true, { _run });
  const argv = calls[0];
  assert.ok(argv.includes('-e'), 'escapes=true must include -e');
  assert.ok(argv.includes('-J'), 'join=true must include -J');
});

test('capturePane passes the -S line-count arg', async () => {
  const { _run, calls } = makeStub();
  await capturePane('0:1.1', 77, false, false, { _run });
  const argv = calls[0];
  const sIdx = argv.indexOf('-S');
  assert.ok(sIdx >= 0, 'must include -S');
  assert.equal(argv[sIdx + 1], '-77', '-S value must be negated line count');
});

test('capturePane visibleOnly OMITS -S (visible screen only, no scrollback)', async () => {
  const { _run, calls } = makeStub();
  await capturePane('0:1.1', 26, false, false, { _run, visibleOnly: true });
  const argv = calls[0];
  assert.equal(argv.indexOf('-S'), -1, 'visibleOnly must NOT pass -S (no scrollback)');
  assert.ok(argv.includes('-p'), 'still captures the pane');
});

test('capturePane passes the target with -t', async () => {
  const { _run, calls } = makeStub();
  await capturePane('mysession:2.0', 40, false, false, { _run });
  const argv = calls[0];
  const tIdx = argv.indexOf('-t');
  assert.ok(tIdx >= 0, 'must include -t');
  assert.equal(argv[tIdx + 1], 'mysession:2.0', '-t value must be the target');
});
