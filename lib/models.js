/**
 * lib/models.js — curated model catalogs + machine-aware recommendations.
 *
 * The enhancer's Claude and MLX models are picked from these fixed lists (the
 * UI shows dropdowns, not freeform inputs, to minimise typos / bad ids). MLX
 * picks are sized for Apple-Silicon unified memory (16–48 GB), and the default
 * is chosen automatically from the host's detected RAM.
 *
 * Exports:
 *  - MLX_MODELS, CLAUDE_MODELS        (catalogs)
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
 * Curated Claude models for the `claude -p` enhancer backend/fallback.
 * @type {{ id: string, label: string }[]}
 */
export const CLAUDE_MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — fast, cheap' },
  { id: 'claude-sonnet-4-6', label: 'Sonnet 4.6 — balanced' },
  { id: 'claude-opus-4-8', label: 'Opus 4.8 — most capable' },
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
  return 'claude-haiku-4-5';
}
