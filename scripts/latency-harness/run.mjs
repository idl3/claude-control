#!/usr/bin/env node
/**
 * scripts/latency-harness/run.mjs — keystroke-echo latency harness (task A2).
 *
 * ESM, Node >=20. Only import beyond built-ins is `ws` (this repo's sole
 * runtime dependency per CONTRACT.md — no new deps added).
 *
 * Measures client-send -> echo-receive round-trip latency against a LIVE
 * terminal WebSocket, so the ttyd path can be calibrated BEFORE the PTY
 * bridge (A4) lands. There is no synthetic-data mode: if a live target isn't
 * reachable, this exits with a clear "no live target" message and a non-zero
 * exit code — it NEVER fabricates latency numbers. See
 * docs/plans/cockpit-protocol-split-native-heads/baseline.md for the results
 * sheet this is meant to fill in, and percentiles.mjs for the pure math
 * (unit-tested separately in percentiles.test.mjs against synthetic arrays).
 *
 * --target ttyd connects through the EXISTING /term/<id> raw-WS relay
 * (server.js's relayTerminalUpgrade — a byte-for-byte TCP pipe to ttyd, not a
 * `ws`-library endpoint), which means this harness must speak ttyd's OWN
 * wire protocol directly:
 *   - WS subprotocol "tty" (ttyd's libwebsockets server registers exactly
 *     "http-only" and "tty"; only "tty" reaches the terminal handler).
 *   - First client message: JSON `{AuthToken, columns, rows}` (ttyd will not
 *     attach the pty / start streaming output until it receives this).
 *   - Every subsequent message is `[1 command byte][payload]`. Client->server
 *     INPUT and server->client OUTPUT share the same byte value ('0'/0x30) —
 *     safe because direction disambiguates them.
 * Confirmed against tsl0922/ttyd @ main (src/server.h, src/server.c,
 * html/src/components/terminal/xterm/index.ts), self-identified as v1.7.7 in
 * CMakeLists.txt (latest tagged release at time of writing). If a future ttyd
 * upgrade changes this protocol, `runOnce` below is the only place that needs
 * to change.
 *
 * --target bridge is accepted (forward-compatible CLI surface for A4) but
 * always reports "no live target" today — the PTY bridge doesn't exist yet.
 *
 * SAFETY: --target ttyd requires an explicit --id <tmux-target>. This harness
 * deliberately does NOT auto-attach to "the first live session it finds" —
 * a probe keystroke sent into an unvetted session could mutate real state
 * (e.g. a Space keystroke toggles a selection in an open AskUserQuestion
 * picker; a stray character lands in someone's shell prompt). Use
 * --list-sessions to see live ids and pick a disposable/idle pane yourself.
 * Each probe keystroke is immediately erased (DEL/0x7f) so the target pane's
 * line is left as found; this is a best-effort courtesy, not a guarantee for
 * non-shell panes (TUIs, pagers, etc.) — pick a plain shell prompt.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { WebSocket } from 'ws';

import { computePercentiles, crossRunVerdict } from './percentiles.mjs';

const execFileAsync = promisify(execFile);

const DEFAULTS = {
  host: '127.0.0.1',
  port: Number(process.env.COCKPIT_PORT) || 4317,
  runs: 3,
  keys: 500,
  tolerancePct: 10,
  connectTimeoutMs: 5000,
  echoTimeoutMs: 2000,
  quietMs: 300,
  quietMaxWaitMs: 3000,
};

// Bail out of a run (not just drop one sample) after this many consecutive
// echo timeouts — a real signal the ttyd process or tmux session died
// mid-run, vs. one-off jitter on an otherwise-live connection.
const MAX_CONSECUTIVE_ECHO_TIMEOUTS = 5;

const USAGE = `Usage: node scripts/latency-harness/run.mjs --target <ttyd|bridge> [options]

Measures keystroke-echo round-trip latency (client send -> echo receive)
against a LIVE terminal WebSocket. Requires the cockpit server running
(node server.js) and, for --target ttyd, an explicit --id naming a real
tmux-backed session to attach to. There is no synthetic/fake-data mode: if no
live target is reachable this exits with a clear message, never invented
numbers.

Options:
  --target <ttyd|bridge>  required. ttyd = current ttyd path (A2 baseline).
                           bridge = future PTY bridge (A4, not built yet).
  --id <tmux-target>       required for --target ttyd. e.g. --id "main:0".
                            Refuses to auto-attach to an arbitrary session —
                            see --list-sessions to find one.
  --runs <N>                independent runs (default ${DEFAULTS.runs})
  --keys <N>                keystrokes measured per run (default ${DEFAULTS.keys})
  --host <host>              cockpit host (default ${DEFAULTS.host})
  --port <port>               cockpit port (default ${DEFAULTS.port}, or $COCKPIT_PORT)
  --token <token>              bearer/terminal token (default: $COCKPIT_TOKEN,
                                else ~/.claude-control/token, else none)
  --tolerance <pct>             cross-run variance tolerance (default ${DEFAULTS.tolerancePct})
  --list-sessions                list live session ids (for picking --id), then exit
  --help                          show this message
`;

/** Thrown for every "could not reach/complete against a live target" case. cli() catches this and prints a clean message + exit 1 — never a stack trace. */
export class NoLiveTargetError extends Error {}

