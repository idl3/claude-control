#!/usr/bin/env node
// claude-control — HTTP + WebSocket integrator.
// Wires tmux discovery, transcript tailing, AskUserQuestion answering, and resource
// monitoring into a localhost web UI. Bind 127.0.0.1 only; never shell out with user text.

import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

import * as tmux from './lib/tmux.js';
import * as terminal from './lib/terminal.js';
import { TranscriptTailer } from './lib/transcript.js';
import { SubAgentsWatcher } from './lib/subagents.js';
import { parsePanePrompt } from './lib/prompt.js';
import { SessionRegistry, listRecentTranscripts } from './lib/sessions.js';
import { loadPins, savePins, validateTranscriptPath, pinKey } from './lib/pins.js';
import { ResourceMonitor } from './lib/resources.js';
import { buildAnswerProgram } from './lib/answer.js';
import { sweepUploads, resolveUploadPath } from './lib/uploads.js';
import { getVersionInfo, currentVersion } from './lib/version.js';
import * as push from './lib/push.js';
import { readConfig, writeConfig } from './lib/config.js';
// Note: the client offers [WS_PROTOCOL, token] as subprotocols; the `ws`
// library auto-selects the FIRST offered one (the non-secret WS_PROTOCOL label)
// and echoes it, so we never reflect the raw token back and need no custom
// handleProtocols here. checkWsToken just verifies the token is among the offers.
import { checkToken as authCheckToken, checkWsToken } from './lib/auth.js';

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

// Durable token: when no token env var is set, read the persisted one at
// ~/.claude-control/token (written by bin/install-service.sh / first run). This
// keeps the same token — and therefore the same phone URL — across restarts and
// /tmp wipes, without relying on a launcher to inject the env var.
function readPersistedToken() {
  try {
    const t = fs.readFileSync(path.join(os.homedir(), '.claude-control', 'token'), 'utf8').trim();
    return t || null;
  } catch {
    return null;
  }
}

const CONFIG = {
  port: Number(env('PORT')) || 4317,
  host: env('HOST') || '127.0.0.1',
  projectsRoot:
    env('PROJECTS') || path.join(os.homedir(), '.claude', 'projects'),
  // 768MB: a long-running Node server (WS + transcript tailing + the bundled
  // web app) baselines ~300-450MB of V8 heap + RSS, so the old 350MB budget
  // tripped "over limit" permanently. Override with CLAUDE_CONTROL_RSS_LIMIT_MB.
  rssLimitMB: Number(env('RSS_LIMIT_MB')) || 768,
  token: env('TOKEN') || readPersistedToken() || null,
  maxBuffer: Number(env('MAX_BUFFER')) || 500,
  maxUploadMB: Number(env('MAX_UPLOAD_MB')) || 25,
  uploadsDir:
    env('UPLOADS') || path.join(os.homedir(), '.claude-control', 'uploads'),
  uploadTtlHours: Number(env('UPLOAD_TTL_HOURS')) || 24,
  pinsFile:
    env('PINS') || path.join(os.homedir(), '.claude-control', 'pins.json'),
};

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
};

// Image MIME types served from the uploads route (extensions → content-type).
const IMAGE_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
  '.svg': 'image/svg+xml',
};

// --- shared state -----------------------------------------------------------
const registry = new SessionRegistry({ projectsRoot: CONFIG.projectsRoot, tmux });
const resources = new ResourceMonitor({ rssLimitMB: CONFIG.rssLimitMB });

// Manual transcript pins (windowId.paneIndex -> transcript path). Loaded at boot,
// applied to the registry, and editable via /api/pins.
let pins = loadPins(CONFIG.pinsFile);

/** id -> { tailer, clients:Set<ws>, pending } */
const subscriptions = new Map();

function sessionById(id) {
  return registry.getSessions().find((s) => s.id === id) || null;
}

