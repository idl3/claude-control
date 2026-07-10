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

// ── reapSiblingServers — injectable run/kill/getListeningPort ───────────────
//
// All same-port tests below pass a `getListeningPort` double that reports
// every candidate as bound to the same port as `opts.port` — this isolates
// the pre-existing command-matching / kill-fanout behavior from the new
// port-scoping behavior, which gets its own dedicated tests further down.

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
    getListeningPort: () => 4317,
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
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
    getListeningPort: () => 4317,
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
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
    getListeningPort: () => 4317,
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
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
      getListeningPort: () => 4317,
      selfPid: 100,
      scriptPath: SCRIPT,
      port: 4317,
    });
    assert.deepEqual(result, []);
  });
});

// ── reapSiblingServers — port scoping (hazard fix) ──────────────────────────
//
// The hazard this closes: a hermetic/test instance booted on a different
// CLAUDE_CONTROL_PORT matches the same scriptPath as the operator's live
// instance and, before this fix, reaped it regardless of port. The
// invariant: an instance on port X must never reap an instance on port Y≠X.

test('reapSiblingServers does NOT reap a same-script sibling bound to a different port', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self, :4420 (hermetic test instance)
    { pid: 200, command: `node ${SCRIPT}` }, // sibling, :4317 (operator's live instance)
  ];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    getListeningPort: (pid) => (pid === 200 ? 4317 : 4420),
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4420,
  });
  assert.deepEqual(result, [], 'a different-port sibling must never be reaped');
  assert.deepEqual(killed, []);
});

test('reapSiblingServers DOES reap a same-script sibling bound to the same port', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self, :4317
    { pid: 200, command: `node ${SCRIPT}` }, // sibling, :4317 — same-port dedup
  ];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    getListeningPort: () => 4317,
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
  });
  assert.deepEqual(result, [200]);
  assert.deepEqual(killed, [{ pid: 200, signal: 'SIGTERM' }]);
});

test('reapSiblingServers leaves a same-script candidate alone when its port cannot be determined', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self
    { pid: 200, command: `node ${SCRIPT}` }, // port unknown (e.g. lsof failed / pid gone)
  ];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    getListeningPort: () => null,
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
  });
  assert.deepEqual(result, [], 'when in doubt, do not kill');
  assert.deepEqual(killed, []);
});

test('reapSiblingServers filters a mix of same-port and different-port siblings correctly', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self, :4317
    { pid: 200, command: `node ${SCRIPT}` }, // :4317 — reap
    { pid: 300, command: `node ${SCRIPT}` }, // :4420 — leave alone
  ];
  const killed = [];
  const ports = { 200: 4317, 300: 4420 };
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    getListeningPort: (pid) => ports[pid],
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
  });
  assert.deepEqual(result, [200]);
  assert.deepEqual(killed, [{ pid: 200, signal: 'SIGTERM' }]);
});

// ── reapSiblingServers — CLAUDE_CONTROL_NO_REAP escape hatch ────────────────

test('reapSiblingServers with noReap:true skips reaping entirely, even for a same-port sibling', () => {
  const psList = [
    { pid: 100, command: `node ${SCRIPT}` }, // self
    { pid: 200, command: `node ${SCRIPT}` }, // same port — would normally be reaped
  ];
  const killed = [];
  const result = reapSiblingServers({
    run: () => psList,
    kill: (pid, signal) => killed.push({ pid, signal }),
    getListeningPort: () => 4317,
    selfPid: 100,
    scriptPath: SCRIPT,
    port: 4317,
    noReap: true,
  });
  assert.deepEqual(result, []);
  assert.deepEqual(killed, []);
});

test('reapSiblingServers defaults noReap from process.env.CLAUDE_CONTROL_NO_REAP=1', () => {
  const original = process.env.CLAUDE_CONTROL_NO_REAP;
  process.env.CLAUDE_CONTROL_NO_REAP = '1';
  try {
    const psList = [
      { pid: 100, command: `node ${SCRIPT}` },
      { pid: 200, command: `node ${SCRIPT}` },
    ];
    const killed = [];
    const result = reapSiblingServers({
      run: () => psList,
      kill: (pid, signal) => killed.push({ pid, signal }),
      getListeningPort: () => 4317,
      selfPid: 100,
      scriptPath: SCRIPT,
      port: 4317,
    });
    assert.deepEqual(result, []);
    assert.deepEqual(killed, []);
  } finally {
    if (original === undefined) delete process.env.CLAUDE_CONTROL_NO_REAP;
    else process.env.CLAUDE_CONTROL_NO_REAP = original;
  }
});
