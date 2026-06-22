#!/usr/bin/env node
// claude-control — HTTP + WebSocket integrator.
// Wires tmux discovery, transcript tailing, AskUserQuestion answering, and resource
// monitoring into a localhost web UI. Bind 127.0.0.1 only; never shell out with user text.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { spawn, execFile as _execFileRaw } from 'node:child_process';
import { promisify } from 'node:util';
import fsp from 'node:fs/promises';

const _execFile = promisify(_execFileRaw);
import { WebSocketServer } from 'ws';

import * as tmux from './lib/tmux.js';
import * as terminal from './lib/terminal.js';
import * as shell from './lib/shell.js';
import { TranscriptTailer } from './lib/transcript.js';
import { SubAgentsWatcher, listAgents } from './lib/subagents.js';
import { parsePanePrompt } from './lib/prompt.js';
import { SessionRegistry, listRecentTranscripts } from './lib/sessions.js';
import { loadPins, savePins, validateTranscriptPath, pinKey } from './lib/pins.js';
import { ResourceMonitor, listProcesses, killProcess } from './lib/resources.js';
import { buildAnswerProgram, parsePicker, planStep } from './lib/answer.js';
import { sweepUploads, resolveUploadPath } from './lib/uploads.js';
import { getVersionInfo, currentVersion } from './lib/version.js';
import * as push from './lib/push.js';
import { readConfig, writeConfig } from './lib/config.js';
import { parseCodexRecord, parseCodexPrompt, buildSpawnCommand } from './lib/codex.js';
import { optimizePrompt, rulesOptimize } from './lib/optimize.js';
import * as mlx from './lib/mlx.js';
import {
  MLX_MODELS,
  CLAUDE_MODELS,
  detectMachine,
  recommendMlxModel,
  recommendClaudeModel,
} from './lib/models.js';
import { transcribe } from './lib/transcribe.js';
import { listSkills, readSkill } from './lib/skills.js';
// Note: the client offers [WS_PROTOCOL, token] as subprotocols; the `ws`
// library auto-selects the FIRST offered one (the non-secret WS_PROTOCOL label)
// and echoes it, so we never reflect the raw token back and need no custom
// handleProtocols here. checkWsToken just verifies the token is among the offers.
import { checkToken as authCheckToken, checkWsToken, safeTokenEqual } from './lib/auth.js';
import { pruneDeadClients } from './lib/ws-heartbeat.js';

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
  codexSessionsRoot:
    env('CODEX_SESSIONS') || path.join(os.homedir(), '.codex', 'sessions'),
  // 768MB: a long-running Node server (WS + transcript tailing + the bundled
  // web app) baselines ~300-450MB of V8 heap + RSS, so the old 350MB budget
  // tripped "over limit" permanently. Override with CLAUDE_CONTROL_RSS_LIMIT_MB.
  rssLimitMB: Number(env('RSS_LIMIT_MB')) || 768,
  token: env('TOKEN') || readPersistedToken() || null,
  // 4000: within lib/transcript's 8 MB byte tail, the message-count cap governs
  // how much history a fresh subscribe serves. Raised 1500 → 4000 for deeper
  // scrollback. Shares the CLAUDE_CONTROL_MAX_BUFFER override with lib/transcript.
  maxBuffer: Number(env('MAX_BUFFER')) || 4000,
  maxUploadMB: Number(env('MAX_UPLOAD_MB')) || 25,
  uploadsDir:
    env('UPLOADS') || path.join(os.homedir(), '.claude-control', 'uploads'),
  uploadTtlHours: Number(env('UPLOAD_TTL_HOURS')) || 24,
  pinsFile:
    env('PINS') || path.join(os.homedir(), '.claude-control', 'pins.json'),
  // Custom PWA home-screen icon (PNG). When present it overrides the bundled
  // default robot logo for the manifest icons + apple-touch-icon. Uploaded via
  // POST /api/icon, removed via DELETE /api/icon.
  iconFile:
    env('ICON') || path.join(os.homedir(), '.claude-control', 'icon.png'),
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
const registry = new SessionRegistry({ projectsRoot: CONFIG.projectsRoot, codexSessionsRoot: CONFIG.codexSessionsRoot, tmux });
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
    return safeTokenEqual(u.searchParams.get('token'), CONFIG.token);
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

// --- HTTP / HTTPS -----------------------------------------------------------
// Optional TLS: set TLS_CERT and TLS_KEY to PEM file paths to serve HTTPS.
// Both must be set together; a missing file is a hard startup error.
function loadTls() {
  const certPath = process.env.TLS_CERT;
  const keyPath = process.env.TLS_KEY;
  if (!certPath && !keyPath) return null;
  if (!certPath || !keyPath) {
    console.error('TLS error: both TLS_CERT and TLS_KEY must be set (only one was provided).');
    process.exit(1);
  }
  let cert, key;
  try { cert = fs.readFileSync(certPath); } catch (e) {
    console.error(`TLS error: cannot read TLS_CERT "${certPath}": ${e.message}`);
    process.exit(1);
  }
  try { key = fs.readFileSync(keyPath); } catch (e) {
    console.error(`TLS error: cannot read TLS_KEY "${keyPath}": ${e.message}`);
    process.exit(1);
  }
  return { cert, key };
}