// Authenticate an HTTP/API request: the token rides `Authorization: Bearer
// <token>` (NOT the URL). Tokenless server → always authorized. Thin wrapper
// over lib/auth so CONFIG.token isn't threaded through every call site.
function checkToken(req) {
  return authCheckToken(req, CONFIG.token);
}

// ttyd exception: the raw-terminal surface is opened with `window.open` to a
// separately-proxied URL and CANNOT send an Authorization header, so it keeps a
// `?token=` in its own URL. This gate reads the token from the query string for
// /term/* requests ONLY — the rest of the app is header/subprotocol-based.
// Tokenless server → always authorized.
function checkTerminalToken(reqUrl) {
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
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { sessions: registry.getSessions() });
  }
  if (u.pathname === '/api/health') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { ok: true, snapshot: resources.snapshot() });
  }
  if (u.pathname === '/api/version') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return getVersionInfo()
      .then((info) => endJson(res, 200, info))
      .catch(() => endJson(res, 200, { current: currentVersion(), latest: null, behind: 0, updateAvailable: false }));
  }
  if (u.pathname === '/api/update') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleUpdate(res);
  }
  if (u.pathname === '/api/upload') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleUpload(req, res, u);
  }
  if (u.pathname === '/api/file') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleServeFile(res, u);
  }
  if (u.pathname === '/api/pins') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'POST') return handleSetPin(req, res);
    return endJson(res, 200, { pins });
  }
  if (u.pathname === '/api/transcripts') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return listRecentTranscripts({ projectsRoot: CONFIG.projectsRoot })
      .then((list) => endJson(res, 200, { transcripts: list }))
      .catch((err) => endJson(res, 500, { error: String(err?.message || err) }));
  }
  if (u.pathname === '/api/push/vapid') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { publicKey: push.getPublicKey() });
  }
  if (u.pathname === '/api/push/subscribe') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return readJsonBody(req)
      .then((sub) => {
        if (!sub || typeof sub.endpoint !== 'string') {
          return endJson(res, 400, { error: 'invalid subscription' });
        }
        push.addSubscription(sub);
        return endJson(res, 200, { ok: true });
      })
      .catch((err) => endJson(res, 400, { error: String(err?.message || err) }));
  }
  if (u.pathname === '/api/push/unsubscribe') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return readJsonBody(req)
      .then((body) => {
        const endpoint = typeof body?.endpoint === 'string' ? body.endpoint : null;
        if (!endpoint) return endJson(res, 400, { error: 'endpoint required' });
        push.removeSubscription(endpoint);
        return endJson(res, 200, { ok: true });
      })
      .catch((err) => endJson(res, 400, { error: String(err?.message || err) }));
  }
  if (u.pathname === '/api/config') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    if (req.method === 'GET') return endJson(res, 200, readConfig());
    if (req.method === 'POST') return handleConfigSave(req, res);
    return endJson(res, 405, { error: 'method not allowed' });
  }
  if (u.pathname === '/api/session/new') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleSessionNew(req, res);
  }
  if (u.pathname === '/api/session/rename') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleSessionRename(req, res);
  }
  // GET /api/uploads/<basename> — token-gated, path-traversal-guarded.
  // Serves a single file from uploadsDir by basename only; no directory
  // segments are allowed. Used by the React UI to render inline attachment
  // previews (thumbnails + lightbox) without exposing the filesystem path.
  if (u.pathname.startsWith('/api/uploads/')) {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleServeUpload(req, res, u);
  }

  // Raw-terminal escape hatch: token-gated reverse proxy to an on-demand,
  // loopback-bound ttyd attached to this session's tmux pane. ttyd itself runs
  // with no auth; this branch (and the matching upgrade branch) is the gate.
  if (u.pathname.startsWith('/term/')) {
    if (!checkTerminalToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return proxyTerminalHttp(req, res, u);
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

// GET /api/uploads/<basename> — serve a single upload by basename.
// Security:
//   1. Only the basename is taken from the URL segment — no sub-dirs allowed.
//   2. sanitizeName strips any remaining path traversal characters.
//   3. The resolved absolute path is checked to start with uploadsDir + sep.
// Returns: 404 if the file doesn't exist, 200 with the correct content-type.
// Only image types get an image/* content-type; everything else is
// application/octet-stream with Content-Disposition: attachment to prevent
// the browser from executing arbitrary served files.
function handleServeUpload(req, res, u) {
  // Extract the last path segment only (drop any leading slashes / sub-dirs).
  const rawSegment = u.pathname.replace(/^\/api\/uploads\//, '');
  // Reject if the caller tried to include a sub-directory.
  if (rawSegment.includes('/') || rawSegment.includes('\\')) {
    res.writeHead(404); return res.end('not found');
  }
  const basename = sanitizeName(rawSegment);
  if (!basename) { res.writeHead(404); return res.end('not found'); }

  const full = path.join(CONFIG.uploadsDir, basename);
  // Defense-in-depth: resolved path must stay inside uploadsDir.
  if (!full.startsWith(CONFIG.uploadsDir + path.sep)) {
    res.writeHead(404); return res.end('not found');
  }

  fs.stat(full, (statErr) => {
    if (statErr) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(basename).toLowerCase();
    const imageMime = IMAGE_MIME[ext];
    const headers = imageMime
      ? { 'content-type': imageMime, 'cache-control': 'private, max-age=3600' }
      : {
          'content-type': 'application/octet-stream',
          'content-disposition': `attachment; filename="${basename}"`,
          'cache-control': 'private, max-age=3600',
        };
    res.writeHead(200, headers);
    fs.createReadStream(full).pipe(res);
  });
}

// Read a small JSON request body with a hard size cap (control payloads are
// tiny — same defense as handleUpload's byte cap, just much smaller). Resolves
// to the parsed object, or {} for an empty body. Rejects on overflow/bad JSON.
function readJsonBody(req, maxBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c) => {
      if (aborted) return;
      size += c.length;
      if (size > maxBytes) {
        aborted = true;
        req.destroy();
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', (err) => {
      if (!aborted) reject(err);
    });
  });
}

