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
  scrubEnvValuesFromError,
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
        // "third:" is ALSO redacted here — line 2's match lands exactly at
        // end-of-line, which is the Fix 4 newline-tolerant-wrap signal (see
        // the 'newline-tolerant wrap redaction' describe block below). This
        // is the accepted conservative trade-off, not a regression.
        '<redacted> https://h2/auth/<redacted>/<redacted>/v1/models',
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

// ── Fix 4: newline-tolerant redaction for hard-wrapped bearer URLs ──────────

describe('redactBearerPaths: newline-tolerant wrap redaction', () => {
  test('wrapped bearer URL split across two physical lines: both segments redacted', () => {
    // Simulates capture-pane WITHOUT -J: an 80-col wrap cuts the secret value
    // mid-string. Line 1's redacted match reaches line-end (no trailing
    // chars before \n) — that is the signal that triggers the line-2 redact.
    const input = 'https://host/auth/user-1/sekret4\n2abc extra-context-not-secret';
    assert.equal(
      redactBearerPaths(input),
      'https://host/auth/<redacted>/<redacted>\n<redacted> extra-context-not-secret',
    );
  });

  test('a redacted match with a trailing suffix (NOT at EOL) does not touch the next line', () => {
    const input = 'https://host/auth/user-1/sekret42/v1/messages\nunrelated line here';
    assert.equal(
      redactBearerPaths(input),
      'https://host/auth/<redacted>/<redacted>/v1/messages\nunrelated line here',
    );
  });

  test('conservative trade-off: a COMPLETE (non-wrapped) URL that ends a line also triggers next-line redaction', () => {
    // No way to distinguish this from a genuine wrap from text alone (see the
    // function doc comment) — this pins the accepted false-positive direction.
    const input = 'see /auth/bob/hunter2\nthird unrelated line';
    assert.equal(
      redactBearerPaths(input),
      'see /auth/<redacted>/<redacted>\n<redacted> unrelated line',
    );
  });

  test('no cascade past the immediate next line', () => {
    const input = '/auth/a/b\nsecondline\nthirdline';
    assert.equal(redactBearerPaths(input), '/auth/<redacted>/<redacted>\n<redacted>\nthirdline');
  });

  test('trailing newline / empty last line does not throw', () => {
    const input = '/auth/a/b\n';
    assert.equal(redactBearerPaths(input), '/auth/<redacted>/<redacted>\n');
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

    // CP3 Fix 2: the new-session -e call is followed by a set-environment -u
    // per key, unsetting the SESSION-scoped env right after create so later
    // windows in this session don't inherit it (full argv-order pin in the
    // dedicated 'createWindow: secret scrubbing + session-env unset' block).
    assert.equal(calls.length, 3);
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

    // CP3 Fix 2: the new-session -e call is followed by a set-environment -u
    // per key, unsetting the SESSION-scoped env right after create so later
    // windows in this session don't inherit it (see the dedicated
    // 'createTmuxSession: secret scrubbing + session-env unset' describe
    // block below for the full argv-order pin).
    assert.equal(calls.length, 3);
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

// ═══════════════════════════════════════════════════════════════════════════
// CP3 Fix 1 (HIGH): scrub secrets from tmux exec errors.
//
// Node's execFile rejection embeds the FULL argv verbatim in err.message —
// including a `-e ANTHROPIC_BASE_URL=https://…/auth/<sub>/<secret>` value.
// server.js's handleSessionNew catch returns `String(err?.message)` in a 500
// JSON body a remote viewer can read. scrubEnvValuesFromError (and its call
// sites in createWindow/createTmuxSession/createWindowInSession) must strip
// every env VALUE out of that message before it ever leaves lib/tmux.js.
// ═══════════════════════════════════════════════════════════════════════════

describe('scrubEnvValuesFromError (pure helper)', () => {
  test('replaces every occurrence of an env value with <redacted>', () => {
    const err = new Error('Command failed: tmux new-session -e ANTHROPIC_BASE_URL=https://host/auth/sub-1/sekret42 -c /tmp');
    const scrubbed = scrubEnvValuesFromError(err, { ANTHROPIC_BASE_URL: 'https://host/auth/sub-1/sekret42' });
    assert.ok(!scrubbed.message.includes('sekret42'), scrubbed.message);
    assert.ok(!scrubbed.message.includes('sub-1'), scrubbed.message);
    assert.ok(scrubbed.message.includes('<redacted>'), scrubbed.message);
    assert.ok(scrubbed.message.includes('Command failed: tmux new-session'), scrubbed.message);
  });

  test('scrubs multiple env values independently', () => {
    const err = new Error('argv: -e A=secretA -e B=secretB');
    const scrubbed = scrubEnvValuesFromError(err, { A: 'secretA', B: 'secretB' });
    assert.equal(scrubbed.message, 'argv: -e A=<redacted> -e B=<redacted>');
  });

  test('preserves err.code when present', () => {
    const err = new Error('boom');
    err.code = 'ENOENT';
    const scrubbed = scrubEnvValuesFromError(err, { A: 'x' });
    assert.equal(scrubbed.code, 'ENOENT');
  });

  test('null/empty env → message unchanged (still returns a fresh Error)', () => {
    const err = new Error('plain failure, no secrets');
    assert.equal(scrubEnvValuesFromError(err, null).message, 'plain failure, no secrets');
    assert.equal(scrubEnvValuesFromError(err, {}).message, 'plain failure, no secrets');
  });
});

describe('createWindow: secret scrubbing + session-env unset (CP3 Fix 1 + Fix 2)', () => {
  test('cold-start bootstrap: a tmux failure never leaks the secret value', async () => {
    const secret = 'https://host/auth/sub-1/sekret42';
    async function _listPanes() {
      return []; // no server → cold-start bootstrap
    }
    async function _run(args) {
      // Mirrors Node's real execFile rejection: the whole argv, incl. the
      // secret, embedded verbatim in the message.
      throw new Error(`Command failed: tmux ${args.join(' ')}`);
    }

    await assert.rejects(
      () => createWindow({ cwd: CWD, env: { ANTHROPIC_BASE_URL: secret } }, { _run, _listPanes }),
      (err) => {
        assert.ok(!err.message.includes('sekret42'), err.message);
        assert.ok(!err.message.includes('sub-1'), err.message);
        assert.ok(err.message.includes('<redacted>'), err.message);
        return true;
      },
    );
  });

  test('cold-start bootstrap: no env → a tmux failure is NOT scrubbed/wrapped (byte-identical)', async () => {
    async function _listPanes() {
      return [];
    }
    async function _run() {
      throw new Error('Command failed: tmux new-session -d -s claude-control');
    }

    await assert.rejects(
      () => createWindow({ cwd: CWD }, { _run, _listPanes }),
      (err) => {
        assert.equal(err.message, 'Command failed: tmux new-session -d -s claude-control');
        return true;
      },
    );
  });

  test('cold-start bootstrap: unsets each injected env key right after new-session succeeds', async () => {
    const { calls, _run } = makeRun();
    let listCall = 0;
    async function _listPanes() {
      listCall += 1;
      if (listCall === 1) return [];
      return [{ sessionName: 'claude-control', target: 'claude-control:0', windowIndex: 0 }];
    }

    await createWindow(
      { cwd: CWD, env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s', FOO: 'bar' } },
      { _run, _listPanes },
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0][0], 'new-session');
    assert.deepEqual(calls[1], ['set-environment', '-t', 'claude-control', '-u', 'ANTHROPIC_BASE_URL']);
    assert.deepEqual(calls[2], ['set-environment', '-t', 'claude-control', '-u', 'FOO']);
  });

  test('cold-start bootstrap: no env → no set-environment calls', async () => {
    const { calls, _run } = makeRun();
    let listCall = 0;
    async function _listPanes() {
      listCall += 1;
      if (listCall === 1) return [];
      return [{ sessionName: 'claude-control', target: 'claude-control:0', windowIndex: 0 }];
    }

    await createWindow({ cwd: CWD }, { _run, _listPanes });

    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c[0] === 'set-environment'));
  });

  test('existing-server path (new-window): a tmux failure never leaks the secret value', async () => {
    const secret = 'https://host/auth/sub-1/sekret42';
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }
    async function _run(args) {
      throw new Error(`Command failed: tmux ${args.join(' ')}`);
    }

    await assert.rejects(
      () => createWindow({ cwd: CWD, env: { ANTHROPIC_BASE_URL: secret } }, { _run, _listPanes }),
      (err) => {
        assert.ok(!err.message.includes('sekret42'), err.message);
        assert.ok(err.message.includes('<redacted>'), err.message);
        return true;
      },
    );
  });

  test('existing-server path (new-window -e): pane-scoped — NO session-env unset issued', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:3\n' });
    async function _listPanes() {
      return [{ sessionName: 'work', target: 'work:0', windowIndex: 0 }];
    }

    await createWindow(
      { cwd: CWD, env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s' } },
      { _run, _listPanes },
    );

    assert.equal(calls.length, 1, 'new-window is pane-scoped; no follow-up unset call');
    assert.ok(!calls.some((c) => c[0] === 'set-environment'));
  });
});

describe('createTmuxSession: secret scrubbing + session-env unset (CP3 Fix 1 + Fix 2)', () => {
  test('a tmux failure never leaks the secret value', async () => {
    const secret = 'https://host/auth/sub-1/sekret42';
    async function _run(args) {
      throw new Error(`Command failed: tmux ${args.join(' ')}`);
    }

    await assert.rejects(
      () => createTmuxSession({ name: 'sess', cwd: CWD, env: { ANTHROPIC_BASE_URL: secret } }, { _run }),
      (err) => {
        assert.ok(!err.message.includes('sekret42'), err.message);
        assert.ok(err.message.includes('<redacted>'), err.message);
        return true;
      },
    );
  });

  test('no env → a tmux failure is NOT scrubbed/wrapped (byte-identical)', async () => {
    async function _run() {
      throw new Error('Command failed: tmux new-session -d -s sess');
    }

    await assert.rejects(
      () => createTmuxSession({ name: 'sess', cwd: CWD }, { _run }),
      (err) => {
        assert.equal(err.message, 'Command failed: tmux new-session -d -s sess');
        return true;
      },
    );
  });

  test('unsets each injected env key right after new-session succeeds (same argv shape as createWindow)', async () => {
    const { calls, _run } = makeRun();
    async function _listPanes() {
      return [{ sessionName: 'sess', target: 'sess:0', windowIndex: 0 }];
    }

    await createTmuxSession(
      { name: 'sess', cwd: CWD, env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s', A: '1' } },
      { _run, _listPanes },
    );

    assert.equal(calls.length, 3);
    assert.equal(calls[0][0], 'new-session');
    assert.deepEqual(calls[1], ['set-environment', '-t', 'sess', '-u', 'ANTHROPIC_BASE_URL']);
    assert.deepEqual(calls[2], ['set-environment', '-t', 'sess', '-u', 'A']);
  });

  test('no env → no set-environment calls', async () => {
    const { calls, _run } = makeRun();
    async function _listPanes() {
      return [{ sessionName: 'sess', target: 'sess:0', windowIndex: 0 }];
    }

    await createTmuxSession({ name: 'sess', cwd: CWD }, { _run, _listPanes });

    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c[0] === 'set-environment'));
  });
});

