// Tests for D3's captures endpoint: lib/media-captures.js's pure helpers,
// plus route-level auth/validation/size-cap/traversal through server.js
// _handler's POST /api/media-apps/<name>/captures.
//
// Route-level POST tests need a body-bearing mockReq (readJsonBody drives it
// via req.on('data'/'end'/'error')) unlike the GET-only mockReq in
// media-apps.test.js/media.test.js. Fetchability-via-/api/media is proven by
// calling the SAME resolveMediaPath() that GET /api/media/<path> uses
// (lib/media.js), rather than re-mocking res as a writable stream target for
// handleServeMedia's fs.createReadStream(...).pipe(res) — media.test.js's own
// route tests avoid exercising that pipe for the same reason (neither of its
// two route tests reach the 200 path).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import {
  isOversizeCapture,
  decodeCaptureDataUrl,
  writeCaptureAtomic,
  MAX_CAPTURE_BYTES,
} from '../lib/media-captures.js';
import { resolveMediaPath } from '../lib/media.js';

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// ── decodeCaptureDataUrl ────────────────────────────────────────────────

test('decodes a well-formed data:image/png;base64 URL to its raw PNG bytes', () => {
  const buf = decodeCaptureDataUrl(PNG_1X1);
  assert.ok(Buffer.isBuffer(buf));
  assert.equal(buf.slice(0, 8).toString('hex'), '89504e470d0a1a0a'); // PNG signature
});

test('rejects a non-PNG mime, malformed prefix, or non-string input', () => {
  assert.equal(decodeCaptureDataUrl('data:image/jpeg;base64,AAAA'), null);
  assert.equal(decodeCaptureDataUrl('not-a-data-url'), null);
  assert.equal(decodeCaptureDataUrl(''), null);
  assert.equal(decodeCaptureDataUrl(null), null);
  assert.equal(decodeCaptureDataUrl(undefined), null);
});

// ── isOversizeCapture ────────────────────────────────────────────────────

test('isOversizeCapture is true only strictly above the 8MB ceiling', () => {
  assert.equal(isOversizeCapture(MAX_CAPTURE_BYTES), false);
  assert.equal(isOversizeCapture(MAX_CAPTURE_BYTES + 1), true);
});

// ── writeCaptureAtomic ───────────────────────────────────────────────────

test('writeCaptureAtomic writes under captures/<name>/<stamp>.png, leaves no temp file behind, and returns the relative path', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-write-'));
  const relPath = writeCaptureAtomic(root, 'widget', Buffer.from('png-bytes'));
  assert.match(relPath, /^captures\/widget\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.png$/);
  const full = path.join(root, relPath);
  assert.equal(fs.readFileSync(full, 'utf8'), 'png-bytes');
  const entries = fs.readdirSync(path.dirname(full));
  assert.ok(entries.every((e) => !e.startsWith('.tmp-')));
});

// ── route level (_handler) ──────────────────────────────────────────────
// Configure env BEFORE importing server.js: token-gated, hermetic media root
// (same convention as media-apps.test.js/media.test.js).

process.env.CLAUDE_CONTROL_TOKEN = 'test-token-captures';
process.env.CLAUDE_CONTROL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-data-'));
const mediaRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'captures-media-'));
process.env.CLAUDE_CONTROL_MEDIA = mediaRoot;
const { _handler } = await import('../server.js');

const AUTH = { authorization: 'Bearer test-token-captures' };

/** POST mockReq: readJsonBody drives it via .on('data'/'end'/'error'). */
function mockPostReq(url, headers, bodyString) {
  const req = new EventEmitter();
  req.url = url;
  req.method = 'POST';
  req.headers = headers;
  req.destroy = () => {};
  queueMicrotask(() => {
    if (bodyString !== undefined) req.emit('data', Buffer.from(bodyString));
    req.emit('end');
  });
  return req;
}

