import { test } from 'node:test';
import assert from 'node:assert/strict';

import { isValidTarget } from '../lib/tmux.js';
import {
  SessionKindSchema,
  SessionTransportSchema,
  SessionEntrySchema,
} from '../lib/protocol/session.js';
import { makeAcpId, isAcpId } from '../lib/acp/ids.js';

test('SessionKindSchema accepts grok', () => {
  assert.equal(SessionKindSchema.parse('grok'), 'grok');
});

test('SessionKindSchema still accepts the pre-ACP kinds', () => {
  for (const kind of ['claude', 'codex', 'terminal', 'remote']) {
    assert.equal(SessionKindSchema.parse(kind), kind);
  }
});

test('SessionTransportSchema accepts acp', () => {
  assert.equal(SessionTransportSchema.parse('acp'), 'acp');
});

test('SessionTransportSchema still accepts the pre-ACP transports', () => {
  for (const t of ['tmux', 'rpc', 'print', 'olam']) {
    assert.equal(SessionTransportSchema.parse(t), t);
  }
});

test('an ACP grok row validates against SessionEntrySchema without a tmux target', () => {
  const row = SessionEntrySchema.parse({
    id: makeAcpId('grok'),
    kind: 'grok',
    transport: 'acp',
    pending: false,
    sessionId: 'sess-abc',
    name: 'probe',
    cwd: '/tmp/proj',
  });
  assert.equal(row.kind, 'grok');
  assert.equal(row.transport, 'acp');
  assert.equal(row.target, undefined);
});

test('an ACP Codex row keeps kind=codex and transport=acp', () => {
  const row = SessionEntrySchema.parse({
    id: makeAcpId('codex'),
    kind: 'codex',
    transport: 'acp',
    pending: false,
  });
  assert.equal(row.kind, 'codex');
  assert.equal(row.transport, 'acp');
});

test('makeAcpId is never a valid tmux target', () => {
  const id = makeAcpId('grok');
  assert.equal(isValidTarget(id), false);
  assert.equal(isAcpId(id), true);
  assert.match(id, /^acp:grok:[0-9a-f-]{36}$/i);
});

test('isAcpId rejects pane targets and olam ids', () => {
  assert.equal(isAcpId('main:1.0'), false);
  assert.equal(isAcpId('olam:atlas:sess-1'), false);
  assert.equal(isAcpId('acp:'), false);
  assert.equal(isAcpId(''), false);
});
