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
 * separate `tmux attach` (e.g. for the embedded pty bridge's terminal panes)
 * it would otherwise resolve its own default socket from *its* environment —
 * which under launchd can differ from ours, yielding a silent empty terminal.
 * Passing this path as `-S <socket>` pins the attach to the SAME server we
 * discovered the target on.
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
// Env injection (-e) helpers — tmux >= 3.2
// ---------------------------------------------------------------------------

// Env var names must be shell-identifier-shaped. A key containing `=` (or other
// junk) would corrupt tmux's KEY=VALUE split and silently mis-inject.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Build `-e KEY=VALUE` argv pairs for tmux `new-session` / `new-window` env
 * injection. Each entry becomes ONE `-e` flag with the whole KEY=VALUE as a
 * single argv element — args reach tmux via execFile (never a shell), so no
 * quoting/escaping is needed and the value never appears in a pane, launch
 * string, or log. Returns [] for an absent/empty env, so callers' args stay
 * byte-identical to the pre-env behaviour.
 *
 * @param {Record<string, string>} [env]
 * @returns {string[]} e.g. ['-e', 'FOO=bar', '-e', 'BAZ=qux'] — or [].
 */
function buildEnvArgs(env) {
  if (env == null) return [];
  if (typeof env !== 'object' || Array.isArray(env)) {
    throw new Error('env must be a plain { KEY: value } object');
  }
  const args = [];
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      throw new Error(`invalid env var name: ${JSON.stringify(key)} — must match ${ENV_KEY_RE}`);
    }
    args.push('-e', `${key}=${String(value)}`);
  }
  return args;
}

/**
 * Scrub every env VALUE out of an error's message and re-throw a fresh Error.
 *
 * Node's execFile rejection embeds the FULL argv verbatim in `err.message`
 * (e.g. "Command failed: tmux new-session … -e ANTHROPIC_BASE_URL=https://
 * host/auth/<sub>/<secret> …"). When `env` carries the claudex bearer URL, a
 * tmux failure would otherwise leak that secret straight into server.js's
 * catch-all `String(err?.message)` 500 JSON body — visible to any remote
 * viewer. This replaces every occurrence of each env VALUE in the message
 * with `<redacted>` before the error ever leaves lib/tmux.js.
 *
 * @param {unknown} err
 * @param {Record<string, string>|null|undefined} env
 * @returns {Error}  Fresh Error with the scrubbed message. `err.code` is
 *   copied over when present (string/number) so callers that branch on it
 *   (e.g. ENOENT handling) keep working.
 */
export function scrubEnvValuesFromError(err, env) {
  let message = String(err?.message ?? err);
  if (env && typeof env === 'object' && !Array.isArray(env)) {
    for (const value of Object.values(env)) {
      if (typeof value === 'string' && value.length > 0) {
        message = message.split(value).join('<redacted>');
      }
    }
  }
  const scrubbed = new Error(message);
  if (err && (typeof err.code === 'string' || typeof err.code === 'number')) {
    scrubbed.code = err.code;
  }
  return scrubbed;
}

/**
 * Preflight: assert the installed tmux supports `-e` on new-session/new-window
 * (landed in tmux 3.2). Runs `tmux -V` and parses versions like "tmux 3.6a",
 * "tmux 3.2", or "tmux next-3.7" (suffix letters and the "next-" dev prefix
 * are ignored for the comparison). Throws a descriptive, actionable Error when
 * the version is below 3.2 or unparseable.
 *
 * Only the claudex spawn path calls this — existing spawn paths are NOT gated.
 *
 * @param {{ _run?: Function }} [_injected]  Test-only seam; production callers omit it.
 * @returns {Promise<void>}
 */
