import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pruneDeadClients } from '../lib/ws-heartbeat.js';

// Minimal fake WebSocket object — only the fields pruneDeadClients touches.
function fakeWs(isAlive) {
  return {
    isAlive,
    terminate: (() => {
      let called = 0;
      const fn = () => { called++; };
      fn.callCount = () => called;
      return fn;
    })(),
    ping: (() => {
      let called = 0;
      const fn = () => { called++; };
      fn.callCount = () => called;
      return fn;
    })(),
  };
}

// --- dead client (isAlive === false) ----------------------------------------

test('pruneDeadClients: terminate()s a dead client and does NOT ping it', () => {
  const ws = fakeWs(false);
  pruneDeadClients([ws]);
  assert.equal(ws.terminate.callCount(), 1, 'terminate must be called once');
  assert.equal(ws.ping.callCount(), 0, 'ping must NOT be called on a dead client');
});

// --- live client (isAlive === true) -----------------------------------------

test('pruneDeadClients: pings a live client, does NOT terminate it, flips isAlive to false', () => {
  const ws = fakeWs(true);
  pruneDeadClients([ws]);
  assert.equal(ws.terminate.callCount(), 0, 'terminate must NOT be called on a live client');
  assert.equal(ws.ping.callCount(), 1, 'ping must be called once');
  assert.equal(ws.isAlive, false, 'isAlive must be flipped to false after the sweep');
});

// --- empty / empty-iterable input -------------------------------------------

test('pruneDeadClients: does not throw on an empty iterable', () => {
  assert.doesNotThrow(() => pruneDeadClients([]));
  assert.doesNotThrow(() => pruneDeadClients(new Set()));
});

// --- teeth: removing terminate() call must fail the dead-client test ---------
// (This is a documentation test — it passes by construction, but the comment
//  records what must break if pruneDeadClients stops calling terminate().)

test('pruneDeadClients (teeth): two sweeps on a dead client call terminate exactly once per sweep', () => {
  // First sweep marks a live client dead.
  const ws = fakeWs(true);
  pruneDeadClients([ws]);
  assert.equal(ws.isAlive, false);
  assert.equal(ws.terminate.callCount(), 0);

  // Second sweep terminates it because it never responded to ping.
  pruneDeadClients([ws]);
  assert.equal(ws.terminate.callCount(), 1, 'must be terminated on second sweep if no pong');
});
