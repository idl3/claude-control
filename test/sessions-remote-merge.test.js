import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';
import { RemoteSessionSource } from '../lib/olam-sessions.js';

/** Registry with tmux stubbed to a fixed pane set (no real tmux). */
function makeRegistry(panes = []) {
  const tmux = {
    listPanes: async () => panes,
    async listWindows() { return panes; },
  };
  const reg = new SessionRegistry({ projectsRoot: '/nonexistent', tmux });
  // Bypass tmux/ps plumbing: drive the merge surface directly.
  return reg;
}

const REMOTE_ROW = {
  id: 'olam:atlas:sess-1',
  kind: 'remote',
  transport: 'olam',
  org: 'atlas',
  sessionId: 'sess-1',
  pool: 'linear',
  phase: 'running',
  linearRef: 'sess-1',
  summary: 'Fix flaky spec',
  lastActivity: '2026-07-02T01:00:00Z',
  inFlight: true,
  halted: false,
  pending: false,
  stale: false,
  orgHealth: { status: 'green', reason: null },
};

// --- setRemoteSessions merge semantics -----------------------------------------

test('setRemoteSessions appends remote rows without touching local ones', () => {
  const reg = makeRegistry();
  reg._sessions = [{ id: 'tmux-1', kind: 'claude', transport: 'tmux', pending: false }];
  reg.setRemoteSessions([REMOTE_ROW]);
  const ids = reg.getSessions().map((s) => s.id);
  assert.deepEqual(ids, ['tmux-1', 'olam:atlas:sess-1']);
});

test('setRemoteSessions replaces the previous remote set (no duplicates)', () => {
  const reg = makeRegistry();
  reg._sessions = [{ id: 'tmux-1', kind: 'claude', pending: false }];
  reg.setRemoteSessions([REMOTE_ROW]);
  reg.setRemoteSessions([{ ...REMOTE_ROW, phase: 'done' }]);
  const remotes = reg.getSessions().filter((s) => s.kind === 'remote');
  assert.equal(remotes.length, 1);
  assert.equal(remotes[0].phase, 'done');
});

test('clearing remote rows restores the exact local-only view', () => {
  const reg = makeRegistry();
  const local = [{ id: 'tmux-1', kind: 'claude', pending: false }];
  reg._sessions = [...local];
  const before = JSON.stringify(local);
  reg.setRemoteSessions([REMOTE_ROW]);
  reg.setRemoteSessions([]);
  assert.equal(JSON.stringify(reg.getSessions()), before);
});

test('local session snapshot is byte-identical with and without remote rows present', () => {
  const reg = makeRegistry();
  const local = [{ id: 'tmux-1', kind: 'claude', transport: 'tmux', pending: false, cwd: '/x' }];
  reg._sessions = [...local];
  reg.setRemoteSessions([REMOTE_ROW]);
  const locals = reg.getSessions().filter((s) => s.kind !== 'remote');
  assert.equal(JSON.stringify(locals), JSON.stringify(local)); // no field injected into local rows
});

test('change event fires when the remote set changes', () => {
  const reg = makeRegistry();
  let fired = 0;
  reg.on('change', () => { fired += 1; });
  reg.setRemoteSessions([REMOTE_ROW]);
  assert.ok(fired >= 1);
});

// --- RemoteSessionSource --------------------------------------------------------

function sourceWith({ listSessions, probeState = { status: 'green', reason: null } }) {
  const olamConfig = {
    orgs: [{ org: 'atlas', runnerUrl: 'https://r.test', spaBase: 'https://s.test', brainUrl: null }],
  };
  const reg = makeRegistry();
  reg._sessions = [{ id: 'tmux-1', kind: 'claude', pending: false }];
  const client = {
    listSessions,
    enrich: async (rows) => rows,
    cfg: { spaBase: 'https://s.test' },
  };
  const probe = { probe: async () => probeState, state: probeState };
  const src = new RemoteSessionSource(olamConfig, reg, {
    clientFactory: () => client,
    probeFactory: () => probe,
  });
  return { src, reg };
}

test('tick pushes normalised rows into the registry with id olam:<org>:<sessionId>', async () => {
  const { src, reg } = sourceWith({
    listSessions: async () => [
      { org: 'atlas', sessionId: 's9', summary: 'x', lastActivity: null, inFlight: false, halted: false, linearRef: 's9', pool: null, phase: null },
    ],
  });
  await src.tick();
  const remote = reg.getSessions().find((s) => s.kind === 'remote');
  assert.equal(remote.id, 'olam:atlas:s9');
  assert.equal(remote.transport, 'olam');
  assert.equal(remote.stale, false);
  assert.equal(remote.orgHealth.status, 'green');
});