/**
 * @param {string[]} argv process.argv.slice(2)
 * @returns {{target:?string, runs:number, keys:number, host:string, port:number, id:?string, token:?string, tolerancePct:number, help:boolean, listSessions:boolean}}
 */
export function parseArgs(argv) {
  const args = {
    target: null,
    runs: DEFAULTS.runs,
    keys: DEFAULTS.keys,
    host: DEFAULTS.host,
    port: DEFAULTS.port,
    id: null,
    token: null,
    tolerancePct: DEFAULTS.tolerancePct,
    help: false,
    listSessions: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) throw new Error(`${arg} requires a value`);
      return argv[i];
    };
    switch (arg) {
      case '--target': args.target = next(); break;
      case '--runs': args.runs = Number(next()); break;
      case '--keys': args.keys = Number(next()); break;
      case '--host': args.host = next(); break;
      case '--port': args.port = Number(next()); break;
      case '--id': args.id = next(); break;
      case '--token': args.token = next(); break;
      case '--tolerance': args.tolerancePct = Number(next()); break;
      case '--list-sessions': args.listSessions = true; break;
      case '--help':
      case '-h': args.help = true; break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (args.help) return args;
  if (args.listSessions) return args; // --target not required just to list sessions
  if (args.target !== 'ttyd' && args.target !== 'bridge') {
    throw new Error(`--target must be "ttyd" or "bridge" (got ${JSON.stringify(args.target)})`);
  }
  if (!Number.isInteger(args.runs) || args.runs < 1) {
    throw new Error(`--runs must be a positive integer (got ${JSON.stringify(args.runs)})`);
  }
  if (!Number.isInteger(args.keys) || args.keys < 1) {
    throw new Error(`--keys must be a positive integer (got ${JSON.stringify(args.keys)})`);
  }
  if (!Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
    throw new Error(`--port must be a valid TCP port (got ${JSON.stringify(args.port)})`);
  }
  if (!Number.isFinite(args.tolerancePct) || args.tolerancePct < 0) {
    throw new Error(`--tolerance must be >= 0 (got ${JSON.stringify(args.tolerancePct)})`);
  }
  return args;
}

// Mirrors server.js's readPersistedToken() convention (~/.claude-control/token)
// so the harness authenticates the same way the real cockpit client does,
// without importing server.js itself (which would boot the whole server).
function readPersistedToken() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.claude-control', 'token'), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

/** @param {{tokenArg:?string}} opts @returns {?string} */
export function resolveToken({ tokenArg }) {
  return tokenArg || process.env.COCKPIT_TOKEN || readPersistedToken() || null;
}

function isLoopbackHost(host) {
  return ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
}

/**
 * Classify a `tailscale status --json` peer entry as direct / DERP-relayed /
 * peer-relayed / unknown, using the SAME precedence as tailscale's own CLI
 * formatter (cmd/tailscale/cli/status.go): CurAddr set -> direct; else Relay
 * set -> derp; else PeerRelay set -> peer-relay; else unknown (not connected).
 * @param {object|null} peer a `Peer` entry from `tailscale status --json`
 * @returns {{type:'direct'|'derp'|'peer-relay'|'unknown', detail:?string}}
 */
export function classifyPeerPath(peer) {
  if (!peer) return { type: 'unknown', detail: 'no matching tailscale peer found for --host' };
  if (peer.CurAddr) return { type: 'direct', detail: peer.CurAddr };
  if (peer.Relay) return { type: 'derp', detail: `DERP region "${peer.Relay}"` };
  if (peer.PeerRelay) return { type: 'peer-relay', detail: peer.PeerRelay };
  return { type: 'unknown', detail: 'peer found but not currently connected (no CurAddr/Relay/PeerRelay)' };
}

/**
 * @param {object} statusJson parsed `tailscale status --json` output
 * @param {string} host hostname / MagicDNS name / tailnet IP passed via --host
 * @returns {object|null}
 */
