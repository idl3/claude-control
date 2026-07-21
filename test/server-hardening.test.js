// Regression tests for PLE-47: crash-safe request handler + endJson double-send
// guard + unknown /api/* JSON 404.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { endJson, _handler } from '../server.js';

// ── endJson double-send guard ────────────────────────────────────────────────

function mockRes() {
  const written = [];
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
    },
    written,
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
  // when CLAUDE_CONTROL_TOKEN is unset). In that case
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

// ── /term/ is retired (the ttyd raw-terminal overlay is gone) ──────────────
// `serveStatic`'s fallback is async (fs.readFile), so these tests must wait
// for the response instead of asserting synchronously right after `_handler`.
function mockResAsync() {
  let resolveDone;
  const done = new Promise((resolve) => { resolveDone = resolve; });
  const res = mockRes();
  const origEnd = res.end.bind(res);
  res.end = (body) => {
    origEnd(body);
    resolveDone();
  };
  return { res, done };
}

test('GET /term/<id>/asset.css (an old ttyd-asset-shaped path) is a plain 404 — no proxy, no distinguishable route', async () => {
  const { res, done } = mockResAsync();
  _handler(mockReq('/term/fake-session%3A0/asset.css'), res);
  await done;

  assert.equal(res._code, 404, 'must be a plain 404, not a ttyd proxy response');
  assert.ok(!res._headers?.['content-type']?.includes('application/json'), 'not the JSON /api/* 404 either — just the generic static 404');
});

test('GET /term/<id> falls through to the SAME generic handling as any other unmatched path — no special /term/ route remains', async () => {
  const { res: termRes, done: termDone } = mockResAsync();
  _handler(mockReq('/term/fake-session%3A0'), termRes);
  await termDone;

  const { res: siblingRes, done: siblingDone } = mockResAsync();
  _handler(mockReq('/this-path-has-never-existed-either'), siblingRes);
  await siblingDone;

  // Both are extension-less unknown paths — they must resolve identically
  // (the SPA fallback), proving /term/ carries no special-cased behavior.
  assert.equal(termRes._code, siblingRes._code);
  assert.equal(termRes._headers?.['content-type'], siblingRes._headers?.['content-type']);
});

test('?token= has no effect anywhere — the ttyd query-string auth exception is gone', async () => {
  const { res: withBadToken, done: d1 } = mockResAsync();
  _handler(mockReq('/term/fake-session%3A0?token=totally-wrong-token'), withBadToken);
  await d1;

  const { res: withoutToken, done: d2 } = mockResAsync();
  _handler(mockReq('/term/fake-session%3A0'), withoutToken);
  await d2;

  // A bogus/missing ?token= must never produce a distinguishing 401 — that
  // gate (checkTerminalToken) no longer exists anywhere in the codebase, and
  // a wrong token must not change the response at all.
  assert.notEqual(withBadToken._code, 401);
  assert.equal(withBadToken._code, withoutToken._code);

  // Sanity: a bogus ?token= on a completely unrelated route ALSO has zero
  // effect anywhere else in the app (it was never a general auth mechanism).
  const { res: apiWithToken, done: d3 } = mockResAsync();
  _handler(mockReq('/api/does-not-exist?token=totally-wrong-token'), apiWithToken);
  await d3;
  const { res: apiWithoutToken, done: d4 } = mockResAsync();
  _handler(mockReq('/api/does-not-exist'), apiWithoutToken);
  await d4;
  assert.equal(apiWithToken._code, apiWithoutToken._code);
});
