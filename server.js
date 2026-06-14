#!/usr/bin/env node
// claude-control — HTTP + WebSocket integrator.
// Wires tmux discovery, transcript tailing, AskUserQuestion answering, and resource
// monitoring into a localhost web UI. Bind 127.0.0.1 only; never shell out with user text.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

import * as tmux from './lib/tmux.js';
import { TranscriptTailer } from './lib/transcript.js';
import { SessionRegistry } from './lib/sessions.js';
import { ResourceMonitor } from './lib/resources.js';
import { buildAnswerProgram } from './lib/answer.js';
import { sweepUploads } from './lib/uploads.js';
import { getVersionInfo, currentVersion } from './lib/version.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Prefer the built assistant-ui app (web/dist) when present; otherwise fall back
// to the zero-build vanilla UI in public/.
const DIST_DIR = path.join(__dirname, 'web', 'dist');
const PUBLIC_DIR = fs.existsSync(path.join(DIST_DIR, 'index.html'))
  ? DIST_DIR
  : path.join(__dirname, 'public');

// Env lookup: prefer CLAUDE_CONTROL_<X>, fall back to the legacy COCKPIT_<X>
// (kept so existing launchers keep working after the claude-control rename).
const env = (name) =>
  process.env[`CLAUDE_CONTROL_${name}`] ?? process.env[`COCKPIT_${name}`];

const CONFIG = {
  port: Number(env('PORT')) || 4317,
  host: env('HOST') || '127.0.0.1',
  projectsRoot:
    env('PROJECTS') || path.join(os.homedir(), '.claude', 'projects'),
  // 768MB: a long-running Node server (WS + transcript tailing + the bundled
  // web app) baselines ~300-450MB of V8 heap + RSS, so the old 350MB budget
  // tripped "over limit" permanently. Override with CLAUDE_CONTROL_RSS_LIMIT_MB.
  rssLimitMB: Number(env('RSS_LIMIT_MB')) || 768,
  token: env('TOKEN') || null,
  maxBuffer: Number(env('MAX_BUFFER')) || 500,
  maxUploadMB: Number(env('MAX_UPLOAD_MB')) || 25,
  uploadsDir:
    env('UPLOADS') || path.join(os.homedir(), '.claude-control', 'uploads'),
  uploadTtlHours: Number(env('UPLOAD_TTL_HOURS')) || 24,
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
};

// --- shared state -----------------------------------------------------------
const registry = new SessionRegistry({ projectsRoot: CONFIG.projectsRoot, tmux });
const resources = new ResourceMonitor({ rssLimitMB: CONFIG.rssLimitMB });

/** id -> { tailer, clients:Set<ws>, pending } */
const subscriptions = new Map();

function sessionById(id) {
  return registry.getSessions().find((s) => s.id === id) || null;
}

function checkToken(reqUrl) {
  if (!CONFIG.token) return true;
  try {
    const u = new URL(reqUrl, 'http://localhost');
    return u.searchParams.get('token') === CONFIG.token;
  } catch {
    return false;
  }
}

// Reject cross-origin WebSocket upgrades. A page at any origin can open
// ws://127.0.0.1:<port> from the user's browser; since this UI can type into
// live tmux sessions, we only accept connections from our own localhost origin
// or from non-browser clients (which send no Origin header).
function isAllowedOrigin(origin) {
  if (!origin) return true; // non-browser WS client (e.g. a script)
  try {
    const host = new URL(origin).hostname;
    if (host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1') return true;
    // Tailscale MagicDNS hostnames (tailnet-private) when reached via `tailscale
    // serve`. The tailnet ACL already restricts who can connect; the token gate
    // is the second factor since this UI can type into live sessions.
    if (host.endsWith('.ts.net')) return true;
    return false;
  } catch {
    return false;
  }
}

// --- HTTP -------------------------------------------------------------------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/sessions') {
    if (!checkToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { sessions: registry.getSessions() });
  }
  if (u.pathname === '/api/health') {
    if (!checkToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { ok: true, snapshot: resources.snapshot() });
  }
  if (u.pathname === '/api/version') {
    if (!checkToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return getVersionInfo()
      .then((info) => endJson(res, 200, info))
      .catch(() => endJson(res, 200, { current: currentVersion(), latest: null, behind: 0, updateAvailable: false }));
  }
  if (u.pathname === '/api/update') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return handleUpdate(res);
  }
  if (u.pathname === '/api/upload') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return handleUpload(req, res, u);
  }

  // static
  serveStatic(u.pathname, res);
});

