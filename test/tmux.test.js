// Tests for the capturePane bearer-path redaction seam (design T8).
//
// Claudex sessions carry ANTHROPIC_BASE_URL=https://<host>/auth/<sub>/<secret>;
// if that URL is ever echoed into a pane, capturePane must redact the sub +
// secret segments before the text reaches LivePane/transcript/remote viewers.
//
// Hermetic — drives the real capturePane with a stub runner that returns
// canned pane text; passes with NO tmux installed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';

import {
  capturePane,
  redactBearerPaths,
  createWindow,
  createTmuxSession,
  createWindowInSession,
  assertTmuxSupportsEnv,
} from '../lib/tmux.js';

/** Stub runner returning fixed pane text (ignores argv). */
function stubRunner(stdout) {
  return async () => ({ stdout, stderr: '' });
}

// ── redactBearerPaths (pure helper) ─────────────────────────────────────────

describe('redactBearerPaths', () => {
  test('full URL: sub+secret redacted, suffix preserved', () => {
    const input = 'ANTHROPIC_BASE_URL=https://auth.example.com/auth/user-1/sekret42/v1/messages';
    assert.equal(
      redactBearerPaths(input),
      'ANTHROPIC_BASE_URL=https://auth.example.com/auth/<redacted>/<redacted>/v1/messages',
    );
  });

  test('bare path (no scheme/host) is redacted too', () => {
    assert.equal(
      redactBearerPaths('GET /auth/user-1/sekret42/v1/models 200'),
      'GET /auth/<redacted>/<redacted>/v1/models 200',
    );
  });

  test('multiple occurrences are all redacted (global)', () => {
    const input = [
      'first: https://h1/auth/alice/topsecret/v1/messages',
      'second: /auth/bob/hunter2',
      'third: https://h2/auth/carol/pw!x/v1/models',
    ].join('\n');
    assert.equal(
      redactBearerPaths(input),
      [
        'first: https://h1/auth/<redacted>/<redacted>/v1/messages',
        'second: /auth/<redacted>/<redacted>',
        'third: https://h2/auth/<redacted>/<redacted>/v1/models',
      ].join('\n'),
    );
  });

  test('ANSI escapes in SURROUNDING text still redact the plain path', () => {
    // Escapes interleave around the URL, not inside the /auth/<seg>/<seg>
    // segments themselves. Escapes INSIDE the segments would split the shape
    // and are a documented known-limit (Phase C verifies CC echo behavior).
    const input = '\x1b[32mcurl\x1b[0m \x1b[4mhttps://host/auth/user-1/sekret42/v1/messages\x1b[24m \x1b[31mdone\x1b[0m';
    assert.equal(
      redactBearerPaths(input),
      '\x1b[32mcurl\x1b[0m \x1b[4mhttps://host/auth/<redacted>/<redacted>/v1/messages\x1b[24m \x1b[31mdone\x1b[0m',
    );
  });

  test('negative: /authors/x/y is NOT touched (auth must be a whole segment)', () => {
    const input = 'see /authors/x/y for the list';
    assert.equal(redactBearerPaths(input), input);
  });

  test('negative: /auth/only-one-seg (no second segment) is NOT touched', () => {
    const input = 'path /auth/only-one-seg end';
    assert.equal(redactBearerPaths(input), input);
    // Also at end-of-string with no trailing text.
    assert.equal(redactBearerPaths('/auth/only-one-seg'), '/auth/only-one-seg');
  });

  test('plain text without the shape is byte-identical', () => {
    const input = 'just a normal pane\nwith some /paths/and/things\nand auth mentioned alone';
    assert.equal(redactBearerPaths(input), input);
  });

  test('idempotent: redacted output passes through unchanged', () => {
    const once = redactBearerPaths('https://h/auth/a/b/v1/messages');
    assert.equal(redactBearerPaths(once), once);
  });

  test('non-string / empty input returned as-is', () => {
    assert.equal(redactBearerPaths(''), '');
    assert.equal(redactBearerPaths(undefined), undefined);
    assert.equal(redactBearerPaths(null), null);
  });
});

