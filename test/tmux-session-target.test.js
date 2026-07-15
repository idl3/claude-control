// Tests for the tmux-target picker's server-side helpers: listSessions,
// createTmuxSession ("New tmux session…"), and createWindowInSession (host in
// an existing session). Same hermetic pattern as create-session.test.js: a
// stub _run/_listPanes records argv without shelling out to tmux, so these
// pass with NO tmux installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import {
  listSessions,
  createTmuxSession,
  createWindowInSession,
  resolveTmuxBin,
} from '../lib/tmux.js';

const execFile = promisify(_execFile);

// ── listSessions ─────────────────────────────────────────────────────────

test('listSessions parses name + window count from list-sessions -F output', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: 'work\x1f3\nclaude-control\x1f1\n', stderr: '' };
  }

  const sessions = await listSessions({ _run });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['list-sessions', '-F', '#{session_name}\x1f#{session_windows}']);
  assert.deepEqual(sessions, [
    { name: 'work', windows: 3 },
    { name: 'claude-control', windows: 1 },
  ]);
});

test('listSessions returns [] when no tmux server is running', async () => {
  async function _run() {
    const err = new Error('no server running on /tmp/tmux-501/default');
    err.code = 1;
    throw err;
  }

  const sessions = await listSessions({ _run });
  assert.deepEqual(sessions, []);
});

test('listSessions rethrows unexpected errors', async () => {
  async function _run() {
    throw new Error('some other tmux failure');
  }

  await assert.rejects(() => listSessions({ _run }), /some other tmux failure/);
});

// ── createTmuxSession ────────────────────────────────────────────────────

test('createTmuxSession emits new-session -d -s <name> -c <cwd>', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listPanes() {
    return [{ sessionName: 'my new session', target: 'my new session:0', windowIndex: 0 }];
  }

  const target = await createTmuxSession(
    { name: 'my new session', cwd: os.tmpdir() },
    { _run, _listPanes },
  );

  assert.equal(calls.length, 1);
  const [cmd, ...argv] = calls[0];
  assert.equal(cmd, 'new-session');
  assert.ok(argv.includes('-d'));
  assert.equal(argv[argv.indexOf('-s') + 1], 'my new session');
  assert.equal(argv[argv.indexOf('-c') + 1], os.tmpdir());
  assert.equal(target, 'my new session:0');
});

test('createTmuxSession rejects a blank/whitespace-only name without calling tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }

  await assert.rejects(
    () => createTmuxSession({ name: '   ', cwd: os.tmpdir() }, { _run, _listPanes: async () => [] }),
    /name is required/,
  );
  assert.equal(calls.length, 0, 'tmux must not be called when the name sanitizes to empty');
});

test('createTmuxSession rejects missing/nonexistent cwd without calling tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }

  await assert.rejects(
    () => createTmuxSession({ name: 'x', cwd: '/nonexistent/__cc_test__' }, { _run, _listPanes: async () => [] }),
    /cwd does not exist/,
  );
  assert.equal(calls.length, 0);
});

test('createTmuxSession sanitizes the name before passing it to tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listPanes() {
    return [{ sessionName: 'bad name', target: 'bad name:0', windowIndex: 0 }];
  }

  await createTmuxSession({ name: 'bad\nname', cwd: os.tmpdir() }, { _run, _listPanes });

  const [, ...argv] = calls[0];
  const passedName = argv[argv.indexOf('-s') + 1];
  assert.ok(!passedName.includes('\n'));
  assert.equal(passedName, 'bad name');
});

// ── createWindowInSession ────────────────────────────────────────────────

test('createWindowInSession emits new-window -t <session>: with -n and -c', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: 'work:2\n', stderr: '' };
  }

  const target = await createWindowInSession(
    { sessionName: 'work', cwd: os.tmpdir(), name: 'feat' },
    { _run },
  );

  assert.equal(calls.length, 1);
  const [cmd, ...argv] = calls[0];
  assert.equal(cmd, 'new-window');
  assert.equal(argv[argv.indexOf('-t') + 1], 'work:', 'targets the given session unambiguously');
  assert.equal(argv[argv.indexOf('-c') + 1], os.tmpdir());
  assert.equal(argv[argv.indexOf('-n') + 1], 'feat');
  assert.equal(target, 'work:2');
});

test('createWindowInSession (no name) omits -n flag', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: 'work:2\n', stderr: '' };
  }

  await createWindowInSession({ sessionName: 'work', cwd: os.tmpdir() }, { _run });

  const [, ...argv] = calls[0];
  assert.ok(!argv.includes('-n'));
});

test('createWindowInSession disambiguates a numeric session name with a trailing colon', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '0:2\n', stderr: '' };
  }

  await createWindowInSession({ sessionName: '0', cwd: os.tmpdir() }, { _run });

  const [, ...argv] = calls[0];
  assert.equal(argv[argv.indexOf('-t') + 1], '0:');
});

test('createWindowInSession rejects a missing sessionName without calling tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }

  await assert.rejects(
    () => createWindowInSession({ cwd: os.tmpdir() }, { _run }),
    /sessionName is required/,
  );
  assert.equal(calls.length, 0);
});

test('createWindowInSession rejects nonexistent cwd without calling tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }

  await assert.rejects(
    () => createWindowInSession({ sessionName: 'work', cwd: '/nonexistent/__cc_test__' }, { _run }),
    /cwd does not exist/,
  );
  assert.equal(calls.length, 0);
});

// ── Real-tmux smoke case — gated on production resolveTmuxBin, isolated socket
//
// Proves listSessions / createTmuxSession / createWindowInSession work against
// a real tmux server, entirely on a throwaway isolated socket — never touches
// the operator's default-socket sessions. Mirrors the pattern + gating in
// create-session.test.js's rename-window smoke case.

test('listSessions + createTmuxSession + createWindowInSession round-trip on a real, isolated tmux server', async (t) => {
  if (process.env.CI) {
    return t.skip('real-tmux smoke skipped in CI (hermetic stub tests above cover argv)');
  }
  let bin;
  try {
    bin = await resolveTmuxBin();
  } catch {
    return t.skip('tmux not available (resolveTmuxBin threw)');
  }

  const socket = `cc-test-${process.pid}-${Date.now().toString(36)}-tt`;
  const L = ['-L', socket];
  const sessionName = `cc-throwaway-${process.pid}-${Date.now().toString(36)}`;
  // _run seam that shells out on the isolated socket instead of the default one.
  const _run = async (args) => execFile(bin, [...L, ...args]);

  try {
    // Empty isolated server → listSessions must report [], not throw.
    assert.deepEqual(await listSessions({ _run }), []);

    const created = await createTmuxSession({ name: sessionName, cwd: os.tmpdir() }, { _run });
    assert.match(created, new RegExp(`^${sessionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+$`));

    const sessions = await listSessions({ _run });
    assert.equal(sessions.length, 1);
    assert.equal(sessions[0].name, sessionName);
    assert.equal(sessions[0].windows, 1);

    const windowTarget = await createWindowInSession({ sessionName, cwd: os.tmpdir(), name: 'second' }, { _run });
    assert.match(windowTarget, new RegExp(`^${sessionName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\d+$`));

    const afterSessions = await listSessions({ _run });
    assert.equal(afterSessions.length, 1, 'still one session');
    assert.equal(afterSessions[0].windows, 2, 'now hosts two windows');
  } finally {
    // Tear down the WHOLE isolated server — never touches the operator's tmux.
    await execFile(bin, [...L, 'kill-server']).catch(() => {});
  }
});
