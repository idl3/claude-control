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
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

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
