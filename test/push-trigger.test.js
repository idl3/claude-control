// Unit tests for the push trigger logic used by server.js. These exercise the
// REAL evaluateEdges/createPushTrigger from lib/push-trigger.js (imported
// directly, not a hand-copied replica) so a bug in the production algorithm
// can't hide behind a stale duplicate.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateEdges, createEdgeState, createPushTrigger } from '../lib/push-trigger.js';

// ── evaluateEdges: rising-edge "ask" cases ──────────────────────────────────
// (ported from the pre-extraction replica-based tests; same coverage, now run
// against the real production algorithm)

function fireAsks(ref, sessions) {
  const { asks, next } = evaluateEdges(ref.state, sessions);
  ref.state = next;
  return asks.map((a) => a.id);
}

test('rising-edge: first change() call (priming) never fires a push', () => {
  const ref = { state: createEdgeState() };
  const fired = fireAsks(ref, [{ id: 'foo', pending: true, name: 'Foo' }]);
  assert.deepEqual(fired, []);
  assert.equal(ref.state.primed, true);
});

test('rising-edge: pending transition false→true fires once', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: false }]); // prime
  const fired = fireAsks(ref, [{ id: 's1', pending: true }]);
  assert.deepEqual(fired, ['s1']);
});

test('rising-edge: staying pending across multiple polls does NOT re-fire', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: false }]);
  fireAsks(ref, [{ id: 's1', pending: true }]); // rising edge → fire
  const second = fireAsks(ref, [{ id: 's1', pending: true }]);
  const third = fireAsks(ref, [{ id: 's1', pending: true }]);
  assert.deepEqual(second, []);
  assert.deepEqual(third, []);
});

test('rising-edge: pending cleared then set again re-fires once', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: false }]);
  fireAsks(ref, [{ id: 's1', pending: true }]); // fire #1
  fireAsks(ref, [{ id: 's1', pending: false }]); // cleared
  const fired = fireAsks(ref, [{ id: 's1', pending: true }]); // fire #2
  assert.deepEqual(fired, ['s1']);
});

test('rising-edge: a session that disappears is forgotten, re-appears re-arms', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: false }]);
  fireAsks(ref, [{ id: 's1', pending: true }]); // fire
  fireAsks(ref, []); // session disappears from list
  assert.equal(ref.state.pending.has('s1'), false); // forgotten
  // Session comes back already pending — treated as a fresh rising edge.
  const refired = fireAsks(ref, [{ id: 's1', pending: true }]);
  assert.deepEqual(refired, ['s1']);
});

test('rising-edge: multiple sessions fire independently', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 'a', pending: false }, { id: 'b', pending: false }]);
  const fired = fireAsks(ref, [{ id: 'a', pending: true }, { id: 'b', pending: true }]);
  assert.deepEqual(fired.sort(), ['a', 'b']);
  const second = fireAsks(ref, [{ id: 'a', pending: true }, { id: 'b', pending: true }]);
  assert.deepEqual(second, []);
});

test('rising-edge: false→false and true→false never fire', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: true }]); // priming; true already
  const a = fireAsks(ref, [{ id: 's1', pending: false }]); // true→false
  const b = fireAsks(ref, [{ id: 's1', pending: false }]); // false→false
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
});

test('ask payload uses name/pendingQuestion when present', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: false }]); // prime
  const { asks } = evaluateEdges(ref.state, [
    { id: 's1', pending: true, name: 'My Session', pendingQuestion: 'Pick one?' },
  ]);
  assert.deepEqual(asks, [{ id: 's1', title: 'My Session', body: 'Pick one?', data: { id: 's1' } }]);
});

test('ask payload falls back to id/default question text', () => {
  const ref = { state: createEdgeState() };
  fireAsks(ref, [{ id: 's1', pending: false }]); // prime
  const { asks } = evaluateEdges(ref.state, [{ id: 's1', pending: true }]);
  assert.deepEqual(asks, [{ id: 's1', title: 's1', body: 'is asking a question', data: { id: 's1' } }]);
});

// ── createPushTrigger: "done"/"stopped" settle-timer cases ─────────────────
// Uses a fake scheduler (captures scheduled fns, runs them on command instead
// of real setTimeout) and a mock send (records calls) so the settle window
// can be driven deterministically without real timers or network calls.

function fakeScheduler() {
  let seq = 0;
  const pending = new Map(); // handle -> fn
  return {
    schedule(fn) {
      const handle = ++seq;
      pending.set(handle, fn);
      return handle;
    },
    cancel(handle) {
      pending.delete(handle);
    },
    runAll() {
      const fns = [...pending.values()];
      pending.clear();
      for (const fn of fns) fn();
    },
    size() {
      return pending.size;
    },
  };
}

function mockSend() {
  const calls = [];
  const send = async (payload) => {
    calls.push(payload);
  };
  send.calls = calls;
  return send;
}

