/**
 * test/spawn-server.test.js — unit tests for lib/spawn.js (handleSpawn).
 *
 * Tests handleSpawn directly with:
 *  - A mock tmux (listWindows, newWindow, newSession as spy functions)
 *  - A mock registry ({ refresh: async()=>{} })
 *  - A real temp dir for cwd (fs.mkdtempSync) so realpath/isDirectory checks run for real
 *  - A stubbed resolveBinary injected via deps
 *
 * Every rejection test asserts that tmux.newWindow and tmux.newSession were
 * called 0 times (no spawn happens on validation failure).
 */

import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Setup: real temp dir + a temp file (to test "cwd is a file, not a dir")
// ---------------------------------------------------------------------------

let tmpDir;
let tmpFile;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-srv-test-'));
  tmpFile = path.join(tmpDir, 'notadir.txt');
  fs.writeFileSync(tmpFile, 'x');
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock factory helpers
// ---------------------------------------------------------------------------

/** Create a fresh spy-based mock tmux with a known existing session list. */
function makeMockTmux({ existingSessions = ['mysess'] } = {}) {
  let newWindowCalls = 0;
  let newSessionCalls = 0;
  let lastNewWindowArgs = null;
  let lastNewSessionArgs = null;

  return {
    listWindows: async () =>
      existingSessions.map((name) => ({ sessionName: name, cwd: '/some/cwd', active: true })),
    isValidName: (name) => {
      if (typeof name !== 'string' || name.length === 0) return false;
      return /^[A-Za-z0-9_-]+$/.test(name);
    },
    newWindow: async (opts) => {
      newWindowCalls++;
      lastNewWindowArgs = opts;
      return 'fakesess:7';
    },
    newSession: async (opts) => {
      newSessionCalls++;
      lastNewSessionArgs = opts;
      return 'newsess:0';
    },
    // Spy accessors
    get _newWindowCalls() { return newWindowCalls; },
    get _newSessionCalls() { return newSessionCalls; },
    get _lastNewWindowArgs() { return lastNewWindowArgs; },
    get _lastNewSessionArgs() { return lastNewSessionArgs; },
  };
}

function makeMockRegistry() {
  return { refresh: async () => {} };
}

function makeMockAdapterById(ids = ['claude', 'codex']) {
  return (id) => {
    if (!ids.includes(id)) return null;
    // Minimal adapter shim — just needs buildSpawnCommand.
    if (id === 'claude') {
      return {
        id: 'claude',
        buildSpawnCommand({ bin = 'claude' } = {}) { return { bin, args: [] }; },
      };
    }
    if (id === 'codex') {
      return {
        id: 'codex',
        buildSpawnCommand({ cwd, bin = 'codex' } = {}) { return { bin, args: ['-C', cwd] }; },
      };
    }
    return null;
  };
}

/** Returns a deps object with stubs pre-filled. Override any prop to customize. */
function makeDeps({ resolveOk = true, sessions = ['mysess'], ...overrides } = {}) {
  return {
    tmux: makeMockTmux({ existingSessions: sessions }),
    adapterById: makeMockAdapterById(),
    registry: makeMockRegistry(),
    codexBin: 'codex',
    resolveBinary: async () => resolveOk,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------

let handleSpawn;

before(async () => {
  ({ handleSpawn } = await import('../lib/spawn.js'));
});

// ---------------------------------------------------------------------------
// SUCCESS CASES
// ---------------------------------------------------------------------------

test('spawn new-window into existing session → calls newWindow once with correct args', async () => {
  const deps = makeDeps({ sessions: ['mysess'] });
  const result = await handleSpawn(
    {
      type: 'spawn',
      agentType: 'claude',
      target: { mode: 'new-window', session: 'mysess' },
      cwd: tmpDir,
    },
    deps,
  );
  assert.equal(result, 'fakesess:7');
  assert.equal(deps.tmux._newWindowCalls, 1, 'newWindow should be called once');
  assert.equal(deps.tmux._newSessionCalls, 0, 'newSession should not be called');
  const args = deps.tmux._lastNewWindowArgs;
  assert.equal(args.session, 'mysess');
  assert.equal(args.cwd, fs.realpathSync(tmpDir), 'cwd must be the realpath');
  assert.equal(args.bin, 'claude');
  assert.deepEqual(args.args, []);
});

test('spawn new-session → calls newSession once with correct args', async () => {
  const deps = makeDeps({ sessions: [] }); // empty so 'freshsess' doesn't clash
  const result = await handleSpawn(
    {
      type: 'spawn',
      agentType: 'claude',
      target: { mode: 'new-session' },
      name: 'freshsess',
      cwd: tmpDir,
    },
    deps,
  );
  assert.equal(result, 'newsess:0');
  assert.equal(deps.tmux._newSessionCalls, 1, 'newSession should be called once');
  assert.equal(deps.tmux._newWindowCalls, 0, 'newWindow should not be called');
  const args = deps.tmux._lastNewSessionArgs;
  assert.equal(args.name, 'freshsess');
  assert.equal(args.cwd, fs.realpathSync(tmpDir));
  assert.equal(args.bin, 'claude');
  assert.deepEqual(args.args, []);
});

test('spawn codex new-window → buildSpawnCommand passes -C cwd in args', async () => {
  const deps = makeDeps({ sessions: ['mysess'] });
  await handleSpawn(
    {
      type: 'spawn',
      agentType: 'codex',
      target: { mode: 'new-window', session: 'mysess' },
      cwd: tmpDir,
    },
    deps,
  );
  assert.equal(deps.tmux._newWindowCalls, 1);
  const args = deps.tmux._lastNewWindowArgs;
  assert.deepEqual(args.args, ['-C', fs.realpathSync(tmpDir)], 'codex must pass -C cwd in args');
  assert.equal(args.bin, 'codex');
});

// ---------------------------------------------------------------------------
// REJECTION: unknown agentType
// ---------------------------------------------------------------------------

test('unknown agentType → throws, no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      { type: 'spawn', agentType: 'gpteeny', target: { mode: 'new-window', session: 'mysess' }, cwd: tmpDir },
      deps,
    ),
    /unknown agent type/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

test('null agentType → throws, no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      { type: 'spawn', agentType: null, target: { mode: 'new-window', session: 'mysess' }, cwd: tmpDir },
      deps,
    ),
    /unknown agent type/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: nonexistent cwd
// ---------------------------------------------------------------------------

test('nonexistent cwd → throws, no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-window', session: 'mysess' },
        cwd: '/this/does/not/exist/at/all/1234567',
      },
      deps,
    ),
    /cwd does not exist/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