// ── capturePane applies redaction at the return seam ────────────────────────

describe('capturePane redaction seam', () => {
  test('default mode: captured bearer URL comes back redacted', async () => {
    const _run = stubRunner('$ echo https://host/auth/user-1/sekret42/v1/messages\n');
    const out = await capturePane('0:1.1', 40, false, false, { _run });
    assert.equal(out, '$ echo https://host/auth/<redacted>/<redacted>/v1/messages\n');
    assert.ok(!out.includes('sekret42'), 'secret must never survive capture');
    assert.ok(!out.includes('user-1'), 'sub must never survive capture');
  });

  test('escapes+join modes inherit the same redaction (single seam)', async () => {
    const _run = stubRunner('\x1b[33m$\x1b[0m https://host/auth/user-1/sekret42/v1/models ok');
    const out = await capturePane('0:1.1', 40, true, true, { _run });
    assert.equal(out, '\x1b[33m$\x1b[0m https://host/auth/<redacted>/<redacted>/v1/models ok');
  });

  test('visibleOnly mode inherits the redaction', async () => {
    const _run = stubRunner('/auth/bob/hunter2 plus /auth/one-seg untouched');
    const out = await capturePane('0:1.1', 40, false, false, { _run, visibleOnly: true });
    assert.equal(out, '/auth/<redacted>/<redacted> plus /auth/one-seg untouched');
  });

  test('pane text without the shape is byte-identical through capturePane', async () => {
    const text = 'plain pane\n❯ 1. option one\n  2. option two\n/authors/x/y\n';
    const _run = stubRunner(text);
    const out = await capturePane('0:1.1', 40, false, false, { _run });
    assert.equal(out, text);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B2 (design T3): tmux env injection — the optional `env` option on
// createWindow / createTmuxSession / createWindowInSession emitted as
// `-e KEY=VALUE` argv pairs (tmux >= 3.2) — plus the assertTmuxSupportsEnv
// version preflight. Hermetic: stub _run/_listPanes record argv without
// shelling out (same pattern as tmux-session-target.test.js).
//
// The bearer-URL secret travels ONLY as a single execFile argv entry — never
// through a shell, a typed launch string, or a log. These tests pin the exact
// argv arrays so any drift (quoting, re-ordering, echo) fails loudly.
// ═══════════════════════════════════════════════════════════════════════════

const CWD = os.tmpdir();

/** Stub runner that records every argv array and replies with canned stdout. */
function makeRun(stdoutByCmd = {}) {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: stdoutByCmd[args[0]] ?? '', stderr: '' };
  }
  return { calls, _run };
}

// ── createWindow ────────────────────────────────────────────────────────────

describe('createWindow env injection', () => {
  test('bootstrap path (no server → new-session) inserts one -e per env entry', async () => {
    const { calls, _run } = makeRun();
    let listCall = 0;
    async function _listPanes() {
      listCall += 1;
      if (listCall === 1) return []; // no server yet → cold-start bootstrap
      return [{ sessionName: 'claude-control', target: 'claude-control:0', windowIndex: 0 }];
    }

    const target = await createWindow(
      { cwd: CWD, name: 'claudex', env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s', FOO: 'bar' } },
      { _run, _listPanes },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'new-session', '-d', '-s', 'claude-control', '-c', CWD,
      '-e', 'ANTHROPIC_BASE_URL=https://h/auth/u/s',
      '-e', 'FOO=bar',
      '-n', 'claudex',
    ]);
    assert.equal(target, 'claude-control:0');
  });

  test('bootstrap path WITHOUT env is byte-identical to today', async () => {
    const { calls, _run } = makeRun();
    let listCall = 0;
    async function _listPanes() {
      listCall += 1;
      if (listCall === 1) return [];
      return [{ sessionName: 'claude-control', target: 'claude-control:0', windowIndex: 0 }];
    }

    await createWindow({ cwd: CWD, name: 'plain' }, { _run, _listPanes });

    assert.deepEqual(calls[0], [
      'new-session', '-d', '-s', 'claude-control', '-c', CWD, '-n', 'plain',
    ]);
  });

  test('existing-server path (new-window) inserts -e pairs before -n', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:3\n' });
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }

    const target = await createWindow(
      { cwd: CWD, name: 'claudex', env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s' } },
      { _run, _listPanes },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'new-window',
      '-t', 'work:',
      '-P',
      '-F', '#{session_name}:#{window_index}',
      '-c', CWD,
      '-e', 'ANTHROPIC_BASE_URL=https://h/auth/u/s',
      '-n', 'claudex',
    ]);
    assert.equal(target, 'work:3');
  });

  test('existing-server path WITHOUT env is byte-identical to today', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:3\n' });
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }

    await createWindow({ cwd: CWD, name: 'plain' }, { _run, _listPanes });

    assert.deepEqual(calls[0], [
      'new-window',
      '-t', 'work:',
      '-P',
      '-F', '#{session_name}:#{window_index}',
      '-c', CWD,
      '-n', 'plain',
    ]);
  });

  test('empty env object emits no -e (byte-identical)', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:3\n' });
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }

    await createWindow({ cwd: CWD, env: {} }, { _run, _listPanes });

    assert.deepEqual(calls[0], [
      'new-window',
      '-t', 'work:',
      '-P',
      '-F', '#{session_name}:#{window_index}',
      '-c', CWD,
    ]);
    assert.ok(!calls[0].includes('-e'));
  });

  test('a value with spaces/shell metacharacters stays ONE argv entry, unquoted', async () => {
    // T3: execFile argv is the whole transport — no shell ever sees the value,
    // so no quoting may be added and the value must not be split.
    const { calls, _run } = makeRun({ 'new-window': 'work:3\n' });
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }
    const gnarly = 'https://h/auth/u 1/s;$(rm -rf)&`x`';

    await createWindow({ cwd: CWD, env: { ANTHROPIC_BASE_URL: gnarly } }, { _run, _listPanes });

    const argv = calls[0];
    const i = argv.indexOf('-e');
    assert.ok(i !== -1);
    assert.equal(argv[i + 1], `ANTHROPIC_BASE_URL=${gnarly}`);
    // Exactly one -e for exactly one entry — the value was not split on spaces.
    assert.equal(argv.filter((a) => a === '-e').length, 1);
  });

  test('rejects an env key that is not identifier-shaped, without calling tmux', async () => {
    const { calls, _run } = makeRun();
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }

    await assert.rejects(
      () => createWindow({ cwd: CWD, env: { 'BAD=KEY': 'v' } }, { _run, _listPanes }),
      /invalid env var name/,
    );
    assert.equal(calls.length, 0, 'tmux must not be called with a corrupt KEY=VALUE split');
  });
});

