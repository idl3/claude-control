/**
 * lib/pty-bridge.js — WS binary PTY bridge that replaces the ttyd daemon.
 *
 * Attaches ONE node-pty process (`tmux attach -t <target>`) per session and
 * fans its output out to N subscriber WebSockets. Ports lib/terminal.js's
 * resource model (see that file's header) onto node-pty instead of ttyd:
 *   (a) dedupe map keyed by session id — a second attach reuses the live pty.
 *   (b) `clients: Map<ws, size>` ref-count — the pty is killed once the last
 *       client detaches (after a short idle grace, mirroring terminal.js).
 *   (c) largest-client window sizing — a resize from a small viewer never
 *       shrinks the pty below another viewer's last reported size.
 *   (d) LRU + MAX cap on live ptys, idle-preferred eviction.
 * Per-view attach (one node-pty per WebSocket) is explicitly REJECTED — N
 * attaches to the same tmux target fight its window-size negotiation.
 *
 * CLEAN SINGLE-PANE VIEW (not a raw `tmux attach`): a plain `tmux attach -t
 * <target>` gives a full tmux CLIENT view — status bar + window list — not a
 * focused single pane. Instead, each attach creates a per-session EPHEMERAL,
 * GROUPED tmux session (`new-session -t <base> -s <ephemeral>`: shares the
 * base session's windows, but has independently-settable options and its own
 * current-window pointer) with its status bar hidden and pinned to the
 * target's window, and node-pty attaches to THAT instead of the base. See
 * `parseTarget`/`ephemeralSessionName` and `ensurePty`'s setup sequence below
 * for the exact commands. The base session is NEVER mutated or killed — only
 * the ephemeral one. Because the base session might not exist at all (or its
 * window/pane might not), and `new-session -t <nonexistent-base>` does NOT
 * reliably fail (empirically verified against tmux 3.6a: it silently creates
 * a standalone, ungrouped session instead of erroring), liveness is checked
 * up front with `has-session -t <full-target>` — which correctly validates
 * session+window+pane existence and fails loudly — before any ephemeral
 * session is created.
 *
 * Wire protocol (lib/protocol/pty.js): JSON text frames for control
 * (attach/resize/close client->server; attached/error server->client),
 * validated with zod. Binary frames carry a 1-byte channel header
 * (PTY_CHANNEL_DATA = 0x00) + opaque terminal bytes — NOT zod-validated,
 * framed here only.
 *
 * CRITICAL testability constraint: this shell may run Node versions with no
 * node-pty prebuild. The bridge therefore never imports `node-pty` at module
 * load time — `defaultNodePtySpawn` lazy-`import()`s it on first REAL use
 * only, so requiring this module (and every test that injects its own
 * `spawn`) works with zero native module present. See that function's
 * comment for a real, reproducible packaging quirk it also repairs. The
 * ephemeral-session tmux setup commands (has-session/new-session/set-option/
 * select-window/select-pane/kill-session) go through a SEPARATE injectable
 * seam (`runTmuxCmd`, defaulting to a plain execFile runner) so hermetic
 * tests stay hermetic without needing to fake the long-lived `spawn` seam
 * for these short-lived, quickly-resolving commands.
 *
 * ESM, ws + zod + Node built-ins only (CONTRACT). ONE tmux target string
 * ever reaches spawn — always validated with tmux.isValidTarget first,
 * always via an argv array (never a shell).
 */

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { isValidTarget, resolveTmuxBin as defaultResolveTmuxBin, getSocketPath as defaultGetSocketPath } from './tmux.js';
import { PtyClientMessageSchema, PtyServerMessageSchema } from './protocol/pty.js';
import { checkWsToken } from './auth.js';
import { encodeWsMessage, sendWsMessage, DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES } from './ws-backpressure.js';

const execFileP = promisify(_execFile);

// Client -> server / server -> client binary frames are a 1-byte channel
// header + opaque payload. 0x00 is the only channel Phase A defines; other
// values are reserved for future multiplexing and are silently ignored so
// this stays forward-compatible without a protocol version bump.
export const PTY_CHANNEL_DATA = 0x00;
const PTY_DATA_HEADER = Buffer.from([PTY_CHANNEL_DATA]);

// Initial pty size before any client has sent a `resize` frame. Overridden
// upward/downward by the largest-client algorithm as soon as one arrives.
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

