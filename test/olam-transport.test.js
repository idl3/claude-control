import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  dispatchSteer,
  dispatchLiveSteer,
  dispatchResume,
  shouldSteerDoor,
  composerMode,
  isExecuteShaped,
  preSendGate,
  DISPATCH_ERRORS,
} from '../lib/olam-transport.js';

function client(apiPost) {
  return { org: 'atlas', apiPost };
}
const res = (status, ok = status < 300) => ({ ok, status, text: async () => '' });
/** A steer-door-shaped response that carries a parseable JSON body. */
const jsonRes = (status, body, ok = status < 300) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) });

// --- composerMode (C2) ----------------------------------------------------------

test('composerMode: read-only wins; awaiting-approval → approve; else steer', () => {
  assert.equal(composerMode({ readOnly: true }), 'read-only');
  assert.equal(composerMode({ planStatus: 'planned' }), 'approve');
  assert.equal(composerMode({ planStatus: 'awaiting_approval' }), 'approve');
  assert.equal(composerMode({ planStatus: 'approved', inFlight: true }), 'steer');
  assert.equal(composerMode({}), 'steer');
});

// --- composerMode + liveness precedence (Phase A, task A4) ----------------------

test('composerMode: no liveness arg is a no-op — pre-Phase-A callers unaffected', () => {
  assert.equal(composerMode({ pool: 'linear' }), 'steer');
  assert.equal(composerMode({ pool: 'linear' }, undefined), 'steer');
  assert.equal(composerMode({ pool: 'linear' }, null), 'steer');
});

test('composerMode: read-only outranks dormant/unknown liveness', () => {
  assert.equal(composerMode({ readOnly: true, pool: 'linear' }, { state: 'dormant' }), 'read-only');
  assert.equal(composerMode({ readOnly: true, pool: 'linear' }, { state: 'unknown' }), 'read-only');
});

test('composerMode: approve (awaiting plan) outranks dormant/unknown liveness', () => {
  assert.equal(composerMode({ planStatus: 'planned', pool: 'linear' }, { state: 'dormant' }), 'approve');
  assert.equal(composerMode({ planStatus: 'awaiting_approval', pool: 'linear' }, { state: 'unknown' }), 'approve');
});

test('composerMode: dormant/unknown liveness demotes an execute-shaped session from steer', () => {
  assert.equal(composerMode({ pool: 'linear' }, { state: 'dormant' }), 'dormant');
  assert.equal(composerMode({ pool: 'linear' }, { state: 'unknown' }), 'unknown');
  assert.equal(composerMode({ pool: 'linear' }, { state: 'live' }), 'steer');
});

test('composerMode: dormant/unknown liveness does NOT demote a non-execute-shaped (chat) session', () => {
  // No pool, no containerSessionId, liveness.state itself isn't 'dormant' —
  // isExecuteShaped stays false, so 'unknown' liveness for a plan/chat
  // session must never gate its composer (the A5-confirmed common case).
  assert.equal(composerMode({}, { state: 'unknown' }), 'steer');
});

test('composerMode: liveness.state dormant is itself sufficient proof of execute-shape (no pool needed)', () => {
  assert.equal(composerMode({}, { state: 'dormant' }), 'dormant');
});

test('composerMode: a containerSessionId on liveness is itself sufficient proof of execute-shape', () => {
  assert.equal(composerMode({}, { state: 'unknown', containerSessionId: 'c1' }), 'unknown');
});

// --- CP3 audit Finding 2: 'n/a' liveness sentinel (never demotes) ---------------

test('composerMode: n/a liveness (no check applicable/made) never demotes — distinct from unknown', () => {
  assert.equal(composerMode({ pool: 'linear' }, { state: 'n/a' }), 'steer');
  assert.equal(composerMode({}, { state: 'n/a' }), 'steer');
  assert.equal(composerMode({ readOnly: true }, { state: 'n/a' }), 'read-only'); // read-only still outranks
});

test('isExecuteShaped: n/a liveness state carries no positive evidence', () => {
  assert.equal(isExecuteShaped({}, { state: 'n/a' }), false);
  assert.equal(isExecuteShaped({ pool: null }, { state: 'n/a' }), false);
});