export function findPeerForHost(statusJson, host) {
  const peers = Object.values(statusJson?.Peer || {});
  const needle = host.toLowerCase().replace(/\.$/, '');
  return (
    peers.find((p) => {
      if (p.HostName && p.HostName.toLowerCase() === needle) return true;
      const dns = (p.DNSName || '').toLowerCase().replace(/\.$/, '');
      if (dns && (dns === needle || dns.startsWith(`${needle}.`))) return true;
      if (Array.isArray(p.TailscaleIPs) && p.TailscaleIPs.includes(host)) return true;
      return false;
    }) || null
  );
}

/**
 * Path-type for the DERP tripwire. Loopback hosts short-circuit (no shellout,
 * no side effects). Any tailscale failure (not installed, not logged in,
 * malformed JSON) degrades to `unknown` rather than throwing — this is a
 * logging concern, never a reason to abort a loopback-only calibration run.
 * @param {{host:string}} opts
 * @returns {Promise<{type:string, detail:?string}>}
 */
export async function detectPathType({ host }) {
  if (isLoopbackHost(host)) return { type: 'loopback', detail: null };
  try {
    const { stdout } = await execFileAsync('tailscale', ['status', '--json']);
    const statusJson = JSON.parse(stdout);
    return classifyPeerPath(findPeerForHost(statusJson, host));
  } catch (err) {
    return { type: 'unknown', detail: `tailscale status unavailable: ${err?.message || err}` };
  }
}

/** Strip a `?token=` query value before ever printing a URL. */
function redactToken(url) {
  try {
    const u = new URL(url);
    if (u.searchParams.has('token')) u.searchParams.set('token', '***');
    return u.toString();
  } catch {
    return url;
  }
}

/** @param {{host:string, port:number, id:string, token:?string}} opts @returns {string} */
export function buildTerminalWsUrl({ host, port, id, token }) {
  const base = `ws://${host}:${port}/term/${encodeURIComponent(id)}`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

/**
 * GET /api/sessions (Bearer-token gated, per CONTRACT/server.js) — read-only,
 * used only to help an operator pick a --id; never used to auto-attach.
 * @param {{host:string, port:number, token:?string}} opts
 * @returns {Promise<{sessions:?Array<{id:string,name:?string}>, error:?string}>}
 */
async function fetchLiveSessions({ host, port, token }) {
  const url = `http://${host}:${port}/api/sessions`;
  let res;
  try {
    res = await fetch(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(DEFAULTS.connectTimeoutMs),
    });
  } catch (err) {
    return { sessions: null, error: `cannot reach cockpit server at ${url}: ${err?.message || err}` };
  }
  if (!res.ok) {
    const hint = res.status === 401 ? ' (unauthorized -- pass --token or set $COCKPIT_TOKEN)' : '';
    return { sessions: null, error: `cockpit server at ${url} returned HTTP ${res.status}${hint}` };
  }
  let body;
  try {
    body = await res.json();
  } catch (err) {
    return { sessions: null, error: `cockpit server at ${url} returned invalid JSON: ${err?.message || err}` };
  }
  const sessions = Array.isArray(body?.sessions)
    ? body.sessions.map((s) => ({ id: s.id, name: s.name || null }))
    : [];
  return { sessions, error: null };
}

// ttyd's OWN client<->server WS sub-protocol (NOT xterm.js, NOT a generic PTY
// framing). See the file header comment for the source citation.
const TTYD_WS_SUBPROTOCOL = 'tty';
const TTYD_CMD_BYTE = 0x30; // '0' -- INPUT when sent, OUTPUT when received
const PROBE_CHAR = ' '; // a Space: a no-op insert on any shell readline (unlike letters, never triggers completion/history-search bindings)
const ERASE_CHAR = '\x7f'; // DEL -- the default `stty erase` on macOS/most Linux; erases the probe char we just sent

function sendInput(ws, text) {
  const body = Buffer.from(text, 'utf8');
  ws.send(Buffer.concat([Buffer.from([TTYD_CMD_BYTE]), body]));
}

/**
 * Resolve on the next OUTPUT frame, reject on timeout/error/close. Used both
 * to time individual keystroke echoes and (via waitForQuiet) to drain ttyd's
 * initial full-screen `tmux attach` redraw before measuring anything.
 */
