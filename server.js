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
import { SubAgentsWatcher, CodexSubAgentsWatcher, listAgents } from './lib/subagents.js';
import { parsePanePrompt, isSystemPrompt, detectPanePicker } from './lib/prompt.js';
import { buildSnapshotPromptFrames } from './lib/snapshot-replay.js';
import { SessionRegistry, listRecentTranscripts } from './lib/sessions.js';
import { Collab } from './lib/collab.js';
import { recordClientError } from './lib/client-errors.js';
import { loadPins, savePins, validateTranscriptPath, pinKey } from './lib/pins.js';
import { writePaneRegistryRecord } from './lib/pane-registry.js';
import { ResourceMonitor, listProcesses, killProcess } from './lib/resources.js';
import { buildAnswerProgram, parsePicker, planStep } from './lib/answer.js';
import { sweepUploads, resolveUploadPath } from './lib/uploads.js';
import { getVersionInfo, currentVersion } from './lib/version.js';
import * as push from './lib/push.js';
import { readConfig, writeConfig } from './lib/config.js';
import { loadOlamConfig, assertAuthWithRemoteOrgs } from './lib/olam-config.js';
import { RemoteSessionSource } from './lib/olam-sessions.js';
import { OlamTranscriptSource } from './lib/olam-transcript.js';
import { dispatchSteer, composerMode, replyTransport } from './lib/olam-transport.js';
import { parseCodexRecord, parseCodexPrompt, parseCodexSubagentNotificationRecord, buildSpawnCommand, buildAppServerCommand } from './lib/codex.js';
import { CodexRpcManager, isCodexActiveStatus, isCodexAppServerCapture, parseCodexAppServerEndpoint } from './lib/codex-rpc.js';
import { ClaudePrintManager, buildBridgeCommand } from './lib/claude-print.js';
import { optimizePrompt, rulesOptimize } from './lib/optimize.js';
import * as mlx from './lib/mlx.js';
import { resolveClaudeBin } from './lib/claude-cli.js';
import {
  MLX_MODELS,
  CLAUDE_MODELS,
  detectMachine,
  recommendMlxModel,
  recommendClaudeModel,
} from './lib/models.js';
import { transcribe } from './lib/transcribe.js';
import { replyShouldBlock } from './lib/reply-guard.js';
import { shouldRefuseSendForPicker } from './lib/picker-send-guard.js';
import { listSkills, readSkill } from './lib/skills.js';
import { reapSiblingServers } from './lib/reap-siblings.js';
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
  // Experimental Codex app-server transport. New Codex sessions use a tmux
  // pane as a visible process pin, but replies/approvals move over JSON-RPC.
  // Set CLAUDE_CONTROL_CODEX_TRANSPORT=tmux to force the legacy TUI-key path.
  codexTransport: String(env('CODEX_TRANSPORT') || '').toLowerCase() === 'tmux' ? 'tmux' : 'rpc',
  // Experimental Claude print-mode transport. New Claude sessions default to the
  // interactive TUI unless CLAUDE_CONTROL_CLAUDE_TRANSPORT=print is set.
  claudeTransport: String(env('CLAUDE_TRANSPORT') || '').toLowerCase() === 'print' ? 'print' : 'tmux',
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
  presentDir:
    env('PRESENT') || path.join(os.homedir(), '.claude-control', 'present'),
  uploadTtlHours: Number(env('UPLOAD_TTL_HOURS')) || 24,
  pinsFile:
    env('PINS') || path.join(os.homedir(), '.claude-control', 'pins.json'),
  // Custom PWA home-screen icon (PNG). When present it overrides the bundled
  // default robot logo for the manifest icons + apple-touch-icon. Uploaded via
  // POST /api/icon, removed via DELETE /api/icon.
  iconFile:
    env('ICON') || path.join(os.homedir(), '.claude-control', 'icon.png'),
};

// Remote olam orgs (docs/plans/cockpit-olam-remote-sessions). Feature-flag by
// file presence: no olam.json → OLAM.enabled false and nothing below changes.
// A malformed file or a tokenless server with orgs configured refuses startup
// (org bearers must not sit behind an open port — design doc T5, decision 7).
const OLAM = loadOlamConfig();
assertAuthWithRemoteOrgs(OLAM, CONFIG.token);
/** @type {import('./lib/olam-sessions.js').RemoteSessionSource|null} */
let olamSource = null;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
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
const collab = new Collab(); // session-to-session collaboration rooms (lib/collab.js)
const resources = new ResourceMonitor({ rssLimitMB: CONFIG.rssLimitMB });
const codexRpc = new CodexRpcManager();
const claudePrint = new ClaudePrintManager();

// Manual transcript pins (windowId.paneIndex -> transcript path). Loaded at boot,
// applied to the registry, and editable via /api/pins.
let pins = loadPins(CONFIG.pinsFile);

/** id -> { tailer, clients:Set<ws>, pending } */
const subscriptions = new Map();
const RAW_EVENT_LIMIT = 200;
const rawEventsById = new Map();

function sessionById(id) {
  return registry.getSessions().find((s) => s.id === id) || null;
}

// Authenticate an HTTP/API request: the token rides `Authorization: Bearer
// <token>` (NOT the URL). Tokenless server → always authorized. Thin wrapper
// over lib/auth so CONFIG.token isn't threaded through every call site.
function checkToken(req) {
  return authCheckToken(req, CONFIG.token);
}

