import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifyOrgError } from '../lib/olam-sessions.js';

const SPA = 'https://olam.dev-atlas.kitchen';

test('classifyOrgError: CF Access wall (HTML parse error) → login-red with re-login prompt', () => {
  const e = new SyntaxError('Unexpected token \'<\', "<!DOCTYPE "... is not valid JSON');
  const h = classifyOrgError(e, SPA);
  assert.equal(h.status, 'red');
  assert.match(h.reason, /cloudflared access login https:\/\/olam\.dev-atlas\.kitchen/);
  // The raw parse error is NOT surfaced to the operator.
  assert.doesNotMatch(h.reason, /Unexpected token/);
});

test('classifyOrgError: typed NoAccessSession → login-red', () => {
  const e = new Error(
    'no cloudflared Access session for https://spa.test — run: cloudflared access login https://spa.test',
  );
  assert.equal(classifyOrgError(e, 'https://spa.test').status, 'red');
});

test('classifyOrgError: an unrelated failure stays transient amber with its raw message', () => {
  const h = classifyOrgError(new Error('ECONNRESET'), SPA);
  assert.equal(h.status, 'amber');
  assert.equal(h.reason, 'ECONNRESET');
});
