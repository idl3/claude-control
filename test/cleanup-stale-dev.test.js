import test from 'node:test';
import assert from 'node:assert/strict';

import {
  elapsedSeconds,
  isProtectedCommand,
  parsePs,
  staleDevGroups,
} from '../scripts/cleanup-stale-dev.mjs';

test('elapsedSeconds parses ps etime forms', () => {
  assert.equal(elapsedSeconds('02:03'), 123);
  assert.equal(elapsedSeconds('04:02:03'), 14523);
  assert.equal(elapsedSeconds('2-04:02:03'), 187323);
});

test('cleanup only selects old scoped Vite/esbuild groups and protects agents', () => {
  const rows = parsePs(`
  10 1 10 01:00:00 npm exec vite
  11 10 10 01:00:00 node /work/claude-cockpit/node_modules/.bin/vite
  12 11 10 01:00:00 /work/claude-cockpit/node_modules/@esbuild/darwin/bin/esbuild --service
  20 1 20 01:00:00 node /work/other/node_modules/.bin/vite
  30 1 30 00:02 node /work/claude-cockpit/node_modules/.bin/vite
  40 1 40 01:00:00 /Users/me/.local/bin/claude
  41 40 40 01:00:00 node /work/claude-cockpit/node_modules/.bin/vite
  `);
  const groups = staleDevGroups(rows, { scopeMarker: '/work/claude-cockpit', minAgeSeconds: 1800 });
  assert.deepEqual(groups.map((group) => group.pgid), [10]);
  assert.equal(isProtectedCommand('/Users/me/.local/bin/claude'), true);
  assert.equal(isProtectedCommand('/work/claude-cockpit/node_modules/.bin/vite'), false);
});