// Restart support: true only when a supervisor will respawn the process after
// it exits. launchd (bin/install-service.sh, KeepAlive: true) reparents its
// managed agents to PID 1, so `process.ppid === 1` is the launchd signal.
// pm2/systemd users can opt in explicitly via CLAUDE_CONTROL_MANAGED=1. A bare
// `node server.js` (dev) has neither, so restart is correctly disabled there —
// process.exit(0) would just kill it with no respawn.
function isServiceManaged() {
  return process.env.CLAUDE_CONTROL_MANAGED === '1' || process.ppid === 1;
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
  // Phase D — mint a runner terminal/replay token for a remote (olam) session.
  // The HMAC lives only in the returned URLs (browser-safe); the runner bearer
  // never leaves the server. GET /api/olam/terminal-token?id=olam:<org>:<sid>
  if (u.pathname === '/api/olam/terminal-token') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    const id = u.searchParams.get('id') ?? '';
    const session = sessionById(id);
    if (!session || session.kind !== 'remote') return endJson(res, 404, { error: 'unknown remote session' });
    const client = olamSource?.clientForOrg(session.org);
    if (!client) return endJson(res, 503, { error: `org ${session.org} unavailable` });
    client
      .terminalToken(session.sessionId, session.pool ?? 'agentrun')
      .then((urls) => endJson(res, 200, urls))
      .catch((err) => endJson(res, 502, { error: String(err?.message ?? err) }));
    return;
  }
  if (u.pathname.startsWith('/api/collab/')) {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    return handleCollab(req, res, u);
  }
  if (u.pathname === '/api/client-error') {
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    return handleClientError(req, res);
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
    if (req.method === 'GET') return endJson(res, 200, { ...readConfig(), restartSupported: isServiceManaged() });
    if (req.method === 'POST') return handleConfigSave(req, res);
    return endJson(res, 405, { error: 'method not allowed' });
  }
  // POST /api/restart — operator-triggered self-restart. Only meaningful under
  // a supervisor (launchd KeepAlive / pm2 / systemd) that respawns the process
  // after it exits; see isServiceManaged(). A bare dev process would just die.
  if (u.pathname === '/api/restart') {
    if (req.method !== 'POST') return endJson(res, 405, { error: 'method not allowed' });
    if (!checkToken(req)) return endJson(res, 401, { error: 'unauthorized' });
    if (!isServiceManaged()) {
      return endJson(res, 409, {
        error: 'not_managed',
        message: 'Restart requires the launchd/pm2 service (KeepAlive). Running as a bare process — exit would not respawn.',
      });
    }
    console.log('[restart] requested via API — exiting for supervisor respawn');
    endJson(res, 200, { ok: true, restarting: true });
    setTimeout(() => process.exit(0), 250);
    return;
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
            defaultTransport: CONFIG.claudeTransport,
            transports: ['tmux', 'print'],
            ...(claudeResult.available ? {} : { reason: claudeResult.reason }),
          },
          {
            id: 'codex',
            available: codexResult.available,
            defaultTransport: CONFIG.codexTransport,
            transports: ['rpc', 'tmux'],
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

  // Public presentation artifacts (screenshots, videos, one-off demos) live
  // under ~/.claude-control/present and are intentionally iframe-friendly.
  // This is a confined static surface: no directory listing, no writes, and no
  // filesystem paths outside presentDir.
  if (u.pathname === '/present' || u.pathname.startsWith('/present/')) {
    return servePresent(u.pathname, res);
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
function commandHead(command) {
  const text = String(command || '').trim();
  const m = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(text);
  return m ? (m[1] || m[2] || m[3] || '') : '';
}

// resolveBin — async lookup for a configured launch command.
//
// If the first command word is an absolute path, checks it is executable
// directly. Otherwise resolves it via PATH and then the user's login shell so
// aliases/functions such as `yodex` are treated the same way as the tmux pane
// that will receive the typed command.
//
// Returns { available: true, path } on success, { available: false, reason }
// on failure. Never throws.
// ---------------------------------------------------------------------------
async function resolveBin(bin) {
  const b = commandHead(bin);
  if (!b) {
    return { available: false, reason: 'no binary configured' };
  }
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
    // Fall through to the user's login shell; aliases/functions are only visible
    // there, but the lookup script itself is fixed and receives `b` as argv.
  }
  try {
    const shell = process.env.SHELL || '/bin/zsh';
    const { stdout } = await _execFile(
      shell,
      ['-lic', 'command -v -- "$1"', 'claude-control-resolve', b],
      { timeout: 5000 },
    );
    const resolved = stdout.trim();
    if (resolved) return { available: true, path: resolved };
    return { available: false, reason: `${b} not found in login shell` };
  } catch {
    return { available: false, reason: `${b} not found in login shell` };
  }
}

async function resolvePaneTarget(target) {
  if (String(target || '').includes('.')) return target;
  try {
    const panes = await tmux.listPanes();
    const pane = panes.find((p) => p.target === target) ||
      panes.find((p) => p.target.startsWith(`${target}.`));
    return pane?.target || target;
  } catch {
    return target;
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
  const rawCwd =
    typeof body.cwd === 'string' && body.cwd.trim() ? body.cwd : config.defaultCwd;
  // Expand a leading ~ to the home directory so projectDirs paths like
  // ~/Projects/atlas work (Node's fs.stat does not expand tilde).
  const cwd = rawCwd.startsWith('~/')
    ? path.join(os.homedir(), rawCwd.slice(2))
    : rawCwd === '~'
      ? os.homedir()
      : rawCwd;

  // agent ∈ {'claude','codex'}, default 'claude'.
  const agent = body.agent === 'codex' ? 'codex' : 'claude';
  const claudeTransport =
    body.claudeTransport === 'print' || body.claudeTransport === 'tmux'
      ? body.claudeTransport
      : CONFIG.claudeTransport;
  const codexTransport =
    body.codexTransport === 'tmux' || body.codexTransport === 'rpc'
      ? body.codexTransport
      : CONFIG.codexTransport;

  // Name is required-with-default: sanitize the requested name, falling back to
  // `session-<short-ts>` so a session is ALWAYS named (the rail reads the tmux
  // window name until a transcript title exists).
  const name = tmux.sanitizeName(body.name) || tmux.defaultSessionName();

  // --- Pre-validation: binary resolution + cwd check BEFORE creating any window ---

  // (i) Resolve the agent binary and return 400 if unavailable.
  const agentBin = agent === 'codex'
    ? (config.codexBin || config.codexLaunchCommand)
    : (agent === 'claude' && claudeTransport === 'print'
      ? (resolveClaudeBin() || 'claude')
      : (config.claudeBin || config.launchCommand));
  const binCheck = await resolveBin(agentBin);
  if (!binCheck.available) {
    return endJson(res, 400, { error: `agent binary unavailable: ${binCheck.reason}` });
  }

  // (ii) For structured transports: pre-validate cwd exists and is a directory
  //      BEFORE createWindow, so a bad request creates NO window.
  if (agent === 'codex' || (agent === 'claude' && claudeTransport === 'print')) {
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
    let codexRpcEndpoint = null;
    let printPaneTarget = target;
    let printClient = null;
    if (agent === 'codex') {
      const codexCommand = config.codexBin || config.codexLaunchCommand;
      if (codexTransport === 'rpc') {
        codexRpcEndpoint = await codexRpc.prepareEndpoint(target);
        const { bin, args } = buildAppServerCommand({ endpoint: codexRpcEndpoint, bin: codexCommand });
        launch = `${bin} ${args.map((a) => (a === codexRpcEndpoint ? tmux.shellQuoteName(a) : a)).join(' ')}`;
      } else {
        // Legacy Codex path: uses -C <cwd> (its own cwd flag). No --name flag —
        // Codex has none. The tmux window is still named (above) so the rail
        // shows it. buildSpawnCommand is the single source of truth for Codex's
        // launch shape; the cwd arg is shell-quoted since the command is typed
        // into an interactive shell via sendText.
        const { bin, args } = buildSpawnCommand({ cwd, bin: codexCommand });
        launch = `${bin} ${args.map((a) => (a === cwd ? tmux.shellQuoteName(cwd) : a)).join(' ')}`;
      }
    } else if (claudeTransport === 'print') {
      printPaneTarget = await resolvePaneTarget(target);
      const socketPath = claudePrint.endpointFor(printPaneTarget);
      printClient = await claudePrint.attach({ target: printPaneTarget, socketPath, cwd });
      await tmux.setPaneOption(printPaneTarget, '@cc_agent', 'claude');
      await tmux.setPaneOption(printPaneTarget, '@cc_transport', 'print');
      await tmux.setPaneOption(printPaneTarget, '@cc_endpoint', socketPath);
      const bridgePath = path.join(__dirname, 'bin', 'claude-print-bridge.mjs');
      const claudeBin = binCheck.path || resolveClaudeBin() || commandHead(agentBin);
      launch = buildBridgeCommand({
        bridgePath,
        socketPath,
        cwd,
        claudeBin,
        name,
        permissionMode: 'bypassPermissions',
        quote: tmux.shellQuoteName,
      });
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

    if (agent === 'codex') {
      await tmux.setPaneOption(target, '@cc_agent', 'codex');
      await tmux.setPaneOption(target, '@cc_transport', codexTransport);
      if (codexRpcEndpoint) await tmux.setPaneOption(target, '@cc_endpoint', codexRpcEndpoint);
    }

    await tmux.sendText(target, launch);
    if (printClient) {
      await printClient.waitForBridge();
    }
    if (agent === 'codex' && codexRpcEndpoint) {
      await codexRpc.attach({ target, endpoint: codexRpcEndpoint, cwd });
    }
    return endJson(res, 200, {
      ok: true,
      target: printPaneTarget,
      name,
      agent,
      transport: agent === 'codex' ? codexTransport : claudeTransport,
    });
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

// Append a frontend crash report to the client-error sink (see lib/client-errors.js).
async function handleClientError(req, res) {
  try {
    const body = await readJsonBody(req);
    recordClientError(body, { userAgent: req.headers['user-agent'] });
    return endJson(res, 200, { ok: true });
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
  }
}

// --- collaboration (claude-collab MCP) --------------------------------------
// A session is idle (safe to nudge) when it is not thinking/compacting/errored
// and has no open question/picker (`pending`).
function isIdleSession(s) {
  return !!s && !s.thinking && !s.compacting && !s.errored && !s.pending;
}

// Resolve the calling session from its tmux pane id ($TMUX_PANE / %N), which the
// MCP shim passes verbatim. Returns the collab member shape, or null if unknown.
function collabMemberByPane(paneId) {
  if (!paneId) return null;
  const s = registry.getSessions().find((x) => x.paneId === paneId);
  if (!s) return null;
  return { paneId: s.paneId, target: s.target, kind: s.kind, title: s.title || s.name || null, sessionId: s.sessionId ?? null };
}

const COLLAB_WAIT_MS = 25_000; // long-poll ceiling for /read?wait
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Router for /api/collab/* — all token-gated (see the dispatch above). The caller
// self-identifies via `paneId` (its $TMUX_PANE); we map that to a live session.
async function handleCollab(req, res, u) {
  const op = u.pathname.slice('/api/collab/'.length);
  try {
    const body = req.method === 'POST' ? await readJsonBody(req) : {};
    const paneId = String((body.paneId ?? u.searchParams.get('paneId')) || '');

    // list is the only op that doesn't require a resolvable caller.
    if (op === 'list' && req.method === 'GET') {
      return endJson(res, 200, { rooms: collab.listOpen() });
    }

    const member = collabMemberByPane(paneId);
    if (!member) return endJson(res, 400, { error: 'unknown session (paneId did not resolve — is this running inside a claude-control tmux pane?)' });

    if (op === 'open' && req.method === 'POST') {
      return endJson(res, 200, collab.open(member, { topic: body.topic }));
    }
    if (op === 'join' && req.method === 'POST') {
      return endJson(res, 200, collab.join(member, { code: body.code, roomId: body.roomId }));
    }
    if (op === 'members' && req.method === 'GET') {
      return endJson(res, 200, { members: collab.members(u.searchParams.get('roomId')) });
    }
    if (op === 'history' && req.method === 'GET') {
      return endJson(res, 200, collab.history(u.searchParams.get('roomId')));
    }
    if (op === 'leave' && req.method === 'POST') {
      return endJson(res, 200, collab.leave(body.roomId, member.paneId));
    }
    if (op === 'send' && req.method === 'POST') {
      const { seq, recipients } = collab.post(body.roomId, member, body.text);
      // Nudge only IDLE peers — inject a one-line prompt telling them to read.
      const byPane = new Map(registry.getSessions().map((s) => [s.paneId, s]));
      const nudged = [];
      for (const r of recipients) {
        const s = byPane.get(r.paneId);
        if (!isIdleSession(s)) continue;
        const line = `\n📨 [collab:${body.roomId}] ${member.title || 'peer'}: new message — call collab_read to view\n`;
        try {
          await tmux.sendText(s.target, line);
          nudged.push(r.paneId);
        } catch {
          /* peer pane vanished — the message still waits in the log */
        }
      }
      return endJson(res, 200, { seq, nudged, waiting: recipients.length - nudged.length });
    }
    if (op === 'read' && req.method === 'GET') {
      const roomId = u.searchParams.get('roomId');
      const since = Number(u.searchParams.get('since')) || 0;
      const wait = u.searchParams.get('wait') === '1' || u.searchParams.get('wait') === 'true';
      let result = collab.read(roomId, since);
      if (wait && result.messages.length === 0) {
        const deadline = Date.now() + COLLAB_WAIT_MS;
        while (Date.now() < deadline && result.messages.length === 0) {
          await delay(600);
          result = collab.read(roomId, since);
        }
      }
      return endJson(res, 200, result);
    }
    return endJson(res, 404, { error: `unknown collab op: ${op}` });
  } catch (err) {
    return endJson(res, 400, { error: String(err?.message || err) });
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
  // Global "re-match all windows": drop every manual pin so every pane falls
  // back to the SessionStart-hook binding (the accurate, current transcript).
  // Used by the "Re-match all" command to recover from stale pins in bulk.
  if (body?.all === true) {
    pins = {};
    try {
      savePins(CONFIG.pinsFile, pins);
    } catch (err) {
      return endJson(res, 500, { error: String(err?.message || err) });
    }
    registry.setPins(pins);
    await registry.refresh().catch(() => {});
    return endJson(res, 200, { ok: true, pins });
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
  // Re-run the matcher NOW so clearing/setting a pin re-binds immediately
  // (otherwise the change only lands on the next 4 s refresh tick).
  await registry.refresh().catch(() => {});
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

function servePresent(pathname, res) {
  let rel;
  try {
    rel = decodeURIComponent(pathname.replace(/^\/present\/?/, ''));
  } catch {
    res.writeHead(400); return res.end('bad request');
  }
  if (!rel || rel.endsWith('/')) rel = path.join(rel, 'index.html');
  const root = path.resolve(CONFIG.presentDir);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-store, must-revalidate',
      'x-content-type-options': 'nosniff',
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

function rawSummary(value, max = 240) {
  const text = typeof value === 'string'
    ? value
    : (() => {
        try { return JSON.stringify(value); } catch { return String(value); }
      })();
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length > max ? compact.slice(0, max - 1) + '…' : compact;
}

function emitRawEvent(id, event) {
  if (!id) return;
  const entry = {
    ts: Date.now(),
    source: event.source || 'server',
    kind: event.kind || 'event',
    summary: rawSummary(event.summary ?? ''),
    detail: event.detail ?? null,
  };
  const prev = rawEventsById.get(id) ?? [];
  const next = [...prev, entry];
  rawEventsById.set(id, next.length > RAW_EVENT_LIMIT ? next.slice(next.length - RAW_EVENT_LIMIT) : next);
  broadcastTo(id, { type: 'raw-event', id, event: entry });
}

codexRpc.on('thread', (id, opened) => {
  const thread = opened?.thread || {};
  const transcriptPath = thread.path ?? null;
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'thread',
    summary: `thread ${thread.id || '(unknown)'} ${transcriptPath || ''}`,
    detail: { threadId: thread.id ?? null, transcriptPath },
  });
  registry.setTranscriptHint(id, {
    transcriptPath,
    sessionId: thread.id ?? null,
  });
  if (transcriptPath) {
    (async () => {
      const panes = await tmux.listPanes();
      const pane = panes.find((p) => p.target === id) ||
        panes.find((p) => p.target.startsWith(`${id}.`));
      if (!pane?.paneId) return;
      await writePaneRegistryRecord({
        paneId: pane.paneId,
        sessionId: thread.id ?? null,
        transcriptPath,
        cwd: pane.cwd ?? null,
      });
    })().catch(() => {});
  }
});
codexRpc.on('messages', (id, messages) => {
  const sub = subscriptions.get(id);
  if (sub?.tailer) return;
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'messages',
    summary: `${messages?.length ?? 0} message(s)`,
    detail: { messages },
  });
  broadcastTo(id, { type: 'append', id, messages });
});
codexRpc.on('prompt', (id, prompt) => {
  registry.setPrompt(id, prompt);
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'prompt',
    summary: prompt ? prompt.question : 'cleared',
    detail: prompt,
  });
  broadcastTo(id, { type: 'prompt', id, prompt });
});
codexRpc.on('pending', (id, pending) => {
  registry.setPending(id, !!pending);
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'pending',
    summary: pending ? 'pending true' : 'pending false',
  });
});
codexRpc.on('status', (id, status) => {
  registry.setThinking(id, isCodexActiveStatus(status));
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'status',
    summary: status ?? 'null',
    detail: status,
  });
});
codexRpc.on('subagent', (id, update) => {
  const sub = subscriptions.get(id);
  sub?.subagents?.ingest?.(update);
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'subagent',
    summary: `${update.agentId} ${update.state}`,
    detail: update,
  });
});
codexRpc.on('raw', (id, event) => {
  emitRawEvent(id, {
    source: event.source || 'codex-rpc',
    kind: event.kind || 'rpc',
    summary: event.summary || event.method || '',
    detail: event,
  });
});
codexRpc.on('error', (id, err) => {
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'error',
    summary: String(err?.message || err),
  });
  broadcastTo(id, {
    type: 'ack',
    op: 'codex-rpc',
    ok: false,
    error: String(err?.message || err),
  });
});
codexRpc.on('close', (id) => {
  registry.setPending(id, false);
  registry.setPrompt(id, null);
  registry.setThinking(id, false);
  emitRawEvent(id, {
    source: 'codex-rpc',
    kind: 'close',
    summary: 'closed',
  });
  broadcastTo(id, { type: 'prompt', id, prompt: null });
});

