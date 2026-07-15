/**
 * test/server.test.js
 *
 * Integration tests for the claude-control HTTP/WS surface.
 * Covers: uploads token-gate + path-traversal, /api/agents shape,
 * promptselect WS op (error path), and WS auth handshake.
 *
 * Runs the actual server as a child process on an ephemeral port so that no
 * production behavior is mocked away. Focused on security-relevant paths.
 *
 * Run: node --test test/server.test.js
 */

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { staticCacheControl } from '../server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SERVER_JS = path.join(__dirname, '..', 'server.js');

const TEST_TOKEN = 'test-secret-cockpit-99';
const AUTH_HEADER = { authorization: `Bearer ${TEST_TOKEN}` };

/**
 * Reserve an ephemeral port by binding + immediately closing a server.
 * Returns the port number.
 */
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

/**
 * Spawn the server as a child process and wait until it logs its startup line
 * (or reject after a timeout). Returns { child, port, uploadsDir }.
 */
async function startServer(port, uploadsDir) {
  const pinsFile = path.join(os.tmpdir(), `cc-test-pins-${port}.json`);
  fs.writeFileSync(pinsFile, '{}');

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_JS], {
      env: {
        ...process.env,
        CLAUDE_CONTROL_PORT: String(port),
        CLAUDE_CONTROL_TOKEN: TEST_TOKEN,
        CLAUDE_CONTROL_UPLOADS: uploadsDir,
        CLAUDE_CONTROL_PINS: pinsFile,
        // Point at a known-empty directory so tmux errors don't crash startup.
        CLAUDE_CONTROL_PROJECTS: os.tmpdir(),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const settle = (val, isErr) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (isErr) reject(val);
      else resolve({ child, port, uploadsDir });
    };

    // Wait for the "claude-control → http://" startup line.
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('claude-control →')) settle({ child, port, uploadsDir });
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

/** Simple fetch wrapper scoped to the test server. */
function req(port, pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
}

// ---------------------------------------------------------------------------
// Module-level server lifecycle
// ---------------------------------------------------------------------------

let port;
let uploadsDir;
let serverCtx; // { child, port, uploadsDir }

before(async () => {
  port = await getFreePort();
  uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-uploads-test-'));
  serverCtx = await startServer(port, uploadsDir);
});

