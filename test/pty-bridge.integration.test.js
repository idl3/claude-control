// test/pty-bridge.integration.test.js — DEV-ONLY real end-to-end check.
//
// The unit suite (test/pty-bridge.test.js) proves the bridge's logic with a
// fully-stubbed spawn. This file proves the ONE thing that can't be faked:
// that the dead-target grace-window HEURISTIC (lib/pty-bridge.js's
// DEFAULT_DEAD_TARGET_GRACE_MS race between "the spawned process exits" and
// "the grace window elapses") actually holds against REAL tmux + REAL
// node-pty timing, not just a synchronously-controlled fake.
//
// Self-skips (does not fail, does not count against the pre-existing-failure
// baseline) when either dependency is unavailable:
//   - no `tmux` binary resolvable
//   - `node-pty` doesn't import/spawn cleanly (no prebuild for this
//     Node/platform combo — expected and acceptable per the task brief)
//
// Uses a throwaway, isolated tmux server (`-L cc-test-pty-bridge -f /dev/null`)
// — never the operator's real tmux server — and always tears it down.
//
// Run: node --test test/pty-bridge.integration.test.js
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { EventEmitter } from 'node:events';

import { resolveTmuxBin } from '../lib/tmux.js';
import { createPtyBridge, loadNodePty } from '../lib/pty-bridge.js';

const execFile = promisify(_execFile);
const SOCKET_NAME = `cc-test-pty-bridge-${process.pid}`;

let tmuxBin = null;
let socketPath = null;
let nodePtyUsable = false;
let skipReason = null;

class FakeWs extends EventEmitter {
  constructor() {
    super();
    this.OPEN = 1;
    this.readyState = this.OPEN;
    this.sent = [];
    this.closedWith = null;
  }
  send(data) { this.sent.push(data); }
  close(code, reason) {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.closedWith = { code, reason };
    this.emit('close');
  }
}

function jsonFrames(ws) {
  return ws.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
}
function binaryFrames(ws) {
  return ws.sent.filter((s) => Buffer.isBuffer(s));
}

async function tmuxCmd(...args) {
  return execFile(tmuxBin, ['-L', SOCKET_NAME, '-f', '/dev/null', ...args]);
}

/** Poll `check` until it's truthy or `timeoutMs` elapses. */
async function waitUntil(check, timeoutMs = 2000, intervalMs = 20) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

before(async () => {
  try {
    tmuxBin = await resolveTmuxBin();
  } catch (err) {
    skipReason = `no tmux binary available: ${err.message}`;
    return;
  }
  try {
    await tmuxCmd('new-session', '-d', '-s', 'real-session', '-x', '80', '-y', '24');
    const { stdout } = await tmuxCmd('display-message', '-p', '#{socket_path}');
    socketPath = stdout.trim();
  } catch (err) {
    skipReason = `could not start an isolated throwaway tmux server: ${err.message}`;
    return;
  }
  try {
    // Route through lib/pty-bridge.js's own loadNodePty — the SAME
    // self-healing path (spawn-helper +x repair) production uses — rather
    // than a raw import('node-pty') that would bypass it.
    const nodePty = await loadNodePty();
    // Real, minimal smoke spawn — proves the native addon actually works
    // before trusting it for the real tests below.
    await new Promise((resolve, reject) => {
      const p = nodePty.spawn('/bin/echo', ['pty-bridge-integration-smoke'], { name: 'xterm', cols: 80, rows: 24 });
      let out = '';
      p.onData((d) => { out += d; });
      p.onExit(() => { out.includes('pty-bridge-integration-smoke') ? resolve() : reject(new Error('unexpected output')); });
      setTimeout(() => reject(new Error('smoke spawn timed out')), 3000);
    });
    nodePtyUsable = true;
  } catch (err) {
    skipReason = `node-pty not usable on this Node/platform (expected/acceptable per task brief): ${err.message}`;
  }
});

after(async () => {
  if (!tmuxBin) return;
  try { await tmuxCmd('kill-server'); } catch { /* already gone / never started */ }
});

function makeBridge() {
  return createPtyBridge({
    resolveTmuxBin: async () => tmuxBin,
    getSocketPath: async () => socketPath,
    // Real DEFAULT_DEAD_TARGET_GRACE_MS (200ms) — this is the whole point:
    // prove the default actually holds against real tmux timing, not a
    // shortened test-only value.
    log: () => {},
  });
}

test('real tmux + real node-pty: attaching a LIVE session streams real data within the grace window', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }

  const bridge = makeBridge();
  const ws = new FakeWs();
  bridge.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  ws.emit('message', JSON.stringify({ type: 'attach', sessionId: 'real-session:0' }), false);

  const attached = await waitUntil(() => jsonFrames(ws).some((f) => f.type === 'attached'), 8000);
  assert.ok(attached, `expected an 'attached' frame; got: ${JSON.stringify(jsonFrames(ws))}`);

  const gotData = await waitUntil(() => binaryFrames(ws).length > 0, 8000);
  assert.ok(gotData, 'expected at least one binary data frame from the real tmux screen redraw');
  assert.equal(binaryFrames(ws)[0][0], 0x00, 'framed with the 0x00 data channel header');
  assert.equal(bridge.liveCount(), 1);

  bridge.shutdownAll();
});

test('real tmux + real node-pty: attaching a DEAD target is detected within the grace window -> dead-target + close 4000', async (t) => {
  if (skipReason) { t.skip(skipReason); return; }

  const bridge = makeBridge();
  const ws = new FakeWs();
  bridge.handleConnection(ws, { socket: { remoteAddress: '127.0.0.1' }, headers: {} });
  ws.emit('message', JSON.stringify({ type: 'attach', sessionId: 'nonexistent-real-target:0' }), false);

  const closed = await waitUntil(() => ws.closedWith != null, 8000);
  assert.ok(closed, 'expected the connection to close');
  assert.equal(ws.closedWith.code, 4000);
  const frames = jsonFrames(ws);
  assert.equal(frames[0]?.type, 'error');
  assert.equal(frames[0]?.code, 'dead-target');
  assert.equal(bridge.liveCount(), 0);
});
