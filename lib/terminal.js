/**
 * lib/terminal.js — on-demand ttyd lifecycle for the raw-terminal escape hatch.
 *
 * ESM, Node >=20 built-ins only (no new runtime deps — CONTRACT: only `ws`).
 * Spawns a per-target `ttyd` bound to 127.0.0.1 on an ephemeral port, attached
 * to the session's tmux pane via `tmux -S <socket> attach -t <target>`. ttyd
 * itself runs with NO basic-auth (`-W -i 127.0.0.1`): it is reachable only
 * through claude-control's token-gated reverse proxy, which is the auth gate.
 *
 * Lifecycle mirrors server.js's `maybeTeardown` ref-count: clients are counted
 * per terminal; when the last client disconnects we start an idle grace timer
 * and reap the ttyd process if no client reconnects. A global cap bounds the
 * number of live ttyd processes. All processes are killed on server shutdown.
 *
 * Never shells out with user text — `spawn` with an args array. The session id
 * is the tmux target string and is validated with `tmux.isValidTarget` (which
 * enforces the CONTRACT pattern) before it ever reaches `spawn`.
 */

import { spawn } from 'node:child_process';
import net from 'node:net';
import fs from 'node:fs';

import * as tmux from './tmux.js';

// Resolve the ttyd binary robustly instead of hardcoding a Homebrew-arm64 path
// (which ENOENTs on Intel macOS /usr/local, Linux, or custom installs): honor
// CLAUDE_CONTROL_TTYD, then probe common locations, else fall back to PATH.
function resolveTtyd() {
  if (process.env.CLAUDE_CONTROL_TTYD) return process.env.CLAUDE_CONTROL_TTYD;
  for (const p of ['/opt/homebrew/bin/ttyd', '/usr/local/bin/ttyd', '/usr/bin/ttyd']) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* next */ }
  }
  return 'ttyd'; // last resort: let the spawn PATH resolve it
}

const TTYD_BIN = resolveTtyd();

// Reap a ttyd that has had zero clients for this long. A short grace absorbs
// page reloads / iframe re-mounts without thrashing the process.
const IDLE_GRACE_MS = Number(process.env.CLAUDE_CONTROL_TERM_IDLE_MS) || 30_000;

// Hard ceiling on concurrent ttyd processes (resource bound, per plan P1).
const MAX_TERMINALS = Number(process.env.CLAUDE_CONTROL_TERM_MAX) || 4;

// xterm.js font size for the passthrough. Well below the default (15) so the
// attached tmux pane fits more rows AND columns → a tall multi-option TUI
// question fits without scrolling its first options off-screen, and the agent
// TUI stops wrapping (robust question parsing). Overridable per device.
// ponytail: a const + env knob, not a settings UI — set CLAUDE_CONTROL_TERM_FONT
// if a screen needs different.
const TTYD_FONT_SIZE = Number(process.env.CLAUDE_CONTROL_TERM_FONT) || 10;

// How long to wait for a freshly-spawned ttyd to start accepting connections
// on its ephemeral port before giving up.
const READY_TIMEOUT_MS = 5_000;

/** @typedef {{ proc: import('node:child_process').ChildProcess, port: number, target: string, clients: Set<unknown>, idleTimer: NodeJS.Timeout | null, ready: Promise<number> }} Terminal */

/** id (tmux target) -> Terminal */
const terminals = new Map();

/**
 * Find a free ephemeral TCP port on 127.0.0.1 by binding port 0 and reading
 * back the assigned port. There is an unavoidable tiny race between close and
 * ttyd's bind, but ttyd binds immediately on spawn and a collision simply
 * surfaces as a failed `ensureTerminal` (the caller returns an error).
 *
 * @returns {Promise<number>}
 */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Resolve once a TCP connect to 127.0.0.1:port succeeds, or reject on timeout.
 * Used to gate the first proxied request until ttyd is actually listening.
 *
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<number>} the port, once ready
 */
function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const sock = net.connect(port, '127.0.0.1');
      sock.once('connect', () => {
        sock.destroy();
        resolve(port);
      });
      sock.once('error', () => {
        sock.destroy();
        if (Date.now() >= deadline) {
          reject(new Error(`ttyd on :${port} did not become ready in ${timeoutMs}ms`));
        } else {
          setTimeout(attempt, 100);
        }
      });
    };
    attempt();
  });
}

/**
 * The URL base path used in links the browser navigates to. The id (a tmux
 * target like `name:0`) is percent-encoded so the path is a single safe
 * segment. The proxy forwards this verbatim to ttyd, which URL-decodes the
 * request path before routing (verified: ttyd 1.7.7 / libwebsockets decodes
 * `%3A` → `:` and matches against the decoded `-b` value).
 *
 * @param {string} id
 * @returns {string} e.g. "/term/name%3A0"
 */
