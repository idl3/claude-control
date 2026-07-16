import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';
import { checkWsToken } from '../lib/auth.js';

/**
 * WS protocol backward-compat guard (phase A, plan T-regression row):
 * the `{type:'sessions', sessions:[...]}` payload must not grow new REQUIRED
 * fields on LOCAL rows, and remote rows must be purely additive — a client
 * that ignores kind:'remote' rows sees exactly the pre-feature protocol.
 */

const LOCAL = Object.freeze({
  id: '@1.0',
  kind: 'claude',
  transport: 'tmux',
  target: 'main:1.0',
  cwd: '/Users/x/proj',
  transcriptPath: '/Users/x/.claude/projects/p/t.jsonl',
  pending: false,
});

function makeRegistry() {
  return new SessionRegistry({ projectsRoot: '/nonexistent', tmux: {} });
}

test('local rows serialize byte-identically before and after remote rows exist', () => {
  const reg = makeRegistry();
  reg._sessions = [{ ...LOCAL }];
  const before = JSON.stringify({ type: 'sessions', sessions: reg.getSessions() });

  reg.setRemoteSessions([
    { id: 'olam:atlas:s1', kind: 'remote', transport: 'olam', org: 'atlas', sessionId: 's1', pending: false },
  ]);
  const localsAfter = reg.getSessions().filter((s) => s.kind !== 'remote');
  const after = JSON.stringify({ type: 'sessions', sessions: localsAfter });
  assert.equal(after, before);
});

test('remote rows carry the fields legacy clients key on (id, kind, transport, pending)', () => {
  const reg = makeRegistry();
  reg.setRemoteSessions([
    { id: 'olam:atlas:s1', kind: 'remote', transport: 'olam', org: 'atlas', sessionId: 's1', pending: false },
  ]);
  const row = reg.getSessions()[0];
  for (const field of ['id', 'kind', 'transport', 'pending']) {
    assert.ok(field in row, `remote row missing baseline field: ${field}`);
  }
  // id namespaced so no collision with tmux targets / codex rollout ids
  assert.match(row.id, /^olam:/);
});

test('remote ids never collide with local id shapes', () => {
  const reg = makeRegistry();
  reg._sessions = [{ ...LOCAL }];
  reg.setRemoteSessions([
    { id: 'olam:atlas:s1', kind: 'remote', transport: 'olam', pending: false },
  ]);
  const ids = reg.getSessions().map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length);
});

/**
 * Legacy no-build UI compat (public/app.js): the zero-build vanilla client
 * has no login prompt and can't set arbitrary WS headers, so it authenticates
 * purely via subprotocol — `new WebSocket(url, ['claude-control', token])`.
 * Browsers join the offered array into a single comma-separated
 * `Sec-WebSocket-Protocol` header, so we simulate that exact join here to
 * lock in the contract public/app.js's connect() now depends on.
 */
function wsUpgradeReq(offeredProtocols) {
  return { headers: { 'sec-websocket-protocol': offeredProtocols.join(', ') } };
}

test('legacy UI contract: WS upgrade offering [claude-control, <token>] is accepted', () => {
  const req = wsUpgradeReq(['claude-control', 's3cr3t']);
  assert.equal(checkWsToken(req, 's3cr3t'), true);
});

test('legacy UI contract: WS upgrade offering only [claude-control] (no token) is rejected when a token is configured', () => {
  const req = wsUpgradeReq(['claude-control']);
  assert.equal(checkWsToken(req, 's3cr3t'), false);
});
