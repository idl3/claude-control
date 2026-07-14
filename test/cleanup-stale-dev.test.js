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
  50 1 50 01:00:00 node /opt/node_modules/@anthropic-ai/claude-code/cli.js --session x
  51 50 50 01:00:00 node /work/claude-cockpit/node_modules/.bin/vite
  60 1 60 01:00:00 node /opt/node_modules/@openai/codex/bin/codex.js exec
  61 60 60 01:00:00 node /work/claude-cockpit/node_modules/@esbuild/darwin/bin/esbuild --service
  70 1 70 01:00:00 /Users/me/.local/share/claude/versions/2.1.7 --resume abc
  71 70 71 01:00:00 node /work/claude-cockpit/node_modules/.bin/vite
  80 1 80 01:00:00 node /opt/openai-codex/app-server-broker.mjs
  81 80 81 01:00:00 node /work/claude-cockpit/node_modules/.bin/vite
  `);
  const groups = staleDevGroups(rows, { scopeMarker: '/work/claude-cockpit', minAgeSeconds: 1800 });
  assert.deepEqual(groups.map((group) => group.pgid), [10]);
  assert.equal(isProtectedCommand('/Users/me/.local/bin/claude'), true);
  assert.equal(isProtectedCommand('node /opt/node_modules/@anthropic-ai/claude-code/cli.js'), true);
  assert.equal(isProtectedCommand('node /opt/node_modules/@openai/codex/bin/codex.js exec'), true);
  assert.equal(isProtectedCommand('/Users/me/.local/share/claude/versions/2.1.7 --resume abc'), true);
  assert.equal(isProtectedCommand('node /opt/openai-codex/app-server-broker.mjs'), true);
  assert.equal(isProtectedCommand('/work/claude-cockpit/node_modules/.bin/vite'), false);
});

test('cleanup excludes its own process group using the ps snapshot', () => {
  const ownPgid = process.pid + 10_000;
  const rows = [
    { pid: process.pid, ppid: 1, pgid: ownPgid, elapsed: 1, command: 'node cleanup-stale-dev.mjs' },
    { pid: process.pid + 1, ppid: process.pid, pgid: ownPgid, elapsed: 3600, command: 'node /work/claude-cockpit/node_modules/.bin/vite' },
  ];
  const groups = staleDevGroups(rows, { scopeMarker: '/work/claude-cockpit', minAgeSeconds: 1800 });
  assert.deepEqual(groups, []);
});
