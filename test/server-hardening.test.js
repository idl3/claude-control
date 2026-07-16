// Regression tests for PLE-47: crash-safe request handler + endJson double-send
// guard + unknown /api/* JSON 404. Also covers the A6 ttyd retirement: /term/
// is no longer a special route and its ?token= URL-auth exception is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endJson, _handler } from '../server.js';

// ── endJson double-send guard ────────────────────────────────────────────────

function mockRes() {
  const written = [];
  let resolveDone;
  // `done` resolves once `end()` fires — needed by tests below that exercise
  // the static/SPA fallback path, which reads the file with async fs.readFile
  // (unlike the synchronous JSON endpoints the other tests here cover).
  const done = new Promise((resolve) => { resolveDone = resolve; });
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) {
      if (this.headersSent) throw new Error('writeHead called after headersSent');
      this.headersSent = true;
      this._code = code;
      this._headers = headers;
      written.push({ type: 'head', code, headers });
    },
    end(body) {
      if (this.writableEnded) throw new Error('end() called after writableEnded');
      this.writableEnded = true;
      this._body = body;
      written.push({ type: 'end', body });
      resolveDone();
    },
    written,
    done,
  };
}

test('endJson double-send: second call is a no-op — only one writeHead', () => {
  const res = mockRes();
  endJson(res, 200, { ok: true });
  // Call again — must not throw and must not call writeHead/end a second time.
  endJson(res, 200, { ok: true });
  const heads = res.written.filter((e) => e.type === 'head');
  const ends = res.written.filter((e) => e.type === 'end');
  assert.equal(heads.length, 1, 'writeHead should be called exactly once');
  assert.equal(ends.length, 1, 'end() should be called exactly once');
});

test('endJson double-send: second call is a no-op even with a different code', () => {
  const res = mockRes();
  endJson(res, 200, { ok: true });
  // Simulate a second caller trying to send a 500 after the response is done.
  endJson(res, 500, { error: 'internal' });
  assert.equal(res._code, 200, 'first status code should win');
});

// ── invalid URL in _handler ──────────────────────────────────────────────────

function mockReq(url, method = 'GET', headers = {}) {
  return { url, method, headers };
}

test('_handler with an unparseable URL responds with 4xx/5xx JSON, does not throw', () => {
  // `//[` is not a valid relative URL — new URL('//[', 'http://localhost') throws.
  const req = mockReq('//[');
  const res = mockRes();

  // _handler is synchronous at the top level; errors are caught internally.
  // It must not throw and must respond with a JSON error status.
  assert.doesNotThrow(() => _handler(req, res));

  // A response must have been sent.
  assert.ok(res.headersSent, 'response should have been sent');
  assert.ok(res._code >= 400 && res._code < 600, `expected 4xx/5xx, got ${res._code}`);

  // Body must be valid JSON.
  const parsed = JSON.parse(res._body);
  assert.ok(typeof parsed.error === 'string', 'body should have an error field');

  // The error string must NOT contain a stack trace (no detail leakage).
  assert.ok(!res._body.includes('at new URL'), 'stack trace must not leak to client');
});

// ── unknown /api/* path → 404 JSON ──────────────────────────────────────────

test('GET /api/does-not-exist returns 404 application/json, not 200 text/html', () => {
  // The server has no token configured in test mode (CONFIG.token is null/empty
  // when COCKPIT_TOKEN / CLAUDE_CONTROL_TOKEN env vars are unset). In that case
  // checkToken returns true for any request, so the route falls through to the
  // unknown-/api/* guard and returns 404 JSON.
  //
  // If a token IS set in the test environment, the route hits the 401 check first
  // (still JSON, still not text/html). Either way the test assertion holds.
  const req = mockReq('/api/does-not-exist');
  const res = mockRes();

  _handler(req, res);

  assert.ok(res.headersSent, 'response should have been sent');
  // Must be 404 (tokenless) or 401 (token-gated) — either way NOT 200.
  // The key property is that it is JSON, not HTML.
  assert.ok(
    res._headers['content-type'].startsWith('application/json'),
    `expected application/json, got: ${res._headers['content-type']}`,
  );
  assert.ok(res._code !== 200, 'must not be 200 OK');

  // In the common tokenless case it should be exactly 404.
  if (res._code === 404) {
    const parsed = JSON.parse(res._body);
    assert.equal(parsed.error, 'not found');
  }
});

// ── ttyd retirement (A6): the /term/ surface + its ?token= exception are GONE ──
// A5 replaced the ttyd-iframe raw terminal with the in-app xterm.js panel over
// /pty (a normal subprotocol-bearer-gated WebSocket — no special-casing). A6
// deleted the ttyd lifecycle module, the `/term/` HTTP route + WS-upgrade
// branch, and `checkTerminalToken` (the one place a `?token=` query string was
// ever honored). These tests assert that exception is actually gone: `/term/*`
// is no longer a distinguishable route at all — it falls through to the exact
// same static/SPA handling as any other unknown path — and appending a
// `?token=` query string has zero effect on the response, proving no
// query-string-token auth bypass remains anywhere in the app.

test('GET /term/<id> is no longer a special route — identical to any other unknown path', async () => {
  const termRes = mockRes();
  _handler(mockReq('/term/some-session'), termRes);
  await termRes.done;

  const otherRes = mockRes();
  _handler(mockReq('/totally-unrelated-deep-link'), otherRes);
  await otherRes.done;

  // Both are non-/api/ extensionless paths, so both fall through to the exact
  // same serveStatic()/SPA-fallback code — no ttyd-specific branch exists to
  // treat /term/ differently (previously this branch called checkTerminalToken
  // + proxyTerminalHttp instead of ever reaching serveStatic).
  assert.equal(termRes._code, otherRes._code, '/term/ must respond exactly like any other unknown path');
  assert.equal(
    termRes._headers['content-type'],
    otherRes._headers['content-type'],
    '/term/ must get the same content-type as any other unknown path',
  );
});

test('GET /term/<id>?token=... — the query-string token has NO effect (no URL-token bypass remains)', async () => {
  const withoutToken = mockRes();
  _handler(mockReq('/term/some-session'), withoutToken);
  await withoutToken.done;

  const withBogusToken = mockRes();
  _handler(mockReq('/term/some-session?token=totally-bogus-value'), withBogusToken);
  await withBogusToken.done;

  // checkTerminalToken (the only code that ever read a `?token=` query param)
  // is deleted. Appending one must be a complete no-op on this path.
  assert.equal(
    withBogusToken._code,
    withoutToken._code,
    'a ?token= query param must not change the /term/ response code',
  );
  assert.equal(
    withBogusToken._headers['content-type'],
    withoutToken._headers['content-type'],
    'a ?token= query param must not change the /term/ response content-type',
  );
});