// In-UI "Update now" (POST /api/update): run the self-update script DETACHED
// (it git-pulls, reinstalls, rebuilds the web bundle, then restarts this
// server). Returns immediately; the client shows "updating…" and reconnects
// when the new server comes back up on the same port.
function handleUpdate(res) {
  const script = path.join(__dirname, 'bin', 'self-update.sh');
  if (!fs.existsSync(script)) {
    return endJson(res, 500, { error: 'self-update script missing' });
  }
  try {
    const child = spawn('/bin/bash', [script], {
      cwd: __dirname,
      env: process.env,
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return endJson(res, 200, { ok: true, updating: true });
  } catch (err) {
    return endJson(res, 500, { error: String(err?.message || err) });
  }
}

function endJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': MIME['.json'], 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// Sanitize an uploaded filename to a safe basename (no path traversal).
function sanitizeName(name) {
  const base = path.basename(String(name || 'file'));
  const safe = base.replace(/[^A-Za-z0-9._-]/g, '_').replace(/^\.+/, '').slice(0, 128);
  return safe || 'file';
}

// Receive a raw-body file upload (the client POSTs the file bytes directly),
// cap the size, save under uploadsDir, and return the absolute path so the
// client can inject it into the prompt for the Claude session to read.
function handleUpload(req, res, u) {
  const maxBytes = CONFIG.maxUploadMB * 1024 * 1024;
  const name = sanitizeName(u.searchParams.get('name'));
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > maxBytes) {
      aborted = true;
      endJson(res, 413, { error: `file exceeds ${CONFIG.maxUploadMB} MB limit` });
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', async () => {
    if (aborted) return;
    if (size === 0) return endJson(res, 400, { error: 'empty upload' });
    try {
      await fs.promises.mkdir(CONFIG.uploadsDir, { recursive: true });
      const stamped = `${Date.now()}-${name}`;
      const full = path.join(CONFIG.uploadsDir, stamped);
      // Defense-in-depth: ensure the resolved path stays inside uploadsDir.
      if (!full.startsWith(CONFIG.uploadsDir + path.sep)) {
        return endJson(res, 400, { error: 'invalid filename' });
      }
      await fs.promises.writeFile(full, Buffer.concat(chunks), { mode: 0o600 });
      endJson(res, 200, { ok: true, path: full, name });
    } catch (err) {
      endJson(res, 500, { error: String(err?.message || err) });
    }
  });

  req.on('error', () => {
    if (!aborted) endJson(res, 400, { error: 'upload stream error' });
  });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  // path-traversal guard
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      // Personal tool under active iteration: never let a phone serve a stale
      // UI. Always revalidate so CSS/JS fixes show up on the next load.
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

// --- WebSocket --------------------------------------------------------------
// 1 MB cap: control messages are tiny; this prevents a single huge frame from
// forcing a multi-hundred-MB string allocation in the cockpit process.
const wss = new WebSocketServer({ noServer: true, maxPayload: 1 * 1024 * 1024 });

server.on('upgrade', (req, socket, head) => {
  if (!isAllowedOrigin(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  if (!checkToken(req.url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of wss.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}
function broadcastTo(id, obj) {
  const sub = subscriptions.get(id);
  if (!sub) return;
  const msg = JSON.stringify(obj);
  for (const ws of sub.clients) if (ws.readyState === ws.OPEN) ws.send(msg);
}

function ensureSubscription(id) {
  let sub = subscriptions.get(id);
  if (sub) {
    // Upgrade a previously tailer-less subscription once the session's
    // transcript has been matched on a later refresh: tear it down so the
    // block below recreates it WITH a tailer (clients re-subscribe).
    const cur = sessionById(id);
    if (sub.tailer === null && cur?.transcriptPath) {
      subscriptions.delete(id);
    } else {
      return sub;
    }
  }
  const session = sessionById(id);
  if (!session) return null; // genuinely unknown tmux target

  // A live Claude pane may have NO matched transcript (a brand-new session, or
  // a worktree whose transcript Claude records under a different cwd than the
  // pane's current path). Previously this returned null → the session showed in
  // the rail but errored "unknown session" the moment it was opened. Instead,
  // allow the subscription with no tailer: the UI still shows the live pane via
  // `capture` and accepts `reply`, and a later refresh that matches the
  // transcript upgrades the subscription (see the tailer-null branch above).
  if (!session.transcriptPath) {
    sub = { tailer: null, clients: new Set(), pending: null, ready: Promise.resolve() };
    subscriptions.set(id, sub);
    return sub;
  }

  const tailer = new TranscriptTailer(session.transcriptPath, { maxBuffer: CONFIG.maxBuffer });
  sub = { tailer, clients: new Set(), pending: null };
  subscriptions.set(id, sub);

  tailer.on('append', (msgs) => broadcastTo(id, { type: 'append', id, messages: msgs }));
  tailer.on('pending', (pending) => {
    sub.pending = pending;
    registry.setPending(id, !!pending);
    broadcastTo(id, { type: 'pending', id, pending });
  });
  tailer.on('error', (err) => broadcastTo(id, { type: 'ack', op: 'tail', ok: false, error: String(err?.message || err) }));

  // Kick off the bounded tail load once; all clients await this same promise so
  // the initial `messages` frame never races the first read.
  sub.ready = tailer.start();
  sub.ready.catch(() => {}); // errors surface via the per-subscribe await below
  return sub;
}

function maybeTeardown(id) {
  const sub = subscriptions.get(id);
  if (sub && sub.clients.size === 0) {
    if (sub.tailer) sub.tailer.stop();
    subscriptions.delete(id);
  }
}

wss.on('connection', (ws) => {
  send(ws, { type: 'sessions', sessions: registry.getSessions() });
  send(ws, { type: 'resources', snapshot: resources.snapshot() });
  ws._subs = new Set();

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    try {
      await handleClientMessage(ws, msg);
    } catch (err) {
      send(ws, { type: 'ack', op: msg?.type || 'unknown', ok: false, error: String(err?.message || err) });
    }
  });

  ws.on('close', () => {
    for (const id of ws._subs) {
      const sub = subscriptions.get(id);
      if (sub) { sub.clients.delete(ws); maybeTeardown(id); }
    }
  });
});

async function handleClientMessage(ws, msg) {
  switch (msg.type) {
    case 'subscribe': {
      const sub = ensureSubscription(msg.id);
      if (!sub) return send(ws, { type: 'ack', op: 'subscribe', ok: false, error: 'unknown session' });
      sub.clients.add(ws);
      ws._subs.add(msg.id);
      try {
        await sub.ready; // wait for the bounded tail load to finish before snapshotting
      } catch (err) {
        return send(ws, { type: 'ack', op: 'subscribe', ok: false, error: String(err?.message || err) });
      }
      // Client may have unsubscribed/closed while we awaited.
      if (!sub.clients.has(ws)) return;
      send(ws, {
        type: 'messages',
        id: msg.id,
        // Tailer-less subscription (no matched transcript): no history to send.
        messages: sub.tailer ? sub.tailer.getMessages() : [],
        pending: sub.tailer ? sub.tailer.getPending() : null,
      });
      return;
    }
    case 'unsubscribe': {
      const sub = subscriptions.get(msg.id);
      if (sub) { sub.clients.delete(ws); ws._subs.delete(msg.id); maybeTeardown(msg.id); }
      return;
    }
    case 'reply': {
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      await tmux.sendText(session.target, String(msg.text ?? ''));
      return send(ws, { type: 'ack', op: 'reply', ok: true });
    }
    case 'answer': {
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      const sub = subscriptions.get(msg.id);
      const pending = sub?.tailer ? sub.tailer.getPending() : null;
      if (!pending) throw new Error('no pending question');
      // Require the client to name the exact question it is answering, so a
      // mismatched (or omitted) id can't be applied to whatever is now pending.
      if (msg.toolUseId !== pending.toolUseId) {
        throw new Error('stale question (already answered or changed)');
      }
      const keys = buildAnswerProgram(pending, msg.selections || []);
      // Sequenced (with delays) so single-select auto-advance settles between keys.
      await tmux.sendRawKeysSequenced(session.target, keys);
      return send(ws, { type: 'ack', op: 'answer', ok: true });
    }
    case 'capture': {
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      const lines = Math.max(1, Math.min(10000, Number(msg.lines) || 40));
      const text = await tmux.capturePane(session.target, lines);
      return send(ws, { type: 'capture', id: msg.id, text });
    }
    default:
      return;
  }
}

// --- wiring -----------------------------------------------------------------
registry.on('change', (sessions) => broadcast({ type: 'sessions', sessions }));
resources.on('sample', (snapshot) => broadcast({ type: 'resources', snapshot }));
resources.on('overlimit', (snapshot) => {
  // Trim memory pressure: drop tailers nobody is watching, then halve the
  // retained buffer on the active ones too.
  const keep = Math.floor(CONFIG.maxBuffer / 2);
  for (const [id, sub] of subscriptions) {
    if (sub.clients.size === 0) maybeTeardown(id);
    else if (sub.tailer) sub.tailer.trim(keep);
  }
  broadcast({ type: 'resources', snapshot, warning: 'self RSS over limit — trimming buffers' });
});

let uploadSweepTimer = null;

async function runUploadSweep() {
  try {
    const ttlMs = CONFIG.uploadTtlHours * 3600 * 1000;
    const { removed } = await sweepUploads(CONFIG.uploadsDir, ttlMs);
    if (removed > 0) console.log(`uploads sweep: removed ${removed} file(s) older than ${CONFIG.uploadTtlHours}h`);
  } catch (err) {
    console.error('uploads sweep failed:', err?.message || err);
  }
}

async function main() {
  registry.start();
  resources.start();
  await registry.refresh().catch(() => {});

  // Daily attachment cleanup: sweep at startup, then every 24h.
  runUploadSweep();
  uploadSweepTimer = setInterval(runUploadSweep, 24 * 3600 * 1000);
  uploadSweepTimer.unref();

  server.listen(CONFIG.port, CONFIG.host, () => {
    const tokenHint = CONFIG.token ? `?token=${CONFIG.token}` : '';
    // eslint-disable-next-line no-console
    console.log(`claude-control → http://${CONFIG.host}:${CONFIG.port}/${tokenHint}`);
    if (!CONFIG.token) {
      console.log('   (no COCKPIT_TOKEN set — relying on 127.0.0.1 bind. This UI can type into your sessions.)');
    }
  });
}

function shutdown() {
  for (const [, sub] of subscriptions) sub.tailer?.stop();
  registry.stop();
  resources.stop();
  if (uploadSweepTimer) clearInterval(uploadSweepTimer);
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
