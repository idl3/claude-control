// Tests for D3's filesystem version convention: lib/media-apps.js's
// isValidAppName/listVersions, plus route-level auth + validation through
// server.js _handler's GET /api/media-apps/<name>/versions.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isValidAppName, listVersions, isoStamp } from '../lib/media-apps.js';

// ── isValidAppName ───────────────────────────────────────────────────────

test('accepts lowercase-alphanumeric-hyphen names', () => {
  assert.equal(isValidAppName('counter'), true);
  assert.equal(isValidAppName('my-app-2'), true);
  assert.equal(isValidAppName('a'), true);
});

test('rejects traversal, uppercase, underscores, slashes, dots, and non-strings', () => {
  assert.equal(isValidAppName('..'), false);
  assert.equal(isValidAppName('../etc'), false);
  assert.equal(isValidAppName('Counter'), false);
  assert.equal(isValidAppName('my_app'), false);
  assert.equal(isValidAppName('a/b'), false);
  assert.equal(isValidAppName('a.b'), false);
  assert.equal(isValidAppName(''), false);
  assert.equal(isValidAppName(null), false);
  assert.equal(isValidAppName(undefined), false);
  assert.equal(isValidAppName(42), false);
});

// ── isoStamp ──────────────────────────────────────────────────────────────

test('isoStamp strips milliseconds and colons, keeping the trailing Z', () => {
  const stamp = isoStamp(new Date('2026-07-08T23:32:05.123Z'));
  assert.equal(stamp, '2026-07-08T23-32-05Z');
});

// ── listVersions ──────────────────────────────────────────────────────────

let root;

before(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'media-apps-root-'));
  const appDir = path.join(root, 'apps', 'widget');
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(path.join(appDir, '2026-07-01T10-00-00Z.html'), '<html>v1</html>');
  fs.writeFileSync(path.join(appDir, '2026-07-08T23-32-05Z-experiment.html'), '<html>v2</html>');
  fs.writeFileSync(path.join(appDir, 'latest'), '2026-07-08T23-32-05Z-experiment.html\n');
  // A stray non-matching file must be ignored, not crash the scan.
  fs.writeFileSync(path.join(appDir, 'notes.txt'), 'irrelevant');
  fs.mkdirSync(path.join(appDir, 'ignored-subdir'));

  // A flat legacy app (no apps/<name>/ dir at all) — listVersions must
  // return null for it, not throw.
  fs.writeFileSync(path.join(root, 'apps', 'counter.html'), '<html>flat</html>');

  // An app dir that exists but has no recognizable version files and no
  // latest pointer yet.
  fs.mkdirSync(path.join(root, 'apps', 'empty'));
});

after(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

test('lists versions newest-first, marking the one the latest pointer names', () => {
  const listing = listVersions(root, 'widget');
  assert.ok(listing);
  assert.equal(listing.name, 'widget');
  assert.equal(listing.latest, '2026-07-08T23-32-05Z-experiment.html');
  assert.equal(listing.versions.length, 2);
  assert.equal(listing.versions[0].filename, '2026-07-08T23-32-05Z-experiment.html');
  assert.equal(listing.versions[0].version, '2026-07-08T23-32-05Z');
  assert.equal(listing.versions[0].label, 'experiment');
  assert.equal(listing.versions[0].latest, true);
  assert.equal(listing.versions[0].url, 'apps/widget/2026-07-08T23-32-05Z-experiment.html');
  assert.equal(listing.versions[1].filename, '2026-07-01T10-00-00Z.html');
  assert.equal(listing.versions[1].label, null);
  assert.equal(listing.versions[1].latest, false);
});

test('ignores non-matching files and subdirectories in the app dir', () => {
  const listing = listVersions(root, 'widget');
  const filenames = listing.versions.map((v) => v.filename);
  assert.ok(!filenames.includes('notes.txt'));
  assert.ok(!filenames.includes('ignored-subdir'));
});

test('returns an empty-but-valid listing for a dir with no version files and no latest pointer', () => {
  const listing = listVersions(root, 'empty');
  assert.deepEqual(listing, { name: 'empty', versions: [], latest: null });
});

test('returns null for a flat-only app (no apps/<name>/ dir)', () => {
  assert.equal(listVersions(root, 'counter'), null);
});

test('returns null for an unknown app name', () => {
  assert.equal(listVersions(root, 'nope'), null);
});

test('returns null (rejects) for an invalid name — traversal never reaches the filesystem join', () => {
  assert.equal(listVersions(root, '../../etc'), null);
  assert.equal(listVersions(root, '..'), null);
});

// ── route level (_handler) ───────────────────────────────────────────────
// Configure env BEFORE importing server.js: token-gated, hermetic media root
// so the route reads real fixture data instead of the operator's actual
// ~/.claude-control/media.

process.env.CLAUDE_CONTROL_TOKEN = 'test-token-media-apps';
process.env.CLAUDE_CONTROL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'media-apps-data-'));
process.env.CLAUDE_CONTROL_MEDIA = root;
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
const AUTH = { authorization: 'Bearer test-token-media-apps' };

test('GET /api/media-apps/<name>/versions without the bearer token -> 401', () => {
  const res = mockRes();
  _handler(mockReq('/api/media-apps/widget/versions'), res);
  assert.equal(res._code, 401);
});

test('GET /api/media-apps/<name>/versions with auth -> 200 with the real listing', () => {
  const res = mockRes();
  _handler(mockReq('/api/media-apps/widget/versions', AUTH), res);
  assert.equal(res._code, 200);
  const body = JSON.parse(res._body);
  assert.equal(body.name, 'widget');
  assert.equal(body.versions.length, 2);
  assert.equal(body.latest, '2026-07-08T23-32-05Z-experiment.html');
});

test('GET .../<unknown-name>/versions with auth -> 200 with an empty listing (no existence leak)', () => {
  const res = mockRes();
  _handler(mockReq('/api/media-apps/nope/versions', AUTH), res);
  assert.equal(res._code, 200);
  assert.deepEqual(JSON.parse(res._body), { name: 'nope', versions: [], latest: null });
});

test('GET .../<invalid-name>/versions with auth -> 400', () => {
  const res = mockRes();
  _handler(mockReq('/api/media-apps/Invalid_Name/versions', AUTH), res);
  assert.equal(res._code, 400);
});

test('a traversal attempt in the name segment -> 400, never reaches the filesystem', () => {
  const res = mockRes();
  _handler(mockReq('/api/media-apps/..%2F..%2Fetc/versions', AUTH), res);
  assert.equal(res._code, 400);
});

test('a raw ".." name segment does not even match the route (falls through to 404 not-found)', () => {
  // "/api/media-apps/../versions" normalizes at the URL-parse layer the same
  // way any other path would; the route regex still requires a literal
  // <name>/versions shape, so a bare ".." here just fails to match at all —
  // asserting this locks in that no bypass exists via the router itself, on
  // top of listVersions'/isValidAppName's own defense proven above.
  const res = mockRes();
  _handler(mockReq('/api/media-apps/../versions', AUTH), res);
  assert.notEqual(res._code, 200);
});
