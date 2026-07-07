/**
 * test/record-pane.test.js
 *
 * Covers the headless-nested-session bug: a `claude -p` child spawned from
 * inside an interactive tmux pane inherits $TMUX_PANE from its parent shell.
 * Without a guard, the child's SessionStart would overwrite the interactive
 * session's pane binding, and its SessionEnd would delete it — destroying
 * cockpit's tmux↔transcript mapping for a session that's still alive.
 *
 * Runs the actual hook script as a child process (matches how Claude Code
 * invokes it) with:
 *   - CC_PANES_DIR      → isolated tmp dir instead of ~/.claude-control/panes
 *   - CC_RECORD_PANE_TTY → simulates the parent-tty lookup without needing a
 *                          real `ps`/tty in the test sandbox
 *
 * Run: node --test test/record-pane.test.js
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOK_JS = path.join(__dirname, '..', 'hooks', 'record-pane.mjs');

const TTY_ATTACHED = '/dev/ttys002'; // any non-empty, non-`??`/`?` value
const TTY_HEADLESS = '??'; // what `ps -o tty=` reports for a detached process

async function tmpPanesDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'record-pane-'));
}

/** Run the hook exactly as Claude Code does: env + JSON on stdin, exit 0 always. */
function runHook({ tmuxPane, tty, panesDir, input }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [HOOK_JS], {
      env: {
        ...process.env,
        TMUX_PANE: tmuxPane,
        CC_PANES_DIR: panesDir,
        ...(tty !== undefined ? { CC_RECORD_PANE_TTY: tty } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (c) => (stderr += c));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(input));
  });
}

async function readPaneFile(panesDir, tmuxPane) {
  const safe = tmuxPane.replace(/[^A-Za-z0-9_-]/g, '');
  try {
    return JSON.parse(await fs.readFile(path.join(panesDir, `${safe}.json`), 'utf8'));
  } catch {
    return null;
  }
}

async function writePaneFile(panesDir, tmuxPane, record) {
  const safe = tmuxPane.replace(/[^A-Za-z0-9_-]/g, '');
  await fs.mkdir(panesDir, { recursive: true });
  await fs.writeFile(path.join(panesDir, `${safe}.json`), JSON.stringify(record), 'utf8');
}

// ─── headless-parent guard ──────────────────────────────────────────────────

test('SessionStart from a headless (non-tty) parent does not create the pane file', async () => {
  const panesDir = await tmpPanesDir();
  const { code } = await runHook({
    tmuxPane: '%9',
    tty: TTY_HEADLESS,
    panesDir,
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'headless-child',
      transcript_path: '/tmp/fake-transcript.jsonl',
    },
  });
  assert.equal(code, 0, 'hook always exits 0');
  assert.equal(await readPaneFile(panesDir, '%9'), null, 'headless child must not write a binding');
});

test('SessionStart from a headless parent does not clobber an existing binding', async () => {
  const panesDir = await tmpPanesDir();
  await writePaneFile(panesDir, '%9', {
    paneId: '%9',
    sessionId: 'interactive-parent',
    transcriptPath: '/tmp/parent.jsonl',
    ts: 1,
  });

  await runHook({
    tmuxPane: '%9',
    tty: TTY_HEADLESS,
    panesDir,
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'headless-child',
      transcript_path: '/tmp/child.jsonl',
    },
  });

  const record = await readPaneFile(panesDir, '%9');
  assert.ok(record, 'binding must still exist');
  assert.equal(record.sessionId, 'interactive-parent', 'headless child must not overwrite the parent binding');
});

test('SessionEnd from a headless parent does not delete an existing binding', async () => {
  const panesDir = await tmpPanesDir();
  await writePaneFile(panesDir, '%9', {
    paneId: '%9',
    sessionId: 'interactive-parent',
    transcriptPath: '/tmp/parent.jsonl',
    ts: 1,
  });

  await runHook({
    tmuxPane: '%9',
    tty: TTY_HEADLESS,
    panesDir,
    input: { hook_event_name: 'SessionEnd', session_id: 'headless-child' },
  });

  const record = await readPaneFile(panesDir, '%9');
  assert.ok(record, 'headless child SessionEnd must not delete the pane file');
  assert.equal(record.sessionId, 'interactive-parent');
});

