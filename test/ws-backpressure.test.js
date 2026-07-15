import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES,
  encodeWsMessage,
  sendWsMessage,
  websocketBackpressureLimitBytes,
} from '../lib/ws-backpressure.js';

test('websocketBackpressureLimitBytes uses default for missing or invalid env', () => {
  assert.equal(websocketBackpressureLimitBytes({}), DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES);
  assert.equal(
    websocketBackpressureLimitBytes({ CLAUDE_CONTROL_WS_BUFFER_LIMIT_MB: 'nope' }),
    DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES,
  );
});

test('websocketBackpressureLimitBytes parses megabyte override', () => {
  assert.equal(
    websocketBackpressureLimitBytes({ CLAUDE_CONTROL_WS_BUFFER_LIMIT_MB: '4' }),
    4 * 1024 * 1024,
  );
});

test('sendWsMessage sends encoded frame when socket is open and below limit', () => {
  const sent = [];
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 16,
    send: (msg) => sent.push(msg),
  };
  assert.equal(sendWsMessage(ws, encodeWsMessage({ ok: true }), { limitBytes: 1024 }), true);
  assert.deepEqual(sent, ['{"ok":true}']);
});

test('sendWsMessage terminates slow clients before queuing more bytes', () => {
  let terminated = false;
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 2048,
    send: () => assert.fail('send must not be called for an over-limit socket'),
    terminate: () => { terminated = true; },
  };
  assert.equal(sendWsMessage(ws, 'frame', { limitBytes: 1024 }), false);
  assert.equal(terminated, true);
});

test('sendWsMessage counts the next frame before enqueueing', () => {
  let terminated = false;
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 1020,
    send: () => assert.fail('send must not cross the configured buffer limit'),
    terminate: () => { terminated = true; },
  };
  assert.equal(sendWsMessage(ws, '12345', { limitBytes: 1024 }), false);
  assert.equal(terminated, true);
});

test('sendWsMessage reports false when ws.send throws', () => {
  const ws = {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    send: () => { throw new Error('socket closed mid-send'); },
  };
  assert.equal(sendWsMessage(ws, 'frame', { limitBytes: 1024 }), false);
});
