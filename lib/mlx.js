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
}

async function ping(port) {
  try {
    const r = await fetch(serverBase(port) + '/v1/models', { signal: AbortSignal.timeout(1500) });
    return r.ok;
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
  child.on('exit', () => { child = null; });
}

// Ensure a server is answering on `port`. Reuses an already-running one (warm
// child OR an external/orphaned server). Otherwise spawns one (once) and waits
// only REQUEST_READY_MS — if it's still warming, throw so the caller falls back;
// the child keeps loading so the next request is warm. Throws if mlx is absent.
async function ensureServer(model, port) {
  if (await ping(port)) return;
  if (!child) spawnServer(model, port); // synchronous before any await → no double-spawn
  const deadline = Date.now() + REQUEST_READY_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 600));
    if (await ping(port)) return;
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
