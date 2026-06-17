// Unit tests for the rising-edge push trigger logic used by firePushForChange
// in server.js. We test the identical algorithm extracted here so we don't need
// to start the whole server.

import { test } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Minimal replica of firePushForChange from server.js. Returns the list of
 * session ids that would have triggered a sendToAll call.
 *
 * @param {Map<string, boolean>} lastPending  mutable state (in/out)
 * @param {object[]} sessions
 * @param {{ primed: boolean }} state  wraps pushPrimed flag (in/out)
 * @returns {string[]} ids that fired
 */
function simulatePushCheck(lastPending, sessions, state) {
  const fired = [];
  if (!state.primed) {
    for (const s of sessions) lastPending.set(s.id, !!s.pending);
    state.primed = true;
    return fired;
  }
  const seen = new Set();
  for (const s of sessions) {
    seen.add(s.id);
    const was = lastPending.get(s.id) ?? false;
    if (s.pending && !was) fired.push(s.id);
    lastPending.set(s.id, !!s.pending);
  }
  for (const id of [...lastPending.keys()]) {
    if (!seen.has(id)) lastPending.delete(id);
  }
  return fired;
}

test('rising-edge: first change() call (priming) never fires a push', () => {
  const last = new Map();
  const state = { primed: false };
  const fired = simulatePushCheck(last, [{ id: 'foo', pending: true, name: 'Foo' }], state);
  assert.deepEqual(fired, []);
  assert.equal(state.primed, true);
});

test('rising-edge: pending transition false→true fires once', () => {
  const last = new Map();
  const state = { primed: false };
  // Prime: session not pending
  simulatePushCheck(last, [{ id: 's1', pending: false }], state);
  // Transition: becomes pending
  const fired = simulatePushCheck(last, [{ id: 's1', pending: true }], state);
  assert.deepEqual(fired, ['s1']);
});

test('rising-edge: staying pending across multiple polls does NOT re-fire', () => {
  const last = new Map();
  const state = { primed: false };
  simulatePushCheck(last, [{ id: 's1', pending: false }], state);
  simulatePushCheck(last, [{ id: 's1', pending: true }], state); // rising edge → fire
  const second = simulatePushCheck(last, [{ id: 's1', pending: true }], state);
  const third  = simulatePushCheck(last, [{ id: 's1', pending: true }], state);
  assert.deepEqual(second, []);
  assert.deepEqual(third, []);
});

test('rising-edge: pending cleared then set again re-fires once', () => {
  const last = new Map();
  const state = { primed: false };
  simulatePushCheck(last, [{ id: 's1', pending: false }], state);
  simulatePushCheck(last, [{ id: 's1', pending: true }], state);  // fire #1
  simulatePushCheck(last, [{ id: 's1', pending: false }], state); // cleared
  const fired = simulatePushCheck(last, [{ id: 's1', pending: true }], state); // fire #2
  assert.deepEqual(fired, ['s1']);
});

test('rising-edge: a session that disappears is forgotten, re-appears re-arms', () => {
  const last = new Map();
  const state = { primed: false };
  simulatePushCheck(last, [{ id: 's1', pending: false }], state);
  simulatePushCheck(last, [{ id: 's1', pending: true }], state);  // fire
  // Session disappears from list.
  simulatePushCheck(last, [], state);
  assert.equal(last.has('s1'), false); // forgotten
  // Session comes back already pending — treated as a fresh rising edge.
  const refired = simulatePushCheck(last, [{ id: 's1', pending: true }], state);
  assert.deepEqual(refired, ['s1']);
});

test('rising-edge: multiple sessions fire independently', () => {
  const last = new Map();
  const state = { primed: false };
  simulatePushCheck(
    last,
    [{ id: 'a', pending: false }, { id: 'b', pending: false }],
    state,
  );
  const fired = simulatePushCheck(
    last,
    [{ id: 'a', pending: true }, { id: 'b', pending: true }],
    state,
  );
  assert.deepEqual(fired.sort(), ['a', 'b']);
  // Next poll: still pending, no re-fire
  const second = simulatePushCheck(
    last,
    [{ id: 'a', pending: true }, { id: 'b', pending: true }],
    state,
  );
  assert.deepEqual(second, []);
});

test('rising-edge: false→false and true→false never fire', () => {
  const last = new Map();
  const state = { primed: false };
  simulatePushCheck(last, [{ id: 's1', pending: true }], state); // priming; true already
  // true→false: clearing should not fire
  const a = simulatePushCheck(last, [{ id: 's1', pending: false }], state);
  // false→false: stable should not fire
  const b = simulatePushCheck(last, [{ id: 's1', pending: false }], state);
  assert.deepEqual(a, []);
  assert.deepEqual(b, []);
});
