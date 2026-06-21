/**
 * test/spawn-command.test.js — tests for P3 spawn-picker additions:
 *   - ClaudeAdapter.buildSpawnCommand
 *   - CodexAdapter.buildSpawnCommand
 *   - tmux.isValidName
 *   - tmux.newWindow / tmux.newSession (via COCKPIT_TMUX mock)
 *
 * Must be run as its own process (node:test does this per file). The
 * COCKPIT_TMUX env var is set before the first tmux function call so the
 * module-level _resolvedBin cache picks up the fake script.
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fake tmux binary setup
// ---------------------------------------------------------------------------
// We create a temp dir, write a shell script that:
//   1. Appends all argv (one per line) to a log file (argv.log)
//   2. Prints "fakesess:7" to stdout (simulating -P -F output for new-window/new-session)
//
// COCKPIT_TMUX is set to this script path before any runTmux call happens.
// Because ESM imports are hoisted, we cannot set env before the import statement —
// but resolveTmuxBin() reads process.env.COCKPIT_TMUX at CALL TIME (not import time),
// so setting it here (before any test runs) is sufficient as long as _resolvedBin
// has not been populated yet (it hasn't — this is a fresh process).

let tmpDir;
let fakeScript;
let argvLog;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spawn-cmd-test-'));
  fakeScript = path.join(tmpDir, 'fake-tmux.sh');
  argvLog = path.join(tmpDir, 'argv.log');

  // Write the fake tmux script.
  // - Logs all argv to argvLog (one invocation per line, args space-joined).
  // - Always prints "fakesess:7" (what new-window / new-session -P -F would print).
  fs.writeFileSync(
    fakeScript,
    [
      '#!/bin/sh',
      // Append argv as a space-separated line (skip argv[0] which is the script path).
      `echo "$@" >> "${argvLog}"`,
      // For new-window and new-session, print the fake target.
      'echo "fakesess:7"',
    ].join('\n') + '\n',
  );
  fs.chmodSync(fakeScript, 0o755);

  // Point COCKPIT_TMUX at the fake script. resolveTmuxBin() will pick this up
  // on first call and cache it for the process lifetime.
  process.env.COCKPIT_TMUX = fakeScript;
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true });
  delete process.env.COCKPIT_TMUX;
});

// Helper: clear the argv log between tmux-exec tests so assertions are fresh.
function clearArgvLog() {
  if (fs.existsSync(argvLog)) fs.writeFileSync(argvLog, '');
}

function readArgvLog() {
  if (!fs.existsSync(argvLog)) return [];
  return fs
    .readFileSync(argvLog, 'utf8')
    .split('\n')
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Imports — after env setup (top-level await not needed; env set synchronously
// in before(), which runs before all tests).
// ---------------------------------------------------------------------------

// We import lazily using dynamic import to ensure COCKPIT_TMUX is already set
// (the before() callback fires before any test body, but the static imports
// at the top of the file are resolved before before() runs — dynamic import
// defers module evaluation to after the before() hook in node:test).
// However, _resolvedBin is only populated on first runTmux call, so even
// static import is fine here. We'll use dynamic import for clarity and safety.

let ClaudeAdapter;
let CodexAdapter;
let tmux;

before(async () => {
  // Dynamic imports happen after the synchronous before() env setup above.
  // Both before() hooks are registered and run in order before any test.
  ({ ClaudeAdapter } = await import('../lib/agents/claude.js'));
  ({ CodexAdapter } = await import('../lib/agents/codex.js'));
  tmux = await import('../lib/tmux.js');
});

// ---------------------------------------------------------------------------
// 1. ClaudeAdapter.buildSpawnCommand
// ---------------------------------------------------------------------------

test('ClaudeAdapter.buildSpawnCommand() defaults to {bin:"claude", args:[]}', () => {
  const result = ClaudeAdapter.buildSpawnCommand();
  assert.deepEqual(result, { bin: 'claude', args: [] });
});

test('ClaudeAdapter.buildSpawnCommand({bin:"claude"}) passes bin through', () => {
  const result = ClaudeAdapter.buildSpawnCommand({ bin: 'claude' });
  assert.deepEqual(result, { bin: 'claude', args: [] });
});

test('ClaudeAdapter.buildSpawnCommand({bin:"/custom/claude"}) overrides bin', () => {
  const result = ClaudeAdapter.buildSpawnCommand({ bin: '/custom/claude' });
  assert.deepEqual(result, { bin: '/custom/claude', args: [] });
});

test('ClaudeAdapter.buildSpawnCommand: args is always empty (ignores cwd)', () => {
  const result = ClaudeAdapter.buildSpawnCommand({ cwd: '/some/project', bin: 'claude' });
  assert.deepEqual(result.args, []);
});

// ---------------------------------------------------------------------------
// 2. CodexAdapter.buildSpawnCommand
// ---------------------------------------------------------------------------

test('CodexAdapter.buildSpawnCommand({cwd:"/abs/x"}) → {bin:"codex", args:["-C","/abs/x"]}', () => {
  const result = CodexAdapter.buildSpawnCommand({ cwd: '/abs/x' });
  assert.deepEqual(result, { bin: 'codex', args: ['-C', '/abs/x'] });
});

test('CodexAdapter.buildSpawnCommand({cwd:"/abs/x", bin:"/usr/local/bin/codex"}) overrides bin, keeps -C cwd', () => {
  const result = CodexAdapter.buildSpawnCommand({ cwd: '/abs/x', bin: '/usr/local/bin/codex' });
  assert.deepEqual(result, { bin: '/usr/local/bin/codex', args: ['-C', '/abs/x'] });
});

test('CodexAdapter.buildSpawnCommand() defaults bin to "codex"', () => {
  const result = CodexAdapter.buildSpawnCommand({ cwd: '/tmp/project' });
  assert.equal(result.bin, 'codex');
});

// ---------------------------------------------------------------------------
// 3. tmux.isValidName
// ---------------------------------------------------------------------------

test('isValidName: accepts "mysess"', () => {
  assert.equal(tmux.isValidName('mysess'), true);
});

test('isValidName: accepts "my-sess_1"', () => {
  assert.equal(tmux.isValidName('my-sess_1'), true);
});

test('isValidName: accepts single char "a"', () => {
  assert.equal(tmux.isValidName('a'), true);
});

test('isValidName: rejects empty string', () => {
  assert.equal(tmux.isValidName(''), false);
});

test('isValidName: rejects "bad.name" (dot disallowed)', () => {
  assert.equal(tmux.isValidName('bad.name'), false);
});

test('isValidName: rejects "bad:name" (colon disallowed)', () => {
  assert.equal(tmux.isValidName('bad:name'), false);
});

test('isValidName: rejects "bad name" (space disallowed)', () => {
  assert.equal(tmux.isValidName('bad name'), false);
});

test('isValidName: rejects "bad;rm" (semicolon metachar)', () => {
  assert.equal(tmux.isValidName('bad;rm'), false);
});

test('isValidName: rejects "$(x)" (dollar/parens)', () => {
  assert.equal(tmux.isValidName('$(x)'), false);
});

test('isValidName: rejects non-string (number)', () => {
  assert.equal(tmux.isValidName(42), false);
});

// ---------------------------------------------------------------------------
// 4. tmux.newWindow — with fake tmux binary
// ---------------------------------------------------------------------------

test('newWindow: returns the printed target from fake tmux', async () => {
  clearArgvLog();
  const result = await tmux.newWindow({
    session: 'mysess',
    cwd: '/tmp/myproject',
    bin: 'claude',
    args: [],
  });
  assert.equal(result, 'fakesess:7');
});

test('newWindow: passes -c <cwd> in argv (cwd never concatenated into a shell string)', async () => {
  clearArgvLog();
  await tmux.newWindow({
    session: 'mysess',
    cwd: '/tmp/myproject',
    bin: 'claude',
    args: [],
  });
  const lines = readArgvLog();
  // The first invocation is new-window, which must contain "-c /tmp/myproject".
  const newWindowLine = lines.find((l) => l.includes('new-window'));
  assert.ok(newWindowLine, 'Expected a new-window invocation in argv log');
  assert.ok(newWindowLine.includes('-c /tmp/myproject'), `Expected -c /tmp/myproject in: ${newWindowLine}`);
});

test('newWindow: does NOT contain "cd " in any argv line (no shell cd injection)', async () => {
  clearArgvLog();
  await tmux.newWindow({
    session: 'mysess',
    cwd: '/tmp/myproject',
    bin: 'claude',
    args: [],
  });
  const lines = readArgvLog();
  for (const line of lines) {
    assert.ok(!line.includes('cd '), `Found "cd " in argv line: ${line}`);
  }
});

test('newWindow: sends send-keys with -l (literal) for the command', async () => {
  clearArgvLog();
  await tmux.newWindow({
    session: 'testsess',
    cwd: '/home/user/proj',
    bin: 'claude',
    args: ['--flag'],
  });
  const lines = readArgvLog();
  const sendKeysLine = lines.find((l) => l.includes('send-keys') && l.includes('-l'));
  assert.ok(sendKeysLine, 'Expected a send-keys -l invocation');
  assert.ok(sendKeysLine.includes('claude --flag'), `Expected "claude --flag" in send-keys line: ${sendKeysLine}`);
});

test('newWindow: also sends Enter after the command', async () => {
  clearArgvLog();
  await tmux.newWindow({
    session: 'testsess',
    cwd: '/home/user/proj',
    bin: 'claude',
    args: [],
  });
  const lines = readArgvLog();
  const enterLine = lines.find((l) => l.includes('send-keys') && l.includes('Enter') && !l.includes('-l'));
  assert.ok(enterLine, 'Expected a send-keys Enter invocation');
});

test('newWindow: invalid session name rejects before any tmux call', async () => {
  clearArgvLog();
  await assert.rejects(
    () => tmux.newWindow({ session: 'bad.session', cwd: '/tmp', bin: 'claude' }),
    /Invalid tmux session\/window name/,
  );
  // No tmux invocation should have been logged.
  const lines = readArgvLog();
  assert.equal(lines.length, 0, `Expected no tmux calls, got: ${lines.join(' | ')}`);
});

test('newWindow: windowName is passed as -n flag when provided', async () => {
  clearArgvLog();
  await tmux.newWindow({
    session: 'mysess',
    cwd: '/tmp/proj',
    bin: 'claude',
    args: [],
    windowName: 'mywin',
  });
  const lines = readArgvLog();
  const newWindowLine = lines.find((l) => l.includes('new-window'));
  assert.ok(newWindowLine, 'Expected new-window call');
  assert.ok(newWindowLine.includes('-n mywin'), `Expected -n mywin in: ${newWindowLine}`);
});

// ---------------------------------------------------------------------------
// 5. tmux.newSession — with fake tmux binary
// ---------------------------------------------------------------------------

test('newSession: returns the printed target from fake tmux', async () => {
  clearArgvLog();
  const result = await tmux.newSession({
    name: 'myagent',
    cwd: '/tmp/agentdir',
    bin: 'codex',
    args: ['-C', '/tmp/agentdir'],
  });
  assert.equal(result, 'fakesess:7');
});

test('newSession: passes -c <cwd> in new-session argv', async () => {
  clearArgvLog();
  await tmux.newSession({
    name: 'myagent',
    cwd: '/tmp/agentdir',
    bin: 'codex',
    args: ['-C', '/tmp/agentdir'],
  });
  const lines = readArgvLog();
  const newSessionLine = lines.find((l) => l.includes('new-session'));
  assert.ok(newSessionLine, 'Expected a new-session invocation');
  assert.ok(newSessionLine.includes('-c /tmp/agentdir'), `Expected -c /tmp/agentdir in: ${newSessionLine}`);
});

test('newSession: uses -d (detached) flag', async () => {
  clearArgvLog();
  await tmux.newSession({
    name: 'detachme',
    cwd: '/tmp/x',
    bin: 'codex',
    args: [],
  });
  const lines = readArgvLog();
  const newSessionLine = lines.find((l) => l.includes('new-session'));
  assert.ok(newSessionLine, 'Expected a new-session invocation');
  assert.ok(newSessionLine.includes(' -d '), `Expected -d flag in: ${newSessionLine}`);
});

test('newSession: does NOT contain "cd " in any argv line', async () => {
  clearArgvLog();
  await tmux.newSession({
    name: 'cleantest',
    cwd: '/tmp/agentdir',
    bin: 'codex',
    args: ['-C', '/tmp/agentdir'],
  });
  const lines = readArgvLog();
  for (const line of lines) {
    assert.ok(!line.includes('cd '), `Found "cd " in argv line: ${line}`);
  }
});

test('newSession: invalid name rejects before any tmux call', async () => {
  clearArgvLog();
  await assert.rejects(
    () => tmux.newSession({ name: 'bad:session', cwd: '/tmp', bin: 'codex' }),
    /Invalid tmux session\/window name/,
  );
  const lines = readArgvLog();
  assert.equal(lines.length, 0, `Expected no tmux calls, got: ${lines.join(' | ')}`);
});

test('newSession: sends command via send-keys -l with args joined', async () => {
  clearArgvLog();
  await tmux.newSession({
    name: 'codexsess',
    cwd: '/my/project',
    bin: 'codex',
    args: ['-C', '/my/project'],
  });
  const lines = readArgvLog();
  const sendKeysLine = lines.find((l) => l.includes('send-keys') && l.includes('-l'));
  assert.ok(sendKeysLine, 'Expected a send-keys -l invocation');
  assert.ok(
    sendKeysLine.includes('codex -C /my/project'),
    `Expected "codex -C /my/project" in send-keys line: ${sendKeysLine}`,
  );
});