// How long to wait, after spawning, for an immediate exit (tmux attaching to
// a target that doesn't exist prints an error and exits near-instantly —
// measured ~13-15ms for a real tmux on loopback, hundreds of ms of margin
// below this default) before declaring the attach alive. A genuinely live
// tmux session never exits in this window; it starts streaming its initial
// screen redraw instead.
const DEFAULT_DEAD_TARGET_GRACE_MS = Number(process.env.CLAUDE_CONTROL_PTY_DEAD_GRACE_MS) || 200;

// Reap a pty that has had zero clients for this long (mirrors
// lib/terminal.js's IDLE_GRACE_MS — absorbs page reloads/panel re-mounts).
const DEFAULT_IDLE_GRACE_MS = Number(process.env.CLAUDE_CONTROL_PTY_IDLE_MS) || 30_000;

// Hard ceiling on concurrent attached ptys (resource bound, mirrors
// lib/terminal.js's MAX_TERMINALS).
const DEFAULT_MAX_PTYS = Number(process.env.CLAUDE_CONTROL_PTY_MAX) || 4;

/**
 * @typedef {Object} PtyHandle a minimal pty handle — the injected-spawn seam.
 * @property {number} pid
 * @property {(data: Buffer|string) => void} write
 * @property {(cols: number, rows: number) => void} resize
 * @property {(signal?: string) => void} kill
 * @property {(cb: (chunk: Buffer|string) => void) => void} onData
 * @property {(cb: (info: { exitCode: number, signal?: number|string|null }) => void) => void} onExit
 */

/**
 * @typedef {{
 *   pty: PtyHandle|null,
 *   target: string,
 *   clients: Map<unknown, { cols: number, rows: number }>,
 *   idleTimer: NodeJS.Timeout|null,
 *   lastUsed: number,
 *   cols: number,
 *   rows: number,
 *   alive: boolean,
 *   ready: Promise<void>,
 *   ephemeralSession: string|null,
 *   tmuxBin: string|null,
 *   socketPath: string|null,
 * }} PtyEntry
 */

/** Raised when a tmux target is unknown, invalid, or the spawned attach died before it was confirmed alive (see DEFAULT_DEAD_TARGET_GRACE_MS). Maps 1:1 to PtyErrorCodeSchema's `'dead-target'`. */
export class DeadTargetError extends Error {}

// ---------------------------------------------------------------------------
// Ephemeral grouped-session helpers (clean single-pane view)
// ---------------------------------------------------------------------------

/** Deterministic prefix for the per-attach ephemeral grouped tmux sessions this bridge creates — lets `sweepOrphanedEphemeralSessions` (below) find and reap any left behind by a prior crash, without touching sessions this bridge didn't create. */
export const EPHEMERAL_SESSION_PREFIX = '_ccpty_';

/**
 * Split a tmux target already confirmed valid by `tmux.isValidTarget`
 * (`session:window` or `session:window.pane` — see tmux.js's TARGET_RE,
 * whose session-name char class excludes `:`, so exactly one `:` ever
 * appears) into its base-session, window, and optional pane parts.
 *
 * @param {string} target  e.g. "main:1.0" or "main:1"
 * @returns {{ session: string, window: string, pane: string|null }}
 */
export function parseTarget(target) {
  const colonIdx = target.indexOf(':');
  const session = target.slice(0, colonIdx);
  const rest = target.slice(colonIdx + 1);
  const dotIdx = rest.indexOf('.');
  if (dotIdx === -1) return { session, window: rest, pane: null };
  return { session, window: rest.slice(0, dotIdx), pane: rest.slice(dotIdx + 1) };
}

/**
 * Deterministic ephemeral grouped-session name for a given target — same
 * target always yields the same name, so the existing per-session dedupe
 * (`ensurePty`'s `ptys` map) still yields exactly ONE ephemeral session (and
 * ONE node-pty) for N concurrent viewers, and a later re-attach after
 * teardown reuses the same, freshly (re)created name. tmux session names may
 * contain almost any byte, but `:`/`.` are the target-string delimiters —
 * stripping them (along with anything else non-alphanumeric) means the name
 * can never be misparsed as a compound target when used bare as `-t <name>`.
 *
 * @param {string} target
 * @returns {string} e.g. "_ccpty_main_1_0"
 */