const _tls = loadTls();
const _scheme = _tls ? 'https' : 'http';

const _handler = (req, res) => {
  try {
  const u = new URL(req.url, 'http://localhost');

  if (u.pathname === '/api/sessions') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { sessions: registry.getSessions() });
  }
  if (u.pathname === '/api/skills') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    // Optional ?id=<sessionId>: resolve the session's cwd from the registry so
    // project skills are merged in. Never trust a client-supplied path.
    const skillsId = u.searchParams.get('id');
    const skillsSession = skillsId ? sessionById(skillsId) : null;
    const skillsCwd = skillsSession?.cwd ?? null;
    return endJson(res, 200, { skills: listSkills(skillsCwd) });
  }
  if (u.pathname === '/api/agents') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    const agentsId = u.searchParams.get('id');
    const agentsSession = agentsId ? sessionById(agentsId) : null;
    const agentsCwd = agentsSession?.cwd ?? null;
    return endJson(res, 200, { agents: listAgents(agentsCwd) });
  }
  if (u.pathname === '/api/skill') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    const skillId = u.searchParams.get('id');
    const skillName = u.searchParams.get('name');
    if (!skillName) return endJson(res, 400, { error: 'missing name' });
    const skillSession = skillId ? sessionById(skillId) : null;
    const skillCwd = skillSession?.cwd ?? null;
    const skill = readSkill(skillName, skillCwd);
    if (!skill) return endJson(res, 404, { error: 'skill not found' });
    return endJson(res, 200, skill);
  }
  if (u.pathname === '/api/health') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { ok: true, snapshot: resources.snapshot() });
  }
  // Process monitor: top processes by CPU (GET) + kill a pid (POST {pid}).
  if (u.pathname === '/api/ps') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return endJson(res, 200, { processes: listProcesses(40) });
  }
  if (u.pathname === '/api/kill') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return readJsonBody(req)
      .then((body) => {
        const result = killProcess(body?.pid, body?.signal === 'SIGKILL' ? 'SIGKILL' : 'SIGTERM');
        return endJson(res, result.ok ? 200 : 400, result);
      })
      .catch((err) => endJson(res, 400, { ok: false, error: String(err?.message || err) }));
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
  if (u.pathname === '/api/optimize') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleOptimize(req, res);
  }
  if (u.pathname === '/api/models') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    const machine = detectMachine();
    return endJson(res, 200, {
      machine,
      // Mark which MLX models are already in the local HF cache so the UI can
      // show downloaded vs. will-download (avoids a surprise multi-GB fetch).
      mlxModels: MLX_MODELS.map((m) => ({ ...m, installed: mlx.isModelCached(m.id) })),
      claudeModels: CLAUDE_MODELS,
      recommendedMlxModel: recommendMlxModel(machine.ramGB),
      recommendedClaudeModel: recommendClaudeModel(),
    });
  }
  if (u.pathname === '/api/transcribe') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleTranscribe(req, res, u);
  }
  // GET /api/spawn-agents — agent-type availability (claude vs codex).
  // Returns which agent binaries are resolvable on this machine so the UI can
  // disable an unavailable agent picker option and show a reason.
  // Token-gated + localhost, same as other GET endpoints.
  if (u.pathname === '/api/spawn-agents') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    const cfg = readConfig();
    return Promise.all([
      resolveBin(cfg.claudeBin || cfg.launchCommand),
      resolveBin(cfg.codexBin || cfg.codexLaunchCommand),
    ]).then(([claudeResult, codexResult]) => {
      return endJson(res, 200, {
        agents: [
          {
            id: 'claude',
            available: claudeResult.available,
            ...(claudeResult.available ? {} : { reason: claudeResult.reason }),
          },
          {
            id: 'codex',
            available: codexResult.available,
            ...(codexResult.available ? {} : { reason: codexResult.reason }),
          },
        ],
      });
    }).catch((err) => endJson(res, 500, { error: String(err?.message || err) }));
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

  // PWA home-screen icon. GET is token-FREE: the OS fetches manifest icons and
  // the apple-touch-icon with no Authorization header, so this surface must be
  // open (it only ever returns an image). POST/DELETE (replace/reset the custom
  // icon) are token-gated.
  if (u.pathname === '/api/icon') {
    if (req.method === 'POST') {
      if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
      return handleIconUpload(req, res);
    }
    if (req.method === 'DELETE') {
      if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
      return handleIconReset(res);
    }
    return handleServeIcon(res, u);
  }

  // Raw-terminal escape hatch: token-gated reverse proxy to an on-demand,
  // loopback-bound ttyd attached to this session's tmux pane. ttyd itself runs
  // with no auth; this branch (and the matching upgrade branch) is the gate.
  if (u.pathname.startsWith('/term/')) {
    if (!checkTerminalToken(req.url)) return endJson(res, 401, { error: 'unauthorized' });
    return proxyTerminalHttp(req, res, u);
  }

  // Unknown /api/* path: return JSON 404 instead of falling through to the SPA.
  if (u.pathname.startsWith('/api/')) return endJson(res, 404, { error: 'not found' });

  // static
  serveStatic(u.pathname, res);
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[handler] uncaught error:', e?.stack || e);
    endJson(res, 500, { error: 'internal' });
  }
};

