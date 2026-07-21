// Tests for named-session creation: name sanitization, default-name generation,
// shell quoting for the `--name` launch flag, the tmux `new-window -n` naming
// semantics, and createWindow argv correctness.
//
// Hermetic cases (the majority) drive the REAL createWindow with a stub runner
// that records argv without shelling out — they pass with NO tmux installed.
//
// The one real-tmux smoke case (rename-window naming semantics) gates on the
// production resolveTmuxBin() so skip-semantics match the production resolver
// (honours CLAUDE_CONTROL_TMUX + `command -v`, not just three hardcoded paths).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';

import {
  sanitizeName,
  defaultSessionName,
  shellQuoteName,
  renameWindow,
  createWindow,
  resolveTmuxBin,
} from '../lib/tmux.js';

const execFile = promisify(_execFile);

// ── sanitizeName ───────────────────────────────────────────────────────────
test('sanitizeName strips control chars and newlines (send-keys safety)', () => {
  // A newline / CR / ESC must never survive — they could smuggle key events.
  assert.equal(sanitizeName('hi\nrm -rf /'), 'hi rm -rf /');
  assert.equal(sanitizeName('a\r\nb'), 'a b');
  assert.equal(sanitizeName('x\x1b[31my'), 'x [31my'); // ESC removed
  assert.equal(sanitizeName('tab\there'), 'tab here');
});

test('sanitizeName keeps spaces/punctuation and collapses whitespace', () => {
  assert.equal(sanitizeName('  my   session  '), 'my session');
  assert.equal(sanitizeName('feature/login-fix'), 'feature/login-fix');
});

test('sanitizeName caps length at 80 and handles empty input', () => {
  assert.equal(sanitizeName('a'.repeat(200)).length, 80);
  assert.equal(sanitizeName(''), '');
  assert.equal(sanitizeName(null), '');
  assert.equal(sanitizeName(undefined), '');
  assert.equal(sanitizeName('   '), '');
});

// ── defaultSessionName ───────────────────────────────────────────────────────
test('defaultSessionName is session-<short-ts> and varies over time', () => {
  assert.match(defaultSessionName(), /^session-[0-9a-z]{1,6}$/);
  const a = defaultSessionName(1_000_000_000_000);
  const b = defaultSessionName(1_000_000_001_000);
  assert.notEqual(a, b);
  assert.ok(a.startsWith('session-'));
});

// ── shellQuoteName ───────────────────────────────────────────────────────────
test('shellQuoteName single-quotes and escapes embedded single quotes', () => {
  assert.equal(shellQuoteName('my session'), `'my session'`);
  assert.equal(shellQuoteName("it's"), `'it'\\''s'`);
  // No shell metacharacter can break out of the single-quoted span.
  assert.equal(shellQuoteName('a; rm -rf /'), `'a; rm -rf /'`);
  assert.equal(shellQuoteName('$(touch pwned)'), `'$(touch pwned)'`);
});

// ── renameWindow target validation (no tmux contact) ────────────────────────
test('renameWindow rejects a syntactically invalid target before touching tmux', async () => {
  // assertTarget throws synchronously-in-promise; an invalid target must never
  // reach a `rename-window` call (which would otherwise hit the live server).
  await assert.rejects(
    () => renameWindow('not a target', 'x'),
    /Invalid tmux target/,
  );
});

// ── Stub runner helper ───────────────────────────────────────────────────────

/**
 * Build a pair of stubs for `createWindow`'s `_run` / `_listPanes` seam.
 *
 * `listCalls` — what `_listPanes` returns on the first call (simulates an
 * existing session) and the second call (simulates the post-create list).
 *
 * Returns `{ _run, _listPanes, calls }` where `calls` is an array of every
 * argv array passed to `_run`.
 */
function makeStubs({ listCalls = [[], [{ sessionName: 'claude-control', target: 'claude-control:0.0', windowIndex: 0 }]] } = {}) {
  const calls = [];
  let listIdx = 0;

  async function _run(args) {
    calls.push([...args]);
    // new-window returns the target via -P -F; new-session returns nothing.
    // If this is a new-window call, return a canned target matching the session
    // in the second listCalls entry so the caller can verify the round-trip.
    const isNewWindow = args[0] === 'new-window';
    return { stdout: isNewWindow ? 'claude-control:1\n' : '', stderr: '' };
  }

  async function _listPanes() {
    return listCalls[listIdx++] ?? [];
  }

  return { _run, _listPanes, calls };
}

