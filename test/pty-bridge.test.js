// test/pty-bridge.test.js — hermetic unit tests for the binary PTY bridge.
//
// Ports lib/terminal.js's ttyd resource model onto node-pty (lib/pty-bridge.js):
// dedupe, ref-count teardown, largest-client sizing, LRU+MAX eviction, and
// dead-target detection. Every test injects a fake `spawn` — NO real node-pty,
// NO real tmux — matching the repo's hermetic-test convention (test/README.md:
// "no tmux, ttyd, ffmpeg, or whisper on the runner").
//
// Run: node --test test/pty-bridge.test.js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  createPtyBridge,
  handlePtyUpgrade,
  PTY_CHANNEL_DATA,
  parseTarget,
  ephemeralSessionName,
} from '../lib/pty-bridge.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

/**
 * A minimal `ws`-like socket. Real `ws` gives 'message' listeners a Buffer
 * for both text and binary frames (differentiated by `isBinary`); JSON
 * control frames in these tests are emitted as plain strings, which
 * `.toString()` (called on `raw` in pty-bridge.js) passes through unchanged.
 */
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
  terminate() { this.close(1006, 'terminated'); }
}

function fakeReq(remoteAddress = '127.0.0.1') {
  return { socket: { remoteAddress }, headers: {} };
}

function jsonFrames(ws) {
  return ws.sent.filter((s) => typeof s === 'string').map((s) => JSON.parse(s));
}

function binaryFrames(ws) {
  return ws.sent.filter((s) => Buffer.isBuffer(s));
}

/**
 * A fake node-pty handle. `onExitAt: 'immediate'` schedules the exit callback
 * via `queueMicrotask` at REGISTRATION time (inside `onExit(cb)` itself) —
 * this microtask is enqueued strictly before the bridge's subsequent
 * `await wait(deadTargetGraceMs)` (tests inject `wait: () => Promise.resolve()`,
 * whose continuation is scheduled as a LATER microtask), so the FIFO
 * microtask queue guarantees the simulated exit is observed before the grace
 * window is considered elapsed — deterministic, no real timers.
 */
function makeFakePty({ onExitAt = null } = {}) {
  let dataCb = null;
  let exitCb = null;
  const handle = {
    pid: Math.floor(Math.random() * 100000) + 1,
    written: [],
    resizes: [],
    killed: false,
    write(data) { handle.written.push(data); },
    resize(cols, rows) { handle.resizes.push({ cols, rows }); },
    kill() { handle.killed = true; },
    onData(cb) { dataCb = cb; },
    onExit(cb) {
      exitCb = cb;
      if (onExitAt === 'immediate') {
        queueMicrotask(() => cb({ exitCode: 1, signal: null }));
      }
    },
    _emitData(chunk) { dataCb?.(chunk); },
    _emitExit(info) { exitCb?.(info); },
  };
  return handle;
}

/**
 * Flush pending microtasks so injected-promise chains settle. The default
 * was raised from 10 to 80 when the ephemeral grouped-session setup added
 * several more sequential awaited round trips (has-session, the defensive
 * pre-clear kill-session, new-session, 2x set-option, select-window,
 * optionally select-pane) ahead of the spawn/wait steps that used to be the
 * whole chain — each `await`, including inside the injected `runTmuxCmd`
 * stub itself, costs at least one microtask tick. Still just
 * `Promise.resolve()` loops (no real timers), so this stays cheap and fully
 * deterministic; it does not change relative microtask ORDERING (see the
 * `makeFakePty` `onExitAt: 'immediate'` comment below), only how many
 * rounds are flushed before assertions run.
 */
