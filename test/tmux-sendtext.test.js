// Unit tests for sendText argv construction + ordering.
//
// Hermetic: drives the real sendText with a stub runner + stub delay that
// record call order without shelling out to tmux. Pass with NO tmux installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendText } from '../lib/tmux.js';

/** Stub runner recording every argv; stub delay recording its waits. */
function makeStub({ failOn } = {}) {
  const calls = [];
  const delays = [];
  async function _run(args) {
    calls.push([...args]);
    if (failOn && args[0] === failOn) throw new Error(`stub fail on ${failOn}`);
    return { stdout: '', stderr: '' };
  }
  async function _delay(ms) {
    delays.push(ms);
  }
  return { _run, _delay, calls, delays };
}

test('sendText: bracketed-paste path = set-buffer → paste-buffer(-p,-d) → delay → Enter', async () => {
  const { _run, _delay, calls, delays } = makeStub();
  await sendText('0:1.1', 'hello world', { _run, _delay });

  assert.equal(calls.length, 3, 'three tmux calls: set-buffer, paste-buffer, send-keys');
  assert.equal(calls[0][0], 'set-buffer');
  assert.equal(calls[1][0], 'paste-buffer');
  assert.ok(calls[1].includes('-p'), 'paste-buffer must be bracketed (-p)');
  assert.ok(calls[1].includes('-d'), 'paste-buffer must delete the buffer (-d)');
  assert.ok(calls[1].includes('-t') && calls[1].includes('0:1.1'), 'paste targets the pane');

  // Enter is the LAST call, and a settle delay happened before it.
  const last = calls[calls.length - 1];
  assert.deepEqual(
    [last[0], last[last.length - 1]],
    ['send-keys', 'Enter'],
    'final call is send-keys Enter',
  );
  assert.equal(delays.length, 1, 'one settle delay before Enter');
  assert.ok(delays[0] > 0, 'settle delay is positive');
});

test('sendText: the staged text is the buffer payload, not a send-keys arg', async () => {
  const { _run, _delay, calls } = makeStub();
  await sendText('0:1.1', 'multi\nline\ntext', { _run, _delay });
  const setBuf = calls[0];
  assert.equal(setBuf[setBuf.length - 1], 'multi\nline\ntext', 'text staged verbatim in set-buffer');
  // No call sends the text via send-keys -l on the happy path.
  assert.ok(!calls.some((c) => c[0] === 'send-keys' && c.includes('-l')), 'no literal send-keys on success');
});

test('sendText: falls back to literal send-keys path when paste-buffer fails', async () => {
  const { _run, _delay, calls } = makeStub({ failOn: 'paste-buffer' });
  await sendText('0:1.1', 'hi', { _run, _delay });

  // Fallback issues delete-buffer (cleanup) + literal send-keys + Enter.
  assert.ok(calls.some((c) => c[0] === 'delete-buffer'), 'orphaned buffer cleaned up');
  const literal = calls.find((c) => c[0] === 'send-keys' && c.includes('-l'));
  assert.ok(literal, 'fallback sends literal text');
  assert.equal(literal[literal.length - 1], 'hi');
  const last = calls[calls.length - 1];
  assert.equal(last[last.length - 1], 'Enter', 'fallback still ends with Enter');
});
