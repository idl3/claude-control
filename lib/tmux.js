/**
 * lib/tmux.js — tmux integration for claude-cockpit.
 * ESM, Node >=20 built-ins only. Never shell out with user text.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, stat } from 'node:fs/promises';
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
    // Force a UTF-8 locale: in the C/POSIX locale a launchd agent inherits, tmux
    // sanitizes our \x1f field separator to '_', so list parsing yields nothing.
    // A UTF-8 locale makes tmux emit \x1f literally. (Honor an existing locale.)
    env: { ...process.env, LC_ALL: process.env.LC_ALL || 'en_US.UTF-8' },
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
// Session-name helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a user-supplied session name for safe use as a tmux window name and
 * inside a `send-keys` payload. Strips ASCII control characters and newlines
 * (which could smuggle extra key events into the pane), collapses runs of
 * whitespace, and caps length. tmux window names may legitimately contain
 * spaces and punctuation, so those are kept — only dangerous bytes are removed.
 * Returns '' when nothing usable remains (callers supply a default).
 *
 * @param {string} name
 * @returns {string}
 */
export function sanitizeName(name) {
  return String(name ?? '')
    .replace(/[\x00-\x1f\x7f]/g, ' ') // control chars incl. \n \r \t ESC, and DEL
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/**
 * Generate a sensible default session name: `session-<short-timestamp>` where
 * the suffix is the tail of the base-36 epoch-ms — short, and monotonic enough
 * to disambiguate rapid creations.
 *
 * @param {number} [now=Date.now()]
 * @returns {string}
 */
export function defaultSessionName(now = Date.now()) {
  return `session-${now.toString(36).slice(-6)}`;
}

/**
 * Wrap an already-sanitized name in single quotes for safe interpolation into a
 * shell command that is typed into a pane via `send-keys` (e.g. appending
 * `--name '<name>'` to a launch command). Single-quote-escaping is the only
 * shell metacharacter that matters inside single quotes; sanitizeName has
 * already removed newlines/control chars, so this fully neutralizes the value.
 *
 * @param {string} name  Output of sanitizeName (no control chars).
 * @returns {string}     e.g. "'my session'" or "'it'\''s'".
 */
export function shellQuoteName(name) {
  return `'${String(name).replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Create window
// ---------------------------------------------------------------------------

/**
 * Create a new tmux window running the DEFAULT shell (NOT a passed command),
 * and return its "session:window" target. The launch command is sent
 * separately via send-keys (see server.js) so the interactive shell loads its
 * rc and resolves aliases (e.g. `yolo`) — passing the command as
 * `new-window <cmd>` would exec it directly, bypassing alias resolution.
 *
 * If a tmux server/session already exists, the window is created in the first
 * existing session. If no server is running, a detached "claude-control"
 * session is created first and used.
 *
 * @param {{ cwd: string, name?: string }} opts
 * @returns {Promise<string>} target "session:windowIndex"
 */
export async function createWindow({ cwd, name } = {}) {
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('createWindow: cwd is required');
  }
  // Validate the cwd exists and is a directory before handing it to tmux, so we
  // surface a clear error instead of tmux's terse "can't find directory".
  let st;
  try {
    st = await stat(cwd);
  } catch {
    throw new Error(`createWindow: cwd does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`createWindow: cwd is not a directory: ${cwd}`);
  }

  // Re-sanitize defensively: the window name reaches tmux as an argv value, but
  // callers may pass raw user text. An empty result means "let tmux auto-name".
  const safeName = sanitizeName(name);

  const windows = await listWindows();

  // No tmux server/session yet — bootstrap a detached session in the cwd. The
  // session's first window IS our target window, so no extra new-window needed.
  if (windows.length === 0) {
    const sessionName = 'claude-control';
    const args = ['new-session', '-d', '-s', sessionName, '-c', cwd];
    if (safeName) args.push('-n', safeName);
    await runTmux(args);
    // The fresh session opens at window index 0 (tmux's base-index may differ,
    // but the first list entry is authoritative).
    const after = await listWindows();
    const win = after.find((w) => w.sessionName === sessionName);
    const target = win ? win.target : `${sessionName}:0`;
    if (!isValidTarget(target)) {
      throw new Error(`createWindow: produced invalid target: ${target}`);
    }
    return target;
  }

  // A server exists — create the window in the first existing session and read
  // back its "session:window" target via the -P/-F print format.
  const targetSession = windows[0].sessionName;
  const args = [
    'new-window',
    '-t', targetSession,
    '-P',
    '-F', '#{session_name}:#{window_index}',
    '-c', cwd,
  ];
  if (safeName) args.push('-n', safeName);
  const { stdout } = await runTmux(args);
  const target = stdout.trim();
  if (!isValidTarget(target)) {
    throw new Error(`createWindow: produced invalid target: ${JSON.stringify(target)}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Rename window
// ---------------------------------------------------------------------------

/**
 * Rename a tmux window so it shows the new label in the rail immediately. The
 * name reaches tmux as an argv value (NOT typed into the pane), and the `--`
 * terminator stops tmux from treating a leading `-` as a flag. Callers must
 * sanitize the name first (sanitizeName strips control chars/newlines).
 *
 * @param {string} target  e.g. "0:3"
 * @param {string} name     already-sanitized window name
 * @returns {Promise<void>}
 */
export async function renameWindow(target, name) {
  assertTarget(target);
  await runTmux(['rename-window', '-t', target, '--', String(name)]);
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
    // NOTE: no '-e' — the UI renders the capture as plain text (LivePane <pre>,
    // AskModal peek), so ANSI escapes would show as literal garbage. Strip them
    // at the source by capturing without escape sequences.
    '-S', `-${lines}`,  // start N lines above visible area
  ]);
  return stdout;
}
