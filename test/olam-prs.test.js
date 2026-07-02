import { test } from 'node:test';
import assert from 'node:assert/strict';

import { normalizePrs } from '../lib/olam-prs.js';

// --- normalizePrs -----------------------------------------------------------

test('normalizePrs: non-array input yields empty array', () => {
  assert.deepEqual(normalizePrs(undefined), []);
  assert.deepEqual(normalizePrs(null), []);
  assert.deepEqual(normalizePrs('not-an-array'), []);
  assert.deepEqual(normalizePrs({}), []);
});

test('normalizePrs: empty array yields empty array', () => {
  assert.deepEqual(normalizePrs([]), []);
});

test('normalizePrs: bare URL strings — number derived from trailing /pull/<n>', () => {
  const out = normalizePrs(['https://github.com/idl3/claude-control/pull/153']);
  assert.deepEqual(out, [{ url: 'https://github.com/idl3/claude-control/pull/153', number: 153 }]);
});

test('normalizePrs: URL with trailing slash/query/fragment after the number', () => {
  assert.equal(normalizePrs(['https://github.com/o/r/pull/42/'])[0].number, 42);
  assert.equal(normalizePrs(['https://github.com/o/r/pull/42?tab=files'])[0].number, 42);
  assert.equal(normalizePrs(['https://github.com/o/r/pull/42#discussion'])[0].number, 42);
});

test('normalizePrs: URL without a /pull/<n> segment yields number:null, url kept', () => {
  const out = normalizePrs(['https://github.com/idl3/claude-control']);
  assert.deepEqual(out, [{ url: 'https://github.com/idl3/claude-control', number: null }]);
});

test('normalizePrs: rich objects {url, number, state} pass number through', () => {
  const out = normalizePrs([{ url: 'https://x/pull/7', number: 7, state: 'open' }]);
  assert.deepEqual(out, [{ url: 'https://x/pull/7', number: 7 }]);
});

test('normalizePrs: rich objects missing number fall back to URL-derived number', () => {
  const out = normalizePrs([{ url: 'https://x/pull/9', state: 'merged' }]);
  assert.deepEqual(out, [{ url: 'https://x/pull/9', number: 9 }]);
});

test('normalizePrs: mixed string + object entries in one array', () => {
  const out = normalizePrs(['https://x/pull/1', { url: 'https://x/pull/2', number: 2 }]);
  assert.deepEqual(out, [
    { url: 'https://x/pull/1', number: 1 },
    { url: 'https://x/pull/2', number: 2 },
  ]);
});

test('normalizePrs: malformed entries are dropped, never throw', () => {
  const out = normalizePrs([null, undefined, 42, {}, { number: 5 }, '', 'ok-string-no-pull-match']);
  assert.deepEqual(out, [{ url: 'ok-string-no-pull-match', number: null }]);
});
