// Tests for moveWindow — moving a tmux WINDOW from one tmux session into
// another (sidebar drag-to-session). Same hermetic pattern as
// tmux-session-target.test.js's renameTmuxSession tests: a stub `_run`
// records argv without shelling out to tmux, so these pass with NO tmux
// installed.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { moveWindow, assertTmuxSupportsEnv } from '../lib/tmux.js';

// ── moveWindow ───────────────────────────────────────────────────────────

test('moveWindow issues move-window -s <winTarget> -t <dest>: after validating dest against list-sessions', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    if (args[0] === 'list-sessions') return { stdout: 'src\ndest\n', stderr: '' };
    return { stdout: '', stderr: '' };
  }

  await moveWindow('src:3.1', 'dest', { _run });

  assert.equal(calls.length, 2, 'exactly one list-sessions validation call, then the move');
  assert.deepEqual(calls[0], ['list-sessions', '-F', '#{session_name}']);
  // Pane index (.1) is stripped — move-window operates on the WINDOW.
  assert.deepEqual(calls[1], ['move-window', '-s', 'src:3', '-t', 'dest:']);
});

test('moveWindow strips the pane index from a window-only srcTarget too (no-op strip)', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    if (args[0] === 'list-sessions') return { stdout: 'src\ndest\n', stderr: '' };
    return { stdout: '', stderr: '' };
  }

  await moveWindow('src:0', 'dest', { _run });

  const move = calls.find((c) => c[0] === 'move-window');
  assert.deepEqual(move, ['move-window', '-s', 'src:0', '-t', 'dest:']);
});

test('moveWindow rejects an unknown destination session, without calling move-window', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    if (args[0] === 'list-sessions') return { stdout: 'src\n', stderr: '' };
    return { stdout: '', stderr: '' };
  }

  await assert.rejects(
    () => moveWindow('src:0', 'nope', { _run }),
    /no such tmux session: "nope"/,
  );
  assert.ok(!calls.some((c) => c[0] === 'move-window'), 'move-window must never be issued');
  assert.equal(calls.length, 1, 'only the list-sessions validation call was made');
});

test('moveWindow rejects a malformed srcTarget before any tmux round-trip', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    return { stdout: 'src\ndest\n', stderr: '' };
  }

  await assert.rejects(
    () => moveWindow('not-a-target', 'dest', { _run }),
    /Invalid tmux target/,
  );
  assert.equal(calls.length, 0, 'assertTarget must fail before list-sessions or move-window run');
});

test('moveWindow validates against the RAW session list (grouped-member names survive, unlike listSessions())', async () => {
  const calls = [];
  async function _run(args) {
    calls.push([...args]);
    // Raw session-name list includes the grouped member "0" — listSessions()
    // would have deduped it away (see renameTmuxSession's identical guard).
    if (args[0] === 'list-sessions') return { stdout: 'work\n0\n', stderr: '' };
    return { stdout: '', stderr: '' };
  }

  await moveWindow('work:2', '0', { _run });

  const move = calls.find((c) => c[0] === 'move-window');
  assert.deepEqual(move, ['move-window', '-s', 'work:2', '-t', '0:']);
});

// Sanity: confirm the module still exports the other tmux helpers used
// elsewhere (guards against an accidental default-export mixup while adding
// this new function, since ESM named exports would silently drop a typo).
test('module still exports assertTmuxSupportsEnv alongside the new moveWindow', () => {
  assert.equal(typeof moveWindow, 'function');
  assert.equal(typeof assertTmuxSupportsEnv, 'function');
});
