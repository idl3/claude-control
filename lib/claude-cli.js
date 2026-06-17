/**
 * lib/claude-cli.js — LLM backend that spawns the host Claude CLI.
 *
 * No API key required. Uses the same `claude` binary that the operator already
 * has installed. Lean flags cut cost ~28x by disabling MCP and tools.
 *
 * Exports:
 *  - resolveClaudeBin()  → string | null   (abs path or null; re-reads config each call)
 *  - parseResult(stdout) → string          (pure; throws on bad envelope)
 *  - complete(prompt, { model }) → Promise<string>
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync, spawn } from 'node:child_process';

import { readConfig } from './config.js';

// ---------------------------------------------------------------------------
// Empty MCP config: written once at module init to a stable temp path so the
// --mcp-config flag always points at a valid (empty) file.
// ---------------------------------------------------------------------------
const EMPTY_MCP_PATH = path.join(os.tmpdir(), 'claude-control-empty-mcp.json');

function ensureEmptyMcpConfig() {
  if (!fs.existsSync(EMPTY_MCP_PATH)) {
    fs.writeFileSync(EMPTY_MCP_PATH, '{"mcpServers":{}}', { mode: 0o600 });
  }
}

try {
  ensureEmptyMcpConfig();
} catch {
  // Non-fatal: complete() will fail if the path is missing, which is fine.
}

// ---------------------------------------------------------------------------
// Binary resolution — re-reads config each call so tests can control it via
// writeConfig({ claudeBin: ... }) without module-level memoization.
// ---------------------------------------------------------------------------

/**
 * Resolve the absolute path of the claude CLI binary.
 * Resolution order:
 *  1. config.claudeBin if set and exists
 *  2. `which claude` result if exists
 *  3. Common installation paths, first that exists
 *
 * Re-reads config each call (cheap; avoids memoization that breaks tests).
 *
 * @returns {string | null}
 */
export function resolveClaudeBin() {
  const config = readConfig();

  // 1. Explicit config override
  if (config.claudeBin && typeof config.claudeBin === 'string' && config.claudeBin.trim()) {
    const p = config.claudeBin.trim();
    if (fs.existsSync(p)) return p;
  }

  // 2. `which claude`
  try {
    const found = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    if (found && fs.existsSync(found)) return found;
  } catch {
    // not on PATH
  }

  // 3. Common paths
  const candidates = [
    path.join(os.homedir(), '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    '/usr/bin/claude',
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Envelope parser — pure, no I/O, fully testable without spawning.
// ---------------------------------------------------------------------------

/**
 * Parse the JSON stdout envelope from `claude -p ... --output-format json`.
 * Throws on malformed JSON, is_error:true, or missing .result.
 *
 * Expected envelope:
 *   { type: 'result', subtype: 'success', is_error: false, result: string, ... }
 *
 * @param {string} stdout
 * @returns {string}
 */
export function parseResult(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`claude CLI: invalid JSON in stdout: ${err.message}`);
  }
  if (parsed && parsed.is_error === true) {
    throw new Error(`claude CLI: is_error=true: ${parsed.result ?? '(no message)'}`);
  }
  if (!parsed || typeof parsed.result !== 'string') {
    throw new Error('claude CLI: missing .result in envelope');
  }
  return parsed.result;
}

// ---------------------------------------------------------------------------
// complete — spawn the CLI and return the result string.
// ---------------------------------------------------------------------------

/**
 * Run a prompt through the Claude CLI and return the text result.
 *
 * @param {string} prompt
 * @param {{ model?: string }} [opts]
 * @returns {Promise<string>}
 */
export function complete(prompt, { model } = {}) {
  return new Promise((resolve, reject) => {
    const bin = resolveClaudeBin();
    if (!bin) {
      return reject(new Error('claude CLI not found'));
    }

    ensureEmptyMcpConfig();

    const resolvedModel = model ?? readConfig().optimizeModel ?? 'claude-haiku-4-5';

    // Lean flags: -p (print mode), --output-format json, no tools, empty MCP.
    // Prompt is passed as a direct argv element — never shell-interpolated.
    const args = [
      '-p', prompt,
      '--model', resolvedModel,
      '--output-format', 'json',
      '--strict-mcp-config',
      '--mcp-config', EMPTY_MCP_PATH,
      '--allowed-tools', '',
    ];

    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdoutChunks = [];
    const stderrChunks = [];

    child.stdout.on('data', (chunk) => stdoutChunks.push(chunk));
    child.stderr.on('data', (chunk) => stderrChunks.push(chunk));

    child.on('close', (code) => {
      if (code !== 0) {
        const stderrText = Buffer.concat(stderrChunks).toString('utf8').slice(0, 300);
        return reject(new Error(`claude CLI exited ${code}: ${stderrText}`));
      }
      const stdout = Buffer.concat(stdoutChunks).toString('utf8');
      try {
        resolve(parseResult(stdout));
      } catch (err) {
        reject(err);
      }
    });

    child.on('error', (err) => reject(err));
  });
}
