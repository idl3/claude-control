/**
 * lib/config.js — tiny persisted config store.
 *
 * Holds the operator-editable settings that drive "new session" creation:
 * the launch command to run in a fresh tmux window (default "claude", but
 * overridable to a shell alias like `yolo` or `claude --flags`) and the
 * default cwd new sessions start in.
 *
 * Also holds prompt-optimiser settings:
 *  - optimizeModel: the Claude model used for LLM-based prompt optimisation
 *    (default 'claude-haiku-4-5').
 *  - claudeBin: optional absolute path to the claude CLI binary. Empty string
 *    means auto-resolve (resolveClaudeBin() in lib/claude-cli.js tries PATH,
 *    then common install locations).
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
import { detectMachine, recommendMlxModel, recommendClaudeModel } from './models.js';
import { writeJsonAtomic } from './json-file.js';

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
const OPTIMIZE_MODEL_MAX = 200;
const CLAUDE_BIN_MAX = 500;
const MLX_MODEL_MAX = 200;
const OPTIMIZE_BACKENDS = ['mlx', 'claude', 'rules'];

// Transcript font-size: integer px values the user can choose.
// Base range: 12-18px. External-display range: 12-22px (larger monitor benefit).
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 18;
const EXT_FONT_SIZE_MAX = 22;

/** Defaults, recomputed each call so a changed HOME/env is honoured. */
function defaults() {
  return {
    launchCommand: 'claude',
    defaultCwd: os.homedir(),
    optimizeModel: recommendClaudeModel(),
    claudeBin: '',
    // Prompt-enhancer backend: 'mlx' (local model → claude → rules chain),
    // 'claude' (claude -p → rules), or 'rules' (deterministic, offline).
    optimizeBackend: 'mlx',
    // Default MLX model auto-picked for this machine's unified memory.
    mlxModel: recommendMlxModel(detectMachine().ramGB),
    // Transcript font-size (px). 0 = use the CSS default (--txt-transcript).
    // transcriptFontSize applies on non-external-display (base / iPad).
    // externalFontSize applies ONLY when body.is-external-display is set.
    transcriptFontSize: 0,
    externalFontSize: 0,
  };
}

/**
 * Read the persisted config, merged over defaults. Never throws — a missing,
 * empty, or corrupt file falls back to defaults. Only known keys are surfaced.
 *
 * @returns {{ launchCommand: string, defaultCwd: string, optimizeModel: string, claudeBin: string, optimizeBackend: string, mlxModel: string, transcriptFontSize: number, externalFontSize: number }}
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

  const clampFontSize = (v, max) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n === 0) return 0; // 0 = use CSS default
    return Math.min(max, Math.max(FONT_SIZE_MIN, n));
  };

  return {
    launchCommand:
      typeof parsed.launchCommand === 'string' && parsed.launchCommand.trim()
        ? parsed.launchCommand
        : base.launchCommand,
    defaultCwd:
      typeof parsed.defaultCwd === 'string' && parsed.defaultCwd.trim()
        ? parsed.defaultCwd
        : base.defaultCwd,
    optimizeModel:
      typeof parsed.optimizeModel === 'string' && parsed.optimizeModel.trim()
        ? parsed.optimizeModel
        : base.optimizeModel,
    claudeBin:
      typeof parsed.claudeBin === 'string'
        ? parsed.claudeBin
        : base.claudeBin,
    optimizeBackend:
      typeof parsed.optimizeBackend === 'string' &&
      OPTIMIZE_BACKENDS.includes(parsed.optimizeBackend)
        ? parsed.optimizeBackend
        : base.optimizeBackend,
    mlxModel:
      typeof parsed.mlxModel === 'string' && parsed.mlxModel.trim()
        ? parsed.mlxModel
        : base.mlxModel,
    transcriptFontSize:
      parsed.transcriptFontSize !== undefined
        ? clampFontSize(parsed.transcriptFontSize, FONT_SIZE_MAX)
        : base.transcriptFontSize,
    externalFontSize:
      parsed.externalFontSize !== undefined
        ? clampFontSize(parsed.externalFontSize, EXT_FONT_SIZE_MAX)
        : base.externalFontSize,
  };
}

/**
 * Validate a partial update against the current config and persist the merged
 * result. Throws on validation failure (the caller maps that to HTTP 400).
 *
 * Validation:
 *  - launchCommand: non-empty string, ≤500 chars.
 *  - defaultCwd: a path that exists and is a directory.
 *  - optimizeModel: non-empty string, ≤200 chars.
 *  - claudeBin: string ≤500 chars; empty string is allowed (means auto-resolve).
 *    Existence is NOT verified at write time (path may differ across hosts).
 *
 * @param {{ launchCommand?: unknown, defaultCwd?: unknown, optimizeModel?: unknown, claudeBin?: unknown }} partial
 * @returns {{ launchCommand: string, defaultCwd: string, optimizeModel: string, claudeBin: string, optimizeBackend: string, mlxModel: string }} the saved config
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

  if (partial.optimizeModel !== undefined) {
    const model = partial.optimizeModel;
    if (typeof model !== 'string' || !model.trim()) {
      throw new Error('optimizeModel must be a non-empty string');
    }
    if (model.length > OPTIMIZE_MODEL_MAX) {
      throw new Error(`optimizeModel must be ≤${OPTIMIZE_MODEL_MAX} characters`);
    }
    next.optimizeModel = model;
  }

  if (partial.claudeBin !== undefined) {
    const bin = partial.claudeBin;
    if (typeof bin !== 'string') {
      throw new Error('claudeBin must be a string');
    }
    if (bin.length > CLAUDE_BIN_MAX) {
      throw new Error(`claudeBin must be ≤${CLAUDE_BIN_MAX} characters`);
    }
    next.claudeBin = bin;
  }

  if (partial.optimizeBackend !== undefined) {
    const b = partial.optimizeBackend;
    if (typeof b !== 'string' || !OPTIMIZE_BACKENDS.includes(b)) {
      throw new Error(`optimizeBackend must be one of: ${OPTIMIZE_BACKENDS.join(', ')}`);
    }
    next.optimizeBackend = b;
  }

  if (partial.mlxModel !== undefined) {
    const m = partial.mlxModel;
    if (typeof m !== 'string' || !m.trim()) {
      throw new Error('mlxModel must be a non-empty string');
    }
    if (m.length > MLX_MODEL_MAX) {
      throw new Error(`mlxModel must be ≤${MLX_MODEL_MAX} characters`);
    }
    next.mlxModel = m;
  }

  if (partial.transcriptFontSize !== undefined) {
    const n = Number(partial.transcriptFontSize);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error('transcriptFontSize must be an integer');
    }
    if (n !== 0 && (n < FONT_SIZE_MIN || n > FONT_SIZE_MAX)) {
      throw new Error(`transcriptFontSize must be 0 or ${FONT_SIZE_MIN}–${FONT_SIZE_MAX}`);
    }
    next.transcriptFontSize = n;
  }

  if (partial.externalFontSize !== undefined) {
    const n = Number(partial.externalFontSize);
    if (!Number.isFinite(n) || !Number.isInteger(n)) {
      throw new Error('externalFontSize must be an integer');
    }
    if (n !== 0 && (n < FONT_SIZE_MIN || n > EXT_FONT_SIZE_MAX)) {
      throw new Error(`externalFontSize must be 0 or ${FONT_SIZE_MIN}–${EXT_FONT_SIZE_MAX}`);
    }
    next.externalFontSize = n;
  }

  const dir = dataDir();
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(configPath(), next, { mode: 0o600 });
  return next;
}
