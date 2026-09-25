import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SessionRegistry } from '../lib/sessions.js';
import { makeAcpId } from '../lib/acp/ids.js';

function makeRegistry() {
  const tmux = {
    listPanes: async () => [],
    async listWindows() { return []; },
  };
  return new SessionRegistry({ projectsRoot: '/nonexistent', tmux });
}

const ACP_ROW = {
  id: makeAcpId('grok', '11111111-1111-4111-8111-111111111111'),
  kind: 'grok',
  transport: 'acp',
  pending: false,
  name: 'probe',
  cwd: '/tmp/proj',
  sessionId: 'sess-1',
};

const CODEX_ACP_ROW = {
  id: makeAcpId('codex', '22222222-2222-4222-8222-222222222222'),
  kind: 'codex',
  transport: 'acp',
  pending: false,
  name: 'codex-acp',
};

test('setAcpSessions appends ACP rows without touching local ones', () => {
  const reg = makeRegistry();
  reg._sessions = [{ id: 'tmux-1', kind: 'claude', transport: 'tmux', pending: false }];
  reg.setAcpSessions([ACP_ROW]);
  const ids = reg.getSessions().map((s) => s.id);
  assert.deepEqual(ids, ['tmux-1', ACP_ROW.id]);
});

test('setAcpSessions replaces the previous ACP set (no duplicates)', () => {
  const reg = makeRegistry();
  reg._sessions = [{ id: 'tmux-1', kind: 'claude', pending: false }];
  reg.setAcpSessions([ACP_ROW]);
  reg.setAcpSessions([{ ...ACP_ROW, name: 'renamed' }]);
  const acp = reg.getSessions().filter((s) => s.transport === 'acp');
  assert.equal(acp.length, 1);
  assert.equal(acp[0].name, 'renamed');
});

test('clearing ACP rows restores the exact local-only view', () => {
  const reg = makeRegistry();
  const local = [{ id: 'tmux-1', kind: 'claude', pending: false }];
  reg._sessions = [...local];
  const before = JSON.stringify(local);
  reg.setAcpSessions([ACP_ROW]);
  reg.setAcpSessions([]);
  assert.equal(JSON.stringify(reg.getSessions()), before);
});

test('local session snapshot is byte-identical with ACP rows present', () => {
  const reg = makeRegistry();
  const local = [{ id: 'tmux-1', kind: 'claude', transport: 'tmux', pending: false, cwd: '/x' }];
  reg._sessions = [...local];
  reg.setAcpSessions([ACP_ROW]);
  const locals = reg.getSessions().filter((s) => s.transport !== 'acp');
  assert.equal(JSON.stringify(locals), JSON.stringify(local));
});

test('setAcpSessions does not drop remote rows, and setRemoteSessions does not drop ACP rows', () => {
  const reg = makeRegistry();
  reg._sessions = [{ id: 'tmux-1', kind: 'claude', transport: 'tmux', pending: false }];
  const remote = {
    id: 'olam:atlas:s1',
    kind: 'remote',
    transport: 'olam',
    pending: false,
  };
  reg.setRemoteSessions([remote]);
  reg.setAcpSessions([ACP_ROW, CODEX_ACP_ROW]);
  reg.setRemoteSessions([{ ...remote, phase: 'running' }]);
  const ids = reg.getSessions().map((s) => s.id);
  assert.ok(ids.includes('tmux-1'));
  assert.ok(ids.includes(ACP_ROW.id));
  assert.ok(ids.includes(CODEX_ACP_ROW.id));
  assert.ok(ids.includes('olam:atlas:s1'));
  assert.equal(reg.getSessions().find((s) => s.id === 'olam:atlas:s1').phase, 'running');
});

test('Codex ACP rows are selected by transport=acp, not kind=codex', () => {
  const reg = makeRegistry();
  reg._sessions = [
    { id: '0:1.0', kind: 'codex', transport: 'rpc', pending: false },
  ];
  reg.setAcpSessions([CODEX_ACP_ROW]);
  const sessions = reg.getSessions();
  assert.equal(sessions.filter((s) => s.kind === 'codex').length, 2);
  assert.equal(sessions.filter((s) => s.transport === 'acp').length, 1);
  assert.equal(sessions.filter((s) => s.transport === 'rpc').length, 1);
});

test('change event fires when the ACP set changes', () => {
  const reg = makeRegistry();
  let fired = 0;
  reg.on('change', () => { fired += 1; });
  reg.setAcpSessions([ACP_ROW]);
  assert.ok(fired >= 1);
});

test('_pruneTargetState keeps ACP ids live so pending maps are not wiped', () => {
  const reg = makeRegistry();
  reg.setAcpSessions([ACP_ROW]);
  reg._thinkingMap.set(ACP_ROW.id, true);
  reg._pendingMap.set(ACP_ROW.id, true);
  reg._pruneTargetState([]);
  assert.equal(reg._thinkingMap.get(ACP_ROW.id), true);
  assert.equal(reg._pendingMap.get(ACP_ROW.id), true);
});