// ── createTmuxSession ───────────────────────────────────────────────────────

describe('createTmuxSession env injection', () => {
  test('inserts -e KEY=VALUE pairs into new-session args', async () => {
    const { calls, _run } = makeRun();
    async function _listPanes() {
      return [{ sessionName: 'sess', target: 'sess:0', windowIndex: 0 }];
    }

    const target = await createTmuxSession(
      { name: 'sess', cwd: CWD, env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s', A: '1' } },
      { _run, _listPanes },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'new-session', '-d', '-s', 'sess', '-c', CWD,
      '-e', 'ANTHROPIC_BASE_URL=https://h/auth/u/s',
      '-e', 'A=1',
    ]);
    assert.equal(target, 'sess:0');
  });

  test('WITHOUT env the args are byte-identical to today', async () => {
    const { calls, _run } = makeRun();
    async function _listPanes() {
      return [{ sessionName: 'sess', target: 'sess:0', windowIndex: 0 }];
    }

    await createTmuxSession({ name: 'sess', cwd: CWD }, { _run, _listPanes });

    assert.deepEqual(calls[0], ['new-session', '-d', '-s', 'sess', '-c', CWD]);
  });
});

// ── createWindowInSession ───────────────────────────────────────────────────

describe('createWindowInSession env injection', () => {
  test('inserts -e KEY=VALUE pairs into new-window args (before -n)', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:5\n' });

    const target = await createWindowInSession(
      { sessionName: 'work', cwd: CWD, name: 'claudex', env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s' } },
      { _run },
    );

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], [
      'new-window',
      '-t', 'work:',
      '-P',
      '-F', '#{session_name}:#{window_index}',
      '-c', CWD,
      '-e', 'ANTHROPIC_BASE_URL=https://h/auth/u/s',
      '-n', 'claudex',
    ]);
    assert.equal(target, 'work:5');
  });

  test('WITHOUT env the args are byte-identical to today', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:5\n' });

    await createWindowInSession({ sessionName: 'work', cwd: CWD, name: 'feat' }, { _run });

    assert.deepEqual(calls[0], [
      'new-window',
      '-t', 'work:',
      '-P',
      '-F', '#{session_name}:#{window_index}',
      '-c', CWD,
      '-n', 'feat',
    ]);
  });
});