describe('createWindowInSession: secret scrubbing only — no session-env unset (pane-scoped)', () => {
  test('a tmux failure never leaks the secret value', async () => {
    const secret = 'https://host/auth/sub-1/sekret42';
    async function _run(args) {
      throw new Error(`Command failed: tmux ${args.join(' ')}`);
    }

    await assert.rejects(
      () => createWindowInSession({ sessionName: 'work', cwd: CWD, env: { ANTHROPIC_BASE_URL: secret } }, { _run }),
      (err) => {
        assert.ok(!err.message.includes('sekret42'), err.message);
        assert.ok(err.message.includes('<redacted>'), err.message);
        return true;
      },
    );
  });

  test('no env → a tmux failure is NOT scrubbed/wrapped (byte-identical)', async () => {
    async function _run() {
      throw new Error('Command failed: tmux new-window -t work:');
    }

    await assert.rejects(
      () => createWindowInSession({ sessionName: 'work', cwd: CWD }, { _run }),
      (err) => {
        assert.equal(err.message, 'Command failed: tmux new-window -t work:');
        return true;
      },
    );
  });

  test('env present but new-window is pane-scoped: NO session-env unset issued', async () => {
    const { calls, _run } = makeRun({ 'new-window': 'work:5\n' });

    await createWindowInSession(
      { sessionName: 'work', cwd: CWD, env: { ANTHROPIC_BASE_URL: 'https://h/auth/u/s' } },
      { _run },
    );

    assert.equal(calls.length, 1);
    assert.ok(!calls.some((c) => c[0] === 'set-environment'));
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
      /tmux >= 3\.2 required for claudex\/claudemi env injection \(new-session -e\); found 3\.1 — brew upgrade tmux/,
    );
  });

  test('rejects 2.9 with the actionable message', async () => {
    const { _run } = versionRun('tmux 2.9a\n');
    await assert.rejects(
      () => assertTmuxSupportsEnv({ _run }),
      /tmux >= 3\.2 required for claudex\/claudemi env injection \(new-session -e\); found 2\.9 — brew upgrade tmux/,
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