const server = _tls
  ? https.createServer(_tls, _handler)
  : http.createServer(_handler);

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
  if (res.headersSent || res.writableEnded) return;
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
    // If the MLX backend is active, (re)warm the selected model now — this
    // restarts the local server with the new model and starts any needed
    // download in the background, so the user doesn't hit a cold stall (or a
    // wrong-model hang) on their next ✨ enhance.
    if (saved.optimizeBackend === 'mlx' && mlx.resolveMlxPython()) {
      mlx.warm();
    }
    return endJson(res, 200, saved);
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
}

// POST /api/optimize — token-gated prompt optimiser. Accepts { text, intent }
// and returns { optimized, rationale, changes, mode } from optimizePrompt.
// Falls back to rules-based optimization when the Claude CLI is unavailable.
async function handleOptimize(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    return endJson(res, 400, { error: 'invalid JSON body' });
  }
  const text = typeof body.text === 'string' ? body.text : '';
  if (!text.trim()) return endJson(res, 400, { error: 'text required' });
  if (text.length > 8000) return endJson(res, 400, { error: 'text exceeds 8000 character limit' });
  const intent = typeof body.intent === 'string' ? body.intent : undefined;
  try {
    const result = await runOptimize(text, intent);
    return endJson(res, 200, result);
  } catch (err) {
    return endJson(res, 500, { error: String(err?.message || err) });
  }
}

// Run the enhancer. The `claude -p` backend is DISABLED: a one-shot `claude -p`
// runs in the server's cwd and writes an ephemeral transcript into the projects
// dir, which the session matcher then mis-binds (transcript drift). So the
// enhancer is MLX-only with a deterministic rules fallback — no claude subprocess
// is ever spawned. ('claude'/'mlx' config both resolve to MLX→rules; 'rules'
// stays rules-only.) optimizePrompt returns mode:'rules' when MLX fails.
async function runOptimize(text, intent) {
  const cfg = readConfig();
  if (cfg.optimizeBackend === 'rules') {
    return { ...rulesOptimize(text), backend: 'rules' };
  }
  const r = await optimizePrompt(text, { complete: (p) => mlx.complete(p), intent });
  if (r.mode === 'llm') {
    return { ...r, backend: 'mlx', model: cfg.mlxModel };
  }
  return { ...rulesOptimize(text), backend: 'rules' };
}

// POST /api/transcribe — local speech-to-text. Accepts a raw audio body (the
// MediaRecorder blob from the voice dialog; ?ext=webm|mp4|wav names the format),
// caps the size, writes it to a temp file, and runs ffmpeg→whisper.cpp via
// lib/transcribe. Returns { ok, text }. No key, no cloud — fully local.
function handleTranscribe(req, res, u) {
  const maxBytes = CONFIG.maxUploadMB * 1024 * 1024;
  const ext =
    (u.searchParams.get('ext') || 'webm').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 5) ||
    'webm';
  const chunks = [];
  let size = 0;
  let aborted = false;

  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > maxBytes) {
      aborted = true;
      endJson(res, 413, { error: `audio exceeds ${CONFIG.maxUploadMB} MB limit` });
      req.destroy();
      return;
    }
    chunks.push(c);
  });

  req.on('end', async () => {
    if (aborted) return;
    if (size === 0) return endJson(res, 400, { error: 'empty audio' });
    const tmp = path.join(os.tmpdir(), `cc-stt-in-${Date.now()}-${process.pid}.${ext}`);
    try {
      await fs.promises.writeFile(tmp, Buffer.concat(chunks), { mode: 0o600 });
      const text = await transcribe(tmp);
      endJson(res, 200, { ok: true, text });
    } catch (err) {
      endJson(res, 500, { error: String(err?.message || err) });
    } finally {
      fs.promises.unlink(tmp).catch(() => {});
    }
  });

  req.on('error', () => {
    if (!aborted) endJson(res, 400, { error: 'audio stream error' });
  });
}