// ── assertTmuxSupportsEnv (tmux -V preflight) ───────────────────────────────

describe('assertTmuxSupportsEnv', () => {
  function versionRun(stdout) {
    const calls = [];
    async function _run(args) {
      calls.push([...args]);
      return { stdout, stderr: '' };
    }
    return { calls, _run };
  }

  test('runs exactly `tmux -V`', async () => {
    const { calls, _run } = versionRun('tmux 3.6a\n');
    await assertTmuxSupportsEnv({ _run });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], ['-V']);
  });

  test('accepts 3.2 (the minimum — new-session -e landed here)', async () => {
    const { _run } = versionRun('tmux 3.2\n');
    await assertTmuxSupportsEnv({ _run });
  });

  test('accepts 3.6a (suffix letter ignored)', async () => {
    const { _run } = versionRun('tmux 3.6a\n');
    await assertTmuxSupportsEnv({ _run });
  });

  test('accepts next-3.7 (dev-build prefix ignored)', async () => {
    const { _run } = versionRun('tmux next-3.7\n');
    await assertTmuxSupportsEnv({ _run });
  });

  test('accepts a future major (4.0)', async () => {
    const { _run } = versionRun('tmux 4.0\n');
    await assertTmuxSupportsEnv({ _run });
  });

  test('rejects 3.1 with the actionable message', async () => {
    const { _run } = versionRun('tmux 3.1b\n');
    await assert.rejects(
      () => assertTmuxSupportsEnv({ _run }),
      /tmux >= 3\.2 required for claudex env injection \(new-session -e\); found 3\.1 — brew upgrade tmux/,
    );
  });

  test('rejects 2.9 with the actionable message', async () => {
    const { _run } = versionRun('tmux 2.9a\n');
    await assert.rejects(
      () => assertTmuxSupportsEnv({ _run }),
      /tmux >= 3\.2 required for claudex env injection \(new-session -e\); found 2\.9 — brew upgrade tmux/,
    );
  });

  test('rejects unparseable version output descriptively', async () => {
    const { _run } = versionRun('tmux weird-build\n');
    await assert.rejects(
      () => assertTmuxSupportsEnv({ _run }),
      /could not parse tmux version .* tmux >= 3\.2 required/,
    );
  });

  test('rejects when tmux -V itself fails', async () => {
    async function _run() {
      throw new Error('spawn tmux ENOENT');
    }
    await assert.rejects(
      () => assertTmuxSupportsEnv({ _run }),
      /tmux -V failed .* spawn tmux ENOENT/,
    );
  });
});