function mockRes() {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(code) {
      this.headersSent = true;
      this._code = code;
    },
    end(body) {
      this.writableEnded = true;
      this._body = body;
    },
  };
}

function waitForEnd(res) {
  return new Promise((resolve) => {
    const check = () => (res.writableEnded ? resolve() : setImmediate(check));
    check();
  });
}

test('POST .../captures without a bearer token -> 401', async () => {
  const res = mockRes();
  _handler(mockPostReq('/api/media-apps/widget/captures', {}, JSON.stringify({ dataUrl: PNG_1X1 })), res);
  await waitForEnd(res);
  assert.equal(res._code, 401);
});

test('an invalid <name> segment -> 400', async () => {
  const res = mockRes();
  _handler(
    mockPostReq('/api/media-apps/Invalid_Name/captures', AUTH, JSON.stringify({ dataUrl: PNG_1X1 })),
    res,
  );
  await waitForEnd(res);
  assert.equal(res._code, 400);
});

test('a traversal attempt in the name segment -> 400, never touches the filesystem', async () => {
  const res = mockRes();
  _handler(
    mockPostReq('/api/media-apps/..%2F..%2Fetc/captures', AUTH, JSON.stringify({ dataUrl: PNG_1X1 })),
    res,
  );
  await waitForEnd(res);
  assert.equal(res._code, 400);
  assert.equal(fs.existsSync(path.join(mediaRoot, 'captures', '..', '..', 'etc')), false);
});

test('a dataUrl that is not a PNG data URL -> 400', async () => {
  const res = mockRes();
  _handler(
    mockPostReq('/api/media-apps/widget/captures', AUTH, JSON.stringify({ dataUrl: 'not-a-data-url' })),
    res,
  );
  await waitForEnd(res);
  assert.equal(res._code, 400);
});

test('a request body over readJsonBody\'s cap -> 413 (base64 expansion pushes a 9MB payload past the 11MB raw-body ceiling)', async () => {
  const oversizeBase64 = Buffer.alloc(9 * 1024 * 1024).toString('base64');
  const res = mockRes();
  _handler(
    mockPostReq(
      '/api/media-apps/widget/captures',
      AUTH,
      JSON.stringify({ dataUrl: `data:image/png;base64,${oversizeBase64}` }),
    ),
    res,
  );
  await waitForEnd(res);
  assert.equal(res._code, 413);
});

test('decoded PNG bytes over the 8MB cap but under the raw-body ceiling -> 413 via isOversizeCapture', async () => {
  // 8MB + 100 bytes decoded => ~10.67MB base64, comfortably under the 11MB
  // readJsonBody cap, so this exercises isOversizeCapture's own 413 branch
  // rather than readJsonBody's.
  const oversizeBase64 = Buffer.alloc(8 * 1024 * 1024 + 100).toString('base64');
  const res = mockRes();
  _handler(
    mockPostReq(
      '/api/media-apps/widget/captures',
      AUTH,
      JSON.stringify({ dataUrl: `data:image/png;base64,${oversizeBase64}` }),
    ),
    res,
  );
  await waitForEnd(res);
  assert.equal(res._code, 413);
});

test('happy path: writes the file under captures/<name>/, returns the embeddable path, and it resolves via the same path-confinement GET /api/media uses', async () => {
  const res = mockRes();
  _handler(mockPostReq('/api/media-apps/widget/captures', AUTH, JSON.stringify({ dataUrl: PNG_1X1 })), res);
  await waitForEnd(res);
  assert.equal(res._code, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.ok, true);
  assert.match(body.path, /^captures\/widget\/\d{4}-\d\d-\d\dT\d\d-\d\d-\d\dZ\.png$/);

  const full = resolveMediaPath(body.path, mediaRoot);
  assert.ok(full, 'resolveMediaPath must resolve the saved capture inside the media root');
  const bytes = fs.readFileSync(full);
  assert.equal(bytes.slice(0, 8).toString('hex'), '89504e470d0a1a0a');
});