export async function assertTmuxSupportsEnv({ _run } = {}) {
  const runner = _run ?? runTmux;
  let stdout = '';
  try {
    ({ stdout } = await runner(['-V']));
  } catch (err) {
    throw new Error(
      `tmux -V failed — cannot verify tmux >= 3.2 for claudex env injection (new-session -e): ${err?.message || err}`,
    );
  }
  const raw = String(stdout || '').trim(); // e.g. "tmux 3.6a" | "tmux next-3.7"
  const m = raw.match(/(\d+)\.(\d+)/);
  if (!m) {
    throw new Error(
      `could not parse tmux version from ${JSON.stringify(raw)} — tmux >= 3.2 required for claudex env injection (new-session -e)`,
    );
  }
  const major = Number(m[1]);
  const minor = Number(m[2]);
  if (major < 3 || (major === 3 && minor < 2)) {
    throw new Error(
      `tmux >= 3.2 required for claudex env injection (new-session -e); found ${major}.${minor} — brew upgrade tmux`,
    );
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
  '#{@cc_agent}',
  '#{@cc_transport}',
  '#{@cc_endpoint}',
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

    const [
      sessionName,
      rawIndex,
      windowName,
      rawActive,
      rawPid,
      cwd,
      cmd,
      windowId,
      rawPane,
      rawPaneActive,
      paneId,
      ccShell,
      ccAgent,
      ccTransport,
      ccEndpoint,
    ] = parts;
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
      ccAgent: ccAgent || null,
      ccTransport: ccTransport || null,
      ccEndpoint: ccEndpoint || null,
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
 * @param {{ cwd: string, name?: string, env?: Record<string, string> }} opts
 *   `env` (optional): variables injected into the new window's environment via
 *   tmux `-e KEY=VALUE` args (requires tmux >= 3.2 — see assertTmuxSupportsEnv).
 *   Values travel as single argv entries, never through a shell, a typed launch
 *   string, or a log. Absent/empty → args byte-identical to the no-env path.
 * @param {{ _run?: Function, _listPanes?: Function }} [_injected]
 *   Test-only injection seam. Production callers omit this argument entirely.
 *   - `_run(args)` replaces the internal `runTmux` call (records argv, returns
 *     canned `{ stdout, stderr }` without shelling out).
 *   - `_listPanes()` replaces the `listWindows` call used to detect an existing
 *     server session (returns a canned pane array).
 * @returns {Promise<string>} target "session:windowIndex"
 */
export async function createWindow({ cwd, name, env } = {}, { _run, _listPanes } = {}) {
  // Allow tests to inject a stub runner; production path uses the real runTmux.
  const runner = _run ?? runTmux;
  const lister = _listPanes ?? listWindows;

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

  // Validate/build env args BEFORE any tmux round-trip so a bad env fails loud
  // without side effects. [] when env is absent/empty → args byte-identical.
  const envArgs = buildEnvArgs(env);

  const windows = await lister();

  // No tmux server/session yet — bootstrap a detached session in the cwd. The
  // session's first window IS our target window, so no extra new-window needed.
  // (Cold-start uses `new-session`, whose `-e` also landed in tmux 3.2.)
  if (windows.length === 0) {
    const sessionName = 'claude-control';
    const args = ['new-session', '-d', '-s', sessionName, '-c', cwd, ...envArgs];
    if (safeName) args.push('-n', safeName);
    if (envArgs.length > 0) {
      // env carries a secret (claudex bearer URL) — scrub it out of any tmux
      // failure message before it can reach a 500 JSON body (see
      // scrubEnvValuesFromError). Zero behaviour change when env is absent.
      try {
        await runner(args);
      } catch (err) {
        throw scrubEnvValuesFromError(err, env);
      }
      // `new-session -e` sets the SESSION's environment, not just this first
      // window's: every LATER window/pane created in this session (via plain
      // `new-window`, no `-e`) would silently inherit ANTHROPIC_BASE_URL —
      // cross-agent contamination (a later plain-claude window would route
      // through the auth-worker). This window's own process already has the
      // var in ITS process env (unaffected by the session-level unset), so
      // unsetting the session copy right after create makes the session env
      // clean for everything created afterward. `new-window -e` (below) is
      // pane-scoped and does not need this.
      for (const key of Object.keys(env)) {
        await runner(['set-environment', '-t', sessionName, '-u', key]);
      }
    } else {
      await runner(args);
    }
    // The fresh session opens at window index 0 (tmux's base-index may differ,
    // but the first list entry is authoritative).
    const after = await lister();
    const win = after.find((w) => w.sessionName === sessionName);
    const target = win ? win.target : `${sessionName}:0`;
    if (!isValidTarget(target)) {
      throw new Error(`createWindow: produced invalid target: ${target}`);
    }
    return target;
  }

  // A server exists — create the window in the first existing session and read
  // back its "session:window" target via the -P/-F print format.
  const targetSession = `${windows[0].sessionName}:`;
  const args = [
    'new-window',
    '-t', targetSession,
    '-P',
    '-F', '#{session_name}:#{window_index}',
    '-c', cwd,
    ...envArgs,
  ];
  if (safeName) args.push('-n', safeName);
  let stdout;
  if (envArgs.length > 0) {
    // env carries a secret — scrub it out of any tmux failure message (see
    // scrubEnvValuesFromError). `new-window -e` is pane-scoped (not
    // session-scoped), so no set-environment unset is needed here.
    try {
      ({ stdout } = await runner(args));
    } catch (err) {
      throw scrubEnvValuesFromError(err, env);
    }
  } else {
    ({ stdout } = await runner(args));
  }
  const target = stdout.trim();
  if (!isValidTarget(target)) {
    throw new Error(`createWindow: produced invalid target: ${JSON.stringify(target)}`);
  }
  return target;
}

// ---------------------------------------------------------------------------
// Session list / create — New Session tmux-target picker
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} TmuxSessionSummary
 * @property {string} name
 * @property {number} windows
 * @property {boolean} [grouped]   Present and `true` only when this entry is
 *   the collapsed representative of a tmux session GROUP (multiple linked
 *   sessions sharing one window set, e.g. tmux's `-t :` / "New Window" ->
 *   "same session" duplicates). Absent for standalone sessions.
 * @property {number} [groupSize]  Number of linked sessions collapsed into
 *   this entry. Only present when `grouped` is `true`.
 */

const SESSION_SEP = '\x1f';
const SESSION_FORMAT = [
  '#{session_name}',
  '#{session_windows}',
  '#{session_group}',
  '#{session_grouped}',
  '#{session_group_size}',
  '#{session_attached}',
].join(SESSION_SEP);

/**
 * List every tmux SESSION (not pane/window) — name + window count. Backs the
 * New Session tmux-target picker so the SPA can offer existing sessions as a
 * host for a new window. Resolves to [] when no tmux server is running,
 * mirroring listPanes' no-server handling.
 *
 * tmux session GROUPS (multiple linked sessions sharing the exact same
 * window set — `session_group`/`session_grouped`/`session_group_size`) are
 * collapsed into a single representative entry each, so the picker doesn't
 * show N identical-looking duplicates for what is really one shared window
 * set. The representative is the attached member if any, else the member
 * whose name sorts first (deterministic). Standalone (ungrouped) sessions
 * pass through unchanged.
 *
 * @param {{ _run?: Function }} [_injected]  Test-only seam; production callers omit it.
 * @returns {Promise<TmuxSessionSummary[]>}
 */
export async function listSessions({ _run } = {}) {
  const runner = _run ?? runTmux;
  let stdout;
  try {
    ({ stdout } = await runner(['list-sessions', '-F', SESSION_FORMAT]));
  } catch (err) {
    const msg = String(err?.message || '');
    if (
      msg.includes('no server running') ||
      msg.includes('error connecting') ||
      msg.includes('no sessions') ||
      (err?.code === 1 && (!err.stderr || err.stderr.includes('no server')))
    ) {
      return [];
    }
    if (err?.stderr && (
      err.stderr.includes('no server running') ||
      err.stderr.includes('error connecting')
    )) {
      return [];
    }
    throw err;
  }

  // Parse tolerantly: older tmux / hermetic test mocks may only emit the
  // original 2 fields (name, windows) with no group fields at all — treat
  // any row missing them as an ungrouped, standalone session.
  const rows = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [name, rawWindows, rawGroup, rawGrouped, rawGroupSize, rawAttached] =
      trimmed.split(SESSION_SEP);
    if (!name) continue;
    rows.push({
      name,
      windows: Number(rawWindows) || 0,
      group: rawGroup || '',
      grouped: rawGrouped === '1',
      groupSize: Number(rawGroupSize) || 0,
      attached: rawAttached === '1',
    });
  }

  // Collapse grouped rows by session_group, preserving first-appearance
  // order for both standalone sessions and each group's single entry.
  const order = [];
  const groups = new Map();
  const standalone = new Map();
  for (const row of rows) {
    if (row.grouped && row.group) {
      if (!groups.has(row.group)) {
        groups.set(row.group, []);
        order.push({ kind: 'group', group: row.group });
      }
      groups.get(row.group).push(row);
    } else if (!standalone.has(row.name)) {
      standalone.set(row.name, row);
      order.push({ kind: 'session', name: row.name });
    }
  }

  const sessions = [];
  for (const entry of order) {
    if (entry.kind === 'session') {
      const row = standalone.get(entry.name);
      sessions.push({ name: row.name, windows: row.windows });
      continue;
    }
    const members = groups.get(entry.group);
    const rep =
      members.find((m) => m.attached) ??
      [...members].sort((a, b) => a.name.localeCompare(b.name))[0];
    sessions.push({
      name: rep.name,
      windows: rep.windows,
      grouped: true,
      groupSize: rep.groupSize || members.length,
    });
  }
  return sessions;
}