test('SessionStart from a tty-attached parent still writes the binding (unchanged behavior)', async () => {
  const panesDir = await tmpPanesDir();
  await runHook({
    tmuxPane: '%9',
    tty: TTY_ATTACHED,
    panesDir,
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'interactive',
      transcript_path: '/tmp/interactive.jsonl',
      cwd: '/workspace',
    },
  });

  const record = await readPaneFile(panesDir, '%9');
  assert.ok(record, 'tty-attached session must write a binding');
  assert.equal(record.sessionId, 'interactive');
  assert.equal(record.transcriptPath, '/tmp/interactive.jsonl');
  assert.equal(record.cwd, '/workspace');
});

// ─── matched delete on SessionEnd ───────────────────────────────────────────

test('SessionEnd for a DIFFERENT session does not delete the current binding', async () => {
  const panesDir = await tmpPanesDir();
  await writePaneFile(panesDir, '%9', {
    paneId: '%9',
    sessionId: 'session-A',
    transcriptPath: '/tmp/a.jsonl',
    ts: 1,
  });

  await runHook({
    tmuxPane: '%9',
    tty: TTY_ATTACHED,
    panesDir,
    input: { hook_event_name: 'SessionEnd', session_id: 'session-B' },
  });

  const record = await readPaneFile(panesDir, '%9');
  assert.ok(record, 'a mismatched SessionEnd must not remove another session\'s binding');
  assert.equal(record.sessionId, 'session-A');
});

test('SessionEnd for the MATCHING session deletes the binding', async () => {
  const panesDir = await tmpPanesDir();
  await writePaneFile(panesDir, '%9', {
    paneId: '%9',
    sessionId: 'session-A',
    transcriptPath: '/tmp/a.jsonl',
    ts: 1,
  });

  await runHook({
    tmuxPane: '%9',
    tty: TTY_ATTACHED,
    panesDir,
    input: { hook_event_name: 'SessionEnd', session_id: 'session-A' },
  });

  assert.equal(await readPaneFile(panesDir, '%9'), null, 'matching SessionEnd must delete the binding');
});

test('SessionEnd deletes a malformed/unreadable pane file regardless of session_id', async () => {
  const panesDir = await tmpPanesDir();
  const safe = '9';
  await fs.mkdir(panesDir, { recursive: true });
  await fs.writeFile(path.join(panesDir, `${safe}.json`), 'not json', 'utf8');

  await runHook({
    tmuxPane: '%9',
    tty: TTY_ATTACHED,
    panesDir,
    input: { hook_event_name: 'SessionEnd', session_id: 'whatever' },
  });

  assert.equal(await readPaneFile(panesDir, '%9'), null, 'malformed pane file is cleaned up');
});

test('SessionEnd with no existing pane file is a silent no-op', async () => {
  const panesDir = await tmpPanesDir();
  const { code } = await runHook({
    tmuxPane: '%9',
    tty: TTY_ATTACHED,
    panesDir,
    input: { hook_event_name: 'SessionEnd', session_id: 'whatever' },
  });
  assert.equal(code, 0);
  assert.equal(await readPaneFile(panesDir, '%9'), null);
});

// ─── existing/no-op behavior preserved ──────────────────────────────────────

test('no-op when TMUX_PANE is unset', async () => {
  const panesDir = await tmpPanesDir();
  const { code } = await new Promise((resolve, reject) => {
    const env = { ...process.env, CC_PANES_DIR: panesDir, CC_RECORD_PANE_TTY: TTY_ATTACHED };
    delete env.TMUX_PANE;
    const child = spawn(process.execPath, [HOOK_JS], { env, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('close', (c) => resolve({ code: c }));
    child.stdin.end(JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'x', transcript_path: '/tmp/x.jsonl' }));
  });
  assert.equal(code, 0);
  const entries = await fs.readdir(panesDir).catch(() => []);
  assert.equal(entries.length, 0, 'nothing written without a tmux pane');
});

test('fails open (behaves as tty-attached) when the tty lookup itself is not overridden and ps is unavailable-safe', async () => {
  // No CC_RECORD_PANE_TTY override → hook shells out to the real `ps`. In the
  // test runner this process's parent is tty-attached or not depending on the
  // environment, but either way the hook must never throw / must exit 0.
  const panesDir = await tmpPanesDir();
  const { code } = await runHook({
    tmuxPane: '%9',
    tty: undefined,
    panesDir,
    input: {
      hook_event_name: 'SessionStart',
      session_id: 'real-ps-path',
      transcript_path: '/tmp/real-ps.jsonl',
    },
  });
  assert.equal(code, 0, 'hook must exit 0 even on the real ps codepath');
});