claudePrint.on('thread', (id, thread) => {
  const transcriptPath = thread?.transcriptPath ?? null;
  registry.setTranscriptHint(id, {
    transcriptPath,
    sessionId: thread?.sessionId ?? null,
  });
  if (transcriptPath) {
    (async () => {
      const panes = await tmux.listPanes();
      const pane = panes.find((p) => p.target === id) ||
        panes.find((p) => p.target.startsWith(`${id}.`));
      if (!pane?.paneId) return;
      await writePaneRegistryRecord({
        paneId: pane.paneId,
        sessionId: thread?.sessionId ?? null,
        transcriptPath,
        cwd: pane.cwd ?? null,
      });
    })().catch(() => {});
  }
});
claudePrint.on('messages', (id, messages) => {
  const sub = subscriptions.get(id);
  if (sub?.tailer) return;
  broadcastTo(id, { type: 'append', id, messages });
});
claudePrint.on('status', (id, status) => {
  registry.setThinking(id, status === 'active');
});
claudePrint.on('error', (id, err) => {
  broadcastTo(id, {
    type: 'ack',
    op: 'claude-print',
    ok: false,
    error: String(err?.message || err),
  });
});
claudePrint.on('close', (id) => {
  registry.setThinking(id, false);
});

function ensureSubscription(id) {
  // Remote (olam) sessions stream from the chunks substrate, not a local
  // transcript file. Build an OlamTranscriptSource whose 'append' events carry
  // the SAME NormalizedMessage shape as the local tailer, so the WS fan-out +
  // renderer are reused. Exactly one live subscription per selected session;
  // teardown/trim/snapshot go through the shared sub.tailer surface below.
  {
    const remote = sessionById(id);
    if (remote?.kind === 'remote') {
      const existing = subscriptions.get(id);
      if (existing) return existing;
      const client = olamSource?.clientForOrg(remote.org);
      if (!client || !remote.worldId) {
        // Can't stream (org gone from config, or no world_id yet) — allow a
        // tailer-less sub so the row is still selectable; a later refresh that
        // fills world_id upgrades it via upgradeSubscriptionIfTranscriptReady's
        // remote analogue (recreated on next select).
        const bare = { tailer: null, subagents: null, clients: new Set(), pending: null, ready: Promise.resolve(), remote: true };
        subscriptions.set(id, bare);
        return bare;
      }
      const source = new OlamTranscriptSource(client, {
        worldId: remote.worldId,
        sessionId: remote.sessionId,
        pool: remote.pool ?? 'agentrun',
        maxBuffer: CONFIG.maxBuffer,
      });
      const rsub = { tailer: source, subagents: null, clients: new Set(), pending: null, remote: true };
      subscriptions.set(id, rsub);
      source.on('append', (msgs) => broadcastTo(id, { type: 'append', id, messages: msgs }));
      // Snapshot fully drained (shape reached its live cursor) — tells the
      // client the empty-vs-loading ambiguity is resolved for this remote
      // session (see lib/olam-transcript.js's ShapeSubscriber 'ready' event).
      source.on('ready', () => broadcastTo(id, { type: 'olam-transcript-ready', id }));
      source.on('banner', (b) => broadcastTo(id, { type: 'olam-degraded', id, degraded: b.degraded, reason: b.reason }));
      source.on('error', (err) =>
        broadcastTo(id, { type: 'ack', op: 'tail', ok: false, error: String(err?.message || err) }));
      rsub.ready = source.start();
      return rsub;
    }
  }
  let sub = subscriptions.get(id);
  if (sub) {
    // Recreate when a previously tailer-less subscription's transcript has
    // been matched on a later refresh, or when the transcript moved to a new
    // file (resume/fork writes a new jsonl) — tear it down so the block below
    // recreates it against the current path (clients re-subscribe).
    const cur = sessionById(id);
    const drifted = sub.tailer && cur?.transcriptPath && sub.tailer.filePath !== cur.transcriptPath;
    if ((sub.tailer === null && cur?.transcriptPath) || drifted) {
      if (sub.tailer) sub.tailer.stop();
      if (sub.subagents) sub.subagents.stop();
      if (sub.promptTimer) clearInterval(sub.promptTimer);
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
    const subagents = session.kind === 'codex' ? new CodexSubAgentsWatcher() : null;
    sub = { tailer: null, subagents, clients: new Set(), pending: null, ready: Promise.resolve() };
    subscriptions.set(id, sub);
    if (subagents) {
      subagents.on('change', (entry) =>
        broadcastTo(id, { type: 'subagent', id, subagent: entry }),
      );
    }
    if (!codexRpc.has(id) && session.transport !== 'print') startPromptPoller(id, sub);
    return sub;
  }

  // Watch this session's sub-agent transcripts (Task/Agent). Discovery is polled
  // when the parent transcript grows (when sub-agents spawn) + once at subscribe.
  const subagents = session.kind === 'codex'
    ? new CodexSubAgentsWatcher()
    : new SubAgentsWatcher(session.transcriptPath);
  const parser = session.kind === 'codex'
    ? (line) => {
        const update = parseCodexSubagentNotificationRecord(line);
        if (update) {
          subagents.ingest(update);
          emitRawEvent(id, {
            source: 'codex-transcript',
            kind: 'subagent',
            summary: `${update.agentId} ${update.state}`,
            detail: update,
          });
        }
        return parseCodexRecord(line);
      }
    : undefined;
  const tailer = new TranscriptTailer(session.transcriptPath, { maxBuffer: CONFIG.maxBuffer, parser });
  sub = { tailer, subagents, clients: new Set(), pending: null };
  subscriptions.set(id, sub);

  subagents.on('change', (entry) =>
    broadcastTo(id, { type: 'subagent', id, subagent: entry }),
  );

  tailer.on('append', (msgs) => {
    emitRawEvent(id, {
      source: session.kind === 'codex' ? 'codex-transcript' : 'transcript',
      kind: 'append',
      summary: `${msgs.length} message(s)`,
      detail: { messages: msgs },
    });
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
    emitRawEvent(id, {
      source: 'transcript',
      kind: 'pending',
      summary: pending ? pending.questions?.[0]?.question || 'pending true' : 'pending false',
      detail: pending,
    });
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
  if (!codexRpc.has(id) && session.transport !== 'print') startPromptPoller(id, sub);
  return sub;
}

function sendSubscriptionSnapshot(ws, id, sub) {
  const liveMessages = claudePrint.has(id)
    ? claudePrint.messages(id)
    : codexRpc.messages(id);
  send(ws, {
    type: 'messages',
    id,
    // Tailer-less RPC-backed Codex subscriptions keep an in-memory message
    // buffer fed by app-server notifications. Claude print mode does the same
    // through its bridge until a real transcript tailer is available.
    messages: sub.tailer ? sub.tailer.getMessages() : liveMessages,
    pending: sub.tailer ? sub.tailer.getPending() : null,
  });
  const rpcPrompt = codexRpc.prompt(id);
  if (rpcPrompt) send(ws, { type: 'prompt', id, prompt: rpcPrompt });
  // Replay the last-known TUI-scrape prompt + picker state. The poller broadcasts
  // these edge-triggered, so a reload / session-switch / late join that subscribes
  // while a picker is already open would otherwise never receive it (the bug where
  // an open question showed once then vanished on reload, or never surfaced when
  // the session was opened after the question appeared).
  for (const frame of buildSnapshotPromptFrames(sub, id)) send(ws, frame);
  // Snapshot any already-running sub-agents for this session.
  const subs = sub.subagents ? sub.subagents.snapshot() : [];
  if (subs.length) send(ws, { type: 'subagents', id, subagents: subs });
  const rawEvents = rawEventsById.get(id) ?? [];
  if (rawEvents.length) send(ws, { type: 'raw-events', id, events: rawEvents });
}

function upgradeSubscriptionIfTranscriptReady(id) {
  const old = subscriptions.get(id);
  if (!old || old.remote) return;
  const session = sessionById(id);
  if (!session?.transcriptPath) return;
  // Rebuild when there is no tailer yet, OR the session's transcript moved to
  // a different file (a resume/fork writes a NEW jsonl; the old one stops
  // growing, so a tailer pinned to it would freeze while the pane moves on).
  if (old.tailer && old.tailer.filePath === session.transcriptPath) return;

  const clients = new Set(old.clients);
  if (old.promptTimer) clearInterval(old.promptTimer);
  if (old.tailer) old.tailer.stop();
  if (old.subagents) old.subagents.stop();
  subscriptions.delete(id);

  const next = ensureSubscription(id);
  if (!next) return;
  for (const ws of clients) next.clients.add(ws);

  next.ready.then(() => {
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN && next.clients.has(ws)) {
        sendSubscriptionSnapshot(ws, id, next);
      }
    }
  }).catch((err) => {
    for (const ws of clients) {
      send(ws, { type: 'ack', op: 'subscribe', ok: false, error: String(err?.message || err) });
    }
  });
}

async function ensureCodexRpcForSession(session) {
  if (session.kind !== 'codex') return null;
  if (session.transport !== 'rpc') return null;
  const existing = codexRpc.get(session.target);
  if (existing) return existing;

  let capture = '';
  let endpoint = session.endpoint || null;
  if (!endpoint) {
    try {
      capture = await tmux.capturePane(session.target, 200, false, true);
    } catch {
      return null;
    }
    endpoint = parseCodexAppServerEndpoint(capture);
  }
  if (!endpoint) {
    if (isCodexAppServerCapture(capture)) {
      throw new Error('Codex RPC app-server endpoint unavailable; refusing to type prompt into tmux pane');
    }
    return null;
  }

  return codexRpc.ensureAttached({
    target: session.target,
    endpoint,
    cwd: session.cwd,
    resumeThreadId: session.sessionId,
    transcriptPath: session.transcriptPath,
  });
}

async function ensureClaudePrintForSession(session) {
  if (session.kind !== 'claude' || session.transport !== 'print') return null;
  const existing = claudePrint.get(session.target);
  if (existing) return existing;
  const socketPath = session.endpoint || claudePrint.endpointFor(session.target);
  const client = await claudePrint.attach({
    target: session.target,
    socketPath,
    cwd: session.cwd,
  });
  await client.waitForBridge();
  return client;
}

// Poll the live pane for a TUI selection prompt (permission/trust/numbered menu).
// These never reach the transcript, so without this the cockpit shows a pending
// tool-call and looks stuck. Broadcasts a `prompt` frame only when it changes.
function startPromptPoller(id, sub) {
  if (sub.promptTimer) return;
  sub._lastPrompt = undefined;
  sub._lastPickerOpen = undefined; // tracks last-broadcast picker state for Item 2
  sub._promptTicking = false;
  const tick = async () => {
    if (sub._promptTicking) return;
    sub._promptTicking = true;
    try {
      const session = sessionById(id);
      if (!session || !tmux.isValidTarget(session.target)) return;
      let prompt = null;
      let pickerOpen = false;
      try {
        // Visible pane only (no scrollback) — an answered picker frozen in
        // history must not re-fire. The live prompt is always on screen.
        if (session.kind === 'codex') {
          const cap = await tmux.capturePane(session.target, 120, false, false, { visibleOnly: true });
          prompt = parseCodexPrompt(cap);
          pickerOpen = !!prompt; // for codex, pickerOpen tracks the same parsed prompt
        } else {
          // Claude: use join=true (-J) capture so hard-wrapped narrow-pane text
          // (AskUserQuestion footer split across 3 physical lines) is pre-joined
          // into logical lines before parsing. detectPanePicker surfaces ALL picker
          // types — AskUserQuestion, permission, trust, plan-review, custom menus.
          const cap = await tmux.capturePane(session.target, 120, false, true, { visibleOnly: true });
          const parsed = detectPanePicker(cap);
          // Scrape is the fallback: only assign if no structured prompt was set above.
          if (prompt === null) {
            prompt = parsed;
          }
          pickerOpen = !!parsed;
        }
      } catch {
        return;
      }
      const json = prompt ? JSON.stringify(prompt) : null;
      if (json !== sub._lastPrompt) {
        sub._lastPrompt = json;
        emitRawEvent(id, {
          source: session.kind === 'codex' ? 'codex-tui' : 'tui',
          kind: 'prompt',
          summary: prompt ? prompt.question : 'cleared',
          detail: prompt,
        });
        broadcastTo(id, { type: 'prompt', id, prompt });
      }
      // Broadcast picker awareness separately from the narrower prompt rendering.
      // pickerOpen=true for ANY parsePanePrompt hit (not just isSystemPrompt) so
      // clients can disable free-text send without waiting for the next poll cycle.
      if (pickerOpen !== sub._lastPickerOpen) {
        sub._lastPickerOpen = pickerOpen;
        broadcastTo(id, { type: 'picker', id, open: pickerOpen });
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
      send(ws, { type: 'ack', op: msg?.type || 'unknown', ok: false, error: String(err?.message || err), reqId: msg?.reqId });
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
      sendSubscriptionSnapshot(ws, msg.id, sub);
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
      // Remote (olam) sessions steer via the cloud-dispatch mirror, not tmux:
      // no tmux target, no pane picker, no send-settle delay — so this branch
      // early-returns BEFORE all of that. The agent's reply streams back as
      // chunks (Phase B), so there is no separate response plumbing.
      if (replyTransport(session) === 'olam') {
        const reqId = msg.reqId;
        const mode = composerMode(session);
        if (mode === 'read-only') {
          send(ws, { type: 'ack', op: 'reply', ok: false, reqId, error: 'This session is read-only — steering is disabled.' });
          return;
        }
        const client = olamSource?.clientForOrg(session.org);
        if (!client || !session.worldId) {
          send(ws, { type: 'ack', op: 'reply', ok: false, reqId, error: `Cannot steer ${session.org} session (org unavailable or no world id yet).` });
          return;
        }
        const steerMode = msg.hardSteer ? 'hard' : 'soft';
        const result = await dispatchSteer(client, {
          worldId: session.worldId,
          sessionId: session.sessionId,
          draft: String(msg.text ?? ''),
          mode: steerMode,
        });
        if (result.ok) {
          send(ws, { type: 'ack', op: 'reply', ok: true, transport: 'olam', reqId, mode });
        } else {
          send(ws, { type: 'ack', op: 'reply', ok: false, reqId, error: result.error });
        }
        return;
      }
      if (!tmux.isValidTarget(session.target)) throw new Error('invalid tmux target');
      // SAFETY: never send a raw reply (paste+Enter) into a pane with an OPEN
      // picker (AskUserQuestion OR a pane-scrape permission/trust/plan/numbered
      // menu) — the Enter would select an option, silently answering it. The
      // client must answer via the structured 'answer'/'promptkey'/'promptselect'
      // path. Refuse raw replies here as defense-in-depth (covers stale/racey
      // clients). EXCEPTION: a reply flagged `viaAnswer` is the trailing free-text
      // of a DELIBERATE answer the inline component sends AFTER it has already
      // navigated the picker — that IS the answer, so it must pass through.
      if (!msg.viaAnswer) {
        const replySub = subscriptions.get(msg.id);
        const tailerPending = replySub?.tailer ? replySub.tailer.getPending() : null;
        const flagPending = !!session.pending;
        if (replyShouldBlock(tailerPending, flagPending)) {
          send(ws, { type: 'ack', op: 'reply', ok: false, reqId: msg.reqId, error: 'A question is open — answer it via the question component' });
          return;
        }
      }
      const replyText = String(msg.text ?? '');
      const reqId = msg.reqId; // correlation id: echoed in the ack so the client
                               // marks THIS send delivered (not just WS-written).
      // Per-attachment settle: each pasted image path is ingested asynchronously
      // by the TUI (read + validate/encode), and a too-early Enter lands before
      // that finishes, leaving the message unsent in the box. Scale the paste→Enter
      // gap by the attachment count (capped) so the Enter always submits.
      const attachments = Math.max(0, Number(msg.attachments) || 0);
      // sendText polls for the TUI's "Pasting…" to clear before Enter; settleMs is
      // the MAX it waits (a ceiling, not a fixed cost — it exits as soon as the
      // paste finishes). Budget generously per image so even a slow read fits.
      const settleMs = Math.min(20000, 1500 + attachments * 3000);
      return runSerial(session.target, async () => {
        if (session.kind === 'claude' && session.transport === 'print') {
          await ensureClaudePrintForSession(session);
          registry.setThinking(session.target, true);
          try {
            claudePrint.submit(session.target, replyText);
          } catch (err) {
            registry.setThinking(session.target, false);
            throw err;
          }
          send(ws, { type: 'ack', op: 'reply', ok: true, transport: 'claude-print', reqId });
          return;
        }
        if (session.kind === 'codex') {
          const codexClient = await ensureCodexRpcForSession(session);
          if (codexClient) {
            registry.setThinking(session.target, true);
            try {
              await codexRpc.submit(session.target, replyText, { cwd: session.cwd });
            } catch (err) {
              registry.setThinking(session.target, false);
              throw err;
            }
            send(ws, { type: 'ack', op: 'reply', ok: true, transport: 'codex-rpc', reqId });
            return;
          }
          // Codex TUI compatibility: only non-app-server Codex panes may use
          // tmux keystrokes. RPC app-server panes must never receive prompt text
          // in their terminal buffer.
        }
        // ── Synchronous send-time picker guard ─────────────────────────────
        // This is the race-free authority: it checks the ACTUAL current screen
        // at send-time, independent of poll cadence, the 64KB flag window, and
        // tailer state. The replyShouldBlock flag-check above (lines ~1901-1909)
        // stays as cheap defense-in-depth that can short-circuit before we even
        // get here. viaAnswer replies bypass BOTH guards (they are the answer).
        //
        // Gate: keystroke-TUI panes (claude AND codex-TUI). Print transport has no
        // keystroke TUI to guard against, and codex-rpc panes already returned above
        // (so any codex pane reaching here fell through to tmux sendText). The parser
        // is chosen by kind — parsePanePrompt for claude, parseCodexPrompt for codex —
        // because the two TUIs scrape pickers differently; the pure predicate then
        // decides on the boolean presence of a parsed picker, identical for both.
        if (!msg.viaAnswer && (session.kind === 'claude' || session.kind === 'codex') && session.transport !== 'print') {
          try {
            const cap = await tmux.capturePane(session.target, 120, false, true, { visibleOnly: true });
            const parsedPicker = session.kind === 'codex' ? parseCodexPrompt(cap) : detectPanePicker(cap);
            if (shouldRefuseSendForPicker({ viaAnswer: msg.viaAnswer, kind: session.kind, transport: session.transport, parsedPicker })) {
              send(ws, { type: 'ack', op: 'reply', ok: false, reqId, error: 'A question/picker is open in this pane — answer it via the question UI, not a free-text reply.' });
              return;
            }
          } catch {
            // Capture failed: do NOT block. The replyShouldBlock flag-check above
            // is the fallback. Better to allow a send than to stall on a tmux error.
          }
        }
        await tmux.sendText(session.target, replyText, { settleMs });
        send(ws, { type: 'ack', op: 'reply', ok: true, reqId });
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
              // 1. Capture current picker state (join=true so hard-wrapped narrow-pane
              //    labels are reconstructed into logical lines before parsing).
              let capture;
              try {
                capture = await tmux.capturePane(session.target, 40, false, true);
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
                const afterReview = await tmux.capturePane(session.target, 40, false, true);
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

              // Snapshot the option-label set BEFORE sending keys so we can detect
              // structural screen advancement in the post-send verify (Gap-2 fix):
              // if the option-label set changes after send, the screen advanced
              // regardless of what label the cursor lands on — avoids false "stuck"
              // when page N+1's cursor-0 label coincidentally equals page N's answer.
              const preSendOptionLabels = parsed.rows
                .filter((r) => r.kind === 'option')
                .map((r) => r.label)
                .join('\x00');

              // 5. Send keys.
              sentAny = true;
              await tmux.sendRawKeysSequenced(session.target, keys, SETTLE_MS);

              // 6. Settle then verify.
              await new Promise((r) => setTimeout(r, SETTLE_MS));
              let afterCapture;
              try {
                afterCapture = await tmux.capturePane(session.target, 40, false, true);
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
                // Accept any structural screen change as advancement.
                //
                // Stuck detection uses TWO criteria (both must be true to declare stuck):
                //   a) cursor is on the same label we just answered, AND
                //   b) the option-label SET is byte-identical to the pre-send state.
                //
                // Criterion (b) prevents false-bail when page N+1 legitimately has its
                // cursor-0 label equal to page N's answer (the label-coincidence bug):
                // a changed option set proves the screen advanced even if the cursor
                // label matches, so we never declare stuck in that case.
                //
                // IMPORTANT: the TUI may take longer than SETTLE_MS to transition
                // between pages (especially on the last question where it renders the
                // full review screen). If we detect "stuck" and immediately retry, the
                // retry capture happens at essentially the same wall-clock position and
                // may also see the old screen — exhausting MAX_RETRIES and causing a
                // mid-picker abort. Wait an extra 2×SETTLE_MS before the retry so the
                // transition has enough time to complete regardless of host load.
                const afterOptionLabels = afterParsed.rows
                  .filter((r) => r.kind === 'option')
                  .map((r) => r.label)
                  .join('\x00');
                const optionSetUnchanged = afterOptionLabels === preSendOptionLabels;
                if (
                  afterParsed.confidence === 'ok' &&
                  !afterParsed.isReview &&
                  optionSetUnchanged &&
                  afterParsed.rows.some(
                    (r) => r.cursor && r.kind === 'option' && r.label === selectedLabels[0],
                  )
                ) {
                  console.log(`[answer/dynamic] single-select stuck on q${qi} attempt=${attempt} — extra settle`);
                  await new Promise((r) => setTimeout(r, SETTLE_MS * 2));
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
              const finalCapture = await tmux.capturePane(session.target, 40, false, true);
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
        if (session.kind === 'claude' && session.transport === 'print') {
          if (promptKey !== 'Escape') throw new Error('key not allowed for Claude print mode');
          await ensureClaudePrintForSession(session);
          claudePrint.cancel(session.target);
          registry.setThinking(session.target, false);
          send(ws, { type: 'ack', op: 'promptkey', ok: true, transport: 'claude-print' });
          return;
        }
        if (session.kind === 'codex') {
          const codexClient = await ensureCodexRpcForSession(session);
          if (codexClient && codexRpc.prompt(session.target)) {
            codexRpc.answerPrompt(session.target, promptKey);
            const sub = subscriptions.get(msg.id);
            if (sub) sub._lastPrompt = '__force__';
            send(ws, { type: 'ack', op: 'promptkey', ok: true, transport: 'codex-rpc' });
            return;
          }
          // Codex TUI compatibility only; app-server panes are rejected inside
          // ensureCodexRpcForSession when an RPC endpoint cannot be attached.
        }
        // Codex TUI confirms a numbered choice with <digit> THEN Enter ("Press
        // enter to confirm"); the digit alone only moves the highlight.
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

        // 1. Capture current picker state (join=true so hard-wrapped narrow-pane
        //    labels are reconstructed into logical lines before parsing).
        let capture;
        try {
          capture = await tmux.capturePane(session.target, 40, false, true);
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
  codexRpc.sweep(sessions.map((s) => s.id));
  claudePrint.sweep(sessions.map((s) => s.id));
  for (const s of sessions) upgradeSubscriptionIfTranscriptReady(s.id);
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
  // Self-healing orphan guard: a past restart or a manual `npm start` can leave
  // duplicate server.js instances running for days (each polling tmux) if they
  // aren't holding the port when a new instance starts (#137 only frees the
  // port itself). Reap any other process running this exact server.js before
  // we do anything else. Best-effort — never blocks boot.
  for (const pid of reapSiblingServers({ scriptPath: fileURLToPath(import.meta.url) })) {
    console.log(`claude-control: reaped duplicate server.js instance (pid ${pid})`);
  }

  registry.setPins(pins); // apply persisted pins before the first refresh
  registry.start();
  resources.start();
  if (OLAM.enabled) {
    olamSource = new RemoteSessionSource(OLAM, registry);
    olamSource.start();
    console.log(`[olam] remote sessions enabled for orgs: ${OLAM.orgs.map((o) => o.org).join(', ')}`);
  }
  await registry.refresh().catch(() => {});

  // Daily attachment cleanup: sweep at startup, then every 24h.
  runUploadSweep();
  uploadSweepTimer = setInterval(runUploadSweep, 24 * 3600 * 1000);
  uploadSweepTimer.unref();

  // Without this, a stale instance still holding the port makes listen() emit an
  // unhandled 'error' and the process dies with an opaque EADDRINUSE stack. Fail
  // loud and clean instead.
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`claude-control: port ${CONFIG.port} is already in use — another instance is still running. Exiting.`);
      process.exit(1);
    }
    console.error('[server error]', err?.stack || err);
    process.exit(1);
  });
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
  // Long-lived WebSocket connections keep the listening socket bound; force them
  // closed so the port frees immediately and an in-place restart can re-bind.
  server.closeAllConnections?.();
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