// POST /api/config — validate + persist the launch config. 400 on bad input.
async function handleConfigSave(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
  try {
    const saved = writeConfig(body);
    return endJson(res, 200, saved);
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
}

// POST /api/session/new — create a new tmux window in the configured (or
// body-overridden) cwd, then type the launch command into it via send-keys so
// the interactive shell resolves aliases. Security: the command is operator
// config and is only ever sent into a pane (never shell-exec'd), consistent
// with this app already typing into live sessions. Token-gated + localhost.
async function handleSessionNew(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
  const config = readConfig();
  const cwd =
    typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : config.defaultCwd;
  // Name is required-with-default: sanitize the requested name, falling back to
  // `session-<short-ts>` so a session is ALWAYS named (the rail reads the tmux
  // window name until a transcript title exists).
  const name = tmux.sanitizeName(body.name) || tmux.defaultSessionName();
  try {
    // (1) Reliable named path: the tmux window name. createWindow sets it via
    //     `new-window -n`, so the rail shows the name immediately.
    const target = await tmux.createWindow({ cwd, name });
    // (2) Claude's own session title: `claude --help` exposes `-n/--name`
    //     (display name in the prompt box, /resume picker, terminal title), so
    //     we append it to the launch command rather than relying on a delayed
    //     `/rename`. The name is shell-quoted (sanitizeName already stripped
    //     control chars/newlines) since the command is typed into an interactive
    //     shell so aliases like `yolo` resolve. sendText appends Enter → runs it.
    const launch = `${config.launchCommand} --name ${tmux.shellQuoteName(name)}`;
    await tmux.sendText(target, launch);
    return endJson(res, 200, { ok: true, target, name });
  } catch (err) {
    return endJson(res, 500, { error: String(err?.message || err) });
  }
}

// POST /api/session/rename — rename an existing session's tmux window. We do
// BOTH: (1) `rename-window` so the rail shows the new name on the next refresh,
// and (2) type `/rename <name>` into the pane so Claude updates its own session
// title (which the transcript records as a custom-title). The name is
// sanitized (control chars/newlines stripped) before either path. Token-gated +
// localhost, consistent with the rest of the control surface.
async function handleSessionRename(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const name = tmux.sanitizeName(body.name);
  if (!name) return endJson(res, 400, { error: 'name is required' });
  const session = sessionById(id);
  if (!session) return endJson(res, 404, { error: 'unknown session' });
  if (!tmux.isValidTarget(session.target)) {
    return endJson(res, 400, { error: 'invalid tmux target' });
  }
  try {
    // (1) tmux window name — instant in the rail (read until a transcript title exists).
    await tmux.renameWindow(session.target, name);
    // (2) Claude's own session title via the /rename slash command, typed into
    //     the pane (sanitizeName already removed newlines/control chars). The
    //     name follows /rename verbatim as a single argument to the command.
    await tmux.sendText(session.target, `/rename ${name}`);
    return endJson(res, 200, { ok: true });
  } catch (err) {
    return endJson(res, 500, { error: String(err?.message || err) });
  }
}

// Extract and validate the session id (== tmux target) from a /term/ path.
// The id is the first path segment after /term/, percent-decoded. Returns the
// decoded id only if it is both a known session AND a valid tmux target;
// otherwise null (caller responds 404/401). This is the injection guard: an id
// never reaches `spawn` unless it matches the CONTRACT target pattern.
function termIdFromPath(pathname) {
  const m = /^\/term\/([^/]+)/.exec(pathname);
  if (!m) return null;
  let id;
  try { id = decodeURIComponent(m[1]); } catch { return null; }
  if (!tmux.isValidTarget(id)) return null;
  const session = sessionById(id);
  if (!session) return null;
  return { id, target: session.target };
}

// HTTP pass-through to a session's ttyd. Ensures the process is up, then pipes
// the request/response verbatim. Registers the response socket as a client for
// idle ref-counting (the long-lived ttyd HTTP keep-alive / SSE keeps the proc
// warm; the WS upgrade is the real liveness signal).
async function proxyTerminalHttp(req, res, u) {
  const parsed = termIdFromPath(u.pathname);
  if (!parsed) { res.writeHead(404); return res.end('unknown terminal'); }

  let port;
  try {
    ({ port } = await terminal.ensureTerminal(parsed.id, parsed.target));
  } catch (err) {
    res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    return res.end(`terminal unavailable: ${err?.message || err}`);
  }

  // Forward the original path+query unchanged; ttyd was started with `-b` set to
  // /term/<encoded-id> so its own asset/WS links already match this prefix.
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port,
      method: req.method,
      path: u.pathname + (u.search || ''),
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
    res.end(`terminal proxy error: ${err.message}`);
  });
  req.pipe(proxyReq);
}

