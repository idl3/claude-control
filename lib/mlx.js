/**
 * lib/mlx.js — local LLM backend via a managed mlx_lm.server (Apple Silicon).
 *
 * Spawns a singleton OpenAI-compatible MLX server on first use, keeps it warm,
 * and shuts it down after an idle period. No API key, no network — fully local.
 * Used by the prompt enhancer as the first link in the mlx → claude → rules
 * chain (server.js handleOptimize).
 *
 * Exports:
 *  - resolveMlxPython() → string | null      (venv python that has mlx_lm)
 *  - serverBase(port) → string               (pure)
 *  - buildChatBody(prompt, model, maxTokens) → object  (pure)
 *  - parseChatContent(json) → string         (pure; throws on bad/empty shape)
 *  - complete(prompt, { model, port, maxTokens }) → Promise<string>
 *  - shutdown()                              (kill the child; for exit/tests)
 *
 * Config/env: model from config.mlxModel (default below); port via
 * CLAUDE_CONTROL_MLX_PORT (default 8080); python via CLAUDE_CONTROL_MLX_PYTHON
 * else ~/.claude-control/mlx-venv/bin/python else a PATH python3 with mlx_lm.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { readConfig } from './config.js';

export const DEFAULT_MODEL = 'mlx-community/Llama-3.2-3B-Instruct-4bit';
const DEFAULT_PORT = Number(process.env.CLAUDE_CONTROL_MLX_PORT) || 8080;
// How long a SINGLE request waits for the server to be ready before giving up
// and letting the caller fall back (to claude -p). The spawned server keeps
// loading in the background, so the next request finds it warm (~1s). Cold
// model load can take ~30-90s under launchd, so we never block a request that
// long — we fail over fast and warm up for next time.
const REQUEST_READY_MS = Number(process.env.CLAUDE_CONTROL_MLX_TIMEOUT_MS) || 8_000;
const IDLE_MS = 15 * 60_000; // free ~2GB after 15 min idle
const MAX_TOKENS = 700;

/** @param {number} [port] */
export function serverBase(port = DEFAULT_PORT) {
  return `http://127.0.0.1:${port}`;
}

/**
 * Resolve a python interpreter that can `import mlx_lm`.
 * @returns {string | null}
 */
export function resolveMlxPython() {
  const envPy = process.env.CLAUDE_CONTROL_MLX_PYTHON;
  const venvPy = path.join(os.homedir(), '.claude-control', 'mlx-venv', 'bin', 'python');
  for (const p of [envPy, venvPy]) {
    if (p && fs.existsSync(p)) return p;
  }
  try {
    const p = execFileSync('which', ['python3'], { encoding: 'utf8' }).trim();
    if (p) {
      execFileSync(p, ['-c', 'import mlx_lm'], { stdio: 'ignore' });
      return p;
    }
  } catch {
    /* no mlx_lm on PATH python */
  }
  return null;
}

// ── server singleton ────────────────────────────────────────────────────────
let child = null;
let childModel = null; // model id the current child was spawned with
let idleTimer = null;

function bumpIdle() {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => shutdown(), IDLE_MS);
  if (idleTimer.unref) idleTimer.unref();
}

/** Kill the managed server (no-op if none / external). */
export function shutdown() {
  if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  if (child) {
    try { child.kill('SIGTERM'); } catch { /* ignore */ }
    child = null;
  }
  childModel = null;
}

