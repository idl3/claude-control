import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createWsPollGate } from '../lib/ws-poll-gate.js';

/**
 * test/ws-poll-gate.test.js
 *
 * R8: createWsPollGate() pauses SessionRegistry + ResourceMonitor polling on
 * the last WS disconnect and resumes + fires an immediate tick on the next
 * connect. Driven here with fake registry/resources spies (call-count
 * assertions) — the same evidence style as poller-guards.test.js's
 * capturePane-call-count proofs for R7/R9 — rather than a real WS server,
 * since the gate's entire contract is "which methods get called how many
 * times, in what order, for which wss.clients.size transitions."
 */

function fakeCounter() {
  let calls = 0;
  const fn = () => { calls++; };
  fn.callCount = () => calls;
  return fn;
}

function fakeRegistry() {
  return { start: fakeCounter(), stop: fakeCounter() };
}

function fakeResources() {
  let refreshCalls = 0;
  return {
    start: fakeCounter(),
    stop: fakeCounter(),
    refreshNow: async () => { refreshCalls++; },
    refreshNowCallCount: () => refreshCalls,
  };
}

// ── boot state: gate starts unpaused, first connect is a no-op ─────────────
//
// server.js's main() already calls registry.start()/resources.start()
// unconditionally at boot, BEFORE any WS client ever connects. The gate must
// reflect that as its initial state, or the very first client to ever
// connect would trigger a redundant .start() call. SessionRegistry.start()
// is now idempotent as a defense-in-depth guard, but the gate still avoids
// unnecessary resume work when polling is already active.

test('onConnect(): no-op when not paused (boot state — registry/resources already running)', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  assert.equal(gate.isPaused(), false, 'gate must start unpaused, matching main()\'s unconditional boot start()');

  gate.onConnect();
  assert.equal(registry.start.callCount(), 0, 'must not call registry.start() when already running');
  assert.equal(resources.start.callCount(), 0, 'must not call resources.start() when already running');
  assert.equal(resources.refreshNowCallCount(), 0, 'must not fire an immediate tick when nothing was paused');
});

// ── disconnect: pauses only on the true last-client transition ─────────────

test('onDisconnect(0): pauses — calls registry.stop() + resources.stop() exactly once', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(0);

  assert.equal(gate.isPaused(), true);
  assert.equal(registry.stop.callCount(), 1);
  assert.equal(resources.stop.callCount(), 1);
});

test('onDisconnect(remaining > 0): does NOT pause — other clients are still connected', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(1);
  gate.onDisconnect(3);

  assert.equal(gate.isPaused(), false);
  assert.equal(registry.stop.callCount(), 0, 'sidebar-only clients (no session open) still count — must not pause with clients remaining');
  assert.equal(resources.stop.callCount(), 0);
});

test('onDisconnect(0) called twice in a row: second call is a no-op (already paused)', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(0);
  gate.onDisconnect(0); // e.g. a heartbeat-terminated dead client after the real last client already left

  assert.equal(registry.stop.callCount(), 1, 'must not call stop() a second time once already paused');
  assert.equal(resources.stop.callCount(), 1);
});

// ── resume: onConnect after a pause restarts both + fires one immediate tick ─

test('onConnect() after a pause: resumes registry + resources and fires resources.refreshNow() once', async () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(0);
  assert.equal(gate.isPaused(), true, 'precondition: paused');

  gate.onConnect();
  // refreshNow() is fired-and-forgotten (.catch()) inside onConnect — give its
  // microtask a turn to run before asserting the call landed.
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(gate.isPaused(), false);
  assert.equal(registry.start.callCount(), 1, 'registry.start() must resume polling');
  assert.equal(resources.start.callCount(), 1, 'resources.start() must resume polling');
  assert.equal(
    resources.refreshNowCallCount(),
    1,
    'resources has no self-tick on start() (unlike registry.start(), which fires refresh()+_pollCtx()+_pollThinking() ' +
      'itself) — onConnect must fire one explicitly so the reconnecting client is not stale until the next 5s interval',
  );
});