// ---------------------------------------------------------------------------
// resolveBin — async PATH lookup for a binary name or absolute path.
//
// If `bin` is an absolute path, checks it is executable directly.
// Otherwise runs `which <bin>` on PATH.
//
// Returns { available: true, path } on success, { available: false, reason }
// on failure. Never throws.
// ---------------------------------------------------------------------------
async function resolveBin(bin) {
  if (!bin || typeof bin !== 'string' || !bin.trim()) {
    return { available: false, reason: 'no binary configured' };
  }
  const b = bin.trim();
  // Absolute path: check existence + execute permission directly.
  if (b.startsWith('/')) {
    try {
      await fsp.access(b, fsp.constants?.X_OK ?? 1);
      return { available: true, path: b };
    } catch {
      return { available: false, reason: `binary not found or not executable: ${b}` };
    }
  }
  // Relative / bare name: resolve via `which`.
  try {
    const { stdout } = await _execFile('which', [b], { timeout: 5000 });
    const resolved = stdout.trim();
    if (resolved) return { available: true, path: resolved };
    return { available: false, reason: `${b} not found on PATH` };
  } catch {
    return { available: false, reason: `${b} not found on PATH` };
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

  // agent ∈ {'claude','codex'}, default 'claude'.
  const agent = body.agent === 'codex' ? 'codex' : 'claude';

  // Name is required-with-default: sanitize the requested name, falling back to
  // `session-<short-ts>` so a session is ALWAYS named (the rail reads the tmux
  // window name until a transcript title exists).
  const name = tmux.sanitizeName(body.name) || tmux.defaultSessionName();

  // --- Pre-validation: binary resolution + cwd check BEFORE creating any window ---

  // (i) Resolve the agent binary and return 400 if unavailable.
  const agentBin = agent === 'codex'
    ? (config.codexBin || config.codexLaunchCommand)
    : (config.claudeBin || config.launchCommand);
  const binCheck = await resolveBin(agentBin);
  if (!binCheck.available) {
    return endJson(res, 400, { error: `agent binary unavailable: ${binCheck.reason}` });
  }

  // (ii) For codex: pre-validate cwd exists and is a directory BEFORE createWindow,
  //      so a bad request creates NO window (400 not 500, window-leak prevention).
  if (agent === 'codex') {
    try {
      const st = await fsp.stat(cwd);
      if (!st.isDirectory()) {
        return endJson(res, 400, { error: `cwd is not a directory: ${cwd}` });
      }
    } catch {
      return endJson(res, 400, { error: `cwd does not exist: ${cwd}` });
    }
  }

  try {
    // (1) Reliable named path: the tmux window name. createWindow sets it via
    //     `new-window -n` and the `-c cwd` flag — cwd flows through tmux's own
    //     working-directory flag, never a shell `cd`.
    const target = await tmux.createWindow({ cwd, name });

    let launch;
    if (agent === 'codex') {
      // Codex path: uses -C <cwd> (its own cwd flag). No --name flag — Codex
      // has none. The tmux window is still named (above) so the rail shows it.
      // buildSpawnCommand is the single source of truth for Codex's launch
      // shape; the cwd arg is shell-quoted since the command is typed into an
      // interactive shell via sendText. The executed command is
      // config.codexLaunchCommand (may be a shell alias), validated above via
      // codexBin||codexLaunchCommand — same pattern as the Claude branch.
      const { bin, args } = buildSpawnCommand({ cwd, bin: config.codexLaunchCommand });
      launch = `${bin} ${args.map((a) => (a === cwd ? tmux.shellQuoteName(cwd) : a)).join(' ')}`;
    } else {
      // Claude path: BYTE-IDENTICAL to the pre-Phase-D implementation.
      // (2) Claude's own session title: `claude --help` exposes `-n/--name`
      //     (display name in the prompt box, /resume picker, terminal title), so
      //     we append it to the launch command rather than relying on a delayed
      //     `/rename`. The name is shell-quoted (sanitizeName already stripped
      //     control chars/newlines) since the command is typed into an interactive
      //     shell so aliases like `yolo` resolve. sendText appends Enter → runs it.
      launch = `${config.launchCommand} --name ${tmux.shellQuoteName(name)}`;
    }

    await tmux.sendText(target, launch);
    return endJson(res, 200, { ok: true, target, name, agent });
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

// 8-byte PNG file signature.
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// GET /api/icon[?size=192|512] — serve the custom icon if one was uploaded,
// else the bundled default robot logo at the closest bundled size. Token-free
// (see the route guard) because the OS fetches it without auth headers.
function handleServeIcon(res, u) {
  const size = Number(u.searchParams.get('size')) || 192;
  const fallback = path.join(PUBLIC_DIR, size >= 512 ? 'icon-512.png' : 'icon-192.png');
  const file = fs.existsSync(CONFIG.iconFile) ? CONFIG.iconFile : fallback;
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, {
      'content-type': 'image/png',
      // The home-screen icon may change at runtime; never let the phone pin a
      // stale one (it already re-reads the manifest on reinstall).
      'cache-control': 'no-store, must-revalidate',
    });
    res.end(data);
  });
}