test('org fetch failure degrades to stale last-known rows (greyed, not dropped)', async () => {
  let fail = false;
  const { src, reg } = sourceWith({
    listSessions: async () => {
      if (fail) throw new Error('HTTP 502');
      return [{ org: 'atlas', sessionId: 's9', summary: 'x', lastActivity: null, inFlight: false, halted: false, linearRef: 's9', pool: null, phase: null }];
    },
  });
  await src.tick();
  fail = true;
  await src.tick();
  const remote = reg.getSessions().find((s) => s.kind === 'remote');
  assert.equal(remote.sessionId, 's9'); // still listed
  assert.equal(remote.stale, true);
  assert.equal(remote.orgHealth.status, 'amber');
});

test('red org health keeps rows visible as stale and skips the list fetch', async () => {
  let listCalls = 0;
  const { src, reg } = sourceWith({
    listSessions: async () => { listCalls += 1; return []; },
    probeState: { status: 'red', reason: 'auth failed after re-read — bearer likely rotated' },
  });
  await src.tick();
  assert.equal(listCalls, 0);
  assert.deepEqual(reg.getSessions().filter((s) => s.kind === 'remote'), []); // nothing known yet, nothing invented
});

test('health() exposes per-org probe state for the API/frontend', async () => {
  const { src } = sourceWith({ listSessions: async () => [] });
  await src.tick();
  assert.equal(src.health().atlas.status, 'green');
});

// --- Phase A (task A4) regression guard: liveness is NEVER polled -------------
//
// R5: liveness is fetched ONLY on session select and immediately before a
// send (both in server.js) — never from the 10s background tick. If a future
// edit wires sessionLiveness() into _fetchOrg()/tick(), this test catches it.
test('tick() makes zero sessionLiveness calls, even across repeated ticks (R5 guard)', async () => {
  let livenessCalls = 0;
  const olamConfig = {
    orgs: [{ org: 'atlas', runnerUrl: 'https://r.test', spaBase: 'https://s.test', brainUrl: null }],
  };
  const reg = makeRegistry();
  const client = {
    listSessions: async () => [
      { org: 'atlas', sessionId: 's1', summary: 'x', lastActivity: null, inFlight: true, halted: false, linearRef: 's1', pool: 'linear', phase: 'running' },
    ],
    enrich: async (rows) => rows,
    sessionLiveness: async () => { livenessCalls += 1; return { state: 'live' }; },
    cfg: { spaBase: 'https://s.test' },
  };
  const probe = { probe: async () => ({ status: 'green', reason: null }), state: { status: 'green', reason: null } };
  const src = new RemoteSessionSource(olamConfig, reg, {
    clientFactory: () => client,
    probeFactory: () => probe,
  });
  await src.tick();
  await src.tick();
  await src.tick();
  assert.equal(livenessCalls, 0);
});

// --- archive-lifecycle derivation (canonical Gateway-written status) -----------

// A halted session is awaiting input — ACTIVE, not archived (#157: archive only
// on a canonical terminal status, never on active halted/done).
test('tick keeps a halted session active (not archived)', async () => {
  const { src, reg } = sourceWith({
    listSessions: async () => [
      { org: 'atlas', sessionId: 's1', summary: 'x', lastActivity: null, inFlight: false, halted: true, linearRef: 's1', pool: null, phase: null },
    ],
  });
  await src.tick();
  const remote = reg.getSessions().find((s) => s.kind === 'remote');
  assert.equal(remote.archived, false);
});

test('tick derives archived:true from a canonical terminal planStatus (e.g. merged)', async () => {
  const { src, reg } = sourceWith({
    listSessions: async () => [
      { org: 'atlas', sessionId: 's1', summary: 'x', lastActivity: null, inFlight: false, halted: false, linearRef: 's1', pool: null, phase: null, planStatus: 'merged' },
    ],
  });
  await src.tick();
  const remote = reg.getSessions().find((s) => s.kind === 'remote');
  assert.equal(remote.archived, true);
});

test('tick derives archived:false for an active session', async () => {
  const { src, reg } = sourceWith({
    listSessions: async () => [
      { org: 'atlas', sessionId: 's1', summary: 'x', lastActivity: null, inFlight: true, halted: false, linearRef: 's1', pool: null, phase: 'running', planStatus: 'approved' },
    ],
  });
  await src.tick();
  const remote = reg.getSessions().find((s) => s.kind === 'remote');
  assert.equal(remote.archived, false);
});