async function ping(port) {
  try {
    const r = await fetch(serverBase(port) + '/v1/models', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

// The model id a server on `port` is currently serving (via /v1/models), or null.
async function servedModel(port) {
  try {
    const r = await fetch(serverBase(port) + '/v1/models', { signal: AbortSignal.timeout(1500) });
    if (!r.ok) return null;
    const j = await r.json();
    const id = j?.data?.[0]?.id;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
}

// Best-effort: kill whatever process holds `port` (used to reclaim the port from
// an orphaned mlx server that's serving the wrong model). No-op if lsof/kill fail.
function freePort(port) {
  try {
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`], { encoding: 'utf8' }).trim();
    for (const pid of out.split('\n').filter(Boolean)) {
      try { process.kill(Number(pid), 'SIGTERM'); } catch { /* already gone */ }
    }
  } catch {
    /* nothing on the port, or lsof unavailable */
  }
}

/**
 * Is the model already in the local HuggingFace cache (so selecting it won't
 * trigger a multi-GB download)? Checks `~/.cache/huggingface/hub/models--…`.
 * @param {string} id @returns {boolean}
 */
export function isModelCached(id) {
  const dir = path.join(
    process.env.HF_HOME || path.join(os.homedir(), '.cache', 'huggingface'),
    'hub',
    `models--${String(id).replace(/\//g, '--')}`,
  );
  try {
    const snaps = path.join(dir, 'snapshots');
    if (!fs.existsSync(snaps)) return false;
    return fs.readdirSync(snaps).some((s) => {
      try {
        return fs.readdirSync(path.join(snaps, s)).length > 0;
      } catch {
        return false;
      }
    });
  } catch {
    return false;
  }
}

// Spawn the mlx_lm.server child (once). Logs to ~/.claude-control/logs so a
// failed/slow start is diagnosable. Sets HOME explicitly (launchd may not).
function spawnServer(model, port) {
  const py = resolveMlxPython();
  if (!py) {
    throw new Error(
      'mlx_lm not installed — create ~/.claude-control/mlx-venv and `pip install mlx-lm`',
    );
  }
  let out = 'ignore';
  try {
    const logPath = path.join(os.homedir(), '.claude-control', 'logs', 'mlx-server.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    out = fs.openSync(logPath, 'a');
  } catch {
    /* fall back to ignored stdio */
  }
  child = spawn(
    py,
    ['-m', 'mlx_lm.server', '--model', model, '--host', '127.0.0.1', '--port', String(port)],
    { stdio: ['ignore', out, out], env: { ...process.env, HOME: os.homedir() } },
  );
  childModel = model;
  child.on('exit', () => { child = null; childModel = null; });
}

// Ensure a server serving EXACTLY `model` is answering on `port`. Reuses our
// warm child or any server already serving the right model; otherwise restarts
// — killing a wrong-model child and reclaiming the port from a wrong-model
// orphan, so swapping models never POSTs a model the running server lacks (which
// would trigger an in-request download and hang). Waits only REQUEST_READY_MS;
// if the (new) model is still loading/downloading, throws so the caller falls
// back while it finishes in the background.
async function ensureServer(model, port) {
  if (child && childModel === model && (await ping(port))) return;
  const served = await servedModel(port);
  if (served === model) return; // right model already up (orphan/external) → reuse
  if (child) shutdown(); // our child is serving the wrong model → stop it
  if (served) freePort(port); // an orphan holds the port with the wrong model → reclaim
  spawnServer(model, port);
  const deadline = Date.now() + REQUEST_READY_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    if ((await servedModel(port)) === model) return;
  }
  throw new Error('mlx server still warming up');
}

/**
 * Build the OpenAI chat-completions request body. Pure.
 * @param {string} prompt @param {string} model @param {number} [maxTokens]
 */
export function buildChatBody(prompt, model, maxTokens = MAX_TOKENS) {
  return {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens,
    temperature: 0.2,
  };
}

/**
 * Extract the assistant text from an OpenAI chat-completions response. Pure.
 * @param {any} json @returns {string}
 */
export function parseChatContent(json) {
  const c = json?.choices?.[0]?.message?.content;
  if (typeof c !== 'string' || !c.trim()) throw new Error('empty MLX completion');
  return c;
}

/**
 * Best-effort pre-warm: spawn + load the server in the background so the first
 * real request is fast. No-op-safe — swallows the "still warming" throw; the
 * child keeps loading. Call at startup when the MLX backend is selected.
 * @param {number} [port]
 */
export function warm(port = DEFAULT_PORT) {
  const model = readConfig().mlxModel || DEFAULT_MODEL;
  ensureServer(model, port).catch(() => {});
}

/**
 * Complete a prompt via the local MLX server (spawning + warming it if needed).
 * Throws on any failure so the caller can fall through to the next backend.
 *
 * @param {string} prompt
 * @param {{ model?: string, port?: number, maxTokens?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function complete(prompt, { model, port = DEFAULT_PORT, maxTokens = MAX_TOKENS } = {}) {
  const m = model || readConfig().mlxModel || DEFAULT_MODEL;
  await ensureServer(m, port);
  const res = await fetch(serverBase(port) + '/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(buildChatBody(prompt, m, maxTokens)),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`MLX server HTTP ${res.status}`);
  const json = await res.json();
  bumpIdle();
  return parseChatContent(json);
}

// Best-effort: don't leave the child server orphaned when the parent exits
// cleanly. (SIGKILL can't be trapped; an orphan is harmless — ensureServer
// reuses whatever is already answering on the port.)
process.on('exit', shutdown);
process.on('SIGTERM', () => { shutdown(); process.exit(0); });
process.on('SIGINT', () => { shutdown(); process.exit(0); });
