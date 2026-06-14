/**
 * lib/config.js — tiny persisted config store.
 *
 * Holds the operator-editable settings that drive "new session" creation:
 * the launch command to run in a fresh tmux window (default "claude", but
 * overridable to a shell alias like `yolo` or `claude --flags`) and the
 * default cwd new sessions start in.
 *
 * Persisted at ~/.claude-control/config.json (honour CLAUDE_CONTROL_DATA when
 * set, matching server.js's env-override convention). Reads never throw —
 * defaults are merged over whatever's on disk. Writes validate strictly and
 * use mode 0600 (same as the uploads handler) since this is a single-user
 * localhost tool.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// Env lookup mirrors server.js: prefer CLAUDE_CONTROL_<X>, fall back to the
// legacy COCKPIT_<X> so existing launchers keep working.
const env = (name) =>
  process.env[`CLAUDE_CONTROL_${name}`] ?? process.env[`COCKPIT_${name}`];

/** Resolve the data directory (CLAUDE_CONTROL_DATA or ~/.claude-control). */
function dataDir() {
  return env('DATA') || path.join(os.homedir(), '.claude-control');
}

/** Absolute path to the config file. */
function configPath() {
  return path.join(dataDir(), 'config.json');
}

const LAUNCH_MAX = 500;

/** Defaults, recomputed each call so a changed HOME/env is honoured. */
function defaults() {
  return {
    launchCommand: 'claude',
    defaultCwd: os.homedir(),
  };
}

/**
 * Read the persisted config, merged over defaults. Never throws — a missing,
 * empty, or corrupt file falls back to defaults. Only known keys are surfaced.
 *
 * @returns {{ launchCommand: string, defaultCwd: string }}
 */
export function readConfig() {
  const base = defaults();
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath(), 'utf8'));
  } catch {
    return base;
  }
  if (!parsed || typeof parsed !== 'object') return base;
  return {
    launchCommand:
      typeof parsed.launchCommand === 'string' && parsed.launchCommand.trim()
        ? parsed.launchCommand
        : base.launchCommand,
    defaultCwd:
      typeof parsed.defaultCwd === 'string' && parsed.defaultCwd.trim()
        ? parsed.defaultCwd
        : base.defaultCwd,
  };
}

/**
 * Validate a partial update against the current config and persist the merged
 * result. Throws on validation failure (the caller maps that to HTTP 400).
 *
 * Validation:
 *  - launchCommand: non-empty string, ≤500 chars.
 *  - defaultCwd: a path that exists and is a directory.
 *
 * @param {{ launchCommand?: unknown, defaultCwd?: unknown }} partial
 * @returns {{ launchCommand: string, defaultCwd: string }} the saved config
 */
export function writeConfig(partial = {}) {
  const current = readConfig();
  const next = { ...current };

  if (partial.launchCommand !== undefined) {
    const cmd = partial.launchCommand;
    if (typeof cmd !== 'string' || !cmd.trim()) {
      throw new Error('launchCommand must be a non-empty string');
    }
    if (cmd.length > LAUNCH_MAX) {
      throw new Error(`launchCommand must be ≤${LAUNCH_MAX} characters`);
    }
    next.launchCommand = cmd;
  }

  if (partial.defaultCwd !== undefined) {
    const cwd = partial.defaultCwd;
    if (typeof cwd !== 'string' || !cwd.trim()) {
      throw new Error('defaultCwd must be a non-empty string');
    }
    let stat;
    try {
      stat = fs.statSync(cwd);
    } catch {
      throw new Error(`defaultCwd does not exist: ${cwd}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`defaultCwd is not a directory: ${cwd}`);
    }
    next.defaultCwd = cwd;
  }

  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}