function activeSession(id, overrides = {}) {
  return {
    id,
    name: id,
    thinking: true,
    compacting: false,
    subAgentActive: false,
    pending: false,
    errored: false,
    ...overrides,
  };
}

function idleSession(id, overrides = {}) {
  return {
    id,
    name: id,
    thinking: false,
    compacting: false,
    subAgentActive: false,
    pending: false,
    errored: false,
    ...overrides,
  };
}

test('createPushTrigger: ask event sends immediately via the mock transport', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({ send, schedule: scheduler.schedule, cancel: scheduler.cancel });

  trigger.onChange([idleSession('s1', { pending: false })]); // prime
  trigger.onChange([idleSession('s1', { pending: true, pendingQuestion: 'Continue?' })]);

  assert.equal(send.calls.length, 1);
  assert.deepEqual(send.calls[0], { title: 's1', body: 'Continue?', data: { id: 's1' } });
});

test('createPushTrigger: active → idle arms a settle timer; firing it sends "done" once', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({
    send,
    schedule: scheduler.schedule,
    cancel: scheduler.cancel,
    settleMs: 8000,
  });

  trigger.onChange([activeSession('s1')]); // prime (active)
  trigger.onChange([idleSession('s1')]); // active → idle: arms

  assert.equal(scheduler.size(), 1, 'a settle timer should be scheduled');
  assert.equal(send.calls.length, 0, 'no push yet — still settling');

  scheduler.runAll();

  assert.equal(send.calls.length, 1);
  assert.deepEqual(send.calls[0], { title: 's1', body: '✅ finished', data: { id: 's1' } });
  assert.equal(trigger._state.doneFired.get('s1'), true);

  // Advancing again does not re-fire (nothing left scheduled).
  scheduler.runAll();
  assert.equal(send.calls.length, 1);
});

test('createPushTrigger: flicker — active again before settle cancels the timer, no push', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({ send, schedule: scheduler.schedule, cancel: scheduler.cancel });

  trigger.onChange([activeSession('s1')]); // prime
  trigger.onChange([idleSession('s1')]); // arms
  assert.equal(scheduler.size(), 1);

  trigger.onChange([activeSession('s1')]); // flicker back to active before settle fires
  assert.equal(scheduler.size(), 0, 'the settle timer should have been cancelled');

  scheduler.runAll(); // nothing left to run
  assert.equal(send.calls.length, 0, 'no done push should have fired');
});

test('createPushTrigger: errored session settles to a "stopped (error)" push', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({ send, schedule: scheduler.schedule, cancel: scheduler.cancel });

  trigger.onChange([activeSession('s1')]); // prime
  trigger.onChange([idleSession('s1', { errored: true })]); // active → errored/idle: arms

  scheduler.runAll();

  assert.equal(send.calls.length, 1);
  assert.deepEqual(send.calls[0], { title: 's1', body: '⚠️ stopped (error)', data: { id: 's1' } });
});

test('createPushTrigger: active → pending (asks) does not also arm a done push', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({ send, schedule: scheduler.schedule, cancel: scheduler.cancel });

  trigger.onChange([activeSession('s1')]); // prime
  trigger.onChange([idleSession('s1', { pending: true, pendingQuestion: 'Which one?' })]); // active → pending

  assert.equal(scheduler.size(), 0, 'no settle timer should be armed for a session that went pending');
  assert.equal(send.calls.length, 1, 'only the ask push should have fired');
  assert.deepEqual(send.calls[0], { title: 's1', body: 'Which one?', data: { id: 's1' } });
});

test('createPushTrigger: priming a session already idle never arms a done push', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({ send, schedule: scheduler.schedule, cancel: scheduler.cancel });

  trigger.onChange([idleSession('s1')]); // priming call: idle at boot
  assert.equal(scheduler.size(), 0);
  assert.equal(send.calls.length, 0);
});

test('createPushTrigger: a session that disappears while settling is cancelled and forgotten', () => {
  const scheduler = fakeScheduler();
  const send = mockSend();
  const trigger = createPushTrigger({ send, schedule: scheduler.schedule, cancel: scheduler.cancel });

  trigger.onChange([activeSession('s1')]); // prime
  trigger.onChange([idleSession('s1')]); // arms
  assert.equal(scheduler.size(), 1);

  trigger.onChange([]); // session disappears mid-settle
  assert.equal(scheduler.size(), 0, 'the settle timer should have been cancelled on disappearance');

  scheduler.runAll();
  assert.equal(send.calls.length, 0);
});

test('createPushTrigger: never throws out of onChange even if send/schedule misbehave', () => {
  const trigger = createPushTrigger({
    send: () => {
      throw new Error('boom');
    },
    schedule: () => {
      throw new Error('boom');
    },
    cancel: () => {},
  });
  assert.doesNotThrow(() => {
    trigger.onChange([idleSession('s1', { pending: false })]); // prime
    trigger.onChange([activeSession('s1')]);
    trigger.onChange([idleSession('s1')]); // arms → schedule() throws internally
  });
});
