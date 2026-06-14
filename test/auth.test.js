import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  tokenFromRequest,
  checkToken,
  parseWsProtocols,
  checkWsToken,
} from '../lib/auth.js';

// Build a minimal req-like object: only `headers` is read by the auth helpers.
function req(headers = {}) {
  return { headers };
}

// --- tokenFromRequest -------------------------------------------------------

test('tokenFromRequest extracts a Bearer token (case-insensitive scheme)', () => {
  assert.equal(tokenFromRequest(req({ authorization: 'Bearer abc123' })), 'abc123');
  assert.equal(tokenFromRequest(req({ authorization: 'bearer abc123' })), 'abc123');
  assert.equal(tokenFromRequest(req({ authorization: 'BEARER abc123' })), 'abc123');
});

test('tokenFromRequest trims surrounding whitespace', () => {
  assert.equal(tokenFromRequest(req({ authorization: 'Bearer   abc123  ' })), 'abc123');
});

test('tokenFromRequest returns null for missing/malformed headers', () => {
  assert.equal(tokenFromRequest(req()), null);
  assert.equal(tokenFromRequest(req({ authorization: '' })), null);
  assert.equal(tokenFromRequest(req({ authorization: 'abc123' })), null); // no scheme
  assert.equal(tokenFromRequest(req({ authorization: 'Basic abc123' })), null);
  assert.equal(tokenFromRequest(req({ authorization: 'Bearer' })), null); // no value
});

// --- checkToken (HTTP/API) --------------------------------------------------

test('checkToken accepts a request with the correct Bearer header', () => {
  assert.equal(checkToken(req({ authorization: 'Bearer s3cr3t' }), 's3cr3t'), true);
});

test('checkToken rejects a wrong or missing Bearer header when a token is set', () => {
  assert.equal(checkToken(req({ authorization: 'Bearer wrong' }), 's3cr3t'), false);
  assert.equal(checkToken(req(), 's3cr3t'), false);
  // Query-string token is NO LONGER honored — only the header counts.
  assert.equal(checkToken(req({}), 's3cr3t'), false);
});

test('checkToken returns true (open) when the server is tokenless', () => {
  assert.equal(checkToken(req(), null), true);
  assert.equal(checkToken(req(), ''), true);
  assert.equal(checkToken(req(), undefined), true);
  // Even a bogus header is fine when there is no configured token.
  assert.equal(checkToken(req({ authorization: 'Bearer anything' }), null), true);
});

// --- parseWsProtocols -------------------------------------------------------

test('parseWsProtocols splits + trims comma-separated subprotocols', () => {
  assert.deepEqual(parseWsProtocols('claude-control, s3cr3t'), [
    'claude-control',
    's3cr3t',
  ]);
  assert.deepEqual(parseWsProtocols('  a ,b,  c '), ['a', 'b', 'c']);
});

test('parseWsProtocols returns [] for absent/empty values', () => {
  assert.deepEqual(parseWsProtocols(undefined), []);
  assert.deepEqual(parseWsProtocols(''), []);
});

// --- checkWsToken (WebSocket upgrade) ---------------------------------------

test('checkWsToken accepts an upgrade offering the token as a subprotocol', () => {
  const r = req({ 'sec-websocket-protocol': 'claude-control, s3cr3t' });
  assert.equal(checkWsToken(r, 's3cr3t'), true);
});

test('checkWsToken rejects an upgrade without the token subprotocol', () => {
  assert.equal(
    checkWsToken(req({ 'sec-websocket-protocol': 'claude-control' }), 's3cr3t'),
    false,
  );
  assert.equal(checkWsToken(req(), 's3cr3t'), false);
  assert.equal(
    checkWsToken(req({ 'sec-websocket-protocol': 'claude-control, wrong' }), 's3cr3t'),
    false,
  );
});

test('checkWsToken returns true (open) when the server is tokenless', () => {
  assert.equal(checkWsToken(req(), null), true);
  assert.equal(
    checkWsToken(req({ 'sec-websocket-protocol': 'claude-control' }), null),
    true,
  );
});