function waitForNextOutput(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    // A `close`/`error` event fires ONCE on the socket's lifetime; if it
    // already happened before THIS call registered its listeners (e.g. the
    // connection died between two keystrokes in runOnce's loop), a fresh
    // listener here will never see it replayed. Without this guard every
    // subsequent call would silently burn the full timeoutMs instead of
    // failing fast on an already-dead connection.
    if (ws.readyState !== WebSocket.OPEN) {
      reject(new Error(`websocket is not open (readyState=${ws.readyState})`));
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      ws.off('message', onMessage);
      ws.off('error', onError);
      ws.off('close', onClose);
    };
    const onMessage = (data, isBinary) => {
      if (settled || !isBinary || data.length === 0 || data[0] !== TTYD_CMD_BYTE) return;
      settled = true;
      cleanup();
      resolve(performance.now());
    };
    const onError = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(err);
    };
    const onClose = () => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('websocket closed while waiting for echo'));
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error(`timed out after ${timeoutMs}ms waiting for echo`));
    }, timeoutMs);
    ws.on('message', onMessage);
    ws.on('error', onError);
    ws.on('close', onClose);
  });
}

/**
 * Resolve once `quietMs` has passed with no new OUTPUT frame, or `maxWaitMs`
 * total has elapsed, whichever comes first. Drains ttyd's initial `tmux
 * attach` full-screen redraw so the first measured keystroke isn't racing
 * against an unrelated burst of output.
 */
function waitForQuiet(ws, { quietMs, maxWaitMs }) {
  return new Promise((resolve) => {
    let settled = false;
    let quietTimer = null;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(quietTimer);
      clearTimeout(hardTimer);
      ws.off('message', onMessage);
      resolve();
    };
    const onMessage = (data, isBinary) => {
      if (!isBinary || data.length === 0 || data[0] !== TTYD_CMD_BYTE) return;
      clearTimeout(quietTimer);
      quietTimer = setTimeout(finish, quietMs);
    };
    ws.on('message', onMessage);
    quietTimer = setTimeout(finish, quietMs); // no output at all -> still resolve after quietMs
    const hardTimer = setTimeout(finish, maxWaitMs);
  });
}

/**
 * Open the ttyd WS, perform the JSON_DATA handshake, resolve with the open
 * socket. Every failure mode (ECONNREFUSED, 401/404/502 from the /term/*
 * relay's auth/session-lookup gate, handshake timeout) becomes a
 * NoLiveTargetError with a redacted URL — never a raw stack trace.
 */
function connectTtydSocket(url, { connectTimeoutMs, columns = 80, rows = 24, authToken = '' }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(url, [TTYD_WS_SUBPROTOCOL]);
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      ws.terminate();
      reject(new NoLiveTargetError(`timed out connecting to ${redactToken(url)} after ${connectTimeoutMs}ms`));
    }, connectTimeoutMs);
    ws.once('open', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // Must be the client's first message, or ttyd never attaches the pty /
      // starts streaming OUTPUT. No separate command-byte prefix needed here:
      // JSON.stringify's output already starts with '{' (0x7B == JSON_DATA).
      ws.send(JSON.stringify({ AuthToken: authToken, columns, rows }));
      resolve(ws);
    });
    ws.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new NoLiveTargetError(`cannot reach ttyd via ${redactToken(url)}: ${err?.message || err}`));
    });
  });
}

/**
 * One full run: connect, drain the initial redraw, measure `keys` echo
 * round-trips (each probe char immediately erased), return computePercentiles
 * over whatever samples were collected. Individual echo timeouts drop that
 * one sample (noise); MAX_CONSECUTIVE_ECHO_TIMEOUTS in a row is treated as
 * target loss and raises NoLiveTargetError instead.
 * @param {{host:string, port:number, id:string, token:?string, keys:number}} opts
 */
async function runOnce({ host, port, id, token, keys }) {
  const url = buildTerminalWsUrl({ host, port, id, token });
  const ws = await connectTtydSocket(url, { connectTimeoutMs: DEFAULTS.connectTimeoutMs });
  try {
    await waitForQuiet(ws, { quietMs: DEFAULTS.quietMs, maxWaitMs: DEFAULTS.quietMaxWaitMs });

    const samples = [];
    let consecutiveTimeouts = 0;
    for (let i = 0; i < keys; i += 1) {
      const t0 = performance.now();
      sendInput(ws, PROBE_CHAR);
      let t1;
      try {
        t1 = await waitForNextOutput(ws, DEFAULTS.echoTimeoutMs);
      } catch (err) {
        consecutiveTimeouts += 1;
        if (consecutiveTimeouts >= MAX_CONSECUTIVE_ECHO_TIMEOUTS) {
          throw new NoLiveTargetError(
            `lost the echo stream after ${consecutiveTimeouts} consecutive timeouts ` +
              `(keystroke ${i + 1}/${keys}): ${err.message}. The ttyd process or tmux session may have died mid-run.`,
          );
        }
        continue; // drop this one sample, try the next keystroke
      }
      consecutiveTimeouts = 0;
      samples.push(t1 - t0);
      // Best-effort cleanup: erase the probe char so the pane is left as
      // found. Not timed, not fatal if it never echoes back.
      sendInput(ws, ERASE_CHAR);
      await waitForNextOutput(ws, DEFAULTS.echoTimeoutMs).catch(() => {});
    }
    if (samples.length === 0) {
      throw new NoLiveTargetError(`every keystroke echo timed out across ${keys} attempts -- no usable samples collected`);
    }
    return computePercentiles(samples);
  } finally {
    try { ws.close(); } catch { /* already closed */ }
  }
}

