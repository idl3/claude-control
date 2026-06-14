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
// Internal helpers
// ---------------------------------------------------------------------------

// We delimit `-F` format fields with US (\x1f). tmux only emits that control
// byte verbatim under a UTF-8 locale; in the C/POSIX locale (e.g. a bare launchd
// or cron environment) it sanitizes \x1f to "_", which collapses every row to a
// single field and yields zero panes. Force a UTF-8 locale for tmux so parsing
// is correct regardless of how the server was launched.
const TMUX_ENV = {
  ...process.env,
  LC_ALL: process.env.LC_ALL || process.env.LANG || 'en_US.UTF-8',
};

/**
 * Run a tmux sub-command with an explicit args array.
 * @param {string[]} args
 * @param {{ timeout?: number }} [opts]
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function runTmux(args, opts = {}) {
  const bin = await resolveTmuxBin();
  return execFile(bin, args, {
    timeout: opts.timeout ?? 10_000,
    maxBuffer: 4 * 1024 * 1024,
    env: TMUX_ENV,
  });
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
// List panes
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} Window
 * @property {string}  sessionName
 * @property {number}  windowIndex
 * @property {string}  windowName
 * @property {string}  target         "sessionName:windowIndex.paneIndex"
 * @property {boolean} active          window is the active window in its session
 * @property {boolean} paneActive      pane is the active pane in its window
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
  '#{pane_active}',
].join(SEP);

/**
 * List every tmux PANE across all sessions (one entry per pane, not per window).
 * A `target` therefore identifies an exact pane —
 * "sessionName:windowIndex.paneIndex" — so the cockpit distinguishes multiple
 * Claude panes sharing one window, and `send-keys -t <target>` always lands in
 * the intended pane rather than the window's currently-active pane. Resolves to
 * [] when no tmux server is running.
 *
 * @returns {Promise<Window[]>}
 */
export async function listPanes() {
  let stdout;
  try {
    ({ stdout } = await runTmux(['list-panes', '-a', '-F', FORMAT]));
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

  const panes = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split(SEP);
    if (parts.length < 9) continue;

    const [sessionName, rawIndex, windowName, rawActive, rawPid, cwd, cmd, windowId, rawPane, rawPaneActive] = parts;
    const windowIndex = Number(rawIndex);
    const panePid = Number(rawPid);
    const paneIndex = Number(rawPane) || 0;

    panes.push({
      sessionName,
      windowIndex,
      windowName,
      target: `${sessionName}:${windowIndex}.${paneIndex}`,
      active: rawActive === '1',
      paneActive: rawPaneActive === '1',
      panePid,
      cwd,
      cmd,
      windowId: windowId ?? `${sessionName}:${windowIndex}`,
      paneIndex,
    });
  }

  return panes;
}

/**
 * @deprecated Back-compat alias — enumerates panes (not windows). Kept so any
 * external caller keeps working after the window→pane migration.
 */
export const listWindows = listPanes;

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