// ── createWindow — hermetic stub cases ──────────────────────────────────────
//
// These run with NO tmux installed. Each assertion on `calls` verifies the
// ACTUAL argv that createWindow would pass to tmux — a wrong target, cwd, or
// flag would fail the test.

test('createWindow (no existing session) emits new-session with correct argv', async () => {
  // First _listPanes call: empty → no server. Second: post-create list.
  const secondList = [{ sessionName: 'claude-control', target: 'claude-control:0.0', windowIndex: 0 }];
  const { _run, _listPanes, calls } = makeStubs({ listCalls: [[], secondList] });

  const target = await createWindow({ cwd: os.tmpdir(), name: 'my session' }, { _run, _listPanes });

  // Must have called new-session exactly once with the right args.
  assert.equal(calls.length, 1, 'exactly one tmux call in no-server path');
  const [cmd, ...argv] = calls[0];
  assert.equal(cmd, 'new-session', 'first call is new-session');
  assert.ok(argv.includes('-d'), 'detached flag present');
  assert.ok(argv.includes('-s'), '-s flag present');
  assert.equal(argv[argv.indexOf('-s') + 1], 'claude-control', 'session named claude-control');
  assert.ok(argv.includes('-c'), '-c flag present');
  assert.equal(argv[argv.indexOf('-c') + 1], os.tmpdir(), 'cwd passed to new-session');
  assert.ok(argv.includes('-n'), '-n flag present');
  assert.equal(argv[argv.indexOf('-n') + 1], 'my session', 'window name passed to new-session');

  // Target comes from the second _listPanes call (post-create).
  assert.equal(target, 'claude-control:0.0', 'target from post-create list');
});

test('createWindow (no existing session, no name) omits -n flag', async () => {
  const secondList = [{ sessionName: 'claude-control', target: 'claude-control:0.0', windowIndex: 0 }];
  const { _run, _listPanes, calls } = makeStubs({ listCalls: [[], secondList] });

  await createWindow({ cwd: os.tmpdir() }, { _run, _listPanes });

  const [, ...argv] = calls[0];
  assert.ok(!argv.includes('-n'), '-n must be absent when no name supplied');
});

test('createWindow (existing session) emits new-window with correct argv', async () => {
  // First _listPanes: existing session present → skip new-session path.
  const existingPanes = [{ sessionName: 'work', target: 'work:0.0', windowIndex: 0 }];
  const { _run, _listPanes, calls } = makeStubs({ listCalls: [existingPanes] });

  const target = await createWindow({ cwd: os.tmpdir(), name: 'feat' }, { _run, _listPanes });

  assert.equal(calls.length, 1, 'exactly one tmux call in existing-session path');
  const [cmd, ...argv] = calls[0];
  assert.equal(cmd, 'new-window', 'first call is new-window');
  assert.ok(argv.includes('-t'), '-t flag present');
  assert.equal(argv[argv.indexOf('-t') + 1], 'work:', 'targets first existing session unambiguously');
  assert.ok(argv.includes('-P'), '-P (print) flag present');
  assert.ok(argv.includes('-F'), '-F flag present');
  assert.equal(argv[argv.indexOf('-F') + 1], '#{session_name}:#{window_index}', 'format string correct');
  assert.ok(argv.includes('-c'), '-c flag present');
  assert.equal(argv[argv.indexOf('-c') + 1], os.tmpdir(), 'cwd passed to new-window');
  assert.ok(argv.includes('-n'), '-n flag present');
  assert.equal(argv[argv.indexOf('-n') + 1], 'feat', 'window name passed to new-window');

  // Target comes from stdout of the stub runner ("claude-control:1\n").
  assert.equal(target, 'claude-control:1', 'target parsed from new-window stdout');
});

test('createWindow (existing session, no name) omits -n flag', async () => {
  const existingPanes = [{ sessionName: 'work', target: 'work:0.0', windowIndex: 0 }];
  const { _run, _listPanes, calls } = makeStubs({ listCalls: [existingPanes] });

  await createWindow({ cwd: os.tmpdir() }, { _run, _listPanes });

  const [, ...argv] = calls[0];
  assert.ok(!argv.includes('-n'), '-n must be absent when no name supplied');
});

test('createWindow (numeric session name) disambiguates session target with trailing colon', async () => {
  const existingPanes = [{ sessionName: '0', target: '0:1.0', windowIndex: 1 }];
  const { _run, _listPanes, calls } = makeStubs({ listCalls: [existingPanes] });

  await createWindow({ cwd: os.tmpdir(), name: 'feat' }, { _run, _listPanes });

  const [, ...argv] = calls[0];
  assert.equal(argv[argv.indexOf('-t') + 1], '0:', 'numeric session name must not be parsed as window index 0');
});

