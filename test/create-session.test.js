// Tests for named-session creation: name sanitization, default-name generation,
// shell quoting for the `--name` launch flag, and the tmux `new-window -n`
// naming semantics our reliable path depends on.
//
// The tmux integration test runs against an ISOLATED tmux server (its own
// `-L <socket>`), so it never touches the operator's live sessions, and uses a
// benign `cat` command (never a real `claude`). The server is killed in a
// finally block. It self-skips when no tmux binary is present.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

import { sanitizeName, defaultSessionName, shellQuoteName } from '../lib/tmux.js';

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

// ── tmux `new-window -n` naming (isolated server, benign command) ────────────
async function tmuxBin() {
  for (const p of ['/opt/homebrew/bin/tmux', '/usr/local/bin/tmux', '/usr/bin/tmux']) {
    try {
      await access(p, fsConstants.X_OK);
      return p;
    } catch {
      /* try next */
    }
  }
  return null;
}

test('tmux new-window -n names the window (the reliable rail path)', async (t) => {
  const bin = await tmuxBin();
  if (!bin) return t.skip('tmux not installed');

  const socket = `cc-test-${process.pid}-${Date.now().toString(36)}`;
  const L = ['-L', socket];
  const name = sanitizeName('my named session');

  try {
    // Isolated server: a detached session whose first window runs `cat` (a benign
    // long-lived no-op, NOT claude), named via -n exactly like createWindow does.
    await execFile(bin, [...L, 'new-session', '-d', '-s', 'box', '-n', name, 'cat']);

    const fmt = '#{window_name}\x1f#{pane_current_command}';
    const { stdout } = await execFile(bin, [...L, 'list-windows', '-a', '-F', fmt]);
    const [winName, paneCmd] = stdout.trim().split('\x1f');

    assert.equal(winName, name, 'window name should match the -n argument');
    assert.equal(paneCmd, 'cat', 'benign test command should be running, not claude');
  } finally {
    // Tear down the WHOLE isolated server — never touches the operator's tmux.
    await execFile(bin, [...L, 'kill-server']).catch(() => {});
  }
});
