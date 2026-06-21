/**
 * lib/tmux.js — tmux integration for claude-cockpit.
 * ESM, Node >=20 built-ins only. Never shell out with user text.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Binary resolution — cached after first successful probe
// ---------------------------------------------------------------------------
let _resolvedBin = null;

const PROBE_PATHS = [
  '/opt/homebrew/bin/tmux',
  '/usr/local/bin/tmux',
  '/usr/bin/tmux',
];

/**
 * Resolve the tmux binary, honouring COCKPIT_TMUX, then absolute-path
 * probes, then `command -v tmux` via a login shell (handles PATH correctly
 * without triggering zsh aliases).
 *
 * @returns {Promise<string>} Absolute path to the tmux binary.
 */
export async function resolveTmuxBin() {
  if (_resolvedBin) return _resolvedBin;

  // 1. Explicit override
  const envBin = process.env.COCKPIT_TMUX;
  if (envBin) {
    _resolvedBin = envBin;
    return _resolvedBin;
  }

  // 2. Fixed absolute paths
  for (const p of PROBE_PATHS) {
    try {
      await access(p, fsConstants.X_OK);
      _resolvedBin = p;
      return _resolvedBin;
    } catch {
      // not present / not executable — try next
    }
  }

  // 3. Login shell lookup (avoids zsh alias shadowing)
  try {
    const { stdout } = await execFile('/bin/sh', ['-lc', 'command -v tmux'], {
      timeout: 5000,
    });
    const candidate = stdout.trim();
    if (candidate) {
      _resolvedBin = candidate;
      return _resolvedBin;
    }
  } catch {
    // fall through
  }

  throw new Error('tmux binary not found; set COCKPIT_TMUX or install tmux');
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

/** Pattern from CONTRACT: ^[A-Za-z0-9_.-]+:\d+(\.\d+)?$ */
const TARGET_RE = /^[A-Za-z0-9_.-]+:\d+(\.\d+)?$/;

/**
 * Returns true when `target` is a syntactically valid tmux target string.
 * Does NOT verify the target is live — that requires a round-trip to tmux.
 *
 * @param {string} target
 * @returns {boolean}
 */
export function isValidTarget(target) {
  return typeof target === 'string' && TARGET_RE.test(target);
}

// ---------------------------------------------------------------------------
// Session / window name validation
// ---------------------------------------------------------------------------

/**
 * Charset for session/window names: ^[A-Za-z0-9_-]+$
 * Explicitly REJECTS `.` and `:` (tmux treats them specially in target
 * addressing), spaces, and any shell metacharacters.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function isValidName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  // Only alphanumerics, underscore, and hyphen are safe in session/window names.
  return /^[A-Za-z0-9_-]+$/.test(name);
}

/**
 * Assert the session/window name is valid, throwing a descriptive error if not.
 * @param {string} name
 */
function assertName(name) {
  if (!isValidName(name)) {
    throw new Error(
      `Invalid tmux session/window name: ${JSON.stringify(name)} — ` +
        'must match ^[A-Za-z0-9_-]+ (no dots, colons, spaces, or shell metacharacters)',
    );
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Run a tmux sub-command with an explicit args array.
 * @param {string[]} args
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runTmux(args, opts = {}) {
  const bin = await resolveTmuxBin();
  return execFile(bin, args, { timeout: opts.timeout ?? 10_000, maxBuffer: 4 * 1024 * 1024 });
}

/**
 * Assert the target is valid, throwing a descriptive error if not.
 * @param {string} target
 */
function assertTarget(target) {
  if (!isValidTarget(target)) {
    throw new Error(`Invalid tmux target: ${JSON.stringify(target)} — must match session:index[.pane]`);
  }
}

// ---------------------------------------------------------------------------
// List windows
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Window
 * @property {string}  sessionName
 * @property {number}  windowIndex
 * @property {string}  windowName
 * @property {string}  target         "sessionName:windowIndex"
 * @property {boolean} active
 * @property {number}  panePid
 * @property {string}  cwd
 * @property {string}  cmd
 * @property {string}  windowId       tmux @-id; SHARED across grouped sessions
 * @property {number}  paneIndex
 */

const SEP = '\x1f';

const FORMAT = [
  '#{session_name}',
  '#{window_index}',
  '#{window_name}',
  '#{window_active}',
  '#{pane_pid}',
  '#{pane_current_path}',
  '#{pane_current_command}',
  '#{window_id}',
  '#{pane_index}',
].join(SEP);

/**
 * List all tmux windows across all sessions.
 * Resolves to [] when no tmux server is running.
 *
 * @returns {Promise<Window[]>}
 */
export async function listWindows() {
  let stdout;
  try {
    ({ stdout } = await runTmux(['list-windows', '-a', '-F', FORMAT]));
  } catch (err) {
    // tmux exits 1 with "no server running" or "error connecting to server"
    const msg = String(err?.message || '');
    if (
      msg.includes('no server running') ||
      msg.includes('error connecting') ||
      msg.includes('no sessions') ||
      (err?.code === 1 && (!err.stderr || err.stderr.includes('no server')))
    ) {
      return [];
    }
    // Also handle the case where stderr contains the no-server message
    if (err?.stderr && (
      err.stderr.includes('no server running') ||
      err.stderr.includes('error connecting')
    )) {
      return [];
    }
    throw err;
  }

  const windows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(SEP);
    if (parts.length < 7) continue;

    const [sessionName, rawIndex, windowName, rawActive, rawPid, cwd, cmd, windowId, rawPane] = parts;
    const windowIndex = Number(rawIndex);
    const panePid = Number(rawPid);

    windows.push({
      sessionName,
      windowIndex,
      windowName,
      target: `${sessionName}:${windowIndex}`,
      active: rawActive === '1',
      panePid,
      cwd,
      cmd,
      windowId: windowId ?? `${sessionName}:${windowIndex}`,
      paneIndex: Number(rawPane) || 0,
    });
  }

  return windows;
}

// ---------------------------------------------------------------------------
// Send text (literal, with Enter)
// ---------------------------------------------------------------------------

/**
 * Send literal text to a tmux pane and then press Enter.
 * Uses `-l` so tmux does not interpret key names.
 *
 * @param {string} target  e.g. "0:3"
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendText(target, text) {
  assertTarget(target);
  // Step 1: literal text (no key interpretation)
  await runTmux(['send-keys', '-t', target, '-l', text]);
  // Step 2: press Enter
  await runTmux(['send-keys', '-t', target, 'Enter']);
}

// ---------------------------------------------------------------------------
// Send raw key names (no -l)
// ---------------------------------------------------------------------------

/**
 * Send a sequence of key names (e.g. 'Down', 'Space', 'Enter') to a pane.
 * Does NOT use `-l`, so tmux interprets these as key names.
 *
 * @param {string}   target
 * @param {string[]} keys    e.g. ['Down', 'Down', 'Space', 'Enter']
 * @returns {Promise<void>}
 */
export async function sendRawKeys(target, keys) {
  assertTarget(target);
  if (!Array.isArray(keys) || keys.length === 0) return;
  await runTmux(['send-keys', '-t', target, ...keys]);
}

/**
 * Send key names ONE AT A TIME with a delay between each. Needed for the
 * AskUserQuestion picker, whose single-select number keys trigger an async
 * tab-advance re-render — firing the next key too soon lands it on the wrong
 * question.
 *
 * @param {string}   target
 * @param {string[]} keys
 * @param {number}   [delayMs=130]
 * @returns {Promise<void>}
 */
export async function sendRawKeysSequenced(target, keys, delayMs = 130) {
  assertTarget(target);
  if (!Array.isArray(keys) || keys.length === 0) return;
  for (let i = 0; i < keys.length; i += 1) {
    await runTmux(['send-keys', '-t', target, keys[i]]);
    if (i < keys.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Capture pane
// ---------------------------------------------------------------------------

/**
 * Capture the visible content of a tmux pane.
 * `-e` preserves ANSI escape sequences (server may strip before forwarding).
 *
 * @param {string} target
 * @param {number} [lines=40]  How many history lines above the visible area to include.
 * @returns {Promise<string>}
 */
export async function capturePane(target, lines = 40) {
  assertTarget(target);
  const { stdout } = await runTmux([
    'capture-pane',
    '-t', target,
    '-p',         // print to stdout
    '-e',         // keep ANSI escapes
    '-S', `-${lines}`,  // start N lines above visible area
  ]);
  return stdout;
}

// ---------------------------------------------------------------------------
// Spawn helpers — create new windows / sessions for agent processes
// ---------------------------------------------------------------------------

/**
 * Create a new tmux window in an existing session, set its cwd via tmux -c
 * (NOT a shell cd — avoids injection), then send the agent command via
 * send-keys -l (literal) + Enter. Returns the new target "session:windowIndex".
 *
 * @param {{ session: string, cwd: string, bin: string, args?: string[], windowName?: string }} opts
 * @returns {Promise<string>} new target "session:windowIndex"
 */
export async function newWindow({ session, cwd, bin, args = [], windowName }) {
  // Validate inputs before any tmux call.
  assertName(session);
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('newWindow: cwd must be a non-empty string');
  }
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('newWindow: bin must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('newWindow: args must be an array of strings');
  }

  // Build new-window argv. Use -P -F to capture the new target.
  const newWindowArgs = ['new-window', '-t', session, '-c', cwd, '-P', '-F', '#{session_name}:#{window_index}'];
  if (windowName !== undefined && windowName !== null) {
    assertName(windowName);
    newWindowArgs.push('-n', windowName);
  }

  const { stdout } = await runTmux(newWindowArgs);
  const newTarget = stdout.trim();

  // Send the command literally (tmux -l does not invoke a shell).
  const commandStr = [bin, ...args].join(' ');
  await runTmux(['send-keys', '-t', newTarget, '-l', commandStr]);
  await runTmux(['send-keys', '-t', newTarget, 'Enter']);

  return newTarget;
}

/**
 * Create a new detached tmux session with cwd via -c, then send the agent
 * command via send-keys -l + Enter. Returns the new target "name:0".
 *
 * @param {{ name: string, cwd: string, bin: string, args?: string[] }} opts
 * @returns {Promise<string>} new target "name:0"
 */
export async function newSession({ name, cwd, bin, args = [] }) {
  // Validate inputs before any tmux call.
  assertName(name);
  if (typeof cwd !== 'string' || cwd.length === 0) {
    throw new Error('newSession: cwd must be a non-empty string');
  }
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('newSession: bin must be a non-empty string');
  }
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    throw new Error('newSession: args must be an array of strings');
  }

  // -d = detached; -P -F prints the new target (session_name:window_index).
  const { stdout } = await runTmux([
    'new-session', '-d', '-s', name, '-c', cwd, '-P', '-F', '#{session_name}:#{window_index}',
  ]);
  const newTarget = stdout.trim();

  // Send the command literally.
  const commandStr = [bin, ...args].join(' ');
  await runTmux(['send-keys', '-t', newTarget, '-l', commandStr]);
  await runTmux(['send-keys', '-t', newTarget, 'Enter']);

  return newTarget;
}