export function basePathFor(id) {
  return `/term/${encodeURIComponent(id)}`;
}

/**
 * The literal base path passed to ttyd's `-b` flag. ttyd routes on the DECODED
 * request path, so `-b` must be the decoded form (`/term/name:0`) — NOT the
 * percent-encoded URL form. With the decoded base, ttyd serves 200 for both the
 * encoded (`%3A`) and decoded request paths, and the asset/WS links it
 * generates resolve under this prefix. (OQ7 resolved at build: an encoded `-b`
 * yields 404 for every request.)
 *
 * @param {string} id
 * @returns {string} e.g. "/term/name:0"
 */
export function ttydBasePath(id) {
  return `/term/${id}`;
}

/**
 * Ensure a ttyd is running for `id` (a tmux target) and return its loopback
 * port once it is accepting connections. Reuses a live process if present.
 *
 * @param {string} id    the session id == tmux target string
 * @param {string} target the tmux target to attach to (validated here)
 * @returns {Promise<{ port: number }>}
 * @throws if the target is invalid, the cap is hit, or ttyd fails to start
 */
export async function ensureTerminal(id, target, deps = {}) {
  // Test seam: inject spawn / port / tmux helpers so the dedup invariant is
  // unit-testable WITHOUT a real ttyd OR tmux (CI runners have neither — leaving
  // resolveTmuxBin/getSocketPath un-injected made the test pass locally but throw
  // on CI where `tmux` is absent). Production passes nothing → real implementations.
  const _spawn = deps.spawn || spawn;
  const _findFreePort = deps.findFreePort || findFreePort;
  const _waitForPort = deps.waitForPort || waitForPort;
  const _resolveTmuxBin = deps.resolveTmuxBin || tmux.resolveTmuxBin;
  const _getSocketPath = deps.getSocketPath || tmux.getSocketPath;
  const _setWindowSizeLargest = deps.setWindowSizeLargest || tmux.setWindowSizeLargest;
  if (!tmux.isValidTarget(target)) {
    throw new Error(`invalid tmux target: ${JSON.stringify(target)}`);
  }

  const existing = terminals.get(id);
  if (existing) {
    // Cancel any pending idle reap — a new request revived it.
    if (existing.idleTimer) {
      clearTimeout(existing.idleTimer);
      existing.idleTimer = null;
    }
    existing.lastUsed = Date.now();
    const port = await existing.ready;
    return { port };
  }

  // LRU bound: keep at most MAX_TERMINALS live. When full, evict the
  // least-recently-used terminal (preferring ones with no connected clients)
  // instead of erroring — the UI keeps the latest few warm and expects older
  // ones to be offloaded silently.
  while (terminals.size >= MAX_TERMINALS) {
    let victimId = null;
    let victim = null;
    for (const [vid, t] of terminals) {
      if (!victim) {
        victimId = vid;
        victim = t;
        continue;
      }
      const vIdle = victim.clients.size === 0;
      const tIdle = t.clients.size === 0;
      if (tIdle && !vIdle) {
        victimId = vid;
        victim = t;
      } else if (tIdle === vIdle && (t.lastUsed || 0) < (victim.lastUsed || 0)) {
        victimId = vid;
        victim = t;
      }
    }
    if (victimId == null) break;
    reap(victimId);
  }

  // Register a PENDING entry SYNCHRONOUSLY — before the first await below — so the
  // burst of concurrent first-hit requests on a cold open (the iframe's HTML GET,
  // its ttyd WebSocket upgrade, and asset GETs all fire at once) DEDUPE onto this
  // single spawn. Previously the map entry was set only AFTER `await findFreePort()`,
  // so every racer passed the `terminals.get(id)` check above and spawned its own
  // ttyd; the losers got overwritten in the map → untracked → never reaped (leaking
  // dozens of ttyds and defeating MAX_TERMINALS), and the clobbered request 502'd.
  /** @type {Terminal} */
  const term = {
    proc: null,
    port: 0,
    target,
    clients: new Set(),
    idleTimer: null,
    ready: null,
    lastUsed: Date.now(),
  };
  // The spawn runs inside the entry's own `ready` promise. We set `term` in the
  // map first (sync), THEN await — concurrent callers find the entry and await
  // the SAME `ready` instead of starting a second ttyd.
  term.ready = (async () => {
    const tmuxBin = await _resolveTmuxBin();
    const socket = await _getSocketPath();
    const port = await _findFreePort();
    const base = ttydBasePath(id);

    // ttyd flags:
    //   -W            allow client write (interactive input)
    //   -i 127.0.0.1  bind loopback only (proxy is the only ingress)
    //   -p <port>     ephemeral loopback port
    //   -b <base>     URL base path so assets/WS resolve under the proxied subpath
    //   -t fontSize=  xterm.js font size — smaller than the default (15) so the
    //                 attached pane fits MORE columns, which keeps the agent TUI
    //                 from wrapping and keeps question/picker parsing robust.
    // followed by the command ttyd runs: tmux -S <socket> attach -t <target>.
    // NO basic-auth — the claude-control token proxy is the gate.
    const proc = _spawn(
      TTYD_BIN,
      ['-W', '-i', '127.0.0.1', '-p', String(port), '-b', base,
       '-t', `fontSize=${TTYD_FONT_SIZE}`,
       tmuxBin, '-S', socket, 'attach', '-t', target],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        // Force a UTF-8 locale: under launchd the service inherits no LANG/LC_ALL,
        // so the attached tmux falls back to the C locale and mangles the TUI's
        // box-drawing / wide glyphs ("icons not loading"). Honor an existing locale.
        env: {
          ...process.env,
          LANG: process.env.LANG || 'en_US.UTF-8',
          LC_ALL: process.env.LC_ALL || 'en_US.UTF-8',
        },
      },
    );
    term.proc = proc;
    term.port = port;

    let stderrTail = '';
    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-2000);
    });

    const readyPort = await new Promise((resolve, reject) => {
      let settled = false;
      proc.once('error', (err) => {
        if (settled) return;
        settled = true;
        terminals.delete(id);
        reject(new Error(`failed to spawn ttyd: ${err.message}`));
      });
      proc.once('exit', (code, signal) => {
        // If ttyd dies before it ever became ready, surface a useful error.
        if (!settled) {
          settled = true;
          terminals.delete(id);
          reject(new Error(`ttyd exited (code=${code} signal=${signal}) before ready: ${stderrTail.trim()}`));
        } else {
          // Died after running: drop the entry so a later request respawns it.
          terminals.delete(id);
        }
      });
      _waitForPort(port, READY_TIMEOUT_MS).then(
        (p) => {
          if (settled) return;
          settled = true;
          resolve(p);
        },
        (err) => {
          if (settled) return;
          settled = true;
          try { proc.kill('SIGTERM'); } catch { /* already gone */ }
          terminals.delete(id);
          reject(err);
        },
      );
    });

    // Pin the window to its largest client so this extra (cockpit) attach never
    // shrinks the user's real terminal. Best-effort — don't fail the open on it.
    _setWindowSizeLargest(target).catch(() => {});
    return readyPort;
  })();
  terminals.set(id, term);

  return { port: await term.ready };
}