// POST /api/icon — replace the custom home-screen icon with the raw PNG body.
// PNG-only (validated by signature) so handleServeIcon's image/png is honest.
function handleIconUpload(req, res) {
  const maxBytes = 4 * 1024 * 1024;
  const chunks = [];
  let size = 0;
  let aborted = false;
  req.on('data', (c) => {
    if (aborted) return;
    size += c.length;
    if (size > maxBytes) {
      aborted = true;
      endJson(res, 413, { error: 'icon exceeds 4 MB limit' });
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on('end', async () => {
    if (aborted) return;
    const buf = Buffer.concat(chunks);
    if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) {
      return endJson(res, 400, { error: 'icon must be a PNG image' });
    }
    try {
      await fs.promises.mkdir(path.dirname(CONFIG.iconFile), { recursive: true });
      await fs.promises.writeFile(CONFIG.iconFile, buf, { mode: 0o600 });
      endJson(res, 200, { ok: true, custom: true });
    } catch (err) {
      endJson(res, 500, { error: String(err?.message || err) });
    }
  });
}

// DELETE /api/icon — drop the custom icon, reverting to the bundled default.
function handleIconReset(res) {
  fs.promises
    .rm(CONFIG.iconFile, { force: true })
    .then(() => endJson(res, 200, { ok: true, custom: false }))
    .catch((err) => endJson(res, 500, { error: String(err?.message || err) }));
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

// --- Per-target WS op serialisation ----------------------------------------
// Multiple browser/device clients on the same session can fire overlapping
// send-keys ops concurrently.  Two such ops dispatched to the same tmux pane
// interleave keystrokes mid-sequence.  We prevent this with a per-target FIFO
// promise chain: each send-keys op appends to the tail of its target's chain
// and runs only after its predecessor settles.  Different targets run in
// parallel.  Read-only ops (subscribe, capture, shell-capture, …) are NOT
// enqueued — they never touch the pane input buffer.
const _opChains = new Map(); // target → current-tail Promise

/**
 * Enqueue `fn` behind any in-flight op on `target`.
 *
 * Contract:
 *  - The returned promise settles exactly as fn() settles (value / throw).
 *  - A rejected op does NOT poison the next op on the same target — the chain
 *    continues regardless of whether prev settled fulfilled or rejected.
 *  - The Map entry is deleted once the queued op is the sole tail and it has
 *    settled, preventing unbounded growth on idle targets.
 *
 * @param {string} target  tmux pane target (the serialisation key)
 * @param {() => Promise<any>} fn  async work to serialise
 * @returns {Promise<any>}
 */
function runSerial(target, fn) {
  const prev = _opChains.get(target) ?? Promise.resolve();
  // chain: run fn after prev regardless of prev's outcome
  const tail = prev.then(fn, fn);
  // Store the tail so the NEXT enqueue can chain behind it.
  // Suppress any rejection on the stored promise so Node's
  // unhandledRejection handler never fires on the chain itself —
  // the caller's `tail` reference will surface the error to the caller.
  const stored = tail.then(() => {}, () => {});
  _opChains.set(target, stored);
  // Clean up once this op is the last in the chain and it has settled.
  stored.finally(() => {
    if (_opChains.get(target) === stored) _opChains.delete(target);
  });
  return tail;
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

  const tailer = new TranscriptTailer(session.transcriptPath, { maxBuffer: CONFIG.maxBuffer, parser: session.kind === 'codex' ? parseCodexRecord : undefined });
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
  sub._promptTicking = false;
  const tick = async () => {
    if (sub._promptTicking) return;
    sub._promptTicking = true;
    try {
      const session = sessionById(id);
      if (!session || !tmux.isValidTarget(session.target)) return;
      let prompt = null;
      try {
        const cap = await tmux.capturePane(session.target, 40);
        prompt = session.kind === 'codex' ? parseCodexPrompt(cap) : parsePanePrompt(cap);
      } catch {
        return;
      }
      const json = prompt ? JSON.stringify(prompt) : null;
      if (json !== sub._lastPrompt) {
        sub._lastPrompt = json;
        broadcastTo(id, { type: 'prompt', id, prompt });
      }
    } finally {
      sub._promptTicking = false;
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
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

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

const heartbeatInterval = setInterval(() => pruneDeadClients(wss.clients), 30000);
heartbeatInterval.unref();

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
      const replyText = String(msg.text ?? '');
      return runSerial(session.target, async () => {
        await tmux.sendText(session.target, replyText);
        send(ws, { type: 'ack', op: 'reply', ok: true });
      });
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

      return runSerial(session.target, async () => {
      // ── Capture-driven path ──────────────────────────────────────────────
      // Attempt to navigate by parsing the live picker render. Falls back to
      // the static buildAnswerProgram on ANY parse failure, unknown label, or
      // post-send verification mismatch — so it can NEVER regress the working path.
      //
      // Constants:
      const SETTLE_MS = 300;   // ms to wait after sending keys before re-capture
      const MAX_RETRIES = 1;   // retry attempts per question on verification failure

      let usedDynamic = false;
      // Tracks whether the dynamic path has injected ANY keystroke. Once true,
      // the picker is in a partial/unknown state and the from-scratch static
      // fallback would corrupt it — so a later failure must fail loud, not retry.
      let sentAny = false;
      try {
        const questions = pending?.questions || [];
        const selections = msg.selections || [];

        if (questions.length > 0) {
          let dynamicOk = true; // will be set false to fall back

          for (let qi = 0; qi < questions.length && dynamicOk; qi += 1) {
            const question = questions[qi];
            const selectedLabels = selections[qi] || [];

            let attempt = 0;
            let stepOk = false;

            while (attempt <= MAX_RETRIES && !stepOk) {
              // 1. Capture current picker state.
              let capture;
              try {
                capture = await tmux.capturePane(session.target);
              } catch (captureErr) {
                console.log(`[answer/dynamic] capture failed q${qi}: ${captureErr?.message}`);
                dynamicOk = false;
                break;
              }

              // 2. Parse.
              const parsed = parsePicker(capture);
              if (parsed.confidence !== 'ok') {
                console.log(`[answer/dynamic] low confidence on q${qi} — falling back`);
                dynamicOk = false;
                break;
              }

              // 3. Handle the review screen (multi-question final step).
              if (parsed.isReview) {
                // We expect to be here only after the last question's action Enter.
                // Send Enter to confirm "Submit answers".
                console.log(`[answer/dynamic] review screen — sending Enter`);
                sentAny = true;
                await tmux.sendRawKeysSequenced(session.target, ['Enter'], SETTLE_MS);
                await new Promise((r) => setTimeout(r, SETTLE_MS));
                // Verify: the review screen should be gone.
                const afterReview = await tmux.capturePane(session.target);
                const reparse = parsePicker(afterReview);
                if (reparse.isReview) {
                  console.log(`[answer/dynamic] review screen still up after Enter — falling back`);
                  dynamicOk = false;
                }
                // Whether verified or not, we break out of the question loop —
                // we've processed all questions.
                break;
              }

              // 4. Plan keystrokes for this question.
              const keys = planStep(parsed, question, selectedLabels);
              if (!keys) {
                console.log(`[answer/dynamic] planStep null on q${qi} — falling back`);
                dynamicOk = false;
                break;
              }

              console.log(
                `[answer/dynamic] q${qi} attempt=${attempt} keys=${JSON.stringify(keys)}`,
              );

              // 5. Send keys.
              sentAny = true;
              await tmux.sendRawKeysSequenced(session.target, keys, SETTLE_MS);

              // 6. Settle then verify.
              await new Promise((r) => setTimeout(r, SETTLE_MS));
              let afterCapture;
              try {
                afterCapture = await tmux.capturePane(session.target);
              } catch (captureErr) {
                console.log(`[answer/dynamic] post-send capture failed q${qi}: ${captureErr?.message}`);
                dynamicOk = false;
                break;
              }

              const afterParsed = parsePicker(afterCapture);

              if (question.multiSelect) {
                // Verify: all intended labels are now checked in the re-parsed picker.
                // If we advanced (Next/Submit pressed), the screen changes — that's
                // also acceptable (confidence goes low = we moved on).
                if (afterParsed.confidence === 'ok' && !afterParsed.isReview) {
                  const uncheckedTargets = selectedLabels.filter((label) =>
                    afterParsed.rows.some(
                      (r) => r.kind === 'option' && r.label === label && !r.checked,
                    ),
                  );
                  if (uncheckedTargets.length > 0) {
                    console.log(
                      `[answer/dynamic] verify failed q${qi}: still unchecked=${JSON.stringify(uncheckedTargets)} attempt=${attempt}`,
                    );
                    attempt += 1;
                    continue; // retry
                  }
                }
                // Either confidence is low (screen advanced) or all checked — either
                // way, treat the step as done and move to the next question.
                stepOk = true;
              } else {
                // Single-select: after Enter, picker should advance (screen changes).
                // If the exact same option is still shown as selected (cursor on it),
                // something went wrong. Accept any screen change as advancement.
                if (
                  afterParsed.confidence === 'ok' &&
                  !afterParsed.isReview &&
                  afterParsed.rows.some(
                    (r) => r.cursor && r.kind === 'option' && r.label === selectedLabels[0],
                  )
                ) {
                  console.log(`[answer/dynamic] single-select stuck on q${qi} attempt=${attempt}`);
                  attempt += 1;
                  continue;
                }
                stepOk = true;
              }
            }

            if (!stepOk && attempt > MAX_RETRIES) {
              console.log(`[answer/dynamic] max retries exceeded on q${qi} — falling back`);
              dynamicOk = false;
            }
          }

          // After processing all questions via dynamic path, check if we need to
          // handle the review screen (multi-question pickers).
          if (dynamicOk && questions.length > 1) {
            // Capture and check: we may already be on the review screen (handled
            // in the loop above) or may need to check.
            try {
              const finalCapture = await tmux.capturePane(session.target);
              const finalParsed = parsePicker(finalCapture);
              if (finalParsed.isReview && finalParsed.confidence === 'ok') {
                // Submit the review screen.
                console.log(`[answer/dynamic] post-loop review screen — sending Enter`);
                sentAny = true;
                await tmux.sendRawKeysSequenced(session.target, ['Enter'], SETTLE_MS);
              }
            } catch (captureErr) {
              // Non-fatal: we already sent the question answers; review Enter is best-effort.
              console.log(`[answer/dynamic] final review capture failed: ${captureErr?.message}`);
            }
          }

          if (dynamicOk) {
            usedDynamic = true;
          }
        }
      } catch (dynamicErr) {
        // Any unexpected error in the dynamic path — log and fall back.
        console.log(`[answer/dynamic] unexpected error: ${dynamicErr?.message} — falling back`);
      }

      // ── Static fallback ──────────────────────────────────────────────────
      // Only safe when the dynamic path sent NOTHING (picker still pristine). If
      // dynamic already injected keys then failed, the picker is in a partial
      // state — replaying the from-scratch static program would mis-navigate a
      // dirty picker and corrupt the answer. Fail loud so the user can retry.
      if (!usedDynamic && sentAny) {
        console.error(
          `[answer] dynamic path failed AFTER sending keys; NOT running static fallback (picker dirty) toolUseId=${msg.toolUseId}`,
        );
        return send(ws, {
          type: 'ack',
          op: 'answer',
          ok: false,
          error: 'answer injection failed mid-picker — please retry',
        });
      }
      if (!usedDynamic) {
        const keys = buildAnswerProgram(pending, msg.selections || []);
        console.log(
          `[answer] toolUseId=${msg.toolUseId} target=${session.target} keys=${JSON.stringify(keys)} (static fallback)`,
        );
        try {
          await tmux.sendRawKeysSequenced(session.target, keys);
        } catch (err) {
          console.error(
            `[answer] FAILED toolUseId=${msg.toolUseId} target=${session.target}: ${String(err?.message || err)}`,
          );
          throw err;
        }
        console.log(`[answer] sent toolUseId=${msg.toolUseId} (${keys.length} keys)`);
      } else {
        console.log(`[answer] sent toolUseId=${msg.toolUseId} via dynamic path`);
      }

      send(ws, { type: 'ack', op: 'answer', ok: true });
      }); // end runSerial
    }
    case 'capture': {
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      const lines = Math.max(1, Math.min(10000, Number(msg.lines) || 40));
      // Terminal-pane rows opt into ANSI escapes so colours render; the plain
      // LivePane omits the flag (escapes would show as garbage there).
      const text = await tmux.capturePane(session.target, lines, !!msg.escapes);
      return send(ws, { type: 'capture', id: msg.id, text });
    }
    // Interactive terminal panes: forward keystrokes to ANY pane by id (the
    // selected one). Mirrors the cc-shell shell-* ops but target-addressed.
    case 'pane-text': {
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      const paneText = String(msg.text ?? '');
      return runSerial(session.target, async () => {
        await tmux.sendLiteral(session.target, paneText);
        send(ws, { type: 'ack', op: 'pane-text', ok: true });
      });
    }
    case 'pane-key': {
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      if (!shell.SHELL_KEYS.has(String(msg.key ?? ''))) throw new Error('key not allowed');
      const paneKey = String(msg.key);
      return runSerial(session.target, async () => {
        await tmux.sendRawKeys(session.target, [paneKey]);
        send(ws, { type: 'ack', op: 'pane-key', ok: true });
      });
    }
    case 'promptkey': {
      // Respond to a live TUI selection prompt (permission/menu). Whitelisted
      // keys only — never arbitrary text — so this can't be used to inject input.
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      const ALLOWED = new Set(['1', '2', '3', '4', '5', '6', '7', '8', '9', 'Enter', 'Escape', 'Up', 'Down']);
      if (!ALLOWED.has(msg.key)) throw new Error('key not allowed');
      const promptKey = msg.key;
      return runSerial(session.target, async () => {
        // Codex confirms a numbered choice with <digit> THEN Enter ("Press enter
        // to confirm"); the digit alone only moves the highlight, so without the
        // Enter the modal hangs on "submitting…". Claude's numbered menus act on
        // the digit alone, so only Codex needs the trailing Enter.
        const isDigit = /^[1-9]$/.test(promptKey);
        if (session.kind === 'codex' && isDigit) {
          await tmux.sendRawKeysSequenced(session.target, [promptKey, 'Enter'], 120);
        } else {
          await tmux.sendRawKeys(session.target, [promptKey]);
        }
        // Force the next poll tick to broadcast (the prompt should now change/clear).
        const sub = subscriptions.get(msg.id);
        if (sub) sub._lastPrompt = '__force__';
        send(ws, { type: 'ack', op: 'promptkey', ok: true });
      });
    }
    case 'promptselect': {
      // Respond to a live TUI multi-select checkbox prompt (surfaced via pane-scrape
      // fallback). Uses the same capture-driven machinery as `case 'answer'`:
      // parsePicker → planStep → sendRawKeysSequenced.
      const session = sessionById(msg.id);
      if (!session) throw new Error('unknown session');
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');

      const labels = Array.isArray(msg.labels) ? msg.labels.map(String) : [];
      if (labels.length === 0) throw new Error('no labels provided');

      return runSerial(session.target, async () => {
        const SETTLE_MS = 300;

        // 1. Capture current picker state.
        let capture;
        try {
          capture = await tmux.capturePane(session.target);
        } catch (captureErr) {
          throw new Error(`promptselect: capture failed: ${captureErr?.message}`);
        }

        // 2. Parse into a structured picker model.
        const parsed = parsePicker(capture);
        if (parsed.confidence !== 'ok') {
          send(ws, {
            type: 'ack',
            op: 'promptselect',
            ok: false,
            error: 'promptselect: picker not found or low confidence — please retry',
          });
          return;
        }

        // 3. Build a synthetic single-question descriptor (multiSelect=true) so
        //    planStep can calculate Space-toggle + action-row Enter keys.
        const syntheticQuestion = {
          multiSelect: true,
          options: parsed.rows
            .filter((r) => r.kind === 'option')
            .map((r) => ({ label: r.label })),
        };

        // 4. Plan keystrokes via the tested planStep function.
        const keys = planStep(parsed, syntheticQuestion, labels);
        if (!keys) {
          console.log(`[promptselect] planStep returned null for labels=${JSON.stringify(labels)} — low confidence`);
          send(ws, {
            type: 'ack',
            op: 'promptselect',
            ok: false,
            error: 'promptselect: could not map labels to picker rows — please retry',
          });
          return;
        }

        console.log(`[promptselect] id=${msg.id} labels=${JSON.stringify(labels)} keys=${JSON.stringify(keys)}`);

        // 5. Send keys sequenced with settle delay (same as case 'answer' dynamic path).
        await tmux.sendRawKeysSequenced(session.target, keys, SETTLE_MS);

        // Force the next poll tick to broadcast (the prompt should now change/clear).
        const promptSub = subscriptions.get(msg.id);
        if (promptSub) promptSub._lastPrompt = '__force__';
        send(ws, { type: 'ack', op: 'promptselect', ok: true });
      });
    }
    // Composer terminal mode (>_): each Claude session has its OWN sister shell
    // pane in its window. Resolve the session by id → its target + cwd, then act
    // on (or lazily create) that window's sister shell.
    case 'shell-input': {
      const s = sessionById(msg.id);
      if (!s) throw new Error('unknown session');
      const shellInputLine = String(msg.line ?? '');
      return runSerial(s.target + ':shell', async () => {
        await shell.shellInput(s.target, s.cwd, shellInputLine);
        send(ws, { type: 'ack', op: 'shell-input', ok: true });
      });
    }
    case 'shell-text': {
      const s = sessionById(msg.id);
      if (!s) throw new Error('unknown session');
      const shellTextVal = String(msg.text ?? '');
      return runSerial(s.target + ':shell', async () => {
        await shell.shellText(s.target, s.cwd, shellTextVal);
        send(ws, { type: 'ack', op: 'shell-text', ok: true });
      });
    }
    case 'shell-key': {
      const s = sessionById(msg.id);
      if (!s) throw new Error('unknown session');
      const shellKeyVal = String(msg.key ?? '');
      return runSerial(s.target + ':shell', async () => {
        await shell.shellKey(s.target, s.cwd, shellKeyVal);
        send(ws, { type: 'ack', op: 'shell-key', ok: true });
      });
    }
    case 'shell-capture': {
      const s = sessionById(msg.id);
      if (!s) throw new Error('unknown session');
      const text = await shell.shellCapture(s.target, s.cwd, msg.lines);
      return send(ws, { type: 'shell-output', id: msg.id, text });
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
    console.log(`claude-control → ${_scheme}://${CONFIG.host}:${CONFIG.port}/`);
    if (CONFIG.token) {
      // The token is no longer carried in the URL — the web app prompts for it
      // on load and sends it as an Authorization header (HTTP) / subprotocol
      // (WS). Print it so the operator can paste it into the login prompt.
      console.log(`   (access token: ${CONFIG.token} — enter it at the login prompt)`);
    } else {
      console.log('   (no COCKPIT_TOKEN set — relying on 127.0.0.1 bind. This UI can type into your sessions.)');
    }
    // Pre-warm the local MLX enhancer so the first ✨ enhance is fast (best-effort;
    // only when that backend is selected and an mlx python is available).
    try {
      if (readConfig().optimizeBackend === 'mlx' && mlx.resolveMlxPython()) {
        mlx.warm();
        console.log('   (pre-warming local MLX enhancer model…)');
      }
    } catch {
      /* best-effort */
    }
  });
}

function shutdown() {
  clearInterval(heartbeatInterval);
  for (const [, sub] of subscriptions) sub.tailer?.stop();
  terminal.shutdownAll();
  mlx.shutdown();
  registry.stop();
  resources.stop();
  if (uploadSweepTimer) clearInterval(uploadSweepTimer);
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Safety nets: log unhandled async rejections; exit on truly uncaught sync
// exceptions so Node doesn't continue with a corrupted process state.
process.on('unhandledRejection', (e) => {
  // eslint-disable-next-line no-console
  console.error('[unhandledRejection]', e?.stack || e);
});
process.on('uncaughtException', (e) => {
  // eslint-disable-next-line no-console
  console.error('[uncaughtException]', e?.stack || e);
  process.exit(1);
});

// Guard: only run the server when executed directly, not when imported for testing.
const _isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (_isMain) main();

// Exported for unit testing only — not part of the public API.
export { endJson, _handler, runSerial };
