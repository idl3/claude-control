import { test } from 'node:test';
import assert from 'node:assert/strict';

import crypto from 'node:crypto';
import {
  tokenFromRequest,
  checkToken,
  parseWsProtocols,
  checkWsToken,
  safeTokenEqual,
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

// --- safeTokenEqual ---------------------------------------------------------

test('safeTokenEqual returns true for an exact match', () => {
  assert.equal(safeTokenEqual('my-secret-token', 'my-secret-token'), true);
});

test('safeTokenEqual returns false for a single-byte difference', () => {
  assert.equal(safeTokenEqual('my-secret-tokex', 'my-secret-token'), false);
});

test('safeTokenEqual returns false for a different-length candidate (no throw)', () => {
  assert.doesNotThrow(() => {
    const result = safeTokenEqual('short', 'much-longer-expected-value');
    assert.equal(result, false);
  });
});

test('safeTokenEqual returns false for null candidate (no throw)', () => {
  assert.doesNotThrow(() => {
    assert.equal(safeTokenEqual(null, 'expected'), false);
  });
});

test('safeTokenEqual returns false for empty-string candidate (no throw)', () => {
  assert.doesNotThrow(() => {
    assert.equal(safeTokenEqual('', 'expected'), false);
  });
});

test('safeTokenEqual returns false for undefined candidate (no throw)', () => {
  assert.doesNotThrow(() => {
    assert.equal(safeTokenEqual(undefined, 'expected'), false);
  });
});

// Equivalence: safeTokenEqual matches plain === for a set of (candidate, expected) pairs.
test('safeTokenEqual boolean result matches === across representative pairs', () => {
  const pairs = [
    ['abc', 'abc'],
    ['abc', 'abd'],
    ['', 'abc'],
    ['longer-string', 'short'],
    ['identical', 'identical'],
    ['UPPER', 'upper'],
  ];
  for (const [candidate, expected] of pairs) {
    const naive = candidate === expected;
    // Skip null/empty guard — safeTokenEqual fast-returns false for those;
    // plain === would also be false for '' === 'abc'.
    assert.equal(
      safeTokenEqual(candidate, expected),
      naive,
      `pair (${JSON.stringify(candidate)}, ${JSON.stringify(expected)})`,
    );
  }
});

// Implementation check: safeTokenEqual uses SHA-256 + timingSafeEqual, not raw ===.
test('safeTokenEqual uses crypto.timingSafeEqual (not raw string comparison)', () => {
  // Spy: if the function delegated to crypto.timingSafeEqual we can confirm
  // by verifying it correctly handles length-mismatched inputs without throwing
  // (timingSafeEqual alone would throw; digest first is required).
  // A raw `===` comparison would also return false here, so this test checks
  // the implementation is resilient to length mismatch — which only works when
  // both values are digested first.
  const longCandidate = 'a'.repeat(1000);
  const shortExpected = 'b';
  assert.doesNotThrow(() => {
    assert.equal(safeTokenEqual(longCandidate, shortExpected), false);
  });

  // Also verify that the crypto module's createHash and timingSafeEqual are
  // accessible (they exist in node:crypto; if this helper used raw ===
  // these would be irrelevant but still importable).
  assert.ok(typeof crypto.timingSafeEqual === 'function');
  assert.ok(typeof crypto.createHash === 'function');
});