// Serve a previously-uploaded file back to the UI by absolute path (used by the
// in-transcript image previews / lightbox). Coexists with /api/uploads/<basename>
// above; both confine strictly to uploadsDir.
const FILE_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
};
function handleServeFile(res, u) {
  const full = resolveUploadPath(u.searchParams.get('path') || '', CONFIG.uploadsDir);
  // Confinement: only files strictly inside uploadsDir are served.
  if (!full) {
    return endJson(res, 403, { error: 'forbidden' });
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': FILE_MIME[ext] || 'application/octet-stream',
      'cache-control': 'private, max-age=3600',
    });
    res.end(data);
  });
}

// Set or clear a manual transcript pin. Body: { id, transcriptPath }.
// transcriptPath null/empty clears the pin. The pin is keyed by the session's
// stable windowId.paneIndex so it survives tmux window renumbering.
async function handleSetPin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
  const id = typeof body?.id === 'string' ? body.id : '';
  const session = sessionById(id);
  if (!session) return endJson(res, 404, { error: 'unknown session' });
  const key = pinKey(session.windowId, session.paneIndex);

  const raw = body?.transcriptPath;
  if (raw == null || raw === '') {
    delete pins[key];
  } else {
    const full = validateTranscriptPath(raw, CONFIG.projectsRoot);
    if (!full) return endJson(res, 400, { error: 'invalid transcript path' });
    pins = { ...pins, [key]: full };
  }
  try {
    savePins(CONFIG.pinsFile, pins);
  } catch (err) {
    return endJson(res, 500, { error: String(err?.message || err) });
  }
  registry.setPins(pins);
  return endJson(res, 200, { ok: true, pins });
}