after(() => {
  try { serverCtx?.child?.kill('SIGTERM'); } catch { /* already gone */ }
  try { fs.rmSync(uploadsDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ===========================================================================
// 1. GET /api/uploads/<basename> — token gate + path-traversal boundary
// ===========================================================================

test('uploads: missing token → 401', async () => {
  const res = await req(port, '/api/uploads/test.png');
  assert.equal(res.status, 401, 'missing token must produce 401');
});

test('uploads: wrong token → 401', async () => {
  const res = await req(port, '/api/uploads/test.png', {
    headers: { authorization: 'Bearer totally-wrong-token' },
  });
  assert.equal(res.status, 401, 'wrong token must produce 401');
});

test('uploads: valid token + missing file → 404', async () => {
  const res = await req(port, '/api/uploads/definitely-missing-file-zzz.png', {
    headers: AUTH_HEADER,
  });
  assert.equal(res.status, 404, 'non-existent file must produce 404');
});

test('uploads: valid token + existing file → 200', async () => {
  const filename = 'test-upload-abc123.png';
  const filePath = path.join(uploadsDir, filename);
  fs.writeFileSync(filePath, Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic bytes

  const res = await req(port, `/api/uploads/${filename}`, { headers: AUTH_HEADER });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') ?? '', /image\/png/);

  fs.unlinkSync(filePath);
});

// ---------------------------------------------------------------------------
// Path-traversal tests — these MUST fail against a naive implementation that
// does path.join(uploadsDir, req.param) without sanitisation. They test that
// the shipped handler blocks every traversal variant before even calling stat().
// ---------------------------------------------------------------------------

test('uploads: traversal via raw .. in HTTP request line → no passwd content leaked', async () => {
  // fetch() normalises /api/uploads/../etc/passwd → /etc/passwd before sending.
  // To test the server's own path-segment guard we must send a raw HTTP request
  // without URL normalisation, using a TCP socket. This simulates a client that
  // bypasses the browser's URL normaliser.
  const body = await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => {
      socket.write(
        'GET /api/uploads/../etc/passwd HTTP/1.0\r\n' +
        `Authorization: Bearer ${TEST_TOKEN}\r\n` +
        'Host: 127.0.0.1\r\n' +
        '\r\n',
      );
    });
    const chunks = [];
    socket.on('data', (c) => chunks.push(c));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
    setTimeout(() => { socket.destroy(); reject(new Error('raw req timeout')); }, 3000);
  });

  // The response must NOT contain /etc/passwd root entry content.
  // It should be a 404 from the uploads handler (slash in segment), OR
  // a 301/302 redirect, OR whatever the static handler returns — but never
  // an unguarded read of /etc/passwd from the uploads dir.
  assert.ok(
    !body.includes('root:') && !body.includes('/bin/sh'),
    'server must not leak /etc/passwd contents via path traversal',
  );
});

test('uploads: traversal via URL-encoded %2e%2e → 404 (not leaked outside dir)', async () => {
  // %2e%2e = ".." URL-encoded. The server (or Node's URL parser) decodes this,
  // so the resolved segment contains a slash — the slash-guard in handleServeUpload
  // must reject it.
  const res = await req(port, '/api/uploads/%2e%2eetc%2fpasswd', { headers: AUTH_HEADER });
  assert.notEqual(res.status, 200, 'URL-encoded traversal must not produce 200');
});

test('uploads: traversal via absolute path segment → 404', async () => {
  // /api/uploads//etc/passwd — double slash creates an empty first segment;
  // sanitizeName(path.basename('')) → 'file', which won't exist in uploadsDir.
  const res = await req(port, '/api/uploads//etc/passwd', { headers: AUTH_HEADER });
  assert.notEqual(res.status, 200, 'absolute path traversal must not produce 200');
});

test('uploads: traversal via backslash (Windows-style) → 404', async () => {
  // The handler explicitly checks for backslash in rawSegment.
  const res = await req(port, '/api/uploads/..%5cetc%5cpasswd', { headers: AUTH_HEADER });
  assert.notEqual(res.status, 200, 'backslash traversal must not produce 200');
});

// ===========================================================================
// 2. GET /api/agents — returns expected shape
// ===========================================================================

test('/api/agents: missing token → 401', async () => {
  const res = await req(port, '/api/agents');
  assert.equal(res.status, 401);
});

test('/api/agents: valid token → 200 with agents array', async () => {
  const res = await req(port, '/api/agents', { headers: AUTH_HEADER });
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(body !== null && typeof body === 'object', 'body must be an object');
  assert.ok(Array.isArray(body.agents), '`agents` field must be an array');

  // Each entry must have at minimum a `name` string and a `source` string.
  for (const agent of body.agents) {
    assert.equal(typeof agent.name, 'string', `agent.name must be string (got ${agent.name})`);
    assert.ok(
      ['user', 'project', 'plugin'].includes(agent.source),
      `agent.source must be 'user'|'project'|'plugin' (got ${agent.source})`,
    );
  }
});

// ===========================================================================
// 2b. GET /api/config restartSupported + POST /api/restart — supervised gate
// ===========================================================================
// The child process here is a plain `spawn(...)` from this test file (not
// launchd), so process.ppid !== 1 and CLAUDE_CONTROL_MANAGED is unset — the
// server MUST report itself as unmanaged and refuse to restart, which is
// exactly the footgun the supervised-gate exists to prevent.

test('/api/config: missing token → 401', async () => {
  const res = await req(port, '/api/config');
  assert.equal(res.status, 401);
});

test('/api/config: valid token → 200 with restartSupported:false for an unsupervised process', async () => {
  const res = await req(port, '/api/config', { headers: AUTH_HEADER });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.restartSupported, false, 'a bare test-spawned process must not report itself as restart-supported');
  // Additive-only: existing fields must still be present.
  assert.equal(typeof body.launchCommand, 'string');
  assert.equal(typeof body.defaultCwd, 'string');
});

test('/api/restart: missing token → 401', async () => {
  const res = await req(port, '/api/restart', { method: 'POST' });
  assert.equal(res.status, 401);
});

test('/api/restart: GET → 405 (POST-only)', async () => {
  const res = await req(port, '/api/restart', { headers: AUTH_HEADER });
  assert.equal(res.status, 405);
});

test('/api/restart: valid token, unmanaged process → 409 not_managed, server stays up', async () => {
  const res = await req(port, '/api/restart', { method: 'POST', headers: AUTH_HEADER });
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error, 'not_managed');
  assert.match(body.message, /KeepAlive|pm2|service/i);

  // The process must NOT have exited — a follow-up request still succeeds.
  const followUp = await req(port, '/api/agents', { headers: AUTH_HEADER });
  assert.equal(followUp.status, 200, 'server must still be alive after a refused restart');
});

