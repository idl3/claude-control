/**
 * lib/models.js — curated model catalogs + machine-aware recommendations.
 *
 * The enhancer's Claude and MLX models are picked from these fixed lists (the
 * UI shows dropdowns, not freeform inputs, to minimise typos / bad ids). MLX
 * picks are sized for Apple-Silicon unified memory (16–48 GB), and the default
 * is chosen automatically from the host's detected RAM.
 *
 * Exports:
 *  - MLX_MODELS, CLAUDE_MODELS, CODEX_MODELS  (catalogs)
 *  - detectMachine() → { ramGB, arch, platform, appleSilicon }
 *  - recommendMlxModel(ramGB) → id
 *  - recommendClaudeModel() → id
 */
import os from 'node:os';

/**
 * Curated MLX instruct models (4-bit, no "thinking" mode → clean JSON for the
 * enhancer). `sizeGB` ≈ on-disk weights; `minRamGB` is the unified-memory tier
 * at/above which the model is a comfortable pick alongside other apps.
 * @type {{ id: string, label: string, sizeGB: number, minRamGB: number }[]}
 */
export const MLX_MODELS = [
  { id: 'mlx-community/Llama-3.2-3B-Instruct-4bit', label: 'Llama 3.2 3B', sizeGB: 1.8, minRamGB: 16 },
  { id: 'mlx-community/Qwen2.5-3B-Instruct-4bit', label: 'Qwen2.5 3B', sizeGB: 1.8, minRamGB: 16 },
  { id: 'mlx-community/Qwen2.5-7B-Instruct-4bit', label: 'Qwen2.5 7B', sizeGB: 4.3, minRamGB: 24 },
  { id: 'mlx-community/Llama-3.1-8B-Instruct-4bit', label: 'Llama 3.1 8B', sizeGB: 4.5, minRamGB: 24 },
  { id: 'mlx-community/Qwen2.5-14B-Instruct-4bit', label: 'Qwen2.5 14B', sizeGB: 8.5, minRamGB: 32 },
  { id: 'mlx-community/Qwen2.5-32B-Instruct-4bit', label: 'Qwen2.5 32B', sizeGB: 18, minRamGB: 48 },
];

/**
 * Claude models offered by the New Session model picker + the enhancer
 * backend/fallback. Exact ids — the CLI expects the real model id (not a
 * shorthand like 'opus'/'sonnet'/'haiku') when --model is passed explicitly.
 * Single source of truth: server.js derives ALLOWED_CLAUDE_MODELS from this
 * list, and the SPA fetches it via /api/models rather than hardcoding a copy.
 * @type {{ id: string, label: string }[]}
 */
export const CLAUDE_MODELS = [
  { id: 'claude-opus-4-8', label: 'Opus 4.8' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
];

/**
 * Codex models offered by the New Session model picker. Unlike Claude, the
 * Codex CLI does not statically enumerate a model catalog anywhere on disk or
 * via `--help` (a `model/list` JSON-RPC method exists on `codex app-server`,
 * but requires a live authenticated connection — impractical for this static
 * /api/models response) — hand-maintained instead, grounded only in ids with
 * direct evidence in this environment: the operator's ~/.codex/config.toml
 * pins `model = "gpt-5.5"` (current default), with its own comment recording
 * `gpt-5.4` as the prior stable pin it was reverted from. Deliberately does
 * NOT include invented ids (e.g. "gpt-5.1-codex") with no evidence here.
 * @type {{ id: string, label: string }[]}
 */
export const CODEX_MODELS = [
  { id: 'gpt-5.5', label: 'GPT-5.5' },
  { id: 'gpt-5.4', label: 'GPT-5.4' },
];

/** Detect host specs relevant to model selection. */
export function detectMachine() {
  const ramGB = Math.round(os.totalmem() / 1024 ** 3);
  const arch = os.arch();
  const platform = os.platform();
  return { ramGB, arch, platform, appleSilicon: platform === 'darwin' && arch === 'arm64' };
}

/**
 * Recommend an MLX model id for a given unified-memory size. Conservative so it
 * stays snappy alongside the user's other apps: 3B (≤23 GB) → 7B (24–47 GB) →
 * 14B (≥48 GB).
 * @param {number} ramGB
 * @returns {string}
 */
export function recommendMlxModel(ramGB) {
  if (ramGB >= 48) return 'mlx-community/Qwen2.5-14B-Instruct-4bit';
  if (ramGB >= 24) return 'mlx-community/Qwen2.5-7B-Instruct-4bit';
  return 'mlx-community/Llama-3.2-3B-Instruct-4bit';
}

/** The enhancer is a short, cheap task → Haiku is the sensible default. */
export function recommendClaudeModel() {
  return 'claude-haiku-4-5-20251001';
}