function printNoLiveTarget(reason) {
  console.error(`no live target: ${reason}`);
}

/** @param {ReturnType<typeof parseArgs>} args */
async function main(args) {
  const token = resolveToken({ tokenArg: args.token });

  if (args.listSessions) {
    const { sessions, error } = await fetchLiveSessions({ host: args.host, port: args.port, token });
    if (error) throw new NoLiveTargetError(error);
    if (sessions.length === 0) {
      console.log('No live sessions found.');
      return;
    }
    console.log('Live sessions (use one of these as --id):');
    for (const s of sessions) console.log(`  ${s.id}${s.name ? `  (${s.name})` : ''}`);
    return;
  }

  console.log(`latency-harness: target=${args.target} runs=${args.runs} keys=${args.keys} host=${args.host}:${args.port}`);

  if (args.target === 'bridge') {
    throw new NoLiveTargetError(
      'PTY bridge (A4) is not implemented in this repo yet -- there is no bridge WS endpoint to connect to. ' +
        'This harness already accepts --target bridge so it is ready to run the moment A4 lands.',
    );
  }

  // target === 'ttyd'
  if (!args.id) {
    throw new NoLiveTargetError(
      '--id <tmux-target> is required for --target ttyd (e.g. --id "main:0"). This harness deliberately refuses ' +
        'to auto-attach to an arbitrary live session -- a probe keystroke could mutate an in-progress picker/TUI ' +
        'state in a session you did not choose. Run with --list-sessions to see live session ids.',
    );
  }

  const runResults = [];
  const pathTypesSeen = new Set();
  for (let i = 1; i <= args.runs; i += 1) {
    console.log(`\nrun ${i}/${args.runs}...`);
    // Logged fresh EVERY run (not once up front) -- the whole point of the
    // DERP tripwire is to catch a tailnet path flipping mid-calibration.
    const pathInfo = await detectPathType({ host: args.host });
    pathTypesSeen.add(pathInfo.type);
    console.log(`  path-type: ${pathInfo.type}${pathInfo.detail ? ` (${pathInfo.detail})` : ''}`);

    const result = await runOnce({ host: args.host, port: args.port, id: args.id, token, keys: args.keys });
    console.log(
      `  p50=${result.p50.toFixed(2)}ms p95=${result.p95.toFixed(2)}ms p99=${result.p99.toFixed(2)}ms ` +
        `(n=${result.n}, min=${result.min.toFixed(2)}ms, max=${result.max.toFixed(2)}ms)`,
    );
    runResults.push(result);
  }

  if (pathTypesSeen.size > 1) {
    console.warn(
      `\nWARNING: path type changed across runs (${[...pathTypesSeen].join(', ')}) -- this baseline mixes ` +
        'different network paths and should not be trusted as a single figure. Re-run once the tailnet path is stable.',
    );
  }

  const verdict = crossRunVerdict(runResults, args.tolerancePct);
  console.log(`\ncross-run variance (+/-${args.tolerancePct}%): ${verdict.ok ? 'OK -- stable' : 'UNSTABLE -- re-run before trusting this baseline'}`);
  console.log(`  p50 max deviation: ${verdict.p50.maxDeviationPct.toFixed(1)}%`);
  console.log(`  p95 max deviation: ${verdict.p95.maxDeviationPct.toFixed(1)}%`);
  console.log(`  p99 max deviation: ${verdict.p99.maxDeviationPct.toFixed(1)}%`);
  if (!verdict.ok) process.exitCode = 1;
}

async function cli() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`latency-harness: ${err.message}`);
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  try {
    await main(args);
  } catch (err) {
    if (err instanceof NoLiveTargetError) {
      printNoLiveTarget(err.message);
      process.exitCode = 1;
      return;
    }
    console.error(`latency-harness: unexpected error: ${err?.message || err}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) cli();
