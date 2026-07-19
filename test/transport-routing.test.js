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

test('everything else (tmux claude, claudex, codex-tui, plain terminal) routes to tmux', () => {
  assert.equal(replyTransport({ kind: 'claude', transport: 'tmux' }), 'tmux');
  assert.equal(replyTransport({ kind: 'claude' }), 'tmux');
  assert.equal(replyTransport({ kind: 'codex', transport: 'tmux' }), 'tmux');
  assert.equal(replyTransport({ kind: 'terminal' }), 'tmux');
});

// Claudex is ALWAYS tmux transport (server.js forces claudeTransport='tmux'
// for it, never 'print' — see handleSessionNew) — no dedicated `kind ===
// 'claude'` literal in replyTransport is needed for this to already be
// correct: it simply never matches the claude-print branch (kind mismatch
// AND transport mismatch both fail it) and falls through to 'tmux'.
test('claudex sessions route to tmux (never claude-print, even if transport were print)', () => {
  assert.equal(replyTransport({ kind: 'claudex', transport: 'tmux' }), 'tmux');
  assert.equal(replyTransport({ kind: 'claudex' }), 'tmux');
  // Defense-in-depth: claudex can never actually reach print transport
  // (server.js forces tmux), but the classifier itself must not treat
  // 'claudex' as an alias for 'claude' here — that would silently grant it
  // print-bridge routing it was never designed for.
  assert.equal(replyTransport({ kind: 'claudex', transport: 'print' }), 'tmux');
});

// Claudemi (claudex's sibling — the same claude binary, pointed at Kimi via
// the olam auth-worker's /kimi route) mirrors the same defense-in-depth
// story: it is ALWAYS tmux transport (server.js forces claudeTransport='tmux'
// for it too), and replyTransport must not treat 'claudemi' as an alias for
// 'claude' either.
test('claudemi sessions route to tmux (never claude-print, even if transport were print)', () => {
  assert.equal(replyTransport({ kind: 'claudemi', transport: 'tmux' }), 'tmux');
  assert.equal(replyTransport({ kind: 'claudemi' }), 'tmux');
  assert.equal(replyTransport({ kind: 'claudemi', transport: 'print' }), 'tmux');
});

test('olam branch never fires for a local session (no shadowing)', () => {
  for (const local of [
    { kind: 'claude', transport: 'tmux' },
    { kind: 'claude', transport: 'print' },
    { kind: 'claudex', transport: 'tmux' },
    { kind: 'claudemi', transport: 'tmux' },
    { kind: 'codex', transport: 'rpc' },
    { kind: 'codex', transport: 'tmux' },
    { kind: 'terminal' },
  ]) {
    assert.notEqual(replyTransport(local), 'olam');
  }
});