/**
 * Register a connected client (HTTP keep-alive conn or WS socket) against a
 * terminal, cancelling any pending idle reap. Mirrors the ref-count in
 * server.js's subscription model.
 *
 * @param {string} id
 * @param {unknown} client an opaque handle (the socket) used only for identity
 */
export function addClient(id, client) {
  const term = terminals.get(id);
  if (!term) return;
  term.clients.add(client);
  term.lastUsed = Date.now();
  if (term.idleTimer) {
    clearTimeout(term.idleTimer);
    term.idleTimer = null;
  }
}

/**
 * Deregister a client. When the last client leaves, start an idle grace timer;
 * if no client reconnects within IDLE_GRACE_MS, reap the ttyd process.
 *
 * @param {string} id
 * @param {unknown} client
 */
export function removeClient(id, client) {
  const term = terminals.get(id);
  if (!term) return;
  term.clients.delete(client);
  if (term.clients.size > 0) return;
  if (term.idleTimer) clearTimeout(term.idleTimer);
  term.idleTimer = setTimeout(() => reap(id), IDLE_GRACE_MS);
  // Don't keep the event loop alive solely for the reap timer.
  term.idleTimer.unref?.();
}

/**
 * Kill the ttyd for `id` and drop its registry entry. No-op if already gone.
 * @param {string} id
 */
export function reap(id) {
  const term = terminals.get(id);
  if (!term) return;
  if (term.idleTimer) clearTimeout(term.idleTimer);
  terminals.delete(id);
  try { term.proc.kill('SIGTERM'); } catch { /* already gone */ }
}

/**
 * Kill every live ttyd. Call from the server's shutdown handler.
 */
export function shutdownAll() {
  for (const [id] of terminals) reap(id);
}

/**
 * Test/diagnostic helper: number of live terminals.
 * @returns {number}
 */
export function liveCount() {
  return terminals.size;
}
