import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findSiblingServerPids, reapSiblingServers } from '../lib/reap-siblings.js';

const SCRIPT = '/Users/ernie/Projects/claude-cockpit/server.js';

// ── findSiblingServerPids — pure matcher ────────────────────────────────────

test('findSiblingServerPids returns siblings running the same server.js path', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` },
    { pid: 200, command: `/usr/local/bin/node ${SCRIPT}` },
    { pid: 300, command: 'node /Users/ernie/Projects/other-app/server.js' },
  ];
  const result = findSiblingServerPids(psList, 999, SCRIPT);
  assert.deepEqual(result.sort((a, b) => a - b), [100, 200]);
});

test('findSiblingServerPids excludes selfPid even when it matches the script path', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` },
    { pid: 200, command: `node ${SCRIPT}` },
  ];
  const result = findSiblingServerPids(psList, 100, SCRIPT);
  assert.deepEqual(result, [200]);
});

test('findSiblingServerPids excludes unrelated node processes (MCP server, other script)', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` },
    { pid: 400, command: 'node /Users/ernie/.claude/plugins/cache/some-mcp/server.mjs' },
    { pid: 500, command: 'node --experimental-vm-modules /some/other/server.js' },
    { pid: 600, command: '/opt/homebrew/bin/node /Users/ernie/other-project/dist/server.js' },
  ];
  const result = findSiblingServerPids(psList, 999, SCRIPT);
  assert.deepEqual(result, [100]);
});

test('findSiblingServerPids does not match on a loose "server" substring', () => {
  const psList = [
    { pid: 700, command: 'node /Users/ernie/Projects/claude-cockpit/lib/some-other-server.js' },
    { pid: 800, command: 'node /Users/ernie/Projects/claude-cockpit-clone/server.js' },
  ];
  const result = findSiblingServerPids(psList, 999, SCRIPT);
  assert.deepEqual(result, []);
});

test('findSiblingServerPids returns [] when only self is present', () => {
  const psList = [{ pid: 100, command: `node ${SCRIPT}` }];
  const result = findSiblingServerPids(psList, 100, SCRIPT);
  assert.deepEqual(result, []);
});

test('findSiblingServerPids returns [] for an empty or missing psList', () => {
  assert.deepEqual(findSiblingServerPids([], 100, SCRIPT), []);
  assert.deepEqual(findSiblingServerPids(undefined, 100, SCRIPT), []);
});

test('findSiblingServerPids returns [] when scriptPath is missing', () => {
  const psList = [{ pid: 100, command: `node ${SCRIPT}` }];
  assert.deepEqual(findSiblingServerPids(psList, 999, ''), []);
});

// ── reapSiblingServers — injectable run/kill ────────────────────────────────

test('reapSiblingServers calls kill on exactly the sibling pids, never on self', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self
    { pid: 200, command: `node ${SCRIPT}` }, // sibling
    { pid: 300, command: `node ${SCRIPT}` }, // sibling
    { pid: 400, command: 'node /unrelated/server.js' },
  ];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    selfPid: 100,
    scriptPath: SCRIPT,
  });

  assert.deepEqual(result.sort((a, b) => a - b), [200, 300]);
  assert.deepEqual(
    killed.sort((a, b) => a.pid - b.pid),
    [
      { pid: 200, signal: 'SIGTERM' },
      { pid: 300, signal: 'SIGTERM' },
    ]
  );
  assert.ok(!killed.some((k) => k.pid === 100), 'must never signal self');
});

test('reapSiblingServers does nothing when only self is present', () => {
  const psList = [{ pid: 100, command: `node ${SCRIPT}` }];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    selfPid: 100,
    scriptPath: SCRIPT,
  });
  assert.deepEqual(result, []);
  assert.deepEqual(killed, []);
});

test('reapSiblingServers is best-effort: a throwing kill() does not stop remaining reaps or bubble up', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self
    { pid: 200, command: `node ${SCRIPT}` },
    { pid: 300, command: `node ${SCRIPT}` },
  ];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid) => {
      if (pid === 200) throw new Error('ESRCH: no such process');
      killed.push(pid);
    },
    selfPid: 100,
    scriptPath: SCRIPT,
  });
  assert.deepEqual(result.sort((a, b) => a - b), [200, 300]);
  assert.deepEqual(killed, [300]);
});

test('reapSiblingServers never throws even if run() itself throws', () => {
  assert.doesNotThrow(() => {
    const result = reapSiblingServers({
      run: () => {
        throw new Error('ps failed');
      },
      kill: () => {},
      selfPid: 100,
      scriptPath: SCRIPT,
    });
    assert.deepEqual(result, []);
  });
});