export function ephemeralSessionName(target) {
  const sanitized = String(target).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 200);
  return `${EPHEMERAL_SESSION_PREFIX}${sanitized}`;
}

/**
 * Default real tmux-command runner for the ephemeral-session setup commands
 * (has-session/new-session/set-option/select-window/select-pane/kill-session/
 * list-sessions) — deliberately SEPARATE from `_spawn` (which owns only the
 * one long-lived `attach` process per pty entry). Plain execFile, argv array,
 * never a shell. Hermetic tests always inject their own `runTmuxCmd` stub —
 * see test/pty-bridge.test.js.
 *
 * @param {string} tmuxBin
 * @param {string[]} args
 * @returns {Promise<{ stdout: string, stderr: string }>}
 */
async function defaultRunTmuxCmd(tmuxBin, args) {
  return execFileP(tmuxBin, args, { timeout: 10_000, maxBuffer: 4 * 1024 * 1024 });
}

let _nodePtyModule = null;

/**
 * Lazily load the real `node-pty` module and repair a real, reproducible
 * packaging defect: node-pty ships its unix prebuilds' `spawn-helper` binary
 * inside its own npm tarball, but on some npm/platform combinations the
 * executable bit does not survive publish/extract (observed firsthand on
 * Node 25/darwin-arm64 — `spawn-helper` lands `-rw-r--r--`, and every
 * `pty.spawn()` then throws `posix_spawnp failed` synchronously, even though
 * the native addon itself loaded fine). node-pty's own postinstall script
 * only handles the Windows conpty.dll copy, not this. Self-heal by chmod-ing
 * the helper +x before first real spawn; a no-op once it's already correct.
 *
 * Exported (beyond internal use by defaultNodePtySpawn) so diagnostics/tests
 * — e.g. test/pty-bridge.integration.test.js's dev-only real-tmux smoke check
 * — can probe real node-pty usability through the SAME self-healing path
 * production uses, instead of bypassing it with a raw `import('node-pty')`.
 *
 * @returns {Promise<{spawn: Function}>}
 */
