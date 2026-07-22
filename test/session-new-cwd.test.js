/**
 * test/session-new-cwd.test.js
 *
 * Integration tests for the cwd-existence handling in POST /api/session/new
 * (server.js handleSessionNew). Covers the hoisted cwd check that now runs for
 * EVERY agent/transport (not just structured transports):
 *
 *   - missing cwd + no createCwd → 400 with code:'cwd_missing' (returns BEFORE
 *     any window creation, so it is fully hermetic).
 *   - missing cwd + createCwd:true → mkdir -p the directory, then proceed past
 *     the cwd check (the directory now exists on disk; the response is NOT the
 *     cwd_missing 400).
 *   - non-ENOENT stat error (ENOTDIR when a parent segment is a regular file,
 *     and by the same branch EACCES / ELOOP) → a prompt 400 code:'cwd_error',
 *     NOT a hung request. Regression guard: the old code re-threw here, escaping
 *     the async handler so the HTTP response was never written.
 *
 * Runs the actual server as a child process on an ephemeral port. Two guards
 * keep it hermetic:
 *   - CLAUDE_CONTROL_DATA points at a throwaway dir with a controlled
 *     config.json (launchCommand = the node binary, so the agent-binary
 *     pre-check passes and we reach the cwd check).
 *   - CLAUDE_CONTROL_TMUX points at a non-existent binary, so the createCwd path
 *     cannot touch the operator's real tmux server — it mkdir's, then fails at
 *     the tmux seam (which is what we want: the mkdir side effect is observable
 *     and the response is deterministically not cwd_missing).
 *
 * Run: node --test test/session-new-cwd.test.js
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import WSPkg from 'ws';
import { resolveTmuxBin } from '../lib/tmux.js';

const execFile = promisify(_execFile);
// `ws`'s CJS export is the WebSocket class itself (with a `.WebSocket` alias) —
// handle both interop shapes. NOT Node's global WebSocket: this test uses the
// `.on(...)` event API the `ws` client provides.
const WebSocket = WSPkg.WebSocket ?? WSPkg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, '..', 'server.js');

const TEST_TOKEN = 'test-secret-cwd-77';
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}`, 'content-type': 'application/json' };

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
    srv.on('error', reject);
  });
}

async function startServer(port, dataDir) {
  const pinsFile = path.join(dataDir, 'pins.json');
  fs.writeFileSync(pinsFile, '{}');
  const uploadsDir = path.join(dataDir, 'uploads');
  fs.mkdirSync(uploadsDir, { recursive: true });
  // Controlled config: launchCommand = the node binary (guaranteed executable,
  // so resolveBin passes); defaultCwd = a real dir.
  fs.writeFileSync(
    path.join(dataDir, 'config.json'),
    JSON.stringify({ launchCommand: process.execPath, defaultCwd: dataDir }),
  );

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: {
        ...process.env,
        CLAUDE_CONTROL_PORT: String(port),
        CLAUDE_CONTROL_TOKEN: TEST_TOKEN,
        CLAUDE_CONTROL_DATA: dataDir,
        CLAUDE_CONTROL_UPLOADS: uploadsDir,
        CLAUDE_CONTROL_PINS: pinsFile,
        CLAUDE_CONTROL_PROJECTS: dataDir,
        // Point tmux resolution at a non-existent binary so no real tmux server
        // is ever contacted (the createCwd path fails AFTER mkdir).
        CLAUDE_CONTROL_TMUX: path.join(dataDir, 'no-such-tmux'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const settle = (val, isErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isErr) reject(val);
      else resolve({ child, port });
    };
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('claude-control →')) settle({ child, port });
    });
    child.stderr.on('data', () => {/* swallow */});
    child.on('error', (err) => settle(err, true));
    child.on('exit', (code) => {
      if (!settled) settle(new Error(`server exited prematurely (code ${code})`), true);
    });
    const timer = setTimeout(
      () => settle(new Error('server did not start within 10 s'), true),
      10_000,
    );
  });
}

function post(port, pathname, body) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: 'POST',
    headers: AUTH_HEADER,
    body: JSON.stringify(body),
  });
}

let port;
let dataDir;
let serverCtx;

before(async () => {
  port = await getFreePort();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-cwd-test-'));
  serverCtx = await startServer(port, dataDir);
});