async function tick(times = 80) {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * Trivial always-succeeds tmux-command runner — the default for every test
 * that doesn't care about the ephemeral grouped-session setup commands
 * (has-session/new-session/set-option/select-window/select-pane/kill-session)
 * introduced for the clean single-pane view. Keeps every pre-existing test
 * (dedupe, ref-count teardown, largest-client sizing, LRU eviction, dead
 * target via a dying spawn, mid-session exit) working unchanged: the setup
 * commands silently succeed and only the injected `spawn` fake governs pty
 * behaviour, exactly as before this feature existed. Tests that care about
 * the tmux setup commands themselves inject their own `runTmuxCmd`.
 */
function baseDeps(overrides = {}) {
  return {
    resolveTmuxBin: async () => '/usr/bin/tmux',
    getSocketPath: async () => '/tmp/tmux-test/default',
    runTmuxCmd: async () => ({ stdout: '', stderr: '' }),
    wait: () => Promise.resolve(),
    log: () => {},
    ...overrides,
  };
}

function attach(ws, sessionId) {
  ws.emit('message', JSON.stringify({ type: 'attach', sessionId }), false);
}
function resize(ws, cols, rows) {
  ws.emit('message', JSON.stringify({ type: 'resize', cols, rows }), false);
}

// ---------------------------------------------------------------------------
// 1. Dedupe — two clients attaching the same session spawn exactly ONE pty.
// ---------------------------------------------------------------------------

test('two clients attaching the same session dedupe onto exactly ONE spawn', async () => {
  let spawnCount = 0;
  const bridge = createPtyBridge(baseDeps({
    spawn: () => { spawnCount += 1; return makeFakePty(); },
  }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'demo:1');
  attach(wsB, 'demo:1');
  await tick();

  assert.equal(spawnCount, 1, 'only one pty spawned for two concurrent attaches to the same session');
  assert.equal(bridge.liveCount(), 1, 'exactly one tracked pty entry');
  assert.deepEqual(jsonFrames(wsA), [{ type: 'attached', sessionId: 'demo:1' }]);
  assert.deepEqual(jsonFrames(wsB), [{ type: 'attached', sessionId: 'demo:1' }]);
});

test('two clients attaching the same session dedupe onto exactly ONE ephemeral grouped session (not one per viewer)', async () => {
  let spawnCount = 0;
  const calls = [];
  const bridge = createPtyBridge(baseDeps({
    spawn: () => { spawnCount += 1; return makeFakePty(); },
    runTmuxCmd: async (tmuxBin, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'demo:1');
  attach(wsB, 'demo:1');
  await tick();

  assert.equal(spawnCount, 1, 'only one node-pty spawned for two concurrent viewers');
  const newSessionCalls = calls.filter((a) => a[2] === 'new-session');
  assert.equal(newSessionCalls.length, 1, 'exactly one grouped ephemeral tmux session created, not one per viewer');
  assert.deepEqual(newSessionCalls[0].slice(3), ['-d', '-t', 'demo', '-s', ephemeralSessionName('demo:1')]);
  assert.equal(bridge.liveCount(), 1);
});

// ---------------------------------------------------------------------------
// 2. Ref-count teardown — last client leaving kills the pty.
// ---------------------------------------------------------------------------

test('last client leaving triggers ref-count teardown (pty.kill called)', async () => {
  const handle = makeFakePty();
  const bridge = createPtyBridge(baseDeps({
    spawn: () => handle,
    // Instant idle reap: fire the reap callback synchronously instead of
    // waiting the real idle grace window (hermetic — no timers).
    scheduleIdleReap: (fn) => { fn(); return null; },
    clearIdleReap: () => {},
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'demo:2');
  await tick();
  assert.equal(bridge.liveCount(), 1);
  assert.equal(handle.killed, false);

  ws.emit('close');
  await tick();

  assert.equal(handle.killed, true, 'pty killed once the last client detaches');
  assert.equal(bridge.liveCount(), 0, 'entry removed after teardown');
});

test('a second client keeps the pty alive when the first leaves (ref-count, not client-count-1)', async () => {
  const handle = makeFakePty();
  const bridge = createPtyBridge(baseDeps({
    spawn: () => handle,
    scheduleIdleReap: (fn) => { fn(); return null; },
    clearIdleReap: () => {},
  }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'demo:20');
  attach(wsB, 'demo:20');
  await tick();

  wsA.emit('close');
  await tick();

  assert.equal(handle.killed, false, 'pty survives while a second client is still attached');
  assert.equal(bridge.liveCount(), 1);

  wsB.emit('close');
  await tick();
  assert.equal(handle.killed, true, 'pty killed once the LAST client leaves');
});

// ---------------------------------------------------------------------------
// 3. Largest-client sizing — a smaller viewer's resize never shrinks below a
//    larger viewer's last reported size.
// ---------------------------------------------------------------------------

test('a resize from the smaller viewer does not shrink below the larger viewer (largest-client sizing)', async () => {
  const handle = makeFakePty();
  const bridge = createPtyBridge(baseDeps({ spawn: () => handle }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'demo:3');
  attach(wsB, 'demo:3');
  await tick();
  assert.equal(handle.resizes.length, 0, 'no resize call before any client has sized itself');

  resize(wsA, 120, 40); // large viewer
  resize(wsB, 80, 24);  // small viewer
  await tick();
  assert.deepEqual(handle.resizes.at(-1), { cols: 120, rows: 40 }, 'pty pinned to the larger viewer');

  resize(wsB, 60, 20); // small viewer shrinks further
  await tick();
  assert.deepEqual(
    handle.resizes.at(-1),
    { cols: 120, rows: 40 },
    'still pinned to the largest client after another small-viewer resize',
  );

  // The large viewer growing further DOES push the pty larger.
  resize(wsA, 200, 50);
  await tick();
  assert.deepEqual(handle.resizes.at(-1), { cols: 200, rows: 50 });
});

// ---------------------------------------------------------------------------
// 4. Dead-target — spawn dies within the grace window: PtyError + close 4000,
//    no auto-retry.
// ---------------------------------------------------------------------------

test('dead-target: pty exits before the grace window elapses -> PtyError{code:"dead-target"} + close 4000, no retry', async () => {
  let spawnCount = 0;
  const bridge = createPtyBridge(baseDeps({
    spawn: () => { spawnCount += 1; return makeFakePty({ onExitAt: 'immediate' }); },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'dead:1');
  await tick();

  const frames = jsonFrames(ws);
  assert.equal(frames.length, 1, 'exactly one control frame sent');
  assert.equal(frames[0].type, 'error');
  assert.equal(frames[0].code, 'dead-target');
  assert.equal(typeof frames[0].message, 'string');
  assert.equal(ws.closedWith?.code, 4000, 'closed with the reserved dead-target code');
  assert.equal(bridge.liveCount(), 0, 'no lingering entry for a dead target');
  assert.equal(spawnCount, 1, 'the bridge itself performs no automatic retry');
});

test('dead-target on an unknown/invalid session id never spawns at all', async () => {
  let spawnCount = 0;
  const bridge = createPtyBridge(baseDeps({
    spawn: () => { spawnCount += 1; return makeFakePty(); },
    resolveTarget: () => null, // session id doesn't resolve to any known target
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'unknown:1');
  await tick();

  assert.equal(spawnCount, 0, 'no process spawned for an unresolvable session id');
  const frames = jsonFrames(ws);
  assert.equal(frames[0]?.code, 'dead-target');
  assert.equal(ws.closedWith?.code, 4000);
});

// ---------------------------------------------------------------------------
// 5. Unauthenticated upgrade is rejected — same bearer mechanism as the main
//    WS (checkWsToken / WS_PROTOCOL subprotocol).
// ---------------------------------------------------------------------------

test('unauthenticated /pty upgrade is rejected with 401 and never reaches the WebSocketServer', () => {
  const writes = [];
  let destroyed = false;
  const socket = { write: (s) => writes.push(s), destroy: () => { destroyed = true; } };
  let handleUpgradeCalled = false;
  const wss = { handleUpgrade: () => { handleUpgradeCalled = true; }, emit: () => {} };
  const req = { headers: {} }; // no Sec-WebSocket-Protocol token offered

  const accepted = handlePtyUpgrade(req, socket, Buffer.alloc(0), { wss, token: 'super-secret' });

  assert.equal(accepted, false);
  assert.equal(handleUpgradeCalled, false, 'unauthorized upgrade never reaches wss.handleUpgrade');
  assert.equal(destroyed, true, 'socket destroyed');
  assert.match(writes[0], /401/);
});

test('authorized /pty upgrade (matching subprotocol token) is handed off to wss', () => {
  const socket = { write: () => {}, destroy: () => {} };
  let handleUpgradeCalled = false;
  const wss = {
    handleUpgrade: (req, sock, head, cb) => { handleUpgradeCalled = true; cb({}); },
    emit: () => {},
  };
  const req = { headers: { 'sec-websocket-protocol': 'claude-control, super-secret' } };

  const accepted = handlePtyUpgrade(req, socket, Buffer.alloc(0), { wss, token: 'super-secret' });

  assert.equal(accepted, true);
  assert.equal(handleUpgradeCalled, true);
});

test('tokenless server accepts any /pty upgrade (open mode, matches main WS)', () => {
  const socket = { write: () => {}, destroy: () => {} };
  let handleUpgradeCalled = false;
  const wss = { handleUpgrade: (req, sock, head, cb) => { handleUpgradeCalled = true; cb({}); }, emit: () => {} };
  const req = { headers: {} };

  const accepted = handlePtyUpgrade(req, socket, Buffer.alloc(0), { wss, token: null });

  assert.equal(accepted, true);
  assert.equal(handleUpgradeCalled, true);
});

// ---------------------------------------------------------------------------
// Bonus: LRU + MAX cap (explicitly one of the four ported terminal.js
// properties) and the binary data channel itself (the actual point of the
// bridge). Not in the required-5 but load-bearing, so covered directly.
// ---------------------------------------------------------------------------

test('LRU cap evicts the idle attach when MAX is exceeded', async () => {
  const handles = {};
  let spawnCount = 0;
  const bridge = createPtyBridge(baseDeps({
    spawn: (tmuxBin, args) => {
      spawnCount += 1;
      // The attach now runs against the EPHEMERAL session name, not the raw
      // target — args.at(-1) is e.g. ephemeralSessionName('a:1').
      const ephemeralTarget = args.at(-1);
      const h = makeFakePty();
      handles[ephemeralTarget] = h;
      return h;
    },
    maxPtys: 2,
  }));

  const wsA = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  attach(wsA, 'a:1');
  await tick();

  const wsB = new FakeWs();
  bridge.handleConnection(wsB, fakeReq());
  attach(wsB, 'b:1');
  await tick();

  assert.equal(bridge.liveCount(), 2);

  // Detach A so it becomes idle (0 clients) — the LRU-eviction preference.
  wsA.emit('close');
  await tick();

  // A third distinct session attaches at the cap: the idle 'a:1' entry must
  // be evicted (killed) to make room, NOT the still-attached 'b:1'.
  const wsC = new FakeWs();
  bridge.handleConnection(wsC, fakeReq());
  attach(wsC, 'c:1');
  await tick();

  const ephA = ephemeralSessionName('a:1');
  const ephB = ephemeralSessionName('b:1');
  assert.equal(bridge.liveCount(), 2, 'stays at the cap, never above it');
  assert.equal(handles[ephA].killed, true, 'the idle LRU victim was killed');
  assert.equal(handles[ephB].killed, false, 'the still-attached session survives eviction');
  assert.equal(spawnCount, 3, 'one spawn per distinct session, no dedupe collision');
});

test('binary data channel: client keystrokes write to the pty; pty output fans out to every attached client framed with the 0x00 channel header', async () => {
  const handle = makeFakePty();
  const bridge = createPtyBridge(baseDeps({ spawn: () => handle }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'io:1');
  attach(wsB, 'io:1');
  await tick();

  // Client -> server: a 0x00-channel binary frame carries opaque keystroke
  // bytes straight through to the pty's write(), header stripped.
  const keystroke = Buffer.concat([Buffer.from([PTY_CHANNEL_DATA]), Buffer.from('ls -la\n', 'utf8')]);
  wsA.emit('message', keystroke, true);
  assert.equal(handle.written.length, 1);
  assert.equal(handle.written[0].toString('utf8'), 'ls -la\n');

  // Server -> clients: pty output fans out to EVERY attached client, each
  // framed with the same 0x00 channel header.
  handle._emitData('total 0\n');
  const framesA = binaryFrames(wsA);
  const framesB = binaryFrames(wsB);
  assert.equal(framesA.length, 1);
  assert.equal(framesB.length, 1);
  assert.equal(framesA[0][0], PTY_CHANNEL_DATA);
  assert.equal(framesA[0].subarray(1).toString('utf8'), 'total 0\n');
  assert.deepEqual(framesA[0], framesB[0], 'both attached clients receive the identical framed chunk');
});

test('a pty that exits mid-session (after attach succeeded) tears down and notifies clients with dead-target + close 4000', async () => {
  const handle = makeFakePty();
  const bridge = createPtyBridge(baseDeps({ spawn: () => handle }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'ends:1');
  await tick();
  assert.equal(jsonFrames(ws).length, 1); // 'attached'
  assert.equal(bridge.liveCount(), 1);

  handle._emitExit({ exitCode: 0, signal: null });
  await tick();

  const frames = jsonFrames(ws);
  assert.equal(frames.at(-1).type, 'error');
  assert.equal(frames.at(-1).code, 'dead-target');
  assert.equal(ws.closedWith?.code, 4000);
  assert.equal(bridge.liveCount(), 0, 'entry torn down when the session ends mid-use');
});

// ---------------------------------------------------------------------------
// 6. Clean single-pane view — each attach creates a per-session EPHEMERAL,
//    GROUPED tmux session (status off, pinned to the target's window) and
//    node-pty attaches to THAT instead of a raw `tmux attach -t <target>`,
//    which would show the full client chrome (status bar + window list).
// ---------------------------------------------------------------------------

test('parseTarget splits session/window/pane; ephemeralSessionName is deterministic and delimiter-free', () => {
  assert.deepEqual(parseTarget('main:1.0'), { session: 'main', window: '1', pane: '0' });
  assert.deepEqual(parseTarget('main:1'), { session: 'main', window: '1', pane: null });
  assert.deepEqual(parseTarget('claude-control & olam:3.2'), { session: 'claude-control & olam', window: '3', pane: '2' });

  // Same target -> same name every time (the dedupe + reattach-reuse guarantee).
  assert.equal(ephemeralSessionName('main:1.0'), ephemeralSessionName('main:1.0'));
  // Delimiter-free: never contains ':' or '.' so it can never be misparsed as
  // a compound target when used bare as `-t <name>`.
  assert.doesNotMatch(ephemeralSessionName('main:1.0'), /[:.]/);
  assert.match(ephemeralSessionName('main:1.0'), /^_ccpty_/);
});

test('attach creates a grouped ephemeral session (status off, aggressive-resize on the target window, pinned via select-window/select-pane) and node-pty attaches to the EPHEMERAL name, not the base target', async () => {
  const calls = [];
  let spawnArgs = null;
  const bridge = createPtyBridge(baseDeps({
    spawn: (tmuxBin, args) => { spawnArgs = args; return makeFakePty(); },
    runTmuxCmd: async (tmuxBin, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:1.0');
  await tick();

  const eph = ephemeralSessionName('main:1.0');

  const hasSessionCall = calls.find((a) => a[2] === 'has-session');
  assert.ok(hasSessionCall, 'has-session was checked before anything else');
  assert.deepEqual(hasSessionCall.slice(3), ['-t', 'main:1.0'], 'has-session validates the FULL target (session+window+pane)');

  const newSessionCall = calls.find((a) => a[2] === 'new-session');
  assert.ok(newSessionCall, 'new-session (grouped) was invoked');
  assert.deepEqual(newSessionCall.slice(3), ['-d', '-t', 'main', '-s', eph]);

  const statusCall = calls.find((a) => a[2] === 'set-option' && a[5] === 'status');
  assert.ok(statusCall, 'status was set off');
  assert.deepEqual(statusCall.slice(3), ['-t', eph, 'status', 'off']);

  const aggressiveCall = calls.find((a) => a[2] === 'set-option' && a[5] === 'aggressive-resize');
  assert.ok(aggressiveCall, 'aggressive-resize was set on');
  assert.deepEqual(aggressiveCall.slice(3), ['-t', `${eph}:1`, 'aggressive-resize', 'on'], 'targets the WINDOW explicitly, not the bare session');

  const selectWindowCall = calls.find((a) => a[2] === 'select-window');
  assert.ok(selectWindowCall, 'select-window pinned the ephemeral session to the target window');
  assert.deepEqual(selectWindowCall.slice(3), ['-t', `${eph}:1`]);

  const selectPaneCall = calls.find((a) => a[2] === 'select-pane');
  assert.ok(selectPaneCall, 'select-pane pinned to the specific pane from the target');
  assert.deepEqual(selectPaneCall.slice(3), ['-t', `${eph}:1.0`]);

  // node-pty's `attach` runs against the EPHEMERAL session name — never a
  // raw `tmux attach -t main:1.0`, which would show the full client chrome.
  assert.deepEqual(spawnArgs.slice(2), ['attach', '-t', eph]);

  assert.equal(jsonFrames(ws)[0]?.type, 'attached');
  assert.equal(bridge.liveCount(), 1);
});

test('attach with no pane segment (session:window only) sets up the window without a select-pane call', async () => {
  const calls = [];
  const bridge = createPtyBridge(baseDeps({
    spawn: () => makeFakePty(),
    runTmuxCmd: async (tmuxBin, args) => { calls.push(args); return { stdout: '', stderr: '' }; },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:2');
  await tick();

  assert.ok(!calls.some((a) => a[2] === 'select-pane'), 'no select-pane call when the target has no pane segment');
  assert.ok(calls.some((a) => a[2] === 'select-window' && a[4] === `${ephemeralSessionName('main:2')}:2`));
});

test('teardown (last client detaches) kills the EPHEMERAL session, never the base session', async () => {
  const handle = makeFakePty();
  const killSessionTargets = [];
  const bridge = createPtyBridge(baseDeps({
    spawn: () => handle,
    runTmuxCmd: async (tmuxBin, args) => {
      if (args[2] === 'kill-session') killSessionTargets.push(args[4]);
      return { stdout: '', stderr: '' };
    },
    scheduleIdleReap: (fn) => { fn(); return null; },
    clearIdleReap: () => {},
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:2.0');
  await tick();
  assert.equal(bridge.liveCount(), 1);
  assert.equal(handle.killed, false);

  ws.emit('close');
  await tick();

  assert.equal(handle.killed, true, 'the node-pty attach process is killed');
  assert.equal(bridge.liveCount(), 0);
  // Every kill-session call (the defensive pre-clear before create, and the
  // real teardown kill) targets ONLY the deterministic ephemeral name — the
  // base session name ("main") is never passed to kill-session.
  assert.ok(killSessionTargets.length >= 1, 'kill-session was called at least once');
  for (const target of killSessionTargets) {
    assert.notEqual(target, 'main', 'the base session is never killed');
    assert.equal(target, ephemeralSessionName('main:2.0'));
  }
});

test('dead base target: has-session fails -> DeadTargetError, no ephemeral session or node-pty ever created', async () => {
  let spawnCount = 0;
  const calls = [];
  const bridge = createPtyBridge(baseDeps({
    spawn: () => { spawnCount += 1; return makeFakePty(); },
    runTmuxCmd: async (tmuxBin, args) => {
      calls.push(args);
      if (args[2] === 'has-session') throw new Error(`can't find session: ${args[4]}`);
      return { stdout: '', stderr: '' };
    },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'ghost:1');
  await tick();

  assert.equal(spawnCount, 0, 'no node-pty spawned for a dead base target');
  assert.ok(!calls.some((a) => a[2] === 'new-session'), 'new-session is never attempted once has-session fails');
  assert.ok(!calls.some((a) => a[2] === 'kill-session'), 'no ephemeral session existed, so nothing to kill');
  const frames = jsonFrames(ws);
  assert.equal(frames[0]?.type, 'error');
  assert.equal(frames[0]?.code, 'dead-target');
  assert.equal(ws.closedWith?.code, 4000);
  assert.equal(bridge.liveCount(), 0);
});

test('a failure after the ephemeral session was created (e.g. set-option/select-window fails) cleans up the ephemeral session before surfacing dead-target', async () => {
  let spawnCount = 0;
  const calls = [];
  const eph = ephemeralSessionName('flaky:1');
  const bridge = createPtyBridge(baseDeps({
    spawn: () => { spawnCount += 1; return makeFakePty(); },
    runTmuxCmd: async (tmuxBin, args) => {
      calls.push(args);
      if (args[2] === 'select-window') throw new Error('select-window: window not found');
      return { stdout: '', stderr: '' };
    },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'flaky:1');
  await tick();

  assert.equal(spawnCount, 0, 'never reaches the node-pty spawn once setup fails');
  const killCalls = calls.filter((a) => a[2] === 'kill-session' && a[4] === eph);
  // One defensive pre-clear kill before create, plus one cleanup kill after
  // the select-window failure — both target the ephemeral name.
  assert.ok(killCalls.length >= 1, 'the ephemeral session created just before the failure is cleaned up');
  const frames = jsonFrames(ws);
  assert.equal(frames[0]?.code, 'dead-target');
  assert.equal(bridge.liveCount(), 0);
});

// ---------------------------------------------------------------------------
// 7. Agent-kind (kind: 'agent') — the Cmd+J raw bidirectional mirror onto a
//    session's LIVE agent tmux pane. No ephemeral session, no node-pty spawn:
//    a fifo + `pipe-pane -O` for output, `send-keys -l` for input, a per-client
//    `capture-pane`+cursor seed on attach, and resize as a structural no-op.
//    See lib/pty-bridge.js's module header, "AGENT-MODE MIRROR".
// ---------------------------------------------------------------------------

/** A minimal fifo-read-stream fake: an EventEmitter with a `destroy()`. */
class FakeFifoStream extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
  }
  destroy() { this.destroyed = true; }
}

/**
 * Agent-kind deps preset layered on `baseDeps`: `resolveTarget` resolves
 * every session id straight through to itself with `mode: 'agent-pane'`
 * (mirrors server.js's real `agent:<id>` branch, minus the prefix — these
 * tests exercise the BRIDGE, not server.js's resolveTarget), and every
 * agent-kind seam (`mkfifo`/`makeFifoPath`/`unlinkFifo`/`pipePane`/
 * `pipePaneOff`/`sendLiteral`/`capturePane`/`cursorPosition`/
 * `createReadStream`) defaults to a hermetic no-op/fake — NO real tmux, NO
 * real filesystem, matching every other test in this file.
 */
function agentDeps(overrides = {}) {
  return baseDeps({
    resolveTarget: (sessionId) => ({ target: sessionId, mode: 'agent-pane' }),
    mkfifo: async () => {},
    makeFifoPath: (target) => `/tmp/fake-fifo-${String(target).replace(/[:.]/g, '_')}`,
    unlinkFifo: async () => {},
    pipePane: async () => {},
    pipePaneOff: async () => {},
    sendLiteral: async () => {},
    capturePane: async () => '',
    cursorPosition: async () => ({ x: 0, y: 0 }),
    createReadStream: () => new FakeFifoStream(),
    ...overrides,
  });
}

test('agent-kind attach: no ephemeral tmux session or node-pty spawn — pipe-pane starts the fifo mirror instead', async () => {
  let spawnCount = 0;
  const tmuxCalls = [];
  const pipePaneCalls = [];
  const bridge = createPtyBridge(agentDeps({
    spawn: () => { spawnCount += 1; return makeFakePty(); },
    runTmuxCmd: async (tmuxBin, args) => { tmuxCalls.push(args); return { stdout: '', stderr: '' }; },
    pipePane: async (target, cmd) => { pipePaneCalls.push({ target, cmd }); },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:0');
  await tick();

  assert.equal(spawnCount, 0, 'no node-pty spawn for an agent-kind attach');
  assert.ok(!tmuxCalls.some((a) => a[2] === 'new-session'), 'no ephemeral grouped session for an agent-kind attach');
  assert.equal(pipePaneCalls.length, 1, 'pipe-pane started exactly once');
  assert.equal(pipePaneCalls[0].target, 'main:0');
  assert.match(pipePaneCalls[0].cmd, /^cat >> /, 'pipe-pane writes into the fifo via cat');
  assert.equal(jsonFrames(ws)[0]?.type, 'attached');
  assert.equal(bridge.liveCount(), 1);
});

test('agent-kind dedupe: two clients attaching the same session start pipe-pane exactly once', async () => {
  let pipePaneCount = 0;
  const bridge = createPtyBridge(agentDeps({
    pipePane: async () => { pipePaneCount += 1; },
  }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'main:0');
  attach(wsB, 'main:0');
  await tick();

  assert.equal(pipePaneCount, 1, 'only one pipe-pane started for two concurrent attaches to the same session');
  assert.equal(bridge.liveCount(), 1);
});

test('agent-kind attach seeds EACH newly-attached client with a capture-pane + cursor redraw frame, sent before it is registered as a broadcast recipient', async () => {
  const bridge = createPtyBridge(agentDeps({
    capturePane: async () => 'line one\nline two',
    cursorPosition: async () => ({ x: 3, y: 1 }),
  }));

  const wsA = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  attach(wsA, 'main:0');
  await tick();

  const framesA = binaryFrames(wsA);
  assert.equal(framesA.length, 1, 'exactly one seed frame sent to the first attaching client');
  const bodyA = framesA[0].subarray(1).toString('utf8');
  assert.ok(bodyA.startsWith('\x1b[2J\x1b[H'), 'seed clears the screen and homes the cursor first');
  assert.ok(bodyA.includes('line one\r\nline two'), 'seed carries the captured pane text (CRLF-joined)');
  assert.ok(bodyA.endsWith('\x1b[2;4H'), 'seed repositions the cursor (1-indexed x/y)');

  // A second client dedupe-attaching to the SAME already-live session gets
  // its OWN independent seed too (the seed is per-client, not per-entry —
  // every viewer needs its own screen painted on attach).
  const wsB = new FakeWs();
  bridge.handleConnection(wsB, fakeReq());
  attach(wsB, 'main:0');
  await tick();

  assert.equal(binaryFrames(wsB).length, 1, 'the second attacher gets its own seed frame');
  assert.equal(binaryFrames(wsA).length, 1, 'the first attacher does not get a duplicate seed from the second attach');
});

test('agent-kind input: a binary keystroke frame is sent via send-keys -l (sendLiteral) to the live tmux pane, never pty.write (there is no pty)', async () => {
  const sendLiteralCalls = [];
  const bridge = createPtyBridge(agentDeps({
    sendLiteral: async (target, text) => { sendLiteralCalls.push({ target, text }); },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:0');
  await tick();

  const keystroke = Buffer.concat([Buffer.from([PTY_CHANNEL_DATA]), Buffer.from('y\n', 'utf8')]);
  ws.emit('message', keystroke, true);
  await tick();

  assert.equal(sendLiteralCalls.length, 1);
  assert.deepEqual(sendLiteralCalls[0], { target: 'main:0', text: 'y\n' });
});

test('agent-kind input ordering: two frames sent back-to-back deliver in strict FIFO order even when the first send is slow (regression for the fire-and-forget race)', async () => {
  // The bug: the handler used to fire `_sendLiteral(...).catch(...)` per
  // frame with no ordering guarantee, so two `tmux send-keys -l` execs raced
  // and could COMPLETE (i.e. actually deliver bytes to the pane) in whatever
  // order the OS scheduled them — not the order the frames arrived in. This
  // fake makes the FIRST call's underlying "exec" resolve much later than the
  // second call's would if fired concurrently, which is exactly the shape of
  // that race: it reproduces the reordering on the old fire-and-forget code
  // (delivered ends up ['b', 'a']) and proves the per-entry send chain fixes
  // it (delivered is ['a', 'b']) by recording order at RESOLUTION time, not
  // invocation time — invocation order alone can't distinguish the two.
  const delivered = [];
  let callCount = 0;
  const bridge = createPtyBridge(agentDeps({
    sendLiteral: async (target, text) => {
      callCount += 1;
      if (callCount === 1) await tick(20);
      delivered.push(text);
    },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:0');
  await tick();

  const frame1 = Buffer.concat([Buffer.from([PTY_CHANNEL_DATA]), Buffer.from('a', 'utf8')]);
  const frame2 = Buffer.concat([Buffer.from([PTY_CHANNEL_DATA]), Buffer.from('b', 'utf8')]);
  ws.emit('message', frame1, true);
  ws.emit('message', frame2, true);
  await tick(150);

  assert.deepEqual(delivered, ['a', 'b'], 'bytes must be delivered in the order the frames arrived, not in whatever order the underlying sends happen to complete');
});

test('agent-kind resize is a structural no-op: no crash, no sendLiteral/pipePane call, entry stays alive', async () => {
  const sendLiteralCalls = [];
  const bridge = createPtyBridge(agentDeps({
    sendLiteral: async (target, text) => { sendLiteralCalls.push({ target, text }); },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:0');
  await tick();

  resize(ws, 120, 40);
  await tick();

  assert.equal(sendLiteralCalls.length, 0, 'a resize never sends any bytes to the pane');
  assert.equal(bridge.liveCount(), 1, 'the entry is untouched by a resize (no size negotiation for agent-kind)');
});

test('agent-kind output: fifo stream data fans out to every attached client, framed with the 0x00 channel header', async () => {
  let stream = null;
  const bridge = createPtyBridge(agentDeps({
    createReadStream: () => { stream = new FakeFifoStream(); return stream; },
  }));

  const wsA = new FakeWs();
  const wsB = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  bridge.handleConnection(wsB, fakeReq());
  attach(wsA, 'main:0');
  attach(wsB, 'main:0');
  await tick();

  // Clear the per-client seed frames so only the fan-out frame is asserted below.
  wsA.sent = [];
  wsB.sent = [];

  stream.emit('data', Buffer.from('agent output\n', 'utf8'));

  const framesA = binaryFrames(wsA);
  const framesB = binaryFrames(wsB);
  assert.equal(framesA.length, 1);
  assert.equal(framesB.length, 1);
  assert.equal(framesA[0][0], PTY_CHANNEL_DATA);
  assert.equal(framesA[0].subarray(1).toString('utf8'), 'agent output\n');
  assert.deepEqual(framesA[0], framesB[0], 'both attached clients receive the identical framed chunk');
});

test('agent-kind teardown (last client detaches): pipe-pane is stopped, the read stream is destroyed, and the fifo is unlinked', async () => {
  let stream = null;
  const pipePaneOffTargets = [];
  const unlinkedPaths = [];
  const bridge = createPtyBridge(agentDeps({
    createReadStream: () => { stream = new FakeFifoStream(); return stream; },
    pipePaneOff: async (target) => { pipePaneOffTargets.push(target); },
    unlinkFifo: async (fifoPath) => { unlinkedPaths.push(fifoPath); },
    scheduleIdleReap: (fn) => { fn(); return null; },
    clearIdleReap: () => {},
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:0');
  await tick();
  assert.equal(bridge.liveCount(), 1);

  ws.emit('close');
  await tick();

  assert.equal(bridge.liveCount(), 0, 'entry removed once the last client detaches');
  assert.deepEqual(pipePaneOffTargets, ['main:0'], 'pipe-pane was turned off for the target');
  assert.equal(stream.destroyed, true, 'the fifo read stream was destroyed');
  assert.deepEqual(unlinkedPaths, ['/tmp/fake-fifo-main_0'], 'the fifo file was unlinked');
});

test('agent-kind pane death mid-session (fifo stream ends) tears down and notifies clients with dead-target + close 4000', async () => {
  let stream = null;
  const pipePaneOffTargets = [];
  const bridge = createPtyBridge(agentDeps({
    createReadStream: () => { stream = new FakeFifoStream(); return stream; },
    pipePaneOff: async (target) => { pipePaneOffTargets.push(target); },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'main:0');
  await tick();
  assert.equal(bridge.liveCount(), 1);

  stream.emit('end');
  await tick();

  const frames = jsonFrames(ws);
  assert.equal(frames.at(-1).type, 'error');
  assert.equal(frames.at(-1).code, 'dead-target');
  assert.equal(ws.closedWith?.code, 4000);
  assert.equal(bridge.liveCount(), 0, 'entry torn down when the agent pane ends mid-use');
  assert.deepEqual(pipePaneOffTargets, ['main:0'], 'teardown still turns pipe-pane off even on a pane-death end event');
});

test('agent-kind dead base target: has-session fails -> DeadTargetError, mkfifo/pipe-pane never attempted', async () => {
  let mkfifoCount = 0;
  let pipePaneCount = 0;
  const bridge = createPtyBridge(agentDeps({
    runTmuxCmd: async (tmuxBin, args) => {
      if (args[2] === 'has-session') throw new Error(`can't find session: ${args[4]}`);
      return { stdout: '', stderr: '' };
    },
    mkfifo: async () => { mkfifoCount += 1; },
    pipePane: async () => { pipePaneCount += 1; },
  }));

  const ws = new FakeWs();
  bridge.handleConnection(ws, fakeReq());
  attach(ws, 'ghost:1');
  await tick();

  assert.equal(mkfifoCount, 0, 'no fifo created for a dead base target');
  assert.equal(pipePaneCount, 0, 'pipe-pane never started for a dead base target');
  const frames = jsonFrames(ws);
  assert.equal(frames[0]?.code, 'dead-target');
  assert.equal(ws.closedWith?.code, 4000);
  assert.equal(bridge.liveCount(), 0);
});

test('LRU cap evicts an idle agent-kind entry via pipe-pane-off + fifo teardown, never pty.kill', async () => {
  const pipePaneOffTargets = [];
  const bridge = createPtyBridge(agentDeps({
    pipePaneOff: async (target) => { pipePaneOffTargets.push(target); },
    maxPtys: 1,
  }));

  const wsA = new FakeWs();
  bridge.handleConnection(wsA, fakeReq());
  attach(wsA, 'a:1');
  await tick();
  wsA.emit('close'); // idle, no idle-grace override -> stays registered but 0 clients
  await tick();

  const wsB = new FakeWs();
  bridge.handleConnection(wsB, fakeReq());
  attach(wsB, 'b:1');
  await tick();

  assert.equal(bridge.liveCount(), 1, 'stays at the cap');
  assert.ok(pipePaneOffTargets.includes('a:1'), 'the idle agent-kind entry was evicted via pipe-pane-off teardown');
});

test('bridge init sweeps and kills orphaned _ccpty_* sessions left by a prior crash, without touching non-matching sessions', async () => {
  const killed = [];
  const bridge = createPtyBridge(baseDeps({
    resolveTmuxBin: async () => '/usr/bin/tmux',
    getSocketPath: async () => '/tmp/tmux-test/default',
    runTmuxCmd: async (tmuxBin, args) => {
      if (args[2] === 'list-sessions') {
        return { stdout: '_ccpty_stale_main_1_0\nmain\n_ccpty_other_2_1\n', stderr: '' };
      }
      if (args[2] === 'kill-session') { killed.push(args[4]); return { stdout: '', stderr: '' }; }
      return { stdout: '', stderr: '' };
    },
  }));

  await bridge.ephemeralSweepDone;

  assert.deepEqual(killed.sort(), ['_ccpty_other_2_1', '_ccpty_stale_main_1_0'], 'only _ccpty_-prefixed orphans are swept');
  assert.ok(!killed.includes('main'), 'a real, non-ephemeral session is never touched by the sweep');
});
