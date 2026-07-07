// Tests for the transcript inline-media route: path confinement in
// lib/media.js resolveMediaPath, plus route-level auth + traversal rejection
// through server.js _handler.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolveMediaPath } from '../lib/media.js';

// ── resolveMediaPath confinement ─────────────────────────────────────────────

let root; // real media root with a file, a subdir file, and an escape symlink
let outside; // sibling dir the symlink escapes to

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-root-'));
  outside = fs.mkdtempSync(path.join(os.tmpdir(), 'media-outside-'));
  fs.writeFileSync(path.join(root, 'shot.png'), 'png-bytes');
  fs.mkdirSync(path.join(root, 'runs'));
  fs.writeFileSync(path.join(root, 'runs', 'demo.mp4'), 'mp4-bytes');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret');
  fs.symlinkSync(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(outside, { recursive: true, force: true });
});

test('resolves a bare filename inside the root', () => {
  const full = resolveMediaPath('shot.png', root);
  assert.ok(full);
  assert.equal(fs.readFileSync(full, 'utf8'), 'png-bytes');
});

test('resolves a relative sub-path inside the root', () => {
  const full = resolveMediaPath('runs%2Fdemo.mp4', root);
  assert.ok(full);
  assert.equal(fs.readFileSync(full, 'utf8'), 'mp4-bytes');
});

test('rejects ".." traversal, raw and URL-encoded', () => {
  assert.equal(resolveMediaPath('../secret.txt', root), null);
  assert.equal(resolveMediaPath('..%2Fsecret.txt', root), null);
  assert.equal(resolveMediaPath('%2e%2e%2fsecret.txt', root), null);
  assert.equal(resolveMediaPath('runs/../../secret.txt', root), null);
});

test('rejects absolute paths', () => {
  assert.equal(resolveMediaPath(path.join(outside, 'secret.txt'), root), null);
  assert.equal(resolveMediaPath('%2Fetc%2Fpasswd', root), null);
});

test('rejects a symlink escaping the root', () => {
  assert.equal(resolveMediaPath('link.txt', root), null);
});

test('rejects null bytes, empty input, and a missing root', () => {
  assert.equal(resolveMediaPath('shot.png%00.txt', root), null);
  assert.equal(resolveMediaPath('', root), null);
  assert.equal(resolveMediaPath('shot.png', path.join(root, 'nope')), null);
});

test('missing file is null (uniform 404, no detail leak)', () => {
  assert.equal(resolveMediaPath('missing.png', root), null);
});

// ── route level (_handler) ───────────────────────────────────────────────────
// Configure env BEFORE importing server.js: token-gated, hermetic data dir.

process.env.CLAUDE_CONTROL_TOKEN = 'test-token';
process.env.CLAUDE_CONTROL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'media-data-'));
const { _handler } = await import('../server.js');

function mockReq(url, headers = {}) {
  return { url, method: 'GET', headers };
}
function mockRes() {
  return {
    headersSent: false,
    writableEnded: false,
    writeHead(code, headers) {
      this.headersSent = true;
      this._code = code;
      this._headers = headers;
    },
    end(body) {
      this.writableEnded = true;
      this._body = body;
    },
  };
}

test('GET /api/media/* without the bearer token → 401', () => {
  const res = mockRes();
  _handler(mockReq('/api/media/shot.png'), res);
  assert.equal(res._code, 401);
});

test('GET /api/media/..%2f… with auth → 404, no path detail in the body', () => {
  const res = mockRes();
  _handler(
    mockReq('/api/media/..%2Fserver.js', { authorization: 'Bearer test-token' }),
    res,
  );
  assert.equal(res._code, 404);
  assert.equal(String(res._body), 'not found');
});