function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const full = path.join(PUBLIC_DIR, rel);
  // path-traversal guard
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== path.join(PUBLIC_DIR, 'index.html')) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      // SPA fallback: a missing path with no file extension is a client-side
      // route (e.g. /0/1/1, a deep link to a session) — serve index.html so the
      // app boots and reads the path. Real missing assets (with an extension)
      // still 404.
      if (!path.extname(rel)) return serveIndexHtml(res);
      res.writeHead(404);
      return res.end('not found');
    }
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

// Serve the SPA shell (index.html) for client-side routes.
function serveIndexHtml(res) {
  fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': MIME['.html'],
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
  // Origin check first (403) — applies to every upgrade regardless of path.
  if (!isAllowedOrigin(req.headers.origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const upgradePath = new URL(req.url, 'http://localhost').pathname;

  // Raw-terminal escape hatch: relay /term/* WS upgrades to the session's ttyd
  // via a raw TCP pipe (ttyd speaks its own WS protocol; we are a transparent
  // byte relay, not a `ws` endpoint). Browsers can't set headers on the ttyd
  // WebSocket, so this surface authenticates via the `?token=` it keeps in its
  // URL. All other upgrades go to the existing claude-control WebSocketServer.
  if (upgradePath.startsWith('/term/')) {
    if (!checkTerminalToken(req.url)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    relayTerminalUpgrade(req, socket, head);
    return;
  }

  // Main cockpit WS: the browser can't set an Authorization header on
  // `new WebSocket(...)`, so the client offers the token as a subprotocol
  // (Sec-WebSocket-Protocol). Tokenless server → accept. We do NOT echo the
  // raw token back; if a subprotocol must be selected, we pick the non-secret
  // WS_PROTOCOL label (which the client always offers alongside the token).
  if (!checkWsToken(req, CONFIG.token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

// Relay a /term/* WebSocket upgrade to the session's loopback ttyd as a raw
// TCP byte pipe. We reconstruct the upgrade request line + headers verbatim and
// replay them (plus any bytes already buffered in `head`) onto a fresh socket
// to 127.0.0.1:<port>, then pipe both directions. Auth was already enforced by
// the origin+token checks above; this inherits it.
async function relayTerminalUpgrade(req, socket, head) {
  const upgradePath = new URL(req.url, 'http://localhost').pathname;
  const parsed = termIdFromPath(upgradePath);
  if (!parsed) {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  let port;
  try {
    ({ port } = await terminal.ensureTerminal(parsed.id, parsed.target));
  } catch {
    socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    socket.destroy();
    return;
  }

  const upstream = net.connect(port, '127.0.0.1', () => {
    // Replay the original upgrade request to ttyd verbatim.
    const headerLines = [`${req.method} ${req.url} HTTP/1.1`];
    const h = req.rawHeaders;
    for (let i = 0; i < h.length; i += 2) headerLines.push(`${h[i]}: ${h[i + 1]}`);
    upstream.write(headerLines.join('\r\n') + '\r\n\r\n');
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });

  // Ref-count this connection for idle teardown; release on either end closing.
  terminal.addClient(parsed.id, socket);
  const release = () => terminal.removeClient(parsed.id, socket);

  upstream.on('error', () => { socket.destroy(); });
  socket.on('error', () => { upstream.destroy(); });
  upstream.on('close', () => { release(); socket.destroy(); });
  socket.on('close', () => { release(); upstream.destroy(); });
}

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
    startPromptPoller(id, sub);
    return sub;
  }

  const tailer = new TranscriptTailer(session.transcriptPath, { maxBuffer: CONFIG.maxBuffer });
  // Watch this session's sub-agent transcripts (Task/Agent). Discovery is polled
  // when the parent transcript grows (when sub-agents spawn) + once at subscribe.
  const subagents = new SubAgentsWatcher(session.transcriptPath);
  sub = { tailer, subagents, clients: new Set(), pending: null };
  subscriptions.set(id, sub);

  subagents.on('change', (entry) =>
    broadcastTo(id, { type: 'subagent', id, subagent: entry }),
  );

  tailer.on('append', (msgs) => {
    broadcastTo(id, { type: 'append', id, messages: msgs });
    // A sub-agent may have just spawned (poll for its files) or finished (its
    // Task tool-call produced a tool_result → mark it done).
    subagents.poll();
    for (const m of msgs) {
      for (const b of m.blocks ?? []) {
        if (b.kind === 'tool_result' && b.forId) subagents.markDone(b.forId);
      }
    }
  });
  tailer.on('pending', (pending) => {
    sub.pending = pending;
    registry.setPending(id, !!pending);
    broadcastTo(id, { type: 'pending', id, pending });
  });
  tailer.on('error', (err) => broadcastTo(id, { type: 'ack', op: 'tail', ok: false, error: String(err?.message || err) }));

  // Kick off the bounded tail load once; all clients await this same promise so
  // the initial `messages` frame never races the first read. Poll sub-agents
  // after the initial load so an already-running sub-agent shows immediately.
  sub.ready = tailer.start().then(() => {
    subagents.poll();
    // Mark already-finished sub-agents done from the EXISTING buffer: their
    // parent tool_result arrived before subscribe and is never re-streamed, so
    // without this they'd be stuck showing "running".
    const doneIds = new Set();
    for (const m of tailer.getMessages()) {
      for (const b of m.blocks ?? []) {
        if (b.kind === 'tool_result' && b.forId) doneIds.add(b.forId);
      }
    }
    if (doneIds.size) subagents.markDone(doneIds);
  });
  sub.ready.catch(() => {}); // errors surface via the per-subscribe await below
  startPromptPoller(id, sub);
  return sub;
}

// Poll the live pane for a TUI selection prompt (permission/trust/numbered menu).
// These never reach the transcript, so without this the cockpit shows a pending
// tool-call and looks stuck. Broadcasts a `prompt` frame only when it changes.
function startPromptPoller(id, sub) {
  if (sub.promptTimer) return;
  sub._lastPrompt = undefined;
  const tick = async () => {
    const session = sessionById(id);
    if (!session || !tmux.isValidTarget(session.target)) return;
    let prompt = null;
    try {
      const cap = await tmux.capturePane(session.target, 40);
      prompt = parsePanePrompt(cap);
    } catch {
      return;
    }
    const json = prompt ? JSON.stringify(prompt) : null;
    if (json !== sub._lastPrompt) {
      sub._lastPrompt = json;
      broadcastTo(id, { type: 'prompt', id, prompt });
    }
  };
  sub.promptTimer = setInterval(() => tick().catch(() => {}), 2000);
  if (sub.promptTimer.unref) sub.promptTimer.unref();
  tick().catch(() => {});
}

function maybeTeardown(id) {
  const sub = subscriptions.get(id);
  if (sub && sub.clients.size === 0) {
    if (sub.tailer) sub.tailer.stop();
    if (sub.subagents) sub.subagents.stop();
    if (sub.promptTimer) clearInterval(sub.promptTimer);
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
      // Snapshot any already-running sub-agents for this session.
      const subs = sub.subagents ? sub.subagents.snapshot() : [];
      if (subs.length) send(ws, { type: 'subagents', id: msg.id, subagents: subs });
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
    case 'promptkey': {
      // Respond to a live TUI selection prompt (permission/menu). Whitelisted
      // keys only — never arbitrary text — so this can't be used to inject input.
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      const ALLOWED = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Enter', 'Escape', 'Up', 'Down']);
      if (!ALLOWED.has(msg.key)) throw new Error('key not allowed');
      await tmux.sendRawKeys(session.target, [msg.key]);
      // Force the next poll tick to broadcast (the prompt should now change/clear).
      const sub = subscriptions.get(msg.id);
      if (sub) sub._lastPrompt = '__force__';
      return send(ws, { type: 'ack', op: 'promptkey', ok: true });
    }
    default:
      return;
  }
}

// --- wiring -----------------------------------------------------------------
// Edge-detect AskUserQuestion pending per session so a phone gets exactly one
// push when a question opens (re-arms once it's answered). id -> last pending.
const lastPending = new Map();
// Skip the very first 'change' so already-pending sessions present at startup
// don't all fire a push when the server boots.
let pushPrimed = false;

function firePushForChange(sessions) {
  try {
    if (!pushPrimed) {
      for (const s of sessions) lastPending.set(s.id, !!s.pending);
      pushPrimed = true;
      return;
    }
    const seen = new Set();
    for (const s of sessions) {
      seen.add(s.id);
      const was = lastPending.get(s.id) ?? false;
      if (s.pending && !was) {
        push
          .sendToAll({
            title: s.name || s.id,
            body: s.pendingQuestion || 'is asking a question',
            data: { id: s.id },
          })
          .catch((err) => console.error('push: sendToAll failed:', err?.message || err));
      }
      lastPending.set(s.id, !!s.pending);
    }
    // Forget sessions that disappeared so a returning id re-arms cleanly.
    for (const id of [...lastPending.keys()]) {
      if (!seen.has(id)) lastPending.delete(id);
    }
  } catch (err) {
    // Never let push logic break the session broadcast.
    console.error('push: firePushForChange error:', err?.message || err);
  }
}

registry.on('change', (sessions) => {
  firePushForChange(sessions);
  broadcast({ type: 'sessions', sessions });
});
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
  registry.setPins(pins); // apply persisted pins before the first refresh
  registry.start();
  resources.start();
  await registry.refresh().catch(() => {});

  // Daily attachment cleanup: sweep at startup, then every 24h.
  runUploadSweep();
  uploadSweepTimer = setInterval(runUploadSweep, 24 * 3600 * 1000);
  uploadSweepTimer.unref();

  server.listen(CONFIG.port, CONFIG.host, () => {
    // eslint-disable-next-line no-console
    console.log(`claude-control → http://${CONFIG.host}:${CONFIG.port}/`);
    if (CONFIG.token) {
      // The token is no longer carried in the URL — the web app prompts for it
      // on load and sends it as an Authorization header (HTTP) / subprotocol
      // (WS). Print it so the operator can paste it into the login prompt.
      console.log(`   (access token: ${CONFIG.token} — enter it at the login prompt)`);
    } else {
      console.log('   (no COCKPIT_TOKEN set — relying on 127.0.0.1 bind. This UI can type into your sessions.)');
    }
  });
}

function shutdown() {
  for (const [, sub] of subscriptions) sub.tailer?.stop();
  terminal.shutdownAll();
  registry.stop();
  resources.stop();
  if (uploadSweepTimer) clearInterval(uploadSweepTimer);
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