// ===========================================================================
// 3. WS auth handshake — subprotocol token gate
// ===========================================================================

/**
 * Attempt a WebSocket upgrade. Returns the close code/reason, or resolves
 * with { connected: true } when the upgrade succeeds.
 */
function tryWsConnect(port, protocols = []) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, protocols);

    const timeout = setTimeout(() => {
      ws.terminate();
      resolve({ connected: false, timedOut: true });
    }, 3000);

    ws.on('open', () => {
      clearTimeout(timeout);
      ws.close(1000);
      resolve({ connected: true });
    });

    ws.on('unexpected-response', (req, res) => {
      clearTimeout(timeout);
      resolve({ connected: false, status: res.statusCode });
    });

    ws.on('error', (err) => {
      clearTimeout(timeout);
      resolve({ connected: false, error: err.message });
    });
  });
}

test('WS auth: correct token subprotocol → upgrade accepted', async () => {
  const result = await tryWsConnect(port, ['claude-control', TEST_TOKEN]);
  assert.equal(result.connected, true, `expected connected=true, got ${JSON.stringify(result)}`);
});

test('WS auth: no subprotocols (missing token) → upgrade rejected', async () => {
  const result = await tryWsConnect(port, []);
  assert.equal(result.connected, false, 'upgrade without token subprotocol must be rejected');
});

test('WS auth: wrong token subprotocol → upgrade rejected', async () => {
  const result = await tryWsConnect(port, ['claude-control', 'wrong-token-xyz']);
  assert.equal(result.connected, false, 'upgrade with wrong token must be rejected');
});

test('static cache headers: index revalidates, hashed assets are immutable', async () => {
  const indexRes = await req(port, '/');
  assert.equal(indexRes.status, 200);
  assert.match(indexRes.headers.get('cache-control') || '', /no-store/);

  assert.equal(
    staticCacheControl('assets/index-AbCdEf123.js', { viteDist: true }),
    'public, max-age=31536000, immutable',
  );
  assert.equal(
    staticCacheControl('assets/index.css', { viteDist: true }),
    'no-store, must-revalidate',
  );
});

// ===========================================================================
// 4. WS op: promptselect — unknown session → error ack
//
// Tests that the message-switch dispatch wires up correctly. The "happy path"
// requires a live tmux session (not feasible without refactoring server.js);
// the error path (unknown session → ack ok=false) is deterministic and
// exercises the same dispatch code path.
// ===========================================================================

/**
 * Open an authenticated WS connection, send one message, wait for an ack
 * matching op, then close. Rejects on timeout or connection failure.
 */
function wsSend(port, message, matchOp, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, ['claude-control', TEST_TOKEN]);

    const timer = setTimeout(() => {
      ws.terminate();
      reject(new Error(`timeout waiting for op=${matchOp} ack`));
    }, timeoutMs);

    ws.on('error', (err) => { clearTimeout(timer); reject(err); });

    ws.on('open', () => {
      ws.send(JSON.stringify(message));
    });

    ws.on('message', (raw) => {
      let parsed;
      try { parsed = JSON.parse(raw.toString()); } catch { return; }
      if (parsed.op === matchOp || (parsed.type === 'ack' && parsed.op === matchOp)) {
        clearTimeout(timer);
        ws.close(1000);
        resolve(parsed);
      }
    });
  });
}

test('WS promptselect: unknown session id → ack ok=false with error', async () => {
  const ack = await wsSend(
    port,
    { type: 'promptselect', id: 'nonexistent-session-id-ple43', labels: ['Option A'] },
    'promptselect',
  );
  assert.equal(ack.type, 'ack', `expected type=ack, got ${ack.type}`);
  assert.equal(ack.op, 'promptselect');
  assert.equal(ack.ok, false, 'unknown session must produce ok=false');
  assert.ok(typeof ack.error === 'string' && ack.error.length > 0, 'error message must be present');
});

test('WS promptselect: empty labels → ack ok=false with error', async () => {
  // labels=[] triggers the "no labels provided" guard BEFORE the session lookup
  // when the session doesn't exist — the session lookup throws first. Either way
  // the result is an error ack. We verify the shape is correct.
  const ack = await wsSend(
    port,
    { type: 'promptselect', id: 'nonexistent-session-id-ple43-b', labels: [] },
    'promptselect',
  );
  assert.equal(ack.type, 'ack');
  assert.equal(ack.op, 'promptselect');
  assert.equal(ack.ok, false);
});
