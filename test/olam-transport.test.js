import { test } from 'node:test';
import assert from 'node:assert/strict';

import { dispatchSteer, composerMode, DISPATCH_ERRORS } from '../lib/olam-transport.js';

function client(apiPost) {
  return { org: 'atlas', apiPost };
}
const res = (status, ok = status < 300) => ({ ok, status, text: async () => '' });

// --- composerMode (C2) ----------------------------------------------------------

test('composerMode: read-only wins; awaiting-approval → approve; else steer', () => {
  assert.equal(composerMode({ readOnly: true }), 'read-only');
  assert.equal(composerMode({ planStatus: 'planned' }), 'approve');
  assert.equal(composerMode({ planStatus: 'awaiting_approval' }), 'approve');
  assert.equal(composerMode({ planStatus: 'approved', inFlight: true }), 'steer');
  assert.equal(composerMode({}), 'steer');
});

// --- dispatchSteer (C1 + C3) ----------------------------------------------------

test('steer mirrors cloud-dispatch body shape (messages[], executor, steer_mode)', async () => {
  let sent = null;
  const c = client(async (path, body) => { sent = { path, body }; return res(200); });
  const r = await dispatchSteer(c, { worldId: 'w1', sessionId: 's1', draft: 'do the thing', mode: 'hard' });
  assert.equal(r.ok, true);
  assert.equal(sent.path, '/api/cloud-dispatch');
  assert.equal(sent.body.world_id, 'w1');
  assert.equal(sent.body.session_id, 's1');
  assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'do the thing' }]);
  assert.equal(sent.body.executor, 'do');
  assert.equal(sent.body.steer_mode, 'hard');
});

test('dispatch error classes are surfaced verbatim, never swallowed', async () => {
  for (const [status, expected] of Object.entries(DISPATCH_ERRORS)) {
    const c = client(async () => res(Number(status), false));
    const r = await dispatchSteer(c, { worldId: 'w', sessionId: 's', draft: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.status, Number(status));
    assert.equal(r.error, expected);
  }
});

test('unknown HTTP status includes the body text (bounded) in the error', async () => {
  const c = client(async () => ({ ok: false, status: 500, text: async () => 'internal boom' }));
  const r = await dispatchSteer(c, { worldId: 'w', sessionId: 's', draft: 'x' });
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 500: internal boom/);
});

test('network throw degrades to a typed failure result, not an exception', async () => {
  const c = client(async () => { throw new Error('socket hang up'); });
  const r = await dispatchSteer(c, { worldId: 'w', sessionId: 's', draft: 'x' });
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.error, /socket hang up/);
});

test('default mode is soft', async () => {
  let body = null;
  const c = client(async (_p, b) => { body = b; return res(202); });
  await dispatchSteer(c, { worldId: 'w', sessionId: 's', draft: 'x' });
  assert.equal(body.steer_mode, 'soft');
});