/**
 * Create a brand-new DETACHED tmux session with the given name, in cwd, and
 * return the "session:window" target of its first window. This is the
 * explicit "New tmux session…" path in the tmux-target picker — distinct from
 * createWindow's implicit bootstrap, which only creates a "claude-control"
 * session when NO tmux server exists at all. Here the caller has explicitly
 * named a fresh session regardless of what else already exists.
 *
 * @param {{ name: string, cwd: string, env?: Record<string, string> }} opts
 *   `env` (optional): injected via tmux `-e KEY=VALUE` args (tmux >= 3.2) —
 *   single argv entries, never a shell/pane/log. Absent → args byte-identical.
 * @param {{ _run?: Function, _listPanes?: Function }} [_injected]  Test-only seam.
 * @returns {Promise<string>} target "session:windowIndex"
 */
export async function createTmuxSession({ name, cwd, env } = {}, { _run, _listPanes } = {}) {
  const runner = _run ?? runTmux;
  const lister = _listPanes ?? listWindows;

  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('createTmuxSession: cwd is required');
  }
  let st;
  try {
    st = await stat(cwd);
  } catch {
    throw new Error(`createTmuxSession: cwd does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`createTmuxSession: cwd is not a directory: ${cwd}`);
  }

  const safeName = sanitizeName(name);
  if (!safeName) {
    throw new Error('createTmuxSession: name is required');
  }

  const envArgs = buildEnvArgs(env);
  const args = ['new-session', '-d', '-s', safeName, '-c', cwd, ...envArgs];
  if (envArgs.length > 0) {
    // env carries a secret — scrub it out of any tmux failure message (see
    // scrubEnvValuesFromError). Zero behaviour change when env is absent.
    try {
      await runner(args);
    } catch (err) {
      throw scrubEnvValuesFromError(err, env);
    }
    // `new-session -e` is SESSION-scoped: unset it right after create so no
    // later window/pane in this session inherits ANTHROPIC_BASE_URL (see the
    // matching comment in createWindow's cold-start bootstrap above).
    for (const key of Object.keys(env)) {
      await runner(['set-environment', '-t', safeName, '-u', key]);
    }
  } else {
    await runner(args);
  }

  const windows = await lister();
  const win = windows.find((w) => w.sessionName === safeName);
  const target = win ? win.target : `${safeName}:0`;
  if (!isValidTarget(target)) {
    throw new Error(`createTmuxSession: produced invalid target: ${target}`);
  }
  return target;
}

/**
 * Create a new window running the default shell inside a GIVEN, already-
 * existing tmux session (by name), and return its "session:window" target.
 * Used by the tmux-target picker when the user selects an existing session to
 * host the new window, instead of createWindow's default "first existing
 * session" fallback.
 *
 * @param {{ sessionName: string, cwd: string, name?: string, env?: Record<string, string> }} opts
 *   `env` (optional): injected via tmux `-e KEY=VALUE` args (tmux >= 3.2) —
 *   single argv entries, never a shell/pane/log. Absent → args byte-identical.
 * @param {{ _run?: Function }} [_injected]  Test-only seam.
 * @returns {Promise<string>} target "session:windowIndex"
 */
export async function createWindowInSession({ sessionName, cwd, name, env } = {}, { _run } = {}) {
  const runner = _run ?? runTmux;

  if (typeof sessionName !== 'string' || !sessionName) {
    throw new Error('createWindowInSession: sessionName is required');
  }
  if (typeof cwd !== 'string' || !cwd) {
    throw new Error('createWindowInSession: cwd is required');
  }
  let st;
  try {
    st = await stat(cwd);
  } catch {
    throw new Error(`createWindowInSession: cwd does not exist: ${cwd}`);
  }
  if (!st.isDirectory()) {
    throw new Error(`createWindowInSession: cwd is not a directory: ${cwd}`);
  }

  const safeName = sanitizeName(name);
  const targetSession = `${sessionName}:`;
  const envArgs = buildEnvArgs(env);
  const args = [
    'new-window',
    '-t', targetSession,
    '-P',
    '-F', '#{session_name}:#{window_index}',
    '-c', cwd,
    ...envArgs,
  ];
  if (safeName) args.push('-n', safeName);
  let stdout;
  if (envArgs.length > 0) {
    // env carries a secret — scrub it out of any tmux failure message (see
    // scrubEnvValuesFromError). `new-window -e` is pane-scoped, so no
    // set-environment unset is needed here (unlike the new-session sites).
    try {
      ({ stdout } = await runner(args));
    } catch (err) {
      throw scrubEnvValuesFromError(err, env);
    }
  } else {
    ({ stdout } = await runner(args));
  }
  const target = stdout.trim();
  if (!isValidTarget(target)) {
    throw new Error(`createWindowInSession: produced invalid target: ${JSON.stringify(target)}`);
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
// Rename session
// ---------------------------------------------------------------------------

/**
 * Rename a tmux SESSION (not a window) — e.g. the deduped tmux-session group
 * header the sidebar shows above its windows/panes. Distinct from
 * `renameWindow` above, which only relabels one window.
 *
 * `oldName` is validated against `listSessions()` first so a typo or stale
 * name fails loudly instead of tmux creating a mismatched no-op. If `oldName`
 * names a member of a tmux session GROUP, tmux renames only that specific
 * session — the group's shared windows and any other member session names
 * are unaffected. That is expected tmux behaviour, not a bug here.
 *
 * @param {string} oldName  Existing tmux session name.
 * @param {string} newName  New name; re-sanitized defensively (callers should
 *                          already run `sanitizeName`, same as `renameWindow`).
 * @param {{ _run?: Function, _listSessions?: Function }} [_injected]  Test-only seam.
 * @returns {Promise<void>}
 */
export async function renameTmuxSession(oldName, newName, { _run } = {}) {
  const runner = _run ?? runTmux;

  if (typeof oldName !== 'string' || !oldName) {
    throw new Error('renameTmuxSession: oldName is required');
  }
  const safeNew = sanitizeName(newName);
  if (!safeNew) {
    throw new Error('renameTmuxSession: newName is required');
  }

  // Validate against the RAW tmux session-name list, NOT listSessions() — that
  // collapses session GROUPS to a single representative, so a grouped member
  // (e.g. "0", whose group is represented by "_mobile") is absent from it and
  // would falsely report "no such session". Query every session name directly.
  let names = [];
  try {
    const { stdout } = await runner(['list-sessions', '-F', '#{session_name}']);
    names = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    /* no server / no sessions → names stays [] → throws below */
  }
  if (!names.includes(oldName)) {
    throw new Error(`renameTmuxSession: no such tmux session: ${JSON.stringify(oldName)}`);
  }

  await runner(['rename-session', '-t', oldName, '--', safeNew]);
}

// ---------------------------------------------------------------------------
// Send text (literal, with Enter)
// ---------------------------------------------------------------------------

/** Monotonic suffix so concurrent sends never collide on a tmux buffer name. */
let _pasteBufferSeq = 0;

/**
 * Send text to a tmux pane as an atomic bracketed paste, then press Enter.
 *
 * Why not `send-keys -l text` + `send-keys Enter`: against a TUI (Claude/Codex,
 * Ink-based) those two execs race — the Enter can land before the app has
 * ingested the literal bytes, so the message sits unsent in the input box.
 * Instead we stage the text in a tmux paste buffer and `paste-buffer -p`
 * (bracketed paste), which the TUI ingests as one atomic unit, wait a short
 * settle, THEN send a real Enter to submit. Bracketed paste also stops embedded
 * newlines from prematurely submitting.
 *
 * Falls back to the old literal `send-keys` path if the buffer route errors, so
 * behaviour never regresses below today's baseline.
 *
 * Submit is DETERMINISTIC, not timed: after the paste we poll the pane until the
 * TUI's "Pasting…" indicator clears, THEN send Enter. A pasted image path is read
 * + encoded asynchronously by the TUI (it shows "Pasting…" meanwhile); an Enter
 * sent during that window is swallowed and the message sits unsent in the box —
 * the exact bug a fixed delay could only guess around. `settleMs` is the MAX time
 * to wait for "Pasting…" to clear (a ceiling, not a fixed cost — the poll exits as
 * soon as the paste finishes). The reply handler scales it per attachment.
 *
 * @param {string} target  e.g. "0:3"
 * @param {string} text
 * @param {{ _run?: Function, _delay?: Function, settleMs?: number }} [_injected]  Test seam + poll budget.
 * @returns {Promise<void>}
 */
export async function sendText(target, text, { _run, _delay, settleMs } = {}) {
  assertTarget(target);
  const runner = _run ?? runTmux;
  const delay = _delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const BUDGET_MS = Number.isFinite(settleMs) ? settleMs : 2000; // max wait for paste to settle
  const INITIAL_MS = 120; // let the TUI enter its "Pasting…" state before polling
  const POLL_MS = 120; // re-check cadence
  const POST_PASTE_MS = 250; // commit settle after "Pasting…" clears, before Enter
  const PASTING_RE = /Pasting/i;

  const bufName = `cc-paste-${process.pid}-${_pasteBufferSeq++}`;
  try {
    // Stage the text in a named buffer (data passed as argv — no shell, no stdin).
    // `--` ends option parsing so a message starting with `-`/`--` (e.g. a CSS
    // token like `--glass-panel`) isn't mis-read by tmux as a flag (invalid flag).
    await runner(['set-buffer', '-b', bufName, '--', text]);
    // Bracketed paste into the pane (-p), deleting the buffer after (-d).
    await runner(['paste-buffer', '-d', '-p', '-b', bufName, '-t', target]);
    // Wait for the TUI to FINISH ingesting the paste rather than guessing a delay:
    // poll the pane until "Pasting…" is gone (bounded by the budget as a ceiling).
    await delay(INITIAL_MS);
    const maxPolls = Math.max(1, Math.ceil(BUDGET_MS / POLL_MS));
    for (let p = 0; p < maxPolls; p++) {
      let cap = '';
      try {
        cap = (await runner(['capture-pane', '-p', '-t', target])).stdout || '';
      } catch {
        break; // capture failed — don't hang; fall through to Enter
      }
      if (!PASTING_RE.test(cap)) break;
      await delay(POLL_MS);
    }
    // Let the input commit the just-ingested content (image chip) before submit.
    await delay(POST_PASTE_MS);
    await runner(['send-keys', '-t', target, 'Enter']);
  } catch {
    // Fallback to the legacy literal path (also clean up a possibly-orphaned buffer).
    await runner(['delete-buffer', '-b', bufName]).catch(() => {});
    await runner(['send-keys', '-t', target, '-l', '--', text]);
    await runner(['send-keys', '-t', target, 'Enter']);
  }
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
  // `--` ends option parsing so text starting with `-`/`--` isn't read as a flag.
  await runTmux(['send-keys', '-t', target, '-l', '--', text]);
}

// ---------------------------------------------------------------------------
// Pipe pane (raw output streaming) + cursor position
// ---------------------------------------------------------------------------

/**
 * Start (or restart) piping a pane's raw output byte-for-byte into a shell
 * command via tmux's `pipe-pane -O` (output-only direction — tmux still owns
 * the pane; this never attaches a client to it or affects window-size
 * negotiation, unlike `tmux attach`). Used by the agent-mode PTY bridge
 * (lib/pty-bridge.js) to stream a LIVE agent pane's bytes into a FIFO without
 * a phone-sized viewer ever shrinking the real TUI for other viewers — see
 * that file's module header for the full rationale.
 *
 * `shellCommand` reaches tmux as a single argv element (never `sh -c`'d by
 * us here) — tmux itself execs it via the user's shell. Callers must build
 * it from trusted, non-user-controlled segments only (e.g. `cat >> <our own
 * fifo path>`), never from pane content or user input.
 *
 * @param {string} target
 * @param {string} shellCommand
 * @returns {Promise<void>}
 */
export async function pipePane(target, shellCommand) {
  assertTarget(target);
  await runTmux(['pipe-pane', '-O', '-t', target, shellCommand]);
}

/**
 * Stop piping a pane's output (idempotent — tmux no-ops if nothing was
 * piped). Always call this during teardown: a pipe left running keeps the
 * FIFO's write end open forever and leaks the tmux-side `cat` process.
 *
 * @param {string} target
 * @returns {Promise<void>}
 */
export async function pipePaneOff(target) {
  assertTarget(target);
  await runTmux(['pipe-pane', '-t', target]);
}

/**
 * Query a pane's current cursor position (0-based column/row, matching
 * `capture-pane`'s coordinate space) — used to reposition the cursor after
 * seeding a fresh agent-mode client with a `capture-pane` redraw (the redraw
 * text alone carries no cursor-position escape).
 *
 * @param {string} target
 * @returns {Promise<{ x: number, y: number }>}
 */
export async function cursorPosition(target) {
  assertTarget(target);
  const { stdout } = await runTmux(['display-message', '-p', '-t', target, '#{cursor_x} #{cursor_y}']);
  const [x, y] = stdout.trim().split(/\s+/).map(Number);
  return { x: Number.isFinite(x) ? x : 0, y: Number.isFinite(y) ? y : 0 };
}

/**
 * Query a pane's real, current geometry (columns/rows) — the AUTHORITATIVE
 * size of the tmux pane itself, independent of any viewer's xterm grid.
 * Agent-mode never resizes this pane (see resizeClient's early-return in
 * pty-bridge.js), so the caller uses this to size ITS OWN xterm grid to
 * match the pane exactly, then visually scales the result to fill the
 * viewport — the inverse of the normal "resize the pane to fit the client"
 * flow this app uses everywhere else.
 *
 * @param {string} target
 * @returns {Promise<{ cols: number, rows: number }>}
 */
export async function paneSize(target) {
  assertTarget(target);
  const { stdout } = await runTmux(['display-message', '-p', '-t', target, '#{pane_width} #{pane_height}']);
  const [cols, rows] = stdout.trim().split(/\s+/).map(Number);
  return { cols: Number.isFinite(cols) ? cols : 0, rows: Number.isFinite(rows) ? rows : 0 };
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

const AUTH_PATH_RE = /\/auth\/[^/\s]+\/[^/\s]+/g;

/**
 * Redact the olam auth-worker path-bearer shape from pane text (design T8).
 *
 * Claudex sessions point ANTHROPIC_BASE_URL at
 * `https://<authHost>/auth/<sub>/<secret>` — if the CLI (or the shell) ever
 * echoes that URL into the pane, the sub+secret pair would reach REMOTE
 * viewers via LivePane/transcript captures. This rewrites every
 * `/auth/<seg>/<seg>` occurrence (segment = run of non-'/', non-whitespace
 * chars) to `/auth/<redacted>/<redacted>`, preserving any suffix
 * (e.g. `/v1/messages`). Catches the shape inside full URLs and bare paths;
 * leaves unrelated text (e.g. `/authors/x/y`, `/auth/one-seg`) untouched.
 * Applied at the single capturePane return seam so every capture mode
 * (escapes, join, visibleOnly) inherits it.
 *
 * Newline-tolerant follow-up (Fix 4): capture-pane WITHOUT `-J` emits one
 * physical line per pane ROW, and a ~140-char bearer URL hard-wraps mid-
 * secret in an 80-col pane — line 1 ends `…/auth/<sub>/<secretHead>` (caught
 * by the regex above) and line 2 STARTS with `<secretTail>`, which the
 * single-line regex can never see (the char class excludes `\n`, so a match
 * never spans a line break). When a line's redacted match reaches EXACTLY
 * the end of that line (no trailing chars before the `\n`), this ALSO
 * redacts the immediately-following line's leading non-whitespace run.
 *
 * This is deliberately conservative, not precise: capture-pane's `-p` text
 * gives NO signal distinguishing "wrapped mid-value" from "a complete
 * /auth/x/y that just happens to be the last thing on an otherwise normal
 * line" — both look identical once redacted. The tradeoff is accepted in
 * the safer direction: an unrelated next line's leading word can get
 * over-redacted (false positive, harmless — it's page/log noise), but a
 * genuine secret tail is never left unredacted (false negative avoided).
 * Only applies when the match ends AT end-of-line; a redacted match with
 * trailing text (e.g. `/v1/messages`) never triggers it.
 *
 * Known limit: ANSI escape sequences interleaved INSIDE the path segments
 * themselves can split the shape so the regex misses it; escapes in the
 * surrounding text are fine. Phase C verifies CC's actual echo behavior.
 *
 * @param {string} text
 * @returns {string}
 */
export function redactBearerPaths(text) {
  if (typeof text !== 'string' || text.length === 0) return text;

  const lines = text.split('\n').map((line) => {
    let endsAtEol = false;
    const out = line.replace(AUTH_PATH_RE, (match, offset) => {
      if (offset + match.length === line.length) endsAtEol = true;
      return '/auth/<redacted>/<redacted>';
    });
    return { out, endsAtEol };
  });

  for (let i = 0; i < lines.length - 1; i++) {
    if (lines[i].endsAtEol) {
      lines[i + 1].out = lines[i + 1].out.replace(/^\S+/, '<redacted>');
    }
  }

  return lines.map((l) => l.out).join('\n');
}

/**
 * Capture the visible content of a tmux pane.
 * `-e` preserves ANSI escape sequences (server may strip before forwarding).
 * `-J` joins soft-wrapped lines so a URL split across pane columns is
 * reconstructed into a single logical line.
 *
 * @param {string} target
 * @param {number} [lines=40]  How many history lines above the visible area to include.
 * @param {boolean} [escapes=false]  Pass `-e` to keep ANSI/SGR sequences.
 * @param {boolean} [join=false]     Pass `-J` to rejoin soft-wrapped lines.
 * @param {{ _run?: Function }} [_injected]  Test-only seam; omit in production.
 * @returns {Promise<string>}
 */
export async function capturePane(target, lines = 40, escapes = false, join = false, { _run, visibleOnly = false } = {}) {
  assertTarget(target);
  const runner = _run ?? runTmux;
  const args = ['capture-pane', '-t', target, '-p'];
  // `-e` keeps ANSI/SGR sequences so the client can render terminal colors. Off
  // by default: LivePane / AskModal render plain text (escapes would show as
  // garbage). The composer terminal view opts in to get a themed, colored pane.
  if (escapes) args.push('-e');
  // `-J` rejoins soft-wrapped lines into logical lines so that a URL split
  // across narrow pane columns is reconstructed before the client linkifies it.
  if (join) args.push('-J');
  // visibleOnly: capture ONLY the on-screen pane (no `-S`), never scrollback.
  // Prompt/question detection MUST use this — a `-S -N` window pulls in an
  // already-answered picker that scrolled into history (frozen WITH its ❯ cursor
  // + "esc to cancel" footer), which re-fires the prompt after it was answered
  // and lets stray numbered prose in history look like a live menu. The active
  // picker always renders on the visible screen, so visible-only is sufficient.
  if (!visibleOnly) args.push('-S', `-${lines}`); // start N lines above the visible area
  const { stdout } = await runner(args);
  // Single redaction seam (design T8): strip the /auth/<sub>/<secret>
  // path-bearer shape before pane text reaches LivePane/transcript/remote
  // viewers. Applied before return so escapes/join modes inherit it.
  //
  // Residual (disclosure, not a fix here): this seam covers the POLL-CAPTURE
  // surfaces (LivePane/transcript/prompt-detection) ONLY — every one of them
  // routes through this function. It does NOT cover the raw STREAMING
  // surfaces: lib/pty-bridge.js's WS stream and the /term/ ttyd pass-through
  // both forward pane bytes directly, bypassing capturePane entirely, so an
  // echoed bearer URL would reach those viewers unredacted. Residual risk
  // accepted after the session-env unset (see createWindow/createTmuxSession)
  // removed the likeliest echo source; Phase C verifies CC's actual echo
  // behavior on the streaming surfaces.
  return redactBearerPaths(stdout);
}