test('empty cwd string → throws, no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      { type: 'spawn', agentType: 'claude', target: { mode: 'new-window', session: 'mysess' }, cwd: '' },
      deps,
    ),
    /cwd does not exist/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: cwd is a FILE, not a directory
// ---------------------------------------------------------------------------

test('cwd points to a file → throws "cwd is not a directory", no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-window', session: 'mysess' },
        cwd: tmpFile,
      },
      deps,
    ),
    /cwd is not a directory/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: unresolvable binary
// ---------------------------------------------------------------------------

test('unresolvable binary → throws, no spawn call', async () => {
  const deps = makeDeps({ resolveOk: false });
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-window', session: 'mysess' },
        cwd: tmpDir,
      },
      deps,
    ),
    /agent binary "claude" not found/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: new-window with session NOT in the list
// ---------------------------------------------------------------------------

test('new-window: session not in tmux list → throws, no spawn call', async () => {
  const deps = makeDeps({ sessions: ['othersess'] });
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-window', session: 'mysess' },
        cwd: tmpDir,
      },
      deps,
    ),
    /session not found: mysess/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: new-session with bad names
// ---------------------------------------------------------------------------

test('new-session: name with dot → throws "invalid session name", no spawn call', async () => {
  const deps = makeDeps({ sessions: [] });
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-session' },
        name: 'a.b',
        cwd: tmpDir,
      },
      deps,
    ),
    /invalid session name/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

test('new-session: name with colon → throws "invalid session name", no spawn call', async () => {
  const deps = makeDeps({ sessions: [] });
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-session' },
        name: 'a:b',
        cwd: tmpDir,
      },
      deps,
    ),
    /invalid session name/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

test('new-session: name with space → throws "invalid session name", no spawn call', async () => {
  const deps = makeDeps({ sessions: [] });
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-session' },
        name: 'a b',
        cwd: tmpDir,
      },
      deps,
    ),
    /invalid session name/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: new-session with name that already exists
// ---------------------------------------------------------------------------

test('new-session: name already exists → throws, no spawn call', async () => {
  const deps = makeDeps({ sessions: ['existingsess'] });
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'new-session' },
        name: 'existingsess',
        cwd: tmpDir,
      },
      deps,
    ),
    /session already exists: existingsess/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

// ---------------------------------------------------------------------------
// REJECTION: invalid target.mode
// ---------------------------------------------------------------------------

test('invalid target.mode → throws "invalid target mode", no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        target: { mode: 'attach' },
        cwd: tmpDir,
      },
      deps,
    ),
    /invalid target mode/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});

test('missing target → throws "invalid target mode", no spawn call', async () => {
  const deps = makeDeps();
  await assert.rejects(
    () => handleSpawn(
      {
        type: 'spawn',
        agentType: 'claude',
        cwd: tmpDir,
      },
      deps,
    ),
    /invalid target mode/,
  );
  assert.equal(deps.tmux._newWindowCalls, 0);
  assert.equal(deps.tmux._newSessionCalls, 0);
});