test('createWindow rejects missing cwd without calling tmux', async () => {
  const { _run, _listPanes, calls } = makeStubs();

  await assert.rejects(
    () => createWindow({ cwd: '' }, { _run, _listPanes }),
    /cwd is required/,
  );
  assert.equal(calls.length, 0, 'tmux must not be called when cwd is missing');
});

test('createWindow rejects non-existent cwd without calling tmux', async () => {
  const { _run, _listPanes, calls } = makeStubs();

  await assert.rejects(
    () => createWindow({ cwd: '/nonexistent/__cc_test__' }, { _run, _listPanes }),
    /cwd does not exist/,
  );
  assert.equal(calls.length, 0, 'tmux must not be called when cwd is missing');
});

test('createWindow sanitizes the name before passing it to tmux', async () => {
  const secondList = [{ sessionName: 'claude-control', target: 'claude-control:0.0', windowIndex: 0 }];
  const { _run, _listPanes, calls } = makeStubs({ listCalls: [[], secondList] });

  // Inject a name with a newline — must never reach tmux raw.
  await createWindow({ cwd: os.tmpdir(), name: 'bad\nname' }, { _run, _listPanes });

  const [, ...argv] = calls[0];
  const nameIdx = argv.indexOf('-n');
  assert.ok(nameIdx !== -1, '-n flag present');
  const passedName = argv[nameIdx + 1];
  assert.ok(!passedName.includes('\n'), 'newline must not reach tmux argv');
  assert.equal(passedName, 'bad name', 'sanitized name passed to tmux');
});

// ── Real-tmux smoke case — gated on production resolveTmuxBin ───────────────
//
// Uses an isolated tmux server so it never touches the operator's live sessions.
// Gates on the same resolveTmuxBin() the production code uses, so skip-semantics
// are identical (honours CLAUDE_CONTROL_TMUX + `command -v`, not just three paths).

test('tmux rename-window renames the window (real tmux smoke, production gating)', async (t) => {
  // Local-dev smoke only. CI is hermetic: createWindow's argv is fully covered by
  // the stub-runner tests above, and live-tmux naming (automatic-rename, list
  // format separators) varies by tmux version/config, so this would flake on the
  // runner. Skip when CI is set.
  if (process.env.CI) {
    return t.skip('real-tmux smoke skipped in CI (hermetic stub tests cover createWindow)');
  }
  let bin;
  try {
    bin = await resolveTmuxBin();
  } catch {
    return t.skip('tmux not available (resolveTmuxBin threw)');
  }

  const socket = `cc-test-${process.pid}-${Date.now().toString(36)}-rn`;
  const L = ['-L', socket];
  const before = sanitizeName('before name');
  const after = sanitizeName('after name');

  try {
    // Isolated server: a detached window running `cat` (benign, NOT claude).
    // ENOENT here means CLAUDE_CONTROL_TMUX points at a non-existent binary — skip.
    let bootResult;
    try {
      bootResult = await execFile(bin, [...L, 'new-session', '-d', '-s', 'box', '-n', before, 'cat']);
    } catch (err) {
      if (err.code === 'ENOENT') return t.skip(`tmux binary not executable: ${bin}`);
      throw err;
    }

    // Resolve the real target — tmux base-index may not be 0, so we read it back
    // from the server rather than assuming "box:0".
    const idxFmt = '#{session_name}:#{window_index}';
    const { stdout: tgtOut } = await execFile(bin, [...L, 'list-windows', '-a', '-F', idxFmt]);
    const target = tgtOut.trim();

    // Mirror renameWindow's exact argv shape: rename-window -t <target> -- <name>.
    await execFile(bin, [...L, 'rename-window', '-t', target, '--', after]);

    const fmt = '#{window_name}\x1f#{pane_current_command}';
    const { stdout } = await execFile(bin, [...L, 'list-windows', '-a', '-F', fmt]);
    const [winName, paneCmd] = stdout.trim().split('\x1f');

    assert.equal(winName, after, 'window name should reflect the rename');
    assert.equal(paneCmd, 'cat', 'benign test command should still be running, not claude');
  } finally {
    // Tear down the WHOLE isolated server — never touches the operator's tmux.
    await execFile(bin, [...L, 'kill-server']).catch(() => {});
  }
});