test('preSendGate: n/a liveness never locks out an execute-shaped session', () => {
  assert.deepEqual(preSendGate({ pool: 'linear' }, { state: 'n/a' }), { ok: true, mode: 'steer' });
});

// --- isExecuteShaped (Phase A execute/chat discriminator) -----------------------

test('isExecuteShaped: true on dormant liveness, containerSessionId, or a confirmed pool', () => {
  assert.equal(isExecuteShaped({}, { state: 'dormant' }), true);
  assert.equal(isExecuteShaped({}, { state: 'unknown', containerSessionId: 'c1' }), true);
  assert.equal(isExecuteShaped({ pool: 'sandbox' }, undefined), true);
});

test('isExecuteShaped: false with no positive signal — "if in doubt, stay steer"', () => {
  assert.equal(isExecuteShaped({}, undefined), false);
  assert.equal(isExecuteShaped({}, { state: 'unknown' }), false);
  assert.equal(isExecuteShaped({ pool: null }, { state: 'live' }), false);
});

// --- preSendGate (Phase A pre-send lockout) --------------------------------------

test('preSendGate: ok:true for steer/approve, carries the resolved mode', () => {
  assert.deepEqual(preSendGate({}), { ok: true, mode: 'steer' });
  assert.deepEqual(preSendGate({ planStatus: 'planned' }), { ok: true, mode: 'approve' });
});

test('preSendGate: read-only refuses with its own message', () => {
  const gate = preSendGate({ readOnly: true });
  assert.equal(gate.ok, false);
  assert.equal(gate.mode, 'read-only');
  assert.match(gate.error, /read-only/);
});

test('preSendGate: dormant/unknown refuse with DISPATCH_ERRORS copy, never call further', () => {
  const dormant = preSendGate({ pool: 'linear' }, { state: 'dormant' });
  assert.equal(dormant.ok, false);
  assert.equal(dormant.mode, 'dormant');
  assert.equal(dormant.error, DISPATCH_ERRORS.dormant);

  const unknown = preSendGate({ pool: 'linear' }, { state: 'unknown' });
  assert.equal(unknown.ok, false);
  assert.equal(unknown.mode, 'unknown');
  assert.equal(unknown.error, DISPATCH_ERRORS.unknown);
});

test('preSendGate: a non-execute-shaped (chat) session ignores dormant/unknown liveness entirely', () => {
  const gate = preSendGate({}, { state: 'unknown' });
  assert.deepEqual(gate, { ok: true, mode: 'steer' });
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
  // DISPATCH_ERRORS also carries the Phase A 'dormant'/'unknown' string keys
  // (composerMode/preSendGate lookups, not HTTP statuses) — only the
  // numeric-status entries apply to dispatchSteer's HTTP-status branch.
  for (const [status, expected] of Object.entries(DISPATCH_ERRORS)) {
    if (!/^\d+$/.test(status)) continue;
    const c = client(async () => res(Number(status), false));
    const r = await dispatchSteer(c, { worldId: 'w', sessionId: 's', draft: 'x' });
    assert.equal(r.ok, false);
    assert.equal(r.status, Number(status));
    assert.equal(r.error, expected);
  }
});

