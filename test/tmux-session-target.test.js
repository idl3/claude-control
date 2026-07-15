// Tests for the tmux-target picker's server-side helpers: listSessions,
// createTmuxSession ("New tmux session…"), createWindowInSession (host in
// an existing session), and renameTmuxSession (sidebar session-group rename).
// Same hermetic pattern as create-session.test.js: a stub _run/_listPanes
// records argv without shelling out to tmux, so these pass with NO tmux installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import {
  listSessions,
  createTmuxSession,
  createWindowInSession,
  renameTmuxSession,
  resolveTmuxBin,
} from '../lib/tmux.js';

const execFile = promisify(_execFile);

// ── listSessions ─────────────────────────────────────────────────────────

test('listSessions parses name + window count from list-sessions -F output', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    // Old-format mock: only the original 2 fields, no group fields at all —
    // proves the tolerant parse still treats these as standalone sessions.
    return { stdout: 'work\x1f3\nclaude-control\x1f1\n', stderr: '' };
  }

  const sessions = await listSessions({ _run });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], [
    'list-sessions',
    '-F',
    '#{session_name}\x1f#{session_windows}\x1f#{session_group}\x1f#{session_grouped}\x1f#{session_group_size}\x1f#{session_attached}',
  ]);
  assert.deepEqual(sessions, [
    { name: 'work', windows: 3 },
    { name: 'claude-control', windows: 1 },
  ]);
});

test('listSessions collapses a tmux session GROUP into one representative entry', async () => {
  // Mirrors the real-world bug: 4 linked sessions (session_group="0",
  // session_grouped=1, session_group_size=4) sharing the same 20 windows,
  // plus 2 standalone sessions (session_group="", session_grouped=0).
  const rows = [
    ['0', '20', '0', '1', '4', '0'],
    ['_mobile', '20', '0', '1', '4', '0'],
    // Attached member is NOT alphabetically first — proves attached wins
    // over the alphabetical tie-break, not just "first in output".
    ['claude-control & olam', '20', '0', '1', '4', '1'],
    ['claude-control + olam-agent', '20', '0', '1', '4', '0'],
    ['cc_14517', '2', '', '0', '1', '0'],
    ['codex-audit', '2', '', '0', '1', '0'],
  ];
  const stdout = rows.map((r) => r.join('\x1f')).join('\n') + '\n';
  async function _run() {
    return { stdout, stderr: '' };
  }

  const sessions = await listSessions({ _run });

  assert.equal(sessions.length, 3);
  assert.deepEqual(sessions[0], {
    name: 'claude-control & olam',
    windows: 20,
    grouped: true,
    groupSize: 4,
  });
  assert.deepEqual(sessions[1], { name: 'cc_14517', windows: 2 });
  assert.deepEqual(sessions[2], { name: 'codex-audit', windows: 2 });
  assert.ok(!sessions[1].grouped);
  assert.ok(!sessions[2].grouped);
});

test('listSessions passes through unchanged when every row is ungrouped (full-format tolerant path)', async () => {
  // Guards the tolerant-parse path with the NEW, full-width format string
  // (all group fields present but every row reports grouped=0) — must
  // produce plain { name, windows } entries, no extra keys.
  const rows = [
    ['alpha', '5', '', '0', '1', '1'],
    ['beta', '1', '', '0', '1', '0'],
  ];
  const stdout = rows.map((r) => r.join('\x1f')).join('\n') + '\n';
  async function _run() {
    return { stdout, stderr: '' };
  }

  const sessions = await listSessions({ _run });

  assert.deepEqual(sessions, [
    { name: 'alpha', windows: 5 },
    { name: 'beta', windows: 1 },
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

// ── renameTmuxSession ────────────────────────────────────────────────────

test('renameTmuxSession emits rename-session -t <old> -- <new> when the session exists', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listSessions() {
    return [{ name: 'work', windows: 2 }, { name: '0', windows: 1 }];
  }

  await renameTmuxSession('0', 'scratch', { _run, _listSessions });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], ['rename-session', '-t', '0', '--', 'scratch']);
});

test('renameTmuxSession rejects an oldName that is not an existing session, without calling tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listSessions() {
    return [{ name: 'work', windows: 2 }];
  }

  await assert.rejects(
    () => renameTmuxSession('nope', 'scratch', { _run, _listSessions }),
    /no such tmux session/,
  );
  assert.equal(calls.length, 0);
});

test('renameTmuxSession rejects a newName that sanitizes to empty, without calling tmux', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listSessions() {
    return [{ name: 'work', windows: 2 }];
  }

  await assert.rejects(
    () => renameTmuxSession('work', '   ', { _run, _listSessions }),
    /newName is required/,
  );
  assert.equal(calls.length, 0);
});

test('renameTmuxSession rejects a missing oldName without calling tmux or listSessions', async () => {
  const runCalls = [];
  const listCalls = [];
  async function _run(args) {
    runCalls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listSessions() {
    listCalls.push(true);
    return [];
  }

  await assert.rejects(
    () => renameTmuxSession('', 'scratch', { _run, _listSessions }),
    /oldName is required/,
  );
  assert.equal(runCalls.length, 0);
});

test('renameTmuxSession sanitizes newName before passing it to tmux (send-keys / injection safety)', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: '', stderr: '' };
  }
  async function _listSessions() {
    return [{ name: 'work', windows: 2 }];
  }

  await renameTmuxSession('work', 'bad\nname', { _run, _listSessions });

  const [, , , , passedName] = calls[0];
  assert.ok(!passedName.includes('\n'));
  assert.equal(passedName, 'bad name');
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

test('renameTmuxSession renames a session on a real, isolated tmux server (sidebar session-group rename)', async (t) => {
  if (process.env.CI) {
    return t.skip('real-tmux smoke skipped in CI (hermetic stub tests above cover argv)');
  }
  let bin;
  try {
    bin = await resolveTmuxBin();
  } catch {
    return t.skip('tmux not available (resolveTmuxBin threw)');
  }

  const socket = `cc-test-${process.pid}-${Date.now().toString(36)}-rs`;
  const L = ['-L', socket];
  const before = `cc-throwaway-${process.pid}-${Date.now().toString(36)}`;
  const after = `cc-renamed-${process.pid}-${Date.now().toString(36)}`;
  // _run seam that shells out on the isolated socket instead of the default one.
  const _run = async (args) => execFile(bin, [...L, ...args]);

  try {
    await createTmuxSession({ name: before, cwd: os.tmpdir() }, { _run });

    // renameTmuxSession validates oldName against listSessions() internally —
    // must also point that lookup at the isolated socket, or it silently falls
    // back to the production listSessions() (default socket) and 404s.
    await renameTmuxSession(before, after, { _run, _listSessions: () => listSessions({ _run }) });

    const sessions = await listSessions({ _run });
    assert.equal(sessions.length, 1, 'still exactly one session — rename, not a duplicate');
    assert.equal(sessions[0].name, after, 'the session now answers to the new name');
    assert.ok(!sessions.some((s) => s.name === before), 'the old name no longer resolves');
  } finally {
    // Tear down the WHOLE isolated server — never touches the operator's tmux.
    await execFile(bin, [...L, 'kill-server']).catch(() => {});
  }
});
