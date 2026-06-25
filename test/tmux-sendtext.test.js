// Unit tests for sendText argv construction + ordering.
//
// Hermetic: drives the real sendText with a stub runner + stub delay that
// record call order without shelling out to tmux. Pass with NO tmux installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendText } from '../lib/tmux.js';

/** Stub runner recording every argv; stub delay recording its waits.
 *  `capture` (string | (callIndex)=>string) feeds capture-pane stdout so the
 *  "Pasting…" poll can be driven deterministically. */
function makeStub({ failOn, capture } = {}) {
  const calls = [];
  const delays = [];
  let captureCall = 0;
  async function _run(args) {
    calls.push([...args]);
    if (failOn && args[0] === failOn) throw new Error(`stub fail on ${failOn}`);
    if (args[0] === 'capture-pane') {
      const out = typeof capture === 'function' ? capture(captureCall++) : capture ?? '';
      return { stdout: out, stderr: '' };
    }
    return { stdout: '', stderr: '' };
  }
  async function _delay(ms) {
    delays.push(ms);
  }
  return { _run, _delay, calls, delays };
}

test('sendText: set-buffer → paste-buffer(-p,-d) → poll capture → send-keys Enter', async () => {
  const { _run, _delay, calls } = makeStub(); // capture returns '' → no "Pasting…"
  await sendText('0:1.1', 'hello world', { _run, _delay });

  assert.equal(calls[0][0], 'set-buffer');
  assert.equal(calls[1][0], 'paste-buffer');
  assert.ok(calls[1].includes('-p'), 'paste-buffer must be bracketed (-p)');
  assert.ok(calls[1].includes('-d'), 'paste-buffer must delete the buffer (-d)');
  assert.ok(calls[1].includes('-t') && calls[1].includes('0:1.1'), 'paste targets the pane');

  const captures = calls.filter((c) => c[0] === 'capture-pane');
  assert.equal(captures.length, 1, 'polls once when "Pasting…" is already clear');

  const last = calls[calls.length - 1];
  assert.deepEqual(
    [last[0], last[last.length - 1]],
    ['send-keys', 'Enter'],
    'final call is send-keys Enter',
  );
});

test('sendText: the staged text is the buffer payload, not a send-keys arg', async () => {
  const { _run, _delay, calls } = makeStub();
  await sendText('0:1.1', 'multi\nline\ntext', { _run, _delay });
  const setBuf = calls[0];
  assert.equal(setBuf[setBuf.length - 1], 'multi\nline\ntext', 'text staged verbatim in set-buffer');
  // No call sends the text via send-keys -l on the happy path.
  assert.ok(!calls.some((c) => c[0] === 'send-keys' && c.includes('-l')), 'no literal send-keys on success');
});

test('sendText: polls while "Pasting…" shows, bounded by settleMs, then submits', async () => {
  const { _run, _delay, calls } = makeStub({ capture: () => 'Pasting…' }); // never clears
  await sendText('0:1.1', 'img', { _run, _delay, settleMs: 600 }); // ceil(600/120) = 5 polls
  const captures = calls.filter((c) => c[0] === 'capture-pane');
  assert.equal(captures.length, 5, 'polls up to the budget ceiling');
  const last = calls[calls.length - 1];
  assert.equal(last[last.length - 1], 'Enter', 'still submits after the ceiling');
});

test('sendText: sends Enter as soon as "Pasting…" clears (deterministic)', async () => {
  // "Pasting…" for the first 2 captures, then gone — Enter must fire right after.
  const { _run, _delay, calls } = makeStub({ capture: (i) => (i < 2 ? 'Pasting…' : '') });
  await sendText('0:1.1', 'img', { _run, _delay, settleMs: 6000 });
  const captures = calls.filter((c) => c[0] === 'capture-pane');
  assert.equal(captures.length, 3, 'stops polling on the first clear capture');
  const last = calls[calls.length - 1];
  assert.equal(last[last.length - 1], 'Enter');
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
