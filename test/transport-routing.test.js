import { test } from 'node:test';
import assert from 'node:assert/strict';

import { replyTransport } from '../lib/olam-transport.js';

// The reply router must send each session kind to its transport, and the new
// 'olam' branch must NEVER shadow the three local transports (regression guard
// for Phase C's server.js change).

test('remote sessions route to the olam transport', () => {
  assert.equal(replyTransport({ kind: 'remote', transport: 'olam' }), 'olam');
  assert.equal(replyTransport({ kind: 'remote' }), 'olam'); // transport optional
});

test('claude print sessions route to claude-print (unchanged)', () => {
  assert.equal(replyTransport({ kind: 'claude', transport: 'print' }), 'claude-print');
});

test('codex rpc sessions route to codex-rpc (unchanged)', () => {
  assert.equal(replyTransport({ kind: 'codex', transport: 'rpc' }), 'codex-rpc');
});

test('everything else (tmux claude, codex-tui, plain terminal) routes to tmux', () => {
  assert.equal(replyTransport({ kind: 'claude', transport: 'tmux' }), 'tmux');
  assert.equal(replyTransport({ kind: 'claude' }), 'tmux');
  assert.equal(replyTransport({ kind: 'codex', transport: 'tmux' }), 'tmux');
  assert.equal(replyTransport({ kind: 'terminal' }), 'tmux');
});

test('olam branch never fires for a local session (no shadowing)', () => {
  for (const local of [
    { kind: 'claude', transport: 'tmux' },
    { kind: 'claude', transport: 'print' },
    { kind: 'codex', transport: 'rpc' },
    { kind: 'codex', transport: 'tmux' },
    { kind: 'terminal' },
  ]) {
    assert.notEqual(replyTransport(local), 'olam');
  }
});
