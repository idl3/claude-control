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
// Socket path
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the tmux server socket this process talks to.
 *
 * claude-control runs tmux on the *default* socket (no `-S`). When we spawn a
 * separate `tmux attach` (e.g. for the ttyd escape hatch) it would otherwise
 * resolve its own default socket from *its* environment — which under launchd
 * can differ from ours, yielding a silent empty terminal. Passing this path as
 * `-S <socket>` pins the attach to the SAME server we discovered the target on.
 *
 * @returns {Promise<string>} absolute socket path (e.g. /tmp/tmux-501/default)
 */
export async function getSocketPath() {
  const { stdout } = await runTmux(['display-message', '-p', '#{socket_path}']);
  const socket = stdout.trim();
  if (!socket) throw new Error('tmux did not report a socket path');
  return socket;
}

// ---------------------------------------------------------------------------
// Target validation
// ---------------------------------------------------------------------------

// tmux session names allow spaces and punctuation (e.g. a grouped session named
// "claude-control & olam"). The session-name part is therefore any run of
// printable chars EXCEPT the `:` target delimiter and control chars; then
// `:window(.pane)`. Targets only ever reach tmux as an execFile/spawn argv (never
// a shell), so spaces/`&` can't inject — and ids from clients must additionally
// resolve via sessionById. Window/pane segments stay strictly numeric.
const TARGET_RE = /^[^\x00-\x1f:]+:\d+(\.\d+)?$/;

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
  '#{pane_id}',
  '#{@cc_shell}',
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

    const [sessionName, rawIndex, windowName, rawActive, rawPid, cwd, cmd, windowId, rawPane, rawPaneActive, paneId, ccShell] = parts;
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
      paneId: paneId ?? null, // stable tmux %N — joins to $TMUX_PANE from the hook
      ccShell: ccShell === '1', // sister shell pane created for the composer >_
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
// Split window (sister pane)
// ---------------------------------------------------------------------------

/**
 * Split a window to add a sister pane running the default shell, WITHOUT
 * stealing focus (`-d`), and return the new pane's target. Used to give each
 * Claude session its own scratch shell next to it (composer >_).
 *
 * @param {{ windowTarget: string, cwd: string, size?: string }} opts
 *   windowTarget e.g. "0:1"; size e.g. "30%" (height of the new pane).
 * @returns {Promise<string>} new pane target "session:window.pane"
 */
export async function splitWindow({ windowTarget, cwd, size = '30%' } = {}) {
  if (!windowTarget) throw new Error('splitWindow: windowTarget required');
  if (typeof cwd !== 'string' || !cwd) throw new Error('splitWindow: cwd required');
  const args = [
    'split-window',
    '-d', // do not switch focus to the new pane
    '-v', // stack below the source pane
    '-l', size,
    '-t', windowTarget,
    '-c', cwd,
    '-P',
    '-F', '#{session_name}:#{window_index}.#{pane_index}',
  ];
  const { stdout } = await runTmux(args);
  const target = stdout.trim();
  if (!isValidTarget(target)) {
    throw new Error(`splitWindow: produced invalid target: ${JSON.stringify(target)}`);
  }
  return target;
}

/**
 * Set a pane-scoped tmux option (e.g. a `@user` marker). Used to tag the sister
 * shell pane so it can be found and reused later.
 *
 * @param {string} target  pane target
 * @param {string} name    option name (e.g. "@cc_shell")
 * @param {string} value
 * @returns {Promise<void>}
 */
export async function setPaneOption(target, name, value) {
  assertTarget(target);
  await runTmux(['set-option', '-p', '-t', target, name, String(value)]);
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

/**
 * Send literal text WITHOUT a trailing Enter — for raw keystroke passthrough,
 * where each character (or a paste) is forwarded as the user types and the pane
 * itself is the echo. `-l` means no key-name interpretation, so this can't inject
 * control keys (those go through sendRawKeys with the SHELL_KEYS allow-list).
 *
 * @param {string} target
 * @param {string} text
 * @returns {Promise<void>}
 */
export async function sendLiteral(target, text) {
  assertTarget(target);
  if (!text) return;
  await runTmux(['send-keys', '-t', target, '-l', text]);
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
 * AskUserQuestion picker: each Down/Space/Enter triggers an async re-render, and
 * firing the next key before it settles drops the key (so the picker stalls and
 * the answer silently never lands).
 *
 * @param {string}   target
 * @param {string[]} keys
 * @param {number}   [delayMs=160]
 * @returns {Promise<void>}
 */
export async function sendRawKeysSequenced(target, keys, delayMs = 160) {
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
export async function capturePane(target, lines = 40, escapes = false) {
  assertTarget(target);
  const args = ['capture-pane', '-t', target, '-p'];
  // `-e` keeps ANSI/SGR sequences so the client can render terminal colors. Off
  // by default: LivePane / AskModal render plain text (escapes would show as
  // garbage). The composer terminal view opts in to get a themed, colored pane.
  if (escapes) args.push('-e');
  args.push('-S', `-${lines}`); // start N lines above the visible area
  const { stdout } = await runTmux(args);
  return stdout;
}
