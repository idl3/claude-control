/**
 * lib/spawn.js — handleSpawn and resolveBinary for the P3 spawn-picker.
 *
 * Extracted from server.js so the validation+spawn logic is unit-testable
 * without booting the HTTP server. server.js's `case 'spawn'` delegates here.
 *
 * SECURITY: cwd reaches tmux ONLY as a realpath'd absolute string passed to
 * tmux.newWindow/newSession's `cwd` param, which passes it via `-c <cwd>` as
 * an argv element (never shell-concatenated). For codex, cwd is also passed as
 * an argv element ['-C', cwd] via the adapter's buildSpawnCommand. No user
 * input is ever interpolated into a shell command string.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import { access } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Binary resolution — real PATH check via login shell (mirrors resolveTmuxBin)
// ---------------------------------------------------------------------------

/**
 * Check whether a binary is resolvable. For absolute paths, checks execute
 * permission via fs.access. For bare names, tries `command -v <bin>` via a
 * login shell (same approach as tmux.resolveTmuxBin — handles PATH correctly).
 *
 * Never throws — returns boolean.
 *
 * @param {string} bin  binary name or absolute path
 * @returns {Promise<boolean>}
 */
export async function resolveBinary(bin) {
  if (typeof bin !== 'string' || !bin) return false;

  try {
    if (bin.startsWith('/')) {
      // Absolute path: check execute permission directly.
      await access(bin, fsConstants.X_OK);
      return true;
    }

    // Bare name: ask a login shell.
    const { stdout } = await execFile('/bin/sh', ['-lc', `command -v ${bin}`], {
      timeout: 5000,
    });
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// handleSpawn — validation + tmux dispatch
// ---------------------------------------------------------------------------

/**
 * Validate a 'spawn' WS message and spawn the agent process in tmux.
 *
 * @param {object} msg  The raw WS message object (already JSON-parsed).
 * @param {object} deps Injected dependencies (for testability).
 * @param {object} deps.tmux         The lib/tmux.js namespace (listWindows, newWindow, newSession).
 * @param {Function} deps.adapterById  lib/agents/index.adapterById
 * @param {object} deps.registry     SessionRegistry (needs .refresh()).
 * @param {string} deps.codexBin     CONFIG.codexBin from the caller.
 * @param {Function} [deps.resolveBinary]  Override for testability.
 * @returns {Promise<string>}  The new tmux target (e.g. "session:7").
 * @throws {Error}  With a descriptive message on validation failure. The
 *                  caller (server.js `case 'spawn'`) catches and sends ack.
 */
export async function handleSpawn(msg, deps) {
  const {
    tmux,
    adapterById,
    registry,
    codexBin,
    resolveBinary: _resolveBinary = resolveBinary,
  } = deps;

  // --- 1. Validate agentType ---
  if (typeof msg.agentType !== 'string') throw new Error('unknown agent type');
  const adapter = adapterById(msg.agentType);
  if (!adapter) throw new Error('unknown agent type');

  // --- 2. Validate and realpath cwd ---
  if (typeof msg.cwd !== 'string' || msg.cwd.length === 0) {
    throw new Error('cwd does not exist');
  }
  let resolvedCwd;
  try {
    resolvedCwd = fs.realpathSync(msg.cwd);
  } catch {
    throw new Error('cwd does not exist');
  }
  if (!fs.statSync(resolvedCwd).isDirectory()) {
    throw new Error('cwd is not a directory');
  }

  // --- 3. Validate binary resolvability ---
  // Determine which binary to use (claude uses 'claude', codex uses CONFIG.codexBin).
  const bin = msg.agentType === 'codex' ? codexBin : 'claude';
  const available = await _resolveBinary(bin);
  if (!available) {
    throw new Error(`agent binary "${bin}" not found`);
  }

  // --- 4. Validate target.mode ---
  const target = msg.target;
  if (!target || (target.mode !== 'new-window' && target.mode !== 'new-session')) {
    throw new Error('invalid target mode');
  }

  // Get current tmux sessions for existence checks.
  const windows = await tmux.listWindows();
  const sessionNames = new Set(windows.map((w) => w.sessionName));

  if (target.mode === 'new-window') {
    // target.session must exist.
    const session = target.session;
    if (typeof session !== 'string' || session.length === 0) {
      throw new Error('invalid target mode');
    }
    if (!tmux.isValidName(session)) {
      throw new Error('invalid target mode');
    }
    if (!sessionNames.has(session)) {
      throw new Error(`session not found: ${session}`);
    }
  } else {
    // new-session: name must pass isValidName AND must NOT already exist.
    const name = msg.name;
    if (!tmux.isValidName(name)) {
      throw new Error('invalid session name');
    }
    if (sessionNames.has(name)) {
      throw new Error(`session already exists: ${name}`);
    }
  }

  // --- 5. Build the spawn command via the adapter ---
  const { bin: spawnBin, args } = adapter.buildSpawnCommand({ cwd: resolvedCwd, bin });

  // --- 6. Spawn via tmux ---
  let newTarget;
  if (target.mode === 'new-window') {
    newTarget = await tmux.newWindow({
      session: target.session,
      cwd: resolvedCwd,
      bin: spawnBin,
      args,
    });
  } else {
    newTarget = await tmux.newSession({
      name: msg.name,
      cwd: resolvedCwd,
      bin: spawnBin,
      args,
    });
  }

  // --- 7. Best-effort registry refresh so the new session surfaces ---
  registry.refresh().catch(() => {});

  return newTarget;
}