export async function loadNodePty() {
  if (_nodePtyModule) return _nodePtyModule;
  const mod = await import('node-pty');
  const nodePty = mod.spawn ? mod : mod.default;
  if (!nodePty || typeof nodePty.spawn !== 'function') {
    throw new Error('node-pty loaded but does not export spawn()');
  }
  if (process.platform !== 'win32') {
    try {
      // import.meta.resolve is synchronous (stable since Node 20.6, no flag).
      const pkgUrl = import.meta.resolve('node-pty/package.json');
      const pkgDir = path.dirname(fileURLToPath(pkgUrl));
      const helper = path.join(pkgDir, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
      if (fs.existsSync(helper)) {
        const mode = fs.statSync(helper).mode;
        // eslint-disable-next-line no-bitwise
        if ((mode & 0o111) === 0) fs.chmodSync(helper, mode | 0o755);
      }
    } catch {
      // Best-effort repair only — if resolution fails, fall through and let
      // the real spawn error (if any) surface to the caller normally.
    }
  }
  _nodePtyModule = nodePty;
  return nodePty;
}

/**
 * Default real spawn: `node-pty`, loaded lazily (see loadNodePty). Never
 * imported at module scope so requiring pty-bridge.js — and every hermetic
 * test that injects its own `spawn` — costs nothing and needs no native
 * module.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cols: number, rows: number, name?: string }} opts
 * @returns {Promise<PtyHandle>}
 */
async function defaultNodePtySpawn(cmd, args, opts) {
  const nodePty = await loadNodePty();
  const pty = nodePty.spawn(cmd, args, {
    name: opts?.name || 'xterm-256color',
    cols: opts?.cols || DEFAULT_COLS,
    rows: opts?.rows || DEFAULT_ROWS,
    // Force a UTF-8 locale — same reasoning as lib/terminal.js's ttyd spawn:
    // under launchd the service inherits no LANG/LC_ALL, and tmux's TUI
    // box-drawing / wide glyphs mangle under the C/POSIX locale fallback.
    env: {
      ...process.env,
      LANG: process.env.LANG || 'en_US.UTF-8',
      LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
    },
  });
  return {
    pid: pty.pid,
    write: (data) => pty.write(Buffer.isBuffer(data) ? data.toString('utf8') : String(data)),
    resize: (cols, rows) => { try { pty.resize(cols, rows); } catch { /* pty may have just exited */ } },
    kill: (signal) => { try { pty.kill(signal); } catch { /* already gone */ } },
    onData: (cb) => pty.onData((chunk) => cb(chunk)),
    onExit: (cb) => pty.onExit((e) => cb({ exitCode: e.exitCode, signal: e.signal })),
  };
}

/**
 * A no-op audit sink used when no `log` dep is injected in tests. Production
 * wiring (server.js) should inject a real one, but a console fallback keeps
 * `createPtyBridge()` usable standalone.
 * @param {Record<string, unknown>} fields
 */
function defaultAuditLog(fields) {
  // eslint-disable-next-line no-console
  console.log(`[pty-bridge] ${JSON.stringify(fields)}`);
}

/**
 * Handle a `/pty` WebSocket upgrade: bearer-gate with the SAME mechanism as
 * the main WS (checkWsToken / WS_PROTOCOL subprotocol — see lib/auth.js),
 * then hand off to `wss`. No new unauthenticated surface: a rejected
 * upgrade never reaches `wss.handleUpgrade` and the raw HTTP socket is
 * closed with 401, mirroring server.js's existing main-WS gate
 * (a JSON `PtyError{code:'unauthorized'}` frame is not possible here — the
 * WS handshake itself hasn't completed yet).
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:net').Socket} socket
 * @param {Buffer} head
 * @param {{ wss: { handleUpgrade: Function, emit: Function }, token: string|null|undefined, checkAuth?: Function }} opts
 * @returns {boolean} true if the upgrade was accepted and handed to `wss`
 */
export function handlePtyUpgrade(req, socket, head, { wss, token, checkAuth = checkWsToken } = {}) {
  if (!checkAuth(req, token)) {
    try {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
    } catch { /* socket may already be gone */ }
    return false;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  return true;
}

/**
 * @param {{
 *   spawn?: (cmd: string, args: string[], opts: object) => Promise<PtyHandle>|PtyHandle,
 *   resolveTarget?: (sessionId: string) => Promise<{target: string}|null>|{target: string}|null,
 *   resolveTmuxBin?: () => Promise<string>,
 *   getSocketPath?: () => Promise<string>,
 *   runTmuxCmd?: (tmuxBin: string, args: string[]) => Promise<{stdout: string, stderr: string}>,
 *   wait?: (ms: number) => Promise<void>,
 *   scheduleIdleReap?: (fn: () => void, ms: number) => unknown,
 *   clearIdleReap?: (timer: unknown) => void,
 *   now?: () => number,
 *   log?: (fields: Record<string, unknown>) => void,
 *   deadTargetGraceMs?: number,
 *   idleGraceMs?: number,
 *   maxPtys?: number,
 *   wsBufferLimitBytes?: number,
 * }} [deps]
 */
export function createPtyBridge(deps = {}) {
  const _spawn = deps.spawn || defaultNodePtySpawn;
  // Default: treat the session id as the tmux target directly (mirrors
  // lib/terminal.js's model, where the ttyd registry key IS the target).
  // server.js's real wiring injects a registry-backed resolver instead.
  const _resolveTarget = deps.resolveTarget || ((sessionId) => ({ target: sessionId }));
  const _resolveTmuxBin = deps.resolveTmuxBin || defaultResolveTmuxBin;
  const _getSocketPath = deps.getSocketPath || defaultGetSocketPath;
  const _runTmuxCmd = deps.runTmuxCmd || defaultRunTmuxCmd;
  const _wait = deps.wait || ((ms) => new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  }));
  const _scheduleIdleReap = deps.scheduleIdleReap || ((fn, ms) => {
    const t = setTimeout(fn, ms);
    t.unref?.();
    return t;
  });
  const _clearIdleReap = deps.clearIdleReap || clearTimeout;
  const _now = deps.now || (() => Date.now());
  const _log = deps.log || defaultAuditLog;
  const _deadGraceMs = deps.deadTargetGraceMs ?? DEFAULT_DEAD_TARGET_GRACE_MS;
  const _idleGraceMs = deps.idleGraceMs ?? DEFAULT_IDLE_GRACE_MS;
  const _maxPtys = deps.maxPtys ?? DEFAULT_MAX_PTYS;
  const _wsBufferLimitBytes = deps.wsBufferLimitBytes ?? DEFAULT_WS_BACKPRESSURE_LIMIT_BYTES;

  /** sessionId -> PtyEntry */
  const ptys = new Map();

  /**
   * Best-effort, non-throwing kill of an entry's ephemeral grouped session
   * (never the base session — the ephemeral name is a DIFFERENT tmux session
   * that merely shares the base's windows). No-ops if the entry never got
   * far enough to create one. Nulls `entry.ephemeralSession` first so a
   * concurrent caller (e.g. the pty's onExit firing around the same time as
   * an explicit reap) can't attempt a double kill.
   * @param {PtyEntry} entry
   * @returns {Promise<void>}
   */
  async function killEphemeralSession(entry) {
    if (!entry.ephemeralSession || !entry.tmuxBin || !entry.socketPath) return;
    const name = entry.ephemeralSession;
    entry.ephemeralSession = null;
    try {
      await _runTmuxCmd(entry.tmuxBin, ['-S', entry.socketPath, 'kill-session', '-t', name]);
    } catch (err) {
      _log({ event: 'pty-ephemeral-kill-failed', ephemeralSession: name, error: String(err?.message || err) });
    }
  }

  /**
   * Sweep + kill any orphaned `_ccpty_*` ephemeral sessions left behind by a
   * prior crash (this process died between creating one and tearing it down
   * on exit/reap). Runs once at bridge creation, fire-and-forget — never
   * throws, never blocks `createPtyBridge()`'s return. Exposed on the
   * returned bridge as `ephemeralSweepDone` purely so tests can await
   * completion deterministically; production callers ignore it.
   * @returns {Promise<void>}
   */
  async function sweepOrphanedEphemeralSessions() {
    try {
      const tmuxBin = await _resolveTmuxBin();
      const socket = await _getSocketPath();
      const { stdout } = await _runTmuxCmd(tmuxBin, ['-S', socket, 'list-sessions', '-F', '#{session_name}']);
      const names = String(stdout || '').split('\n').map((s) => s.trim()).filter(Boolean);
      const orphans = names.filter((n) => n.startsWith(EPHEMERAL_SESSION_PREFIX));
      for (const name of orphans) {
        try {
          await _runTmuxCmd(tmuxBin, ['-S', socket, 'kill-session', '-t', name]);
          _log({ event: 'pty-ephemeral-orphan-swept', name });
        } catch (err) {
          _log({ event: 'pty-ephemeral-orphan-sweep-kill-failed', name, error: String(err?.message || err) });
        }
      }
    } catch (err) {
      // No tmux server / not resolvable / no sessions at all yet — the
      // common case on a fresh boot. Nothing to sweep; not an error.
      _log({ event: 'pty-ephemeral-orphan-sweep-skipped', error: String(err?.message || err) });
    }
  }

  const ephemeralSweepDone = sweepOrphanedEphemeralSessions();

  /** Send a validated JSON control frame to one client. */
  function sendControl(ws, frame) {
    const parsed = PtyServerMessageSchema.safeParse(frame);
    if (!parsed.success) {
      _log({ event: 'invalid-outgoing-frame', error: String(parsed.error?.message || parsed.error) });
      return;
    }
    sendWsMessage(ws, encodeWsMessage(parsed.data), { limitBytes: _wsBufferLimitBytes });
  }

  /** Notify every client of a dead entry with a typed error, then close 4000. */
  function killEntryClientsWithError(entry, code, message) {
    for (const ws of entry.clients.keys()) {
      sendControl(ws, { type: 'error', code, message });
      try { ws.close(4000, code); } catch { /* already closed */ }
    }
    entry.clients.clear();
  }

  /**
   * LRU eviction: prefer an idle (0-client) entry; among equally-idle (or
   * equally-busy) entries, evict the least-recently-used. Mirrors
   * lib/terminal.js's `ensureTerminal` eviction loop exactly. A victim that
   * still has clients is closed with a generic (non-error) code — eviction
   * is a capacity decision, not a target failure.
   * @returns {boolean} true if something was evicted
   */
  function evictOne() {
    let victimId = null;
    let victim = null;
    for (const [id, entry] of ptys) {
      if (!victim) { victimId = id; victim = entry; continue; }
      const vIdle = victim.clients.size === 0;
      const eIdle = entry.clients.size === 0;
      if (eIdle && !vIdle) { victimId = id; victim = entry; }
      else if (eIdle === vIdle && (entry.lastUsed || 0) < (victim.lastUsed || 0)) { victimId = id; victim = entry; }
    }
    if (victimId == null) return false;
    const entry = ptys.get(victimId);
    if (entry.idleTimer) _clearIdleReap(entry.idleTimer);
    entry.alive = false;
    ptys.delete(victimId);
    for (const ws of entry.clients.keys()) {
      try { ws.close(1001, 'terminal evicted (capacity)'); } catch { /* already closed */ }
    }
    entry.clients.clear();
    if (entry.pty) entry.pty.kill();
    killEphemeralSession(entry);
    return true;
  }

  /**
   * Compute the largest cols/rows across all currently-sized clients of an
   * entry ("largest-client" sizing — an extra small viewer never shrinks a
   * larger one's view). Clients that haven't sent a `resize` yet (cols=0)
   * don't contribute. Falls back to the entry's current size if nobody has
   * sized yet.
   */
  function largestSize(entry) {
    let maxCols = 0;
    let maxRows = 0;
    for (const size of entry.clients.values()) {
      if (size.cols > maxCols) maxCols = size.cols;
      if (size.rows > maxRows) maxRows = size.rows;
    }
    return {
      cols: maxCols || entry.cols || DEFAULT_COLS,
      rows: maxRows || entry.rows || DEFAULT_ROWS,
    };
  }

  /**
   * Ensure a pty is attached for `sessionId` (bound to `target`) and return
   * its entry once confirmed alive. Reuses a live/in-flight entry (dedupe —
   * the entry is registered in `ptys` SYNCHRONOUSLY, before any `await`, so
   * concurrent first-hit attaches for the same session never race into two
   * spawns; mirrors lib/terminal.js's cache-stampede fix exactly).
   *
   * @param {string} sessionId
   * @param {string|null|undefined} target
   * @returns {Promise<PtyEntry>}
   * @throws {DeadTargetError}
   */
  async function ensurePty(sessionId, target) {
    const existing = ptys.get(sessionId);
    if (existing) {
      if (existing.idleTimer) { _clearIdleReap(existing.idleTimer); existing.idleTimer = null; }
      existing.lastUsed = _now();
      await existing.ready;
      return existing;
    }

    if (!target || !isValidTarget(target)) {
      throw new DeadTargetError(`unknown or invalid session: ${JSON.stringify(sessionId)}`);
    }

    while (ptys.size >= _maxPtys) {
      if (!evictOne()) break;
    }

    /** @type {PtyEntry} */
    const entry = {
      pty: null,
      target,
      clients: new Map(),
      idleTimer: null,
      lastUsed: _now(),
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      alive: false,
      ready: null,
      ephemeralSession: null,
      tmuxBin: null,
      socketPath: null,
    };

    entry.ready = (async () => {
      const tmuxBin = await _resolveTmuxBin();
      const socket = await _getSocketPath();
      entry.tmuxBin = tmuxBin;
      entry.socketPath = socket;

      const { session: baseSession, window, pane } = parseTarget(target);
      const ephemeralName = ephemeralSessionName(target);

      // Liveness check FIRST, against the FULL target (session+window+pane).
      // `new-session -t <base>` on a non-existent base does NOT reliably
      // fail (see module header) so it can't be trusted as the dead-target
      // signal on its own — `has-session` validates precisely and fails
      // loudly, and crucially runs BEFORE anything is created.
      try {
        await _runTmuxCmd(tmuxBin, ['-S', socket, 'has-session', '-t', target]);
      } catch (err) {
        ptys.delete(sessionId);
        throw new DeadTargetError(`unknown or dead tmux target ${JSON.stringify(target)}: ${err?.message || err}`);
      }

      // Defensive: clear out any leftover ephemeral session with this exact
      // deterministic name (e.g. a prior crash before the init-time orphan
      // sweep ran, or a teardown kill that failed) so `new-session` below
      // always starts from a clean slate. Best-effort — "no such session" is
      // the expected common case, not an error.
      try { await _runTmuxCmd(tmuxBin, ['-S', socket, 'kill-session', '-t', ephemeralName]); } catch { /* didn't exist */ }

      // Create the ephemeral GROUPED session (shares the base session's
      // windows; independent options + current-window), hide its status
      // bar, size to THIS client rather than the base's other clients, and
      // pin its current window to the target's window (never mutating the
      // base session's own current-window). See module header for why each
      // step targets what it targets.
      try {
        await _runTmuxCmd(tmuxBin, ['-S', socket, 'new-session', '-d', '-t', baseSession, '-s', ephemeralName]);
        // Created — from here on, ANY later failure in this try block MUST
        // clean it up (the catch below does), and normal teardown (reap /
        // evictOne / pty exit) must kill it too — never the base session.
        entry.ephemeralSession = ephemeralName;
        await _runTmuxCmd(tmuxBin, ['-S', socket, 'set-option', '-t', ephemeralName, 'status', 'off']);
        const windowTarget = `${ephemeralName}:${window}`;
        // `aggressive-resize` is a WINDOW option, not session-scoped — an
        // explicit window-qualified target (rather than the bare ephemeral
        // session name) is REQUIRED here: empirically verified that setting
        // it on the bare session name applies to whatever window happens to
        // be that session's "current" window at that moment (inherited from
        // the base at grouped-session creation time), which is not
        // necessarily our target window at all.
        await _runTmuxCmd(tmuxBin, ['-S', socket, 'set-option', '-t', windowTarget, 'aggressive-resize', 'on']);
        await _runTmuxCmd(tmuxBin, ['-S', socket, 'select-window', '-t', windowTarget]);
        if (pane != null) {
          await _runTmuxCmd(tmuxBin, ['-S', socket, 'select-pane', '-t', `${windowTarget}.${pane}`]);
        }
      } catch (err) {
        await killEphemeralSession(entry);
        ptys.delete(sessionId);
        throw new DeadTargetError(
          `failed to prepare grouped tmux session for target ${JSON.stringify(target)}: ${err?.message || err}`,
        );
      }

      const handle = await _spawn(tmuxBin, ['-S', socket, 'attach', '-t', ephemeralName], {
        name: 'xterm-256color',
        cols: DEFAULT_COLS,
        rows: DEFAULT_ROWS,
      });

      let exitInfo = null;
      handle.onExit((info) => {
        exitInfo = info;
        // Fires either (a) during the grace race below — exitInfo is read
        // synchronously after `_wait` resolves — or (b) later, after this
        // pty was confirmed alive and is in normal use: a genuine
        // session-ended event, unified with dead-target framing per the
        // Phase-A close-4000 design ("session ended / dead target").
        if (entry.alive) {
          entry.alive = false;
          if (entry.idleTimer) _clearIdleReap(entry.idleTimer);
          ptys.delete(sessionId);
          killEphemeralSession(entry); // fire-and-forget — never the base session
          killEntryClientsWithError(entry, 'dead-target', `tmux session ended (exit code=${info.exitCode})`);
        }
      });

      await _wait(_deadGraceMs);
      if (exitInfo) {
        ptys.delete(sessionId);
        await killEphemeralSession(entry);
        throw new DeadTargetError(
          `tmux attach failed for target ${JSON.stringify(target)} (exit code=${exitInfo.exitCode}, signal=${exitInfo.signal ?? 'none'})`,
        );
      }

      entry.pty = handle;
      entry.alive = true;
      handle.onData((chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
        const framed = Buffer.concat([PTY_DATA_HEADER, buf]);
        for (const ws of entry.clients.keys()) sendWsMessage(ws, framed, { limitBytes: _wsBufferLimitBytes });
      });
    })();

    // Synchronous insertion (before the IIFE above has had a chance to run
    // any awaited step) — the dedupe guarantee.
    ptys.set(sessionId, entry);

    await entry.ready;
    return entry;
  }

  /**
   * Attach a resize from one client and re-derive the pty size as the max
   * across all of this session's clients (largest-client sizing).
   */
  function resizeClient(sessionId, ws, cols, rows) {
    const entry = ptys.get(sessionId);
    if (!entry || !entry.clients.has(ws)) return;
    entry.clients.set(ws, { cols, rows });
    entry.lastUsed = _now();
    const size = largestSize(entry);
    if (size.cols !== entry.cols || size.rows !== entry.rows) {
      entry.cols = size.cols;
      entry.rows = size.rows;
      if (entry.pty) entry.pty.resize(size.cols, size.rows);
    }
  }

  /**
   * Ref-count teardown: drop `ws` from the entry's clients; once the last
   * client leaves, start an idle-grace timer and kill the pty if nobody
   * reattaches (mirrors lib/terminal.js's removeClient/reap pair).
   */
  function detachClient(sessionId, ws) {
    const entry = ptys.get(sessionId);
    if (!entry) return;
    entry.clients.delete(ws);
    if (entry.clients.size > 0) return;
    if (entry.idleTimer) _clearIdleReap(entry.idleTimer);
    entry.idleTimer = _scheduleIdleReap(() => reap(sessionId), _idleGraceMs);
  }

  /** Kill the pty for `sessionId` and drop its registry entry. No-op if already gone. */
  function reap(sessionId) {
    const entry = ptys.get(sessionId);
    if (!entry) return;
    if (entry.idleTimer) _clearIdleReap(entry.idleTimer);
    entry.alive = false;
    ptys.delete(sessionId);
    if (entry.pty) entry.pty.kill();
    killEphemeralSession(entry); // the EPHEMERAL session only — never the base
  }

  /**
   * Wire the full attach/resize/close/data protocol onto one WS connection.
   * Call from the `wss`'s `'connection'` listener after `handlePtyUpgrade`
   * has already authenticated the upgrade.
   *
   * @param {{ on: Function, close: Function, readyState: number, OPEN: number }} ws
   * @param {import('node:http').IncomingMessage} [req]
   */
  function handleConnection(ws, req) {
    let sessionId = null;
    let entryRef = null;

    ws.on('message', (raw, isBinary) => {
      if (isBinary) {
        if (!sessionId || !entryRef || !entryRef.pty) return;
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        if (buf.length < 1 || buf[0] !== PTY_CHANNEL_DATA) return;
        try { entryRef.pty.write(buf.subarray(1)); } catch { /* pty may have just exited */ }
        return;
      }

      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      const parsed = PtyClientMessageSchema.safeParse(msg);
      if (!parsed.success) return;
      const m = parsed.data;

      if (m.type === 'attach') {
        if (sessionId) return; // one session per connection — ignore re-attach
        const requestedId = m.sessionId;
        sessionId = requestedId;
        (async () => {
          try {
            const resolved = await _resolveTarget(requestedId);
            const target = resolved && resolved.target;
            const entry = await ensurePty(requestedId, target);
            if (ws.readyState !== ws.OPEN) { detachClient(requestedId, ws); return; }
            entry.clients.set(ws, { cols: 0, rows: 0 });
            entry.lastUsed = _now();
            entryRef = entry;
            _log({
              event: 'attach',
              sessionId: requestedId,
              target: entry.target,
              remote: req?.socket?.remoteAddress || 'unknown',
              at: new Date().toISOString(),
            });
            sendControl(ws, { type: 'attached', sessionId: requestedId });
          } catch (err) {
            sessionId = null;
            entryRef = null;
            sendControl(ws, { type: 'error', code: 'dead-target', message: err?.message || 'attach failed' });
            try { ws.close(4000, 'dead-target'); } catch { /* already closed */ }
          }
        })();
        return;
      }

      if (m.type === 'resize') {
        if (!sessionId) return;
        resizeClient(sessionId, ws, m.cols, m.rows);
        return;
      }

      if (m.type === 'close') {
        if (!sessionId || m.sessionId !== sessionId) return;
        detachClient(sessionId, ws);
        sessionId = null;
        entryRef = null;
        try { ws.close(1000, 'closed'); } catch { /* already closed */ }
      }
    });

    ws.on('close', () => {
      if (sessionId) detachClient(sessionId, ws);
    });
  }

  /** Kill every live pty. Call from the server's shutdown handler. */
  function shutdownAll() {
    for (const id of [...ptys.keys()]) reap(id);
  }

  /** Test/diagnostic helper: number of live ptys. */
  function liveCount() {
    return ptys.size;
  }

  return { handleConnection, shutdownAll, liveCount, ephemeralSweepDone };
}