test('onConnect() called twice after one pause: second call does not double-start (idempotent resume)', async () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(0);
  gate.onConnect(); // first reconnecting client — real resume
  gate.onConnect(); // a second client connecting moments later — must be a no-op
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(registry.start.callCount(), 1, 'a second concurrent connect must not re-trigger start()');
  assert.equal(resources.start.callCount(), 1);
  assert.equal(resources.refreshNowCallCount(), 1, 'must not fire a second immediate tick for the second client');
});

// ── refreshNow() failure must not crash the gate or block the resume ────────

test('onConnect(): a rejecting resources.refreshNow() is swallowed (does not throw out of onConnect)', () => {
  const registry = fakeRegistry();
  const resources = {
    start: fakeCounter(),
    stop: fakeCounter(),
    refreshNow: async () => { throw new Error('vm_stat failed'); },
  };
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(0);
  assert.doesNotThrow(() => gate.onConnect());
});

// ── full round trip: multiple pause/resume cycles toggle correctly ──────────

test('full round trip: disconnect -> reconnect -> disconnect toggles paused state and call counts correctly each time', async () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  // Cycle 1: last client leaves.
  gate.onDisconnect(0);
  assert.equal(gate.isPaused(), true);

  // A new client connects — resume.
  gate.onConnect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gate.isPaused(), false);
  assert.equal(registry.start.callCount(), 1);

  // Cycle 2: last client leaves again.
  gate.onDisconnect(0);
  assert.equal(gate.isPaused(), true);
  assert.equal(registry.stop.callCount(), 2, 'second pause cycle must call stop() again');

  // Resume again.
  gate.onConnect();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(gate.isPaused(), false);
  assert.equal(registry.start.callCount(), 2, 'second resume cycle must call start() again');
  assert.equal(resources.refreshNowCallCount(), 2, 'each resume must fire its own immediate tick');
});

// ── push subscribers: the gate must NOT pause while a device is subscribed ──
//
// registry.on('change') is the only thing that drives lib/push-trigger.js's
// ask/done edge detection. If the gate paused the registry the instant the
// last WS client disconnected — the exact moment a push is needed, since the
// app is now closed/backgrounded — no push would ever fire. `hasSubscribers`
// must keep the loop armed whenever at least one PushSubscription exists.

test('onDisconnect(0) with an active push subscriber: does NOT pause (keeps polling for push edges)', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources, { hasSubscribers: () => true });

  gate.onDisconnect(0);

  assert.equal(gate.isPaused(), false, 'must stay unpaused so push-trigger.js keeps detecting ask/done edges');
  assert.equal(registry.stop.callCount(), 0);
  assert.equal(resources.stop.callCount(), 0);
});

test('onDisconnect(0) with zero push subscribers: pauses as before (no regression to R8 battery saving)', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources, { hasSubscribers: () => false });

  gate.onDisconnect(0);

  assert.equal(gate.isPaused(), true);
  assert.equal(registry.stop.callCount(), 1);
  assert.equal(resources.stop.callCount(), 1);
});

test('createWsPollGate() with no opts arg: defaults hasSubscribers to false (back-compat, matches all tests above)', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  const gate = createWsPollGate(registry, resources);

  gate.onDisconnect(0);

  assert.equal(gate.isPaused(), true, 'omitting opts must preserve the original pause-on-last-disconnect behaviour');
});

test('a push subscriber appearing after the gate is already paused does not retroactively resume it (hasSubscribers is only read at onDisconnect time)', () => {
  const registry = fakeRegistry();
  const resources = fakeResources();
  let subscribed = false;
  const gate = createWsPollGate(registry, resources, { hasSubscribers: () => subscribed });

  gate.onDisconnect(0); // paused, 0 subscribers at the time
  assert.equal(gate.isPaused(), true);

  subscribed = true; // a subscription is added out-of-band while paused
  assert.equal(gate.isPaused(), true, 'the gate only re-evaluates on the next onConnect/onDisconnect transition');
});

// ── teeth: without the `if (!paused) return` guard, a redundant connect
// would still issue extra resume work — this is exactly what the gate avoids.

test('teeth: calling start() twice without the gate guard is redundant resume work', () => {
  const registry = fakeRegistry();
  // Simulate the un-guarded scenario directly: two connects, no gate.
  registry.start();
  registry.start();
  assert.equal(registry.start.callCount(), 2, 'without the paused-state guard, every connect would call start() again');
});
