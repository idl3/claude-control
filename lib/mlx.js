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
// First request may load (or download) the model, so the readiness window is
// generous. A warm server answers in well under a second.
const READY_TIMEOUT_MS = Number(process.env.CLAUDE_CONTROL_MLX_TIMEOUT_MS) || 120_000;
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
let starting = null; // Promise while spawning, to coalesce concurrent callers
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

// Ensure a server is answering on `port`. Reuses an already-running one (warm
// child OR an external/orphaned server); otherwise spawns mlx_lm.server and
// polls until ready. Throws if mlx_lm is absent or readiness times out.
async function ensureServer(model, port) {
  if (await ping(port)) return;
  if (starting) return starting;
  starting = (async () => {
    const py = resolveMlxPython();
    if (!py) {
      throw new Error(
        'mlx_lm not installed — create ~/.claude-control/mlx-venv and `pip install mlx-lm`',
      );
    }
    child = spawn(
      py,
      ['-m', 'mlx_lm.server', '--model', model, '--host', '127.0.0.1', '--port', String(port)],
      { stdio: 'ignore' },
    );
    child.on('exit', () => { child = null; });
    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 800));
      if (await ping(port)) return;
    }
    shutdown();
    throw new Error('mlx server did not become ready in time');
  })().finally(() => { starting = null; });
  return starting;
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