test('DISPATCH_ERRORS carries the Phase A dormant/unknown refusal copy (non-HTTP-status keys)', () => {
  assert.match(DISPATCH_ERRORS.dormant, /dormant/);
  assert.match(DISPATCH_ERRORS.unknown, /unknown/);
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

// --- shouldSteerDoor (Phase B, B3 routing predicate) -----------------------------

test('shouldSteerDoor: execute-shaped + live → true', () => {
  assert.equal(shouldSteerDoor({ pool: 'linear' }, { state: 'live' }), true);
  assert.equal(shouldSteerDoor({}, { state: 'live', containerSessionId: 'c1' }), true);
});

test('shouldSteerDoor: execute-shaped + dormant/unknown/n-a/no-liveness → false (never steer door)', () => {
  assert.equal(shouldSteerDoor({ pool: 'linear' }, { state: 'dormant' }), false);
  assert.equal(shouldSteerDoor({ pool: 'linear' }, { state: 'unknown' }), false);
  assert.equal(shouldSteerDoor({ pool: 'linear' }, { state: 'n/a' }), false);
  assert.equal(shouldSteerDoor({ pool: 'linear' }, undefined), false);
});

test('shouldSteerDoor: a plan/chat (non execute-shaped) session is false even if liveness somehow reads live', () => {
  assert.equal(shouldSteerDoor({}, { state: 'live' }), false);
});

// --- dispatchLiveSteer (Phase B, B3 routing decision) -----------------------------

test('dispatchLiveSteer: routing decision table — execute+live→steer door; execute+dormant/unknown→dispatch; plan→dispatch', async () => {
  const table = [
    { label: 'execute + live', session: { pool: 'linear' }, liveness: { state: 'live' }, wantDoor: 'steer-live', wantPath: '/api/session-steer' },
    { label: 'execute + dormant', session: { pool: 'linear' }, liveness: { state: 'dormant' }, wantDoor: 'dispatch', wantPath: '/api/cloud-dispatch' },
    { label: 'execute + unknown', session: { pool: 'linear' }, liveness: { state: 'unknown' }, wantDoor: 'dispatch', wantPath: '/api/cloud-dispatch' },
    { label: 'plan/chat, no liveness', session: {}, liveness: undefined, wantDoor: 'dispatch', wantPath: '/api/cloud-dispatch' },
    { label: 'plan/chat, liveness live (defence-in-depth — never happens upstream since chat sessions have no mapping)', session: {}, liveness: { state: 'live' }, wantDoor: 'dispatch', wantPath: '/api/cloud-dispatch' },
  ];
  for (const { label, session, liveness, wantDoor, wantPath } of table) {
    let sent = null;
    const c = client(async (path, body) => { sent = { path, body }; return res(200); });
    const r = await dispatchLiveSteer(c, { worldId: 'w1', sessionId: 's1', ...session }, liveness, 'x');
    assert.equal(r.ok, true, label);
    assert.equal(r.door, wantDoor, label);
    assert.equal(sent.path, wantPath, label);
  }
});

test('dispatchLiveSteer: steer-door body shape is {session_id, instruction, mode} — NOT the cloud-dispatch shape', async () => {
  let sent = null;
  const c = client(async (path, body) => { sent = { path, body }; return res(200); });
  const r = await dispatchLiveSteer(c, { worldId: 'w1', sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'do the thing', 'hard');
  assert.equal(r.ok, true);
  assert.equal(sent.path, '/api/session-steer');
  assert.deepEqual(sent.body, { session_id: 's1', instruction: 'do the thing', mode: 'hard' });
});

test('dispatchLiveSteer: dispatch-fallback body is byte-identical to dispatchSteer (plan-session acceptance)', async () => {
  let sent = null;
  const c = client(async (path, body) => { sent = { path, body }; return res(200); });
  const r = await dispatchLiveSteer(c, { worldId: 'w1', sessionId: 's1' }, undefined, 'plan chat text', 'soft');
  assert.equal(r.door, 'dispatch');
  assert.equal(sent.path, '/api/cloud-dispatch');
  assert.equal(sent.body.world_id, 'w1');
  assert.equal(sent.body.session_id, 's1');
  assert.deepEqual(sent.body.messages, [{ role: 'user', content: 'plan chat text' }]);
  assert.equal(sent.body.executor, 'do');
  assert.equal(sent.body.goal_mode, false);
  assert.equal(sent.body.steer_mode, 'soft');
});

test('dispatchLiveSteer: never throws on a network error, either door', async () => {
  const c = client(async () => { throw new Error('socket hang up'); });
  const r = await dispatchLiveSteer(c, { worldId: 'w', sessionId: 's', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.error, /socket hang up/);
  assert.equal(r.door, 'steer-live');
});

// --- steer door failure classes (Phase B, B3 DISPATCH_ERRORS extension) ----------

test('steer door: 409 passes the body reason through verbatim', async () => {
  const c = client(async () => jsonRes(409, { reason: 'a steer is already queued by another operator' }, false));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
  assert.equal(r.error, 'a steer is already queued by another operator');
  assert.equal(r.door, 'steer-live');
});

test('steer door: 422 passes the body error field through verbatim', async () => {
  const c = client(async () => jsonRes(422, { error: 'no live container mapped for this session' }, false));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.status, 422);
  assert.equal(r.error, 'no live container mapped for this session');
});

test('steer door: 409/422 with no parseable body reason falls back to DISPATCH_ERRORS.steerConflict/steerInvalid', async () => {
  const c409 = client(async () => res(409, false));
  const r409 = await dispatchLiveSteer(c409, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r409.error, DISPATCH_ERRORS.steerConflict);

  const c422 = client(async () => res(422, false));
  const r422 = await dispatchLiveSteer(c422, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r422.error, DISPATCH_ERRORS.steerInvalid);
});

test('steer door: 404 (not-owner) reuses the shared DISPATCH_ERRORS[404] entry, door-agnostic', async () => {
  const c = client(async () => res(404, false));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.status, 404);
  assert.equal(r.error, DISPATCH_ERRORS[404]);
});

test('steer door: 429/402/502 infra failures reuse the shared DISPATCH_ERRORS map, same as cloud-dispatch', async () => {
  for (const status of [429, 402, 502]) {
    const c = client(async () => res(status, false));
    const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
    assert.equal(r.error, DISPATCH_ERRORS[status]);
  }
});

test('steer door: an unmapped status falls back to bounded body text, mirrors dispatchSteer', async () => {
  const c = client(async () => ({ ok: false, status: 500, text: async () => 'internal boom' }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.match(r.error, /HTTP 500: internal boom/);
});

// --- steer door true-delivery (mirrored) signal (202 queued-but-not-live) --------

test('steer door: 202 with liveSteerRelay {ok:false, mirrored:false} → ok:true but mirrored:false (queued, not live-applied)', async () => {
  const c = client(async () => jsonRes(202, { liveSteerRelay: { ok: false, mirrored: false, error: 'session_never_dispatched' } }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, true);
  assert.equal(r.status, 202);
  assert.equal(r.mirrored, false);
  assert.equal(r.door, 'steer-live');
});

test('steer door: 202 with liveSteerRelay {ok:true, mirrored:true} → mirrored:true (truly live-delivered)', async () => {
  const c = client(async () => jsonRes(202, { liveSteerRelay: { ok: true, mirrored: true } }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, true);
  assert.equal(r.mirrored, true);
  assert.equal(r.door, 'steer-live');
});

test('steer door: hardSteerRelay is honoured the same as liveSteerRelay (hard-mode mirror)', async () => {
  const c = client(async () => jsonRes(200, { hardSteerRelay: { ok: false, mirrored: false } }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x', 'hard');
  assert.equal(r.ok, true);
  assert.equal(r.mirrored, false);
});

test('steer door: relay.ok:true but mirrored explicitly false → mirrored:false (relay ran but did not land)', async () => {
  const c = client(async () => jsonRes(202, { liveSteerRelay: { ok: true, mirrored: false } }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.mirrored, false);
});

test('steer door: relay.ok:true with mirrored ABSENT → mirrored:true (mirrored !== false, not required to be present)', async () => {
  const c = client(async () => jsonRes(202, { liveSteerRelay: { ok: true } }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.mirrored, true);
});

test('steer door: a 2xx body with NO relay object defaults mirrored:true (fail-soft, no regression)', async () => {
  const c = client(async () => jsonRes(200, { ok: true }));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, true);
  assert.equal(r.mirrored, true);
});

test('steer door: a body-less / parse-failing 2xx defaults mirrored:true (never regress a delivered steer)', async () => {
  // res(200) has no json() method → the parse attempt throws → fail-soft to true.
  const c = client(async () => res(200));
  const r = await dispatchLiveSteer(c, { sessionId: 's1', pool: 'linear' }, { state: 'live' }, 'x');
  assert.equal(r.ok, true);
  assert.equal(r.mirrored, true);
});

test('steer door: mirrored:false NEVER appears on the cloud-dispatch door (a 202 there is a legit new turn)', async () => {
  // A plan/chat session (not execute-shaped) routes through dispatchSteer; its
  // 202 has no relay to inspect, so no mirrored field rides — leave it success.
  const c = client(async () => jsonRes(202, { liveSteerRelay: { ok: false, mirrored: false } }));
  const r = await dispatchLiveSteer(c, { worldId: 'w1', sessionId: 's1' }, undefined, 'plan chat text');
  assert.equal(r.ok, true);
  assert.equal(r.door, 'dispatch');
  assert.equal(r.mirrored, undefined);
});

test('DISPATCH_ERRORS.steerConflict/steerInvalid are non-numeric keys, excluded from the numeric-status exhaustive test above', () => {
  assert.equal(/^\d+$/.test('steerConflict'), false);
  assert.equal(/^\d+$/.test('steerInvalid'), false);
  assert.match(DISPATCH_ERRORS.steerConflict, /steer/);
  assert.match(DISPATCH_ERRORS.steerInvalid, /steer/);
});

// --- dispatchResume (Phase C, task C5) -------------------------------------------

test('dispatchResume: request body is {session_id, message} — no actorSub, identity is server-derived', async () => {
  let sent = null;
  const c = client(async (path, body) => { sent = { path, body }; return jsonRes(200, { ok: true, resumed: true, session_id: 's1', worldId: 'w1', containerSessionId: 'cs1' }); });
  const r = await dispatchResume(c, { sessionId: 's1' }, 'hi, please continue');
  assert.equal(r.ok, true);
  assert.equal(sent.path, '/api/cloud-resume');
  assert.deepEqual(sent.body, { session_id: 's1', message: 'hi, please continue' });
});

test('dispatchResume: success parses worldId/containerSessionId off the response body', async () => {
  const c = client(async () => jsonRes(200, { ok: true, resumed: true, session_id: 's1', worldId: 'w9', containerSessionId: 'cs9' }));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, true);
  assert.equal(r.resumed, true);
  assert.equal(r.worldId, 'w9');
  assert.equal(r.containerSessionId, 'cs9');
});

test('dispatchResume: success with a body lacking worldId/containerSessionId degrades to null, never throws', async () => {
  const c = client(async () => jsonRes(200, {}));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, true);
  assert.equal(r.worldId, null);
  assert.equal(r.containerSessionId, null);
});

test('dispatchResume: the 5 resume-specific DISPATCH_ERRORS classes are looked up by the body error field, not HTTP status', async () => {
  const table = [
    { error: 'pr_fix_in_flight', status: 409 },
    { error: 'resume_in_flight', status: 409 },
    { error: 'execute_in_flight', status: 409 },
    { error: 'session_live', status: 409 },
    { error: 'no_execute_state', status: 422 },
  ];
  for (const { error, status } of table) {
    const c = client(async () => jsonRes(status, { error }, false));
    const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
    assert.equal(r.ok, false, error);
    assert.equal(r.status, status, error);
    assert.match(r.error, new RegExp(DISPATCH_ERRORS[error].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), error);
  }
});

test('dispatchResume: pr_fix_in_flight carries prUrl through as its own field and appends it to the message', async () => {
  const c = client(async () => jsonRes(409, { error: 'pr_fix_in_flight', prUrl: 'https://github.com/org/repo/pull/42' }, false));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.prUrl, 'https://github.com/org/repo/pull/42');
  assert.match(r.error, /https:\/\/github\.com\/org\/repo\/pull\/42/);
});

test('dispatchResume: pr_fix_in_flight with no prUrl in the body falls back to the plain DISPATCH_ERRORS copy, no prUrl field', async () => {
  const c = client(async () => jsonRes(409, { error: 'pr_fix_in_flight' }, false));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.error, DISPATCH_ERRORS.pr_fix_in_flight);
  assert.equal(r.prUrl, undefined);
});

test('dispatchResume: an unrecognised body error key falls back to the numeric-status branch', async () => {
  const c = client(async () => jsonRes(429, { error: 'totally_unknown_key' }, false));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.error, DISPATCH_ERRORS[429]);
});

test('dispatchResume: an unparseable body degrades to the numeric-status branch, never throws', async () => {
  const c = client(async () => ({ ok: false, status: 403, json: async () => { throw new Error('not json'); }, text: async () => 'forbidden' }));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.status, 403);
});

test('dispatchResume: an unmapped status falls back to bounded body text, mirrors dispatchSteer/dispatchLiveSteer', async () => {
  const c = client(async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'internal boom' }));
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, false);
  assert.match(r.error, /HTTP 500: internal boom/);
});

test('dispatchResume: network throw degrades to a typed failure result, not an exception (never-throw contract)', async () => {
  const c = client(async () => { throw new Error('socket hang up'); });
  const r = await dispatchResume(c, { sessionId: 's1' }, 'x');
  assert.equal(r.ok, false);
  assert.equal(r.status, null);
  assert.match(r.error, /socket hang up/);
});