after(() => {
  try { serverCtx?.child?.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

test('session/new: missing cwd + no createCwd → 400 code:cwd_missing', async () => {
  const missing = path.join(dataDir, 'does-not-exist-abc');
  const res = await post(port, '/api/session/new', { agent: 'claude', cwd: missing, name: 'x' });
  assert.equal(res.status, 400, 'missing cwd must produce 400');
  const json = await res.json();
  assert.equal(json.code, 'cwd_missing', 'error code must be cwd_missing');
  assert.equal(json.cwd, missing, 'response echoes the missing cwd');
  assert.ok(!fs.existsSync(missing), 'no createCwd → directory must NOT be created');
});

test('session/new: missing cwd + createCwd:true → mkdir then proceed (not cwd_missing)', async () => {
  const toCreate = path.join(dataDir, 'nested', 'new-project');
  assert.ok(!fs.existsSync(toCreate), 'precondition: directory absent');
  const res = await post(port, '/api/session/new', {
    agent: 'claude', cwd: toCreate, name: 'x', createCwd: true,
  });
  // The directory must have been created (mkdir -p) regardless of whether the
  // downstream tmux launch succeeds (it cannot here — CLAUDE_CONTROL_TMUX is bogus).
  assert.ok(fs.existsSync(toCreate), 'createCwd:true must mkdir -p the directory');
  const json = await res.json().catch(() => ({}));
  assert.notEqual(json.code, 'cwd_missing', 'createCwd path must not reject as cwd_missing');
});

test('session/new: cwd that is a file → 400 not a directory', async () => {
  const filePath = path.join(dataDir, 'a-file.txt');
  fs.writeFileSync(filePath, 'x');
  const res = await post(port, '/api/session/new', { agent: 'claude', cwd: filePath, name: 'x' });
  assert.equal(res.status, 400, 'a file cwd must produce 400');
  const json = await res.json();
  assert.match(json.error, /not a directory/, 'error explains cwd is not a directory');
});

test('session/new: cwd whose parent segment is a file (ENOTDIR) → prompt 400 cwd_error, NOT a hang', async () => {
  // A plausible typo: notes.txt/app. stat() throws ENOTDIR (a non-ENOENT
  // error). The handler MUST return a clean 400 — the old `else { throw e }`
  // escaped the async handler with no `.catch()`, so the response was never
  // written and this fetch would hang until the test timeout. The `await`
  // resolving at all is itself the regression assertion.
  const filePath = path.join(dataDir, 'notes.txt');
  fs.writeFileSync(filePath, 'x');
  const badCwd = path.join(filePath, 'app'); // parent segment is a regular file
  const res = await post(port, '/api/session/new', { agent: 'claude', cwd: badCwd, name: 'x' });
  assert.equal(res.status, 400, 'ENOTDIR stat error must produce a 400');
  const json = await res.json();
  assert.equal(json.code, 'cwd_error', 'error code must be cwd_error');
  assert.equal(json.cwd, badCwd, 'response echoes the offending cwd');
  assert.match(json.error, /cannot access cwd/, 'error explains the stat failure');
});

// ── Real-tmux attach regression: createCwd retry must return a target the
//    session registry can immediately resolve (no detach / no manual heal) ────
//
// Regression guard for the New Session "create folder" detach bug: the confirm
// →createCwd retry created the real session but the client landed on the WRONG
// session, subscribed to the wrong transcript, and never self-healed. Two root
// causes, both fixed in handleSessionNew's success return:
//   1. SHAPE — createWindow* return the WINDOW target "session:windowIndex",
//      but the registry keys sessions by the PANE target
//      "session:windowIndex.paneIndex" (lib/tmux.js listPanes). The raw window
//      target never string-matches sessionById(id) → subscribe "unknown session".
//   2. FRESHNESS — the registry wasn't rebuilt before returning, so even a
//      correctly-shaped target raced the next ~4s poll and wasn't yet known.
// The client (App.tsx onDraftCreated → select(result.target)) already keys off
// the server-returned id verbatim — so the fix is to make that id (a) pane-
// shaped and (b) already in the registry when the response is written.
//
// Hermetic-CI note: the rest of this file uses a bogus tmux binary. This case
// needs a REAL tmux to exercise window creation + the registry, so it gates on
// CI (skip) and on tmux availability (skip), matching create-session.test.js's
// real-tmux smoke convention. It runs on local/dev, where it fails on the
// pre-fix server (returns "sess:N", subscribe errors "unknown session").
test('session/new: createCwd retry returns a pane-shaped, immediately-subscribable target (attach, no detach)', async (t) => {
  if (process.env.CI) {
    return t.skip('real-tmux attach regression skipped in CI (hermetic — no tmux)');
  }
  let tmuxBin;
  try {
    tmuxBin = await resolveTmuxBin();
  } catch {
    return t.skip('tmux not available (resolveTmuxBin threw)');
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-attach-'));
  const data = path.join(base, 'data');
  const uploads = path.join(data, 'uploads');
  const tmuxTmp = path.join(base, 'tmuxtmp');
  fs.mkdirSync(uploads, { recursive: true });
  fs.mkdirSync(tmuxTmp, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(data, 'pins.json'), '{}');
  // Keep-alive launch command so the created pane persists for the registry.
  const keep = path.join(base, 'keep.sh');
  fs.writeFileSync(keep, '#!/bin/sh\nexec sleep 600\n');
  fs.chmodSync(keep, 0o755);
  fs.writeFileSync(
    path.join(data, 'config.json'),
    JSON.stringify({ launchCommand: keep, claudeBin: keep, defaultCwd: data, claudeTransport: 'tmux' }),
  );

  // Isolated tmux: a private TMUX_TMPDIR socket, and TMUX/TMUX_PANE UNSET so tmux
  // does not glom onto the caller's inherited server socket (which would ignore
  // TMUX_TMPDIR and leak windows into the operator's real tmux).
  const isoEnv = (extra) => {
    const e = { ...process.env, ...extra, TMUX_TMPDIR: tmuxTmp, CLAUDE_CONTROL_TMUX: tmuxBin };
    delete e.TMUX;
    delete e.TMUX_PANE;
    return e;
  };
  const tmux = (args) => execFile(tmuxBin, args, { env: isoEnv({}) });

  const rtPort = await getFreePort();
  let child;
  try {
    // Pre-existing session so the new window lands in it (mirrors the operator's
    // "existing tmux session" default), and gives the registry a prior row.
    await tmux(['new-session', '-d', '-s', 'box', '-n', 'prior', '-c', data]);

    child = await new Promise((resolve, reject) => {
      const c = spawn(process.execPath, [SERVER_JS], {
        env: isoEnv({
          CLAUDE_CONTROL_PORT: String(rtPort),
          CLAUDE_CONTROL_TOKEN: TEST_TOKEN,
          CLAUDE_CONTROL_DATA: data,
          CLAUDE_CONTROL_UPLOADS: uploads,
          CLAUDE_CONTROL_PINS: path.join(data, 'pins.json'),
          CLAUDE_CONTROL_PROJECTS: data,
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let settled = false;
      const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('server did not start')); } }, 10_000);
      c.stdout.on('data', (chunk) => {
        if (!settled && chunk.toString().includes('claude-control →')) { settled = true; clearTimeout(timer); resolve(c); }
      });
      c.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited (${code})`)); } });
    });

    const missing = path.join(base, 'Projects', 'hello-mobile');
    // A1: missing cwd, no createCwd → 400 cwd_missing, and NO window created.
    const a1 = await post(rtPort, '/api/session/new', { agent: 'claude', cwd: missing, name: 'hello-mobile', claudeTransport: 'tmux' });
    assert.equal(a1.status, 400, 'A1: missing cwd → 400');
    assert.equal((await a1.json()).code, 'cwd_missing', 'A1: cwd_missing');

    // A2: confirm → createCwd:true → 200 with the real session.
    const a2 = await post(rtPort, '/api/session/new', { agent: 'claude', cwd: missing, name: 'hello-mobile', claudeTransport: 'tmux', createCwd: true });
    assert.equal(a2.status, 200, 'A2: createCwd retry → 200');
    const result = await a2.json();
    assert.equal(result.ok, true);
    assert.equal(result.name, 'hello-mobile', 'A2: name is the requested name, not the cwd basename');

    // (1) SHAPE: the returned target is the PANE shape "session:windowIndex.paneIndex"
    //     the registry keys by — NOT the bare window shape. The pre-fix server
    //     returned "box:N" (window shape), which this assertion rejects.
    assert.match(
      result.target,
      /^[^:]+:\d+\.\d+$/,
      `returned target must be pane-shaped (session:window.pane), got "${result.target}"`,
    );

    // (2) + (3) FRESHNESS + ATTACH: opening a WS immediately (as the client does
    //     on select) must find the session in the initial snapshot AND a
    //     subscribe to the returned target must attach (a transcript snapshot),
    //     never ack "unknown session". This is the exact detach symptom.
    const attach = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${rtPort}/`, ['claude-control', TEST_TOKEN]);
      const out = { snapshotHasId: null, subscribeError: null, attached: false };
      let done = false;
      const finish = () => { if (done) return; done = true; try { ws.close(); } catch { /* noop */ } resolve(out); };
      ws.on('message', (raw) => {
        let m;
        try { m = JSON.parse(raw.toString()); } catch { return; }
        if (m.type === 'sessions' && out.snapshotHasId === null) {
          out.snapshotHasId = (m.sessions || []).some((s) => s.id === result.target);
          ws.send(JSON.stringify({ type: 'subscribe', id: result.target }));
        }
        if (m.type === 'ack' && m.op === 'subscribe' && m.ok === false) { out.subscribeError = m.error; finish(); }
        if ((m.type === 'messages' || m.type === 'append') && m.id === result.target) { out.attached = true; finish(); }
      });
      ws.on('error', () => finish());
      setTimeout(finish, 4000);
    });

    assert.equal(attach.subscribeError, null, `subscribe must not error (got "${attach.subscribeError}") — the detach bug`);
    assert.equal(attach.snapshotHasId, true, 'the freshly-created session must be in the initial sessions snapshot (registry refreshed)');
    assert.equal(attach.attached, true, 'subscribing to the returned target must attach its transcript (no manual heal)');
  } finally {
    try { if (child) child.kill('SIGKILL'); } catch { /* noop */ }
    try { await tmux(['kill-server']); } catch { /* noop */ }
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
  }
});
